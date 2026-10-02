import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";

type Any = any;

describe("AgentDaemon follow-up startup recovery", () => {
  it("interrupts terminal tasks only when their latest user follow-up receipt is queued or started", () => {
    const candidates = [
      { id: "completed-started", status: "completed", source: "manual" },
      { id: "failed-queued", status: "failed", source: "manual" },
      { id: "completed-finished", status: "completed", source: "manual" },
      { id: "completed-agent-message", status: "completed", source: "manual" },
      { id: "hook-started", status: "completed", source: "hook" },
    ];
    const eventsByTask = new Map([
      [
        "completed-started",
        [
          {
            id: "started-receipt",
            taskId: "completed-started",
            timestamp: 1,
            type: "user_message",
            payload: {
              messageId: "started-follow-up",
              deliveryMode: "follow_up",
              deliveryStatus: "started",
            },
          },
        ],
      ],
      [
        "failed-queued",
        [
          {
            id: "queued-receipt",
            taskId: "failed-queued",
            timestamp: 1,
            type: "user_message",
            payload: {
              messageId: "queued-follow-up",
              deliveryMode: "follow_up",
              deliveryStatus: "queued",
            },
          },
        ],
      ],
      [
        "completed-finished",
        [
          {
            id: "completed-receipt",
            taskId: "completed-finished",
            timestamp: 1,
            type: "user_message",
            payload: {
              messageId: "finished-follow-up",
              deliveryMode: "follow_up",
              deliveryStatus: "accepted",
              providerDispatchStatus: "completed",
            },
          },
        ],
      ],
      [
        "completed-agent-message",
        [
          {
            id: "agent-receipt",
            taskId: "completed-agent-message",
            timestamp: 1,
            type: "user_message",
            payload: {
              messageId: "agent-message",
              deliveryMode: "message",
              deliveryStatus: "queued",
            },
          },
        ],
      ],
      [
        "hook-started",
        [
          {
            id: "hook-receipt",
            taskId: "hook-started",
            timestamp: 1,
            type: "user_message",
            payload: {
              messageId: "hook-follow-up",
              deliveryMode: "follow_up",
              deliveryStatus: "started",
            },
          },
        ],
      ],
    ]);
    const update = vi.fn();
    const logEvent = vi.fn();
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findByStatus: vi.fn().mockReturnValue(candidates),
        update,
      },
      eventRepo: {
        findByTaskIdAndTypes: vi.fn((taskId: string) => eventsByTask.get(taskId) ?? []),
      },
      logEvent,
    }) as Any;

    AgentDaemon.prototype["recoverUnstartedUserFollowUpsOnStartup"].call(daemonLike);

    expect(daemonLike.taskRepo.findByStatus).toHaveBeenCalledWith([
      "paused",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(
      1,
      "completed-started",
      expect.objectContaining({ status: "interrupted" }),
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      "failed-queued",
      expect.objectContaining({ status: "interrupted" }),
    );
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(logEvent).toHaveBeenCalledWith(
      "completed-started",
      "task_interrupted",
      expect.objectContaining({ reason: "user_follow_up_recovered_after_restart" }),
    );
  });

  it("promotes a transcript-consumed started receipt before redispatching after a crash", async () => {
    const event = {
      id: "follow-up-receipt",
      taskId: "task-1",
      timestamp: 1,
      type: "user_message",
      payload: {
        message: "Continue the task",
        messageId: "follow-up-123",
        deliveryMode: "follow_up",
        deliveryStatus: "started",
      },
    };
    const followUp = {
      message: "Continue the task",
      messageId: "follow-up-123",
      deliveryMode: "follow_up",
    };
    const queue = [followUp];
    const runtime = {
      isFollowUpMessageConsumed: vi.fn().mockReturnValue(true),
      removeFollowUpAtTurnBoundary: vi.fn(),
      requeueFollowUpAtTurnBoundary: vi.fn(),
      saveSnapshot: vi.fn(),
    };
    const executor = {
      isRunning: false,
      takeNextFollowUpAtTurnBoundary: vi.fn(() => queue.shift()),
      runtime,
      suppressNextUserMessageEvent: vi.fn(),
    };
    const updatePayloadById = vi.fn((_eventId: string, payload: Any) => {
      event.payload = payload;
    });
    const sendMessage = vi.fn().mockResolvedValue({ queued: false, deliveryStatus: "accepted" });
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      drainingFollowUps: new Set<string>(),
      activeTasks: new Map([["task-1", { executor }]]),
      eventRepo: {
        findByTaskIdAndTypes: vi.fn(() => [event]),
        updatePayloadById,
      },
      emitTaskEvent: vi.fn(),
      timelineRowsCommitted: vi.fn().mockResolvedValue(undefined),
      sendMessage,
      logEvent: vi.fn(),
    }) as Any;

    AgentDaemon.prototype.processOrphanedFollowUps.call(daemonLike, "task-1", executor);

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(event.payload).toMatchObject({
      deliveryStatus: "accepted",
      providerDispatchStatus: "pending",
    });
    expect(runtime.removeFollowUpAtTurnBoundary).toHaveBeenCalledWith("follow-up-123");
    expect(sendMessage.mock.calls[0]?.[4]).toMatchObject({
      messageId: "follow-up-123",
      transcriptAlreadyContainsMessage: true,
      queuedFollowUp: followUp,
    });
    expect(runtime.requeueFollowUpAtTurnBoundary).not.toHaveBeenCalled();
  });
});

describe("AgentDaemon follow-up turn-boundary drain", () => {
  it.each([
    ["ends while the receipt commits", false],
    ["keeps running", true],
  ])("drains a busy-path follow-up only when the turn %s", async (_label, stillRunning) => {
    const task = {
      id: "850e8400-e29b-41d4-a716-446655440000",
      title: "Running task",
      workspaceId: "workspace-1",
      agentConfig: {},
    };
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace",
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
      createdAt: Date.now(),
    };
    const executor = {
      isRunning: true,
      updateTaskAgentConfig: vi.fn(),
      updateWorkspace: vi.fn(),
      queueFollowUp: vi.fn(),
    };
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      activeTasks: new Map([[task.id, { executor, lastAccessed: 0, status: "active" }]]),
      taskRepo: { findById: vi.fn().mockReturnValue(task), update: vi.fn(), touch: vi.fn() },
      workspaceRepo: { findById: vi.fn().mockReturnValue(workspace) },
      annotationRepo: { listOpenByTask: vi.fn().mockReturnValue([]) },
      logEvent: vi.fn(),
      // The executor's turn (and its post-run drain) finishes during the commit.
      timelineRowsCommitted: vi.fn(async () => {
        executor.isRunning = stillRunning;
      }),
      processOrphanedFollowUps: vi.fn(),
    }) as Any;

    const result = await AgentDaemon.prototype.sendMessage.call(
      daemonLike,
      task.id,
      "Also check the CSV header",
    );

    expect(result).toMatchObject({ queued: true, deliveryStatus: "queued" });
    expect(executor.queueFollowUp).toHaveBeenCalledTimes(1);
    if (stillRunning) {
      expect(daemonLike.processOrphanedFollowUps).not.toHaveBeenCalled();
    } else {
      expect(daemonLike.processOrphanedFollowUps).toHaveBeenCalledWith(task.id, executor);
      expect(executor.queueFollowUp.mock.invocationCallOrder[0]).toBeLessThan(
        daemonLike.processOrphanedFollowUps.mock.invocationCallOrder[0],
      );
    }
  });

  it("drains a follow-up queued after the final take of a running drain", async () => {
    const queue: Any[] = [{ message: "First" }];
    const daemonLike = Object.create(AgentDaemon.prototype) as Any;
    let lateArrivalQueued = false;
    const executor = {
      isRunning: false,
      takeNextFollowUpAtTurnBoundary: vi.fn(() => {
        const next = queue.shift();
        if (!next && !lateArrivalQueued) {
          // A busy-path follow-up lands right after this empty take. Its own
          // drain attempt sees the running drain and leaves the item to it.
          lateArrivalQueued = true;
          queue.push({ message: "Late" });
          daemonLike.processOrphanedFollowUps("task", executor);
        }
        return next;
      }),
      get hasPendingFollowUps() {
        return queue.length > 0;
      },
      suppressNextUserMessageEvent: vi.fn(),
    };
    daemonLike.drainingFollowUps = new Set();
    daemonLike.logEvent = vi.fn();
    daemonLike.sendMessage = vi.fn().mockResolvedValue({ queued: false });

    daemonLike.processOrphanedFollowUps("task", executor);

    await vi.waitFor(() => expect(daemonLike.sendMessage).toHaveBeenCalledTimes(2));
    expect(daemonLike.sendMessage.mock.calls.map((call: Any[]) => call[1])).toEqual([
      "First",
      "Late",
    ]);
    await vi.waitFor(() => expect(daemonLike.drainingFollowUps.has("task")).toBe(false));
    expect(queue).toHaveLength(0);
  });
});
