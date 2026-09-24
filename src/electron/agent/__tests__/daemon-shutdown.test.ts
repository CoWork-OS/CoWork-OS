import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/tmp") } }));

describe("daemon shutdown persistence", () => {
  it.each(["completed", "failed", "cancelled"])(
    "does not interrupt a durable %s task left active in the executor cache",
    async (status) => {
      const executor = { saveConversationSnapshot: vi.fn(), cancel: vi.fn(async () => undefined) };
      const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
        orchestrationGraphEngine: { stop: vi.fn() },
        workSessionProtocolService: { getReliabilityService: () => ({ stop: vi.fn() }) },
        pendingApprovals: new Map(),
        pendingDurableApprovalGrants: new Map(),
        pendingInputRequests: new Map(),
        pendingRetries: new Map(),
        pendingTaskImages: new Map(),
        activeTasks: new Map([["task", { status: "active", executor }]]),
        taskRepo: { findById: () => ({ id: "task", status }), update: vi.fn() },
        logEvent: vi.fn(),
        removeAllListeners: vi.fn(),
      });
      await daemon.shutdown();
      expect(daemon.taskRepo.update).not.toHaveBeenCalled();
      expect(daemon.logEvent).not.toHaveBeenCalledWith(
        "task",
        "task_interrupted",
        expect.anything(),
      );
      expect(executor.saveConversationSnapshot).not.toHaveBeenCalled();
      expect(executor.cancel).toHaveBeenCalledOnce();
    },
  );

  it.each(["updateTask", "updateTaskStatus"])(
    "%s retires a completed follow-up in the cache",
    (method) => {
      const cached = { status: "active", lastAccessed: 0 };
      const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
        activeTasks: new Map([["task", cached]]),
        taskRepo: { findById: () => ({ id: "task", status: "executing" }), update: vi.fn() },
        clearRetryState: vi.fn(),
        clearTimelineTaskState: vi.fn(),
        finishQueueSlotIfTracked: vi.fn(),
      });
      if (method === "updateTask") daemon.updateTask("task", { status: "completed" });
      else daemon.updateTaskStatus("task", "completed");
      expect(cached.status).toBe("completed");
      expect(cached.lastAccessed).toBeGreaterThan(0);
    },
  );

  it.each(["orchestration", "reliability"])(
    "persists interruption even if %s stop throws",
    async (failure) => {
      const events: string[] = [];
      const failIf = (name: string) => () => {
        if (failure === name) throw new Error("fixture stop failure");
      };
      const executor = {
        saveConversationSnapshot: vi.fn(() => events.push("snapshot")),
        cancel: vi.fn(async () => {
          events.push("cancel");
        }),
      };
      const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
        orchestrationGraphEngine: { stop: failIf("orchestration") },
        workSessionProtocolService: {
          getReliabilityService: () => ({ stop: failIf("reliability") }),
        },
        pendingApprovals: new Map(),
        pendingDurableApprovalGrants: new Map(),
        pendingInputRequests: new Map(),
        pendingRetries: new Map(),
        activeTasks: new Map([["task", { status: "active", executor }]]),
        pendingTaskImages: new Map(),
        taskRepo: {
          findById: () => ({
            id: "task",
            status: "executing",
            resultSummary: "Saved task progress. ".repeat(12),
          }),
          update: vi.fn(() => events.push("interrupted")),
        },
        logEvent: vi.fn(),
        removeAllListeners: vi.fn(),
      });
      await expect(daemon.shutdown()).rejects.toThrow("did not reach quiescence");
      expect(events).toEqual(["snapshot", "interrupted", "cancel"]);
      expect(daemon.taskRepo.update).toHaveBeenCalledWith(
        "task",
        expect.objectContaining({ status: "interrupted", terminalStatus: "resume_available" }),
      );
      expect(daemon.activeTasks.size).toBe(1);
    },
  );

  it("shares one shutdown promise and cancels each active executor once", async () => {
    const executor = {
      saveConversationSnapshot: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      orchestrationGraphEngine: { stop: vi.fn() },
      workSessionProtocolService: { getReliabilityService: () => ({ stop: vi.fn() }) },
      pendingApprovals: new Map(),
      pendingDurableApprovalGrants: new Map(),
      pendingInputRequests: new Map(),
      pendingRetries: new Map(),
      activeTasks: new Map([["task", { status: "active", executor }]]),
      pendingTaskImages: new Map(),
      taskRepo: {
        findById: () => ({ id: "task", status: "executing" }),
        update: vi.fn(),
      },
      logEvent: vi.fn(),
      removeAllListeners: vi.fn(),
    });

    const first = daemon.shutdown();
    const second = daemon.shutdown();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(executor.cancel).toHaveBeenCalledTimes(1);
    expect(daemon.removeAllListeners).toHaveBeenCalledTimes(1);
  });

  it("drains a delayed queue starter before shutdown releases dependencies", async () => {
    let releaseCollaboration!: (launched: boolean) => void;
    const collaboration = new Promise<boolean>((resolve) => {
      releaseCollaboration = resolve;
    });
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      shutdownRequested: false,
      shouldStartAsQueuedContinuation: vi.fn().mockReturnValue(false),
      applyAgentRoleOverrides: vi.fn((task: Any) => ({ task, changed: false })),
      maybeCaptureMentionedAgentRoleIds: vi.fn(),
      applyRuntimeTaskStrategy: vi.fn((task: Any) => ({
        task,
        route: {
          intent: "execution",
          confidence: 1,
          conversationMode: "execute",
          answerFirst: false,
          signals: [],
          complexity: "low",
          domain: "general",
        },
        agentConfigChanged: false,
        promptChanged: false,
      })),
      applyJevTaskStrategy: vi.fn(async (task: Any) => ({
        task,
        changed: false,
        profileSelected: true,
        status: "skipped",
      })),
      maybeLaunchCollaborativeTask: vi.fn(() => collaboration),
      finishQueueSlot: vi.fn(),
      activeTasks: new Map(),
      pendingContinuationTaskIds: new Set(),
      pendingTaskImages: new Map(),
      pendingRetries: new Map(),
      pendingApprovals: new Map(),
      pendingDurableApprovalGrants: new Map(),
      pendingInputRequests: new Map(),
      orchestrationGraphEngine: { stop: vi.fn() },
      workSessionProtocolService: { getReliabilityService: () => ({ stop: vi.fn() }) },
      removeAllListeners: vi.fn(),
    });
    const task = { id: "delayed", title: "Delayed", status: "queued" } as Any;

    const starter = AgentDaemon.prototype.startTaskImmediate.call(daemon, task);
    await vi.waitFor(() => expect(daemon.admittedStartOperations?.size).toBe(1));
    const shutdown = daemon.shutdown();
    releaseCollaboration(false);

    await starter;
    await shutdown;
    expect(daemon.activeTasks.size).toBe(0);
    expect(daemon.finishQueueSlot).toHaveBeenCalledWith("delayed");
  });
});
