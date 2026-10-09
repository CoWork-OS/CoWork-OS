import { describe, expect, it, vi } from "vitest";

import { AgentDaemon, buildCollaborativeUpdateAcknowledgement } from "../daemon";
import { TaskExecutor } from "../executor";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

// The responsibility policy has its own tests; these follow-ups are not responsibility tasks.
vi.mock("../../automation/responsibility-task-policy", () => ({
  enforceResponsibilityTaskStart: vi.fn(async () => {}),
}));

const ROOT_ID = "root-task";

function createDaemonLike(options: {
  rootConfig?: Record<string, unknown>;
  runStatus?: string | null;
  children?: Array<{ id: string; status: string }>;
  runningChildIds?: string[];
  userMessages?: Array<Record<string, unknown>>;
}) {
  const root = {
    id: ROOT_ID,
    title: "Plan a workshop",
    prompt: "Plan a workshop for 40 people with a €250 cash budget.",
    status: "executing",
    agentConfig: options.rootConfig ?? { collaborativeMode: true },
  };
  const children = (options.children ?? []).map((child) => ({
    ...child,
    parentTaskId: ROOT_ID,
  }));
  const tickRun = vi.fn().mockResolvedValue(undefined);
  const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
    taskRepo: {
      findById: vi.fn((id: string) => (id === ROOT_ID ? root : undefined)),
      findByParent: vi.fn(() => children),
    },
    eventRepo: {
      findByTaskIdAndTypes: vi.fn(() =>
        (options.userMessages ?? []).map((payload, index) => ({
          id: `event-${index}`,
          taskId: ROOT_ID,
          type: "user_message",
          timestamp: index,
          payload,
        })),
      ),
    },
    activeTasks: new Map(
      (options.runningChildIds ?? []).map((id) => [
        id,
        { executor: { isRunning: true }, lastAccessed: 0, status: "active" },
      ]),
    ),
    teamOrchestrator: { tickRun },
    findTeamRunByRootTaskId: vi.fn(() =>
      options.runStatus ? { id: "run-1", status: options.runStatus } : null,
    ),
    sendMessage: vi.fn().mockResolvedValue({ queued: true }),
  }) as Any;
  return { daemon, root, tickRun };
}

describe("collaborative root follow-ups", () => {
  it("defers a root follow-up's completion while its team run is running", () => {
    const { daemon, tickRun } = createDaemonLike({
      runStatus: "running",
      children: [
        { id: "lane-1", status: "executing" },
        { id: "lane-2", status: "completed" },
      ],
    });

    expect(daemon.reconcileCollaborativeRunBeforeFollowUpCompletion(ROOT_ID)).toEqual({
      deferred: true,
      activeChildCount: 1,
    });
    expect(tickRun).toHaveBeenCalledWith("run-1", "root_follow_up_deferred");
  });

  it.each([
    ["the team run has finished", { runStatus: "completed" }],
    ["there is no team run", { runStatus: null }],
    ["the task is not collaborative", { runStatus: "running", rootConfig: {} }],
    [
      "the run belongs to the parent's own executor",
      {
        runStatus: "running",
        rootConfig: { collaborativeMode: true, childAgentCollaborativeRun: true },
      },
    ],
  ])("does not defer when %s", (_label, options) => {
    const { daemon } = createDaemonLike(options);
    expect(daemon.reconcileCollaborativeRunBeforeFollowUpCompletion(ROOT_ID).deferred).toBe(false);
  });

  it("forwards a root update only to team lanes that are running", () => {
    const { daemon, root } = createDaemonLike({
      runStatus: "running",
      children: [
        { id: "lane-running", status: "executing" },
        { id: "lane-not-started", status: "pending" },
        { id: "lane-done", status: "completed" },
      ],
      runningChildIds: ["lane-running", "lane-done"],
    });

    daemon.forwardRootFollowUpToActiveTeamLanes(
      root,
      "Cap attendance at 20 people and the cash budget at €150.",
      "msg-1",
    );

    expect(daemon.sendMessage).toHaveBeenCalledTimes(1);
    expect(daemon.sendMessage).toHaveBeenCalledWith(
      "lane-running",
      expect.stringContaining("Cap attendance at 20 people and the cash budget at €150."),
      undefined,
      undefined,
      { deliveryMode: "follow_up", messageSource: "user", messageId: "msg-1:lane:lane-running" },
    );
  });

  it("lists user follow-ups after the original request, once each", () => {
    const { daemon } = createDaemonLike({
      userMessages: [
        { message: "Plan a workshop for 40 people with a €250 cash budget." },
        { message: "Cap attendance at 20 people.", messageSource: "user", messageId: "m1" },
        { message: "Cap attendance at 20 people.", messageSource: "user", messageId: "m1" },
        { message: "Lane note", messageSource: "agent", messageId: "m2" },
        { message: "Direct message", deliveryMode: "message", messageId: "m3" },
        { message: "Budget is €150.", messageSource: "user", messageId: "m4" },
      ],
    });

    expect(daemon.listUserFollowUpMessages(ROOT_ID)).toEqual([
      "Cap attendance at 20 people.",
      "Budget is €150.",
    ]);
  });

  it("keeps the root executing instead of completing it while the team works", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { id: ROOT_ID, status: "executing" };
    executor.lastAssistantText = "Updated draft for 20 people and €150.";
    executor.getContentFallback = vi.fn(() => "");
    executor.emitEvent = vi.fn();
    executor.daemon = {
      reconcileCollaborativeRunBeforeFollowUpCompletion: vi.fn(() => ({
        deferred: true,
        activeChildCount: 3,
      })),
      updateTask: vi.fn(),
      updateTaskStatus: vi.fn(),
    };

    executor.finalizeFollowUpCompletion("Follow-up completed (status safety net)");

    expect(executor.task.status).toBe("executing");
    expect(executor.daemon.updateTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTaskStatus).toHaveBeenCalledWith(ROOT_ID, "executing");
    expect(executor.emitEvent).not.toHaveBeenCalledWith("task_completed", expect.anything());
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "task_status",
      expect.objectContaining({ status: "executing", collaborativeRunWaiting: true }),
    );
  });
});

describe("team lane completion after a forwarded user update", () => {
  const LANE_ID = "lane-1";
  const UPDATE =
    "The user updated the parent request while you were working. Update the pilot: it now starts 26 October, with 8 staff.";

  function createLaneDaemon(options: {
    parentTaskId?: string;
    status?: string;
    queue: Array<Record<string, unknown>>;
    running?: boolean;
  }) {
    const lane = {
      id: LANE_ID,
      title: "Arjuna (builder)",
      prompt: "Plan the pilot starting 19 October for 12 staff.",
      status: options.status ?? "executing",
      ...(options.parentTaskId === undefined ? { parentTaskId: ROOT_ID } : {}),
      ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
      agentConfig: {},
    };
    const queue = options.queue;
    const executor = {
      isRunning: options.running ?? true,
      runtime: { state: { queues: { pendingFollowUps: queue } } },
    };
    const proceeded = new Error("completion proceeded");
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: { findById: vi.fn((id: string) => (id === LANE_ID ? lane : undefined)) },
      activeTasks: new Map([[LANE_ID, { executor, lastAccessed: 0, status: "active" }]]),
      getTaskEventsForReplay: vi.fn(() => []),
      logEvent: vi.fn(),
      updateTaskStatus: vi.fn(),
      processOrphanedFollowUps: vi.fn(),
      cleanupPendingApprovalsForTask: vi.fn(() => {
        throw proceeded;
      }),
    }) as Any;
    return { daemon, executor, queue, proceeded };
  }

  const queuedUpdate = {
    message: UPDATE,
    deliveryMode: "follow_up",
    messageSource: "user",
    messageId: "root-msg:lane:lane-1",
  };

  it("does not store a stale result while the accepted update is still queued", async () => {
    // Live order: update accepted at 09:00:11, the original final step
    // finishes at 09:00:43 without having seen it, then completeTask runs.
    const { daemon, queue, proceeded } = createLaneDaemon({ queue: [{ ...queuedUpdate }] });

    await daemon.completeTask(LANE_ID, "Plan: starts 19 October, 12 staff, €600.");

    expect(daemon.cleanupPendingApprovalsForTask).not.toHaveBeenCalled();
    expect(daemon.logEvent).not.toHaveBeenCalledWith(LANE_ID, "task_completed", expect.anything());
    expect(daemon.logEvent).toHaveBeenCalledWith(
      LANE_ID,
      "log",
      expect.objectContaining({
        metric: "completion_deferred_for_user_update",
        pendingMessageIds: ["root-msg:lane:lane-1"],
      }),
    );
    // The running executor drains the update when its run returns.
    expect(daemon.processOrphanedFollowUps).not.toHaveBeenCalled();

    // The update turn consumes the queue; its completion is authoritative.
    queue.splice(0, queue.length);
    await expect(
      daemon.completeTask(LANE_ID, "Plan: starts 26 October, 8 staff, €350."),
    ).rejects.toBe(proceeded);
  });

  it("drains the update itself when the executor is no longer running", () => {
    const { daemon, executor } = createLaneDaemon({
      queue: [{ ...queuedUpdate }],
      running: false,
      status: "completed",
    });

    expect(daemon.reconcilePendingUserUpdateBeforeCompletion(LANE_ID)).toEqual({
      deferred: true,
      pendingMessageIds: ["root-msg:lane:lane-1"],
    });
    expect(daemon.updateTaskStatus).toHaveBeenCalledWith(LANE_ID, "executing");
    expect(daemon.processOrphanedFollowUps).toHaveBeenCalledWith(LANE_ID, executor);
  });

  it.each([
    ["only teammate messages are queued", { queue: [{ ...queuedUpdate, messageSource: "agent" }] }],
    [
      "a queue-only agent message is waiting",
      { queue: [{ ...queuedUpdate, deliveryMode: "message" }] },
    ],
    ["an internal retry note is waiting", { queue: [{ message: "[RETRY CONTEXT]: again" }] }],
    ["the queue is empty", { queue: [] }],
    ["the task has no parent", { queue: [{ ...queuedUpdate }], parentTaskId: "" }],
  ])("completes normally when %s", (_label, options) => {
    const { daemon } = createLaneDaemon(options);

    expect(daemon.reconcilePendingUserUpdateBeforeCompletion(LANE_ID).deferred).toBe(false);
    expect(daemon.logEvent).not.toHaveBeenCalled();
  });
});

describe("user update on a collaborative root while its team works", () => {
  const UPDATE =
    "Update the pilot: it now starts 26 October, with 8 staff and a €350 materials ceiling. Please pass these revised limits to every specialist before finalizing the plan.";

  function createRootDaemon(options: {
    runStatus?: string | null;
    children: Array<{ id: string; title: string; status: string }>;
    runningChildIds: string[];
    failingChildIds?: string[];
  }) {
    const root = {
      id: ROOT_ID,
      title: "Northstar Onboarding Pilot Launch Plan",
      prompt: "Plan the onboarding pilot starting 19 October for 12 staff.",
      status: "executing",
      workspaceId: "ws-1",
      agentConfig: { collaborativeMode: true },
    };
    const children = options.children.map((child) => ({ ...child, parentTaskId: ROOT_ID }));
    const events: Array<{ taskId: string; type: string; payload: Record<string, unknown> }> = [];
    const laneSend = vi.fn(async (taskId: string) => {
      if (options.failingChildIds?.includes(taskId)) throw new Error("lane unavailable");
      return { queued: true };
    });
    const tickRun = vi.fn().mockResolvedValue(undefined);
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      shutdownRequested: false,
      taskRepo: {
        findById: vi.fn((id: string) => (id === ROOT_ID ? root : undefined)),
        findByParent: vi.fn(() => children),
        touch: vi.fn(),
      },
      eventRepo: {
        findByTaskIdAndTypes: vi.fn((taskId: string, types: string[]) =>
          events
            .filter((event) => event.taskId === taskId && types.includes(event.type))
            .map((event, index) => ({ id: `event-${index}`, timestamp: index, ...event })),
        ),
      },
      getDatabase: vi.fn(),
      activeTasks: new Map<string, unknown>(
        options.runningChildIds.map((id) => [
          id,
          { executor: { isRunning: true }, lastAccessed: 0, status: "active" },
        ]),
      ),
      teamOrchestrator: { tickRun },
      findTeamRunByRootTaskId: vi.fn(() =>
        options.runStatus === null ? null : { id: "run-1", status: options.runStatus ?? "running" },
      ),
      timelineRowsCommitted: vi.fn(async () => {}),
      logEvent: vi.fn((taskId: string, type: string, payload: Record<string, unknown>) => {
        events.push({ taskId, type, payload });
      }),
    }) as Any;
    // Lanes take the forwarded update; the root goes through the real sendMessage.
    daemon.sendMessage = vi.fn((taskId: string, ...rest: unknown[]) =>
      taskId === ROOT_ID
        ? (AgentDaemon.prototype.sendMessage as Any).call(daemon, taskId, ...rest)
        : laneSend(taskId),
    );
    return { daemon, events, laneSend, tickRun };
  }

  const liveChildren = [
    { id: "anansi", title: "Anansi (explorer)", status: "executing" },
    { id: "apollo", title: "Apollo (explorer)", status: "executing" },
    { id: "ares", title: "Ares (builder)", status: "executing" },
    { id: "arjuna", title: "Arjuna (planner)", status: "executing" },
  ];

  it("passes the update to the working specialists and says so without running a root turn", async () => {
    const { daemon, events, laneSend, tickRun } = createRootDaemon({
      children: liveChildren,
      runningChildIds: ["anansi", "apollo", "ares", "arjuna"],
    });

    const result = await daemon.sendMessage(ROOT_ID, UPDATE, undefined, undefined, {
      deliveryMode: "follow_up",
      messageId: "msg-1",
      returnOnAccepted: true,
    });

    expect(result).toEqual(
      expect.objectContaining({ queued: false, messageId: "msg-1", deliveryStatus: "delivered" }),
    );
    // No root executor was created, so no free-form root turn ran.
    expect(daemon.activeTasks.has(ROOT_ID)).toBe(false);
    expect(laneSend.mock.calls.map(([taskId]) => taskId)).toEqual([
      "anansi",
      "apollo",
      "ares",
      "arjuna",
    ]);
    const replies = events.filter((event) => event.type === "assistant_message");
    expect(replies).toHaveLength(1);
    const reply = String(replies[0].payload.message);
    expect(reply).toContain(
      "Passed your update to the 4 specialists still working: Anansi (explorer), Apollo (explorer), Ares (builder), Arjuna (planner).",
    );
    expect(reply).not.toMatch(/can.t contact|cannot brief|can.t brief/i);
    // The synthesis reads the update from the root's user messages.
    expect(daemon.listUserFollowUpMessages(ROOT_ID)).toEqual([UPDATE]);
    // The root is left executing for the team's synthesis to complete it.
    expect(events.some((event) => event.type === "task_completed")).toBe(false);
    expect(tickRun).toHaveBeenCalledWith("run-1", "root_follow_up_forwarded");

    // A renderer retry of the same message is a duplicate, not a second reply.
    const retry = await daemon.sendMessage(ROOT_ID, UPDATE, undefined, undefined, {
      deliveryMode: "follow_up",
      messageId: "msg-1",
    });
    expect(retry).toEqual(
      expect.objectContaining({ duplicate: true, deliveryStatus: "delivered" }),
    );
    expect(events.filter((event) => event.type === "assistant_message")).toHaveLength(1);
    expect(laneSend).toHaveBeenCalledTimes(4);
  });

  it("names finished, idle and unreachable lanes as handled by the synthesis", async () => {
    const { daemon, events } = createRootDaemon({
      children: [
        { id: "anansi", title: "Anansi (explorer)", status: "executing" },
        { id: "apollo", title: "Apollo (explorer)", status: "completed" },
        { id: "ares", title: "Ares (builder)", status: "pending" },
        { id: "arjuna", title: "Arjuna (planner)", status: "executing" },
      ],
      runningChildIds: ["anansi", "arjuna"],
      failingChildIds: ["arjuna"],
    });

    await daemon.sendMessage(ROOT_ID, UPDATE, undefined, undefined, { messageId: "msg-2" });

    const reply = String(
      events.find((event) => event.type === "assistant_message")?.payload.message,
    );
    expect(reply).toContain(
      "Passed your update to the 1 specialist still working: Anansi (explorer).",
    );
    expect(reply).toContain(
      "Apollo (explorer) had already finished, so the synthesis reconciles that result with your update.",
    );
    expect(reply).toContain(
      "Ares (builder), Arjuna (planner) are not running right now, so the synthesis applies your update to their results.",
    );
  });

  it("reports a running synthesis as the recipient once every specialist is done", async () => {
    const { daemon, events, laneSend } = createRootDaemon({
      children: [
        { id: "anansi", title: "Anansi (explorer)", status: "completed" },
        { id: "synthesis", title: "Synthesis", status: "executing" },
      ],
      runningChildIds: ["synthesis"],
    });

    await daemon.sendMessage(ROOT_ID, UPDATE, undefined, undefined, { messageId: "msg-3" });

    expect(laneSend).toHaveBeenCalledWith("synthesis");
    const reply = String(
      events.find((event) => event.type === "assistant_message")?.payload.message,
    );
    expect(reply).toContain("Passed your update to the synthesis drafting the final answer");
    expect(reply).not.toContain("specialists still working");
  });

  it.each([
    ["the team run has finished", { runStatus: "completed" }, undefined, {}],
    ["the message comes from an agent", {}, undefined, { messageSource: "agent" }],
    ["it carries images", {}, [{ data: "x", mimeType: "image/png" }], {}],
    ["it recovers a queued item", {}, undefined, { queuedFollowUp: { message: UPDATE } }],
  ])(
    "leaves the regular follow-up path in charge when %s",
    async (_label, setup, images, extra) => {
      const { daemon, events, laneSend } = createRootDaemon({
        children: liveChildren,
        runningChildIds: ["anansi"],
        ...(setup as { runStatus?: string }),
      });

      await expect(
        daemon.acknowledgeCollaborativeRootUpdate(
          daemon.taskRepo.findById(ROOT_ID),
          UPDATE,
          images,
          { messageId: "msg-4", ...extra },
        ),
      ).resolves.toBeNull();
      expect(events).toHaveLength(0);
      expect(laneSend).not.toHaveBeenCalled();
    },
  );
});

describe("collaborative update acknowledgement text", () => {
  const empty = {
    forwarded: [],
    finished: [],
    notRunning: [],
    synthesisForwarded: false,
    synthesisFinished: false,
  };

  it("routes the update to the synthesis when no specialist is working", () => {
    expect(buildCollaborativeUpdateAcknowledgement(empty)).toBe(
      "No specialist is still working, so your update goes to the synthesis that drafts the final answer. The final answer follows when the team finishes and uses your update.",
    );
  });

  it("does not promise the update when the synthesis already finished", () => {
    const text = buildCollaborativeUpdateAcknowledgement({ ...empty, synthesisFinished: true });
    expect(text).toContain("does not include this update");
    expect(text).not.toContain("uses your update");
  });
});
