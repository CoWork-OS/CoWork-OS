import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/tmp") } }));

describe("daemon shutdown persistence", () => {
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
        agentConfigChanged: false,
        promptChanged: false,
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
