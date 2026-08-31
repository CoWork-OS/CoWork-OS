import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

describe("AgentDaemon.forkTaskSession", () => {
  it("creates a forked task with session lineage metadata", async () => {
    const forkedTask = {
      id: "forked-task",
      title: "Original task (investigate)",
    };
    const createTaskRecord = vi.fn().mockReturnValue({
      task: forkedTask,
      derived: {
        route: { intent: "debug", domain: "code", confidence: 0.9, signals: [] },
        strategy: { conversationMode: "task", executionMode: "execute" },
      },
    });
    const logEvent = vi.fn();
    const startTask = vi.fn().mockResolvedValue(undefined);
    const cloneForkHistoryEvents = vi.fn();
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-1",
          title: "Original task",
          prompt: "Fix the bug",
          rawPrompt: "Fix the bug",
          userPrompt: "Fix the bug",
          workspaceId: "workspace-1",
          agentConfig: { executionMode: "execute" },
          source: "manual",
        }),
      },
      getTaskEventsForReplay: vi.fn().mockReturnValue([
        {
          id: "event-7",
          eventId: "event-7",
          taskId: "task-1",
          timestamp: 1,
          type: "assistant_message",
          payload: { message: "Prior answer" },
        },
      ]),
      createTaskRecord,
      cloneForkHistoryEvents,
      logEvent,
      logTaskIntentRouted: vi.fn(),
      startTask,
    } as Any);

    const result = await AgentDaemon.prototype.forkTaskSession.call(daemonLike, {
      taskId: "task-1",
      branchLabel: "investigate",
      fromEventId: "event-7",
    });

    expect(createTaskRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        taskOverrides: expect.objectContaining({
          branchFromTaskId: "task-1",
          branchFromEventId: "event-7",
          branchLabel: "investigate",
        }),
      }),
    );
    expect(cloneForkHistoryEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: "task-1",
        targetTaskId: "forked-task",
        events: expect.arrayContaining([
          expect.objectContaining({
            id: "event-7",
          }),
        ]),
      }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "forked-task",
      "log",
      expect.objectContaining({
        message: "Session fork created",
        sourceTaskId: "task-1",
      }),
    );
    expect(startTask).not.toHaveBeenCalled();
    expect(result.id).toBe("forked-task");
  });

  it("backtracks before a selected user message and uses it as the branch prompt", async () => {
    const createTaskRecord = vi.fn().mockReturnValue({
      task: { id: "forked-task", title: "Original task (side-chat)" },
      derived: {
        route: { intent: "debug", domain: "code", confidence: 0.9, signals: [] },
        strategy: { conversationMode: "task", executionMode: "execute" },
      },
    });
    const cloneForkHistoryEvents = vi.fn();
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-1",
          title: "Original task",
          prompt: "Original prompt",
          rawPrompt: "Original prompt",
          userPrompt: "Original prompt",
          workspaceId: "workspace-1",
          source: "manual",
        }),
      },
      getTaskEventsForReplay: vi.fn().mockReturnValue([
        {
          id: "event-1",
          eventId: "event-1",
          taskId: "task-1",
          timestamp: 1,
          type: "user_message",
          payload: { message: "Start here" },
        },
        {
          id: "event-2",
          eventId: "event-2",
          taskId: "task-1",
          timestamp: 2,
          type: "assistant_message",
          payload: { message: "Prior answer" },
        },
        {
          id: "event-step",
          eventId: "event-step",
          taskId: "task-1",
          timestamp: 2.5,
          type: "timeline_step_finished",
          payload: { legacyType: "step_completed", message: "Finished a step" },
          legacyType: "step_completed",
        },
        {
          id: "event-3",
          eventId: "event-3",
          taskId: "task-1",
          timestamp: 3,
          type: "user_message",
          payload: { message: "Try the other approach" },
        },
      ]),
      createTaskRecord,
      cloneForkHistoryEvents,
      logEvent: vi.fn(),
      logTaskIntentRouted: vi.fn(),
      startTask: vi.fn().mockResolvedValue(undefined),
    } as Any);

    await AgentDaemon.prototype.forkTaskSession.call(daemonLike, {
      taskId: "task-1",
      branchLabel: "side-chat",
      fromEventId: "event-3",
    });

    expect(createTaskRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Try the other approach",
      }),
    );
    expect(cloneForkHistoryEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({ id: "event-1" }),
          expect.objectContaining({ id: "event-2" }),
          expect.objectContaining({ id: "event-step" }),
        ],
      }),
    );
  });

  it("creates sidechat forks as read-only chat tasks and starts the initial question server-side", async () => {
    const forkedTask = {
      id: "side-task",
      title: "Original task (side-chat)",
    };
    const createTaskRecord = vi.fn().mockReturnValue({
      task: forkedTask,
      derived: {
        route: { intent: "advice", domain: "general", confidence: 0.8, signals: [] },
        strategy: { conversationMode: "chat", executionMode: "chat" },
      },
    });
    const sendMessage = vi.fn().mockResolvedValue({ queued: false });
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-1",
          title: "Original task",
          prompt: "Original prompt",
          rawPrompt: "Original prompt",
          userPrompt: "Original prompt",
          workspaceId: "workspace-1",
          agentConfig: { executionMode: "execute", allowedTools: ["read_file"] },
          source: "manual",
        }),
      },
      getTaskEventsForReplay: vi.fn().mockReturnValue([]),
      createTaskRecord,
      cloneForkHistoryEvents: vi.fn(),
      logEvent: vi.fn(),
      logTaskIntentRouted: vi.fn(),
      sendMessage,
    } as Any);

    await AgentDaemon.prototype.forkTaskSession.call(daemonLike, {
      taskId: "task-1",
      branchLabel: "side-chat",
      sideChat: true,
      initialMessage: "How is it going?",
    });

    expect(createTaskRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "side_chat",
        agentConfig: expect.objectContaining({
          conversationMode: "chat",
          executionMode: "chat",
          autonomousMode: false,
          shellAccess: false,
          requireWorktree: false,
          toolRestrictions: ["*"],
          allowedTools: [],
        }),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith("side-task", "How is it going?");
  });

  it("refreshes sidechat parent context with missing parent events before later turns", () => {
    const cloneForkHistoryEvents = vi.fn();
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue({ id: "task-1", title: "Original task" }),
      },
      eventRepo: {
        findByTaskId: vi.fn().mockReturnValue([
          {
            id: "cloned-event-1",
            eventId: "cloned-event-1",
            taskId: "side-task",
            timestamp: 1,
            seq: 4,
            type: "assistant_message",
            payload: {
              message: "Older parent answer",
              forkedFromTaskId: "task-1",
              forkedFromEventId: "event-1",
            },
          },
        ]),
      },
      getTaskEventsForReplay: vi.fn().mockReturnValue([
        {
          id: "event-1",
          eventId: "event-1",
          taskId: "task-1",
          timestamp: 1,
          type: "assistant_message",
          payload: { message: "Older parent answer" },
        },
        {
          id: "event-2",
          eventId: "event-2",
          taskId: "task-1",
          timestamp: 2,
          type: "assistant_message",
          payload: { message: "Fresh parent answer" },
        },
      ]),
      cloneForkHistoryEvents,
      logEvent: vi.fn(),
    } as Any);

    (AgentDaemon.prototype as Any).refreshSideChatParentSnapshot.call(daemonLike, {
      id: "side-task",
      source: "side_chat",
      branchLabel: "side-chat",
      branchFromTaskId: "task-1",
    });

    expect(cloneForkHistoryEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: "task-1",
        targetTaskId: "side-task",
        startSeq: 4,
        events: [expect.objectContaining({ id: "event-2" })],
      }),
    );
  });

  it("builds a fresh parent status block for sidechat status questions", () => {
    const parentTask = {
      id: "task-1",
      title: "Make my internet faster",
      status: "executing",
    };
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockImplementation((taskId: string) => {
          return taskId === "task-1" ? parentTask : undefined;
        }),
      },
      activeTasks: new Map([
        [
          "task-1",
          {
            status: "active",
            executor: { isRunning: true },
            lastAccessed: Date.now(),
          },
        ],
      ]),
      activeTimelineStageByTask: new Map([["task-1", "BUILD"]]),
      activeStepIdsByTask: new Map([["task-1", new Set(["latency-ping"])]]),
      failedPlanStepsByTask: new Map(),
      getTaskEventsForReplay: vi.fn().mockReturnValue([
        {
          id: "event-1",
          eventId: "event-1",
          taskId: "task-1",
          timestamp: 1_000,
          type: "timeline_step_started",
          payload: { message: "Checking Wi-Fi stability" },
        },
        {
          id: "event-2",
          eventId: "event-2",
          taskId: "task-1",
          timestamp: 2_000,
          type: "log",
          payload: { message: "Running ping test now" },
        },
      ]),
    } as Any);

    const result = (AgentDaemon.prototype as Any).buildSideChatTurnAgentConfigOverride.call(
      daemonLike,
      {
        id: "side-task",
        source: "side_chat",
        branchLabel: "side-chat",
        branchFromTaskId: "task-1",
      },
      "how is it going now?",
    );

    expect(result?.sideChatTurnContext).toContain("LIVE_PARENT_STATUS");
    expect(result?.sideChatTurnContext).toContain("Parent task status: executing");
    expect(result?.sideChatTurnContext).toContain("Parent runtime state: running");
    expect(result?.sideChatTurnContext).toContain("Active timeline stage: BUILD");
    expect(result?.sideChatTurnContext).toContain("Running ping test now");
    expect(result?.sideChatTurnContext).toContain("do not use them as the current parent status");
  });
});
