import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";
import { getBackgroundProcessManager } from "../tools/background-processes";

vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/tmp") } }));

// run_command background: true processes outlive a finished turn so follow-ups
// can reach them; the daemon stops them when the task is cancelled or deleted
// (deletion cancels first) and when it shuts down.
describe("daemon background process lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["completed", "failed", "cancelled", "executing"])(
    "stops a %s task's background processes when it is cancelled or deleted",
    async (status) => {
      const stopAllForTask = vi
        .spyOn(getBackgroundProcessManager(), "stopAllForTask")
        .mockResolvedValue(1);
      const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
        taskRepo: {
          findById: vi.fn().mockReturnValue({ id: "task-1", status }),
          findByParent: vi.fn().mockReturnValue([]),
        },
        orchestrationGraphEngine: { cancelRunForRootTask: vi.fn(async () => undefined) },
        pendingContinuationTaskIds: new Set(),
        logEvent: vi.fn(),
        queueManager: { cancelQueuedTask: vi.fn().mockReturnValue(true) },
        cancelTaskRecord: vi.fn(),
        pendingTaskImages: new Map(),
        activeTasks: new Map(),
      }) as Any;

      await AgentDaemon.prototype.cancelTask.call(daemon, "task-1");

      expect(stopAllForTask).toHaveBeenCalledWith("task-1", "task_cancelled");
    },
  );

  it("stops every background process on shutdown, including evicted tasks'", async () => {
    const stopAll = vi.spyOn(getBackgroundProcessManager(), "stopAll").mockResolvedValue(2);
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      orchestrationGraphEngine: { stop: vi.fn() },
      workSessionProtocolService: { getReliabilityService: () => ({ stop: vi.fn() }) },
      pendingApprovals: new Map(),
      pendingDurableApprovalGrants: new Map(),
      pendingInputRequests: new Map(),
      pendingRetries: new Map(),
      pendingTaskImages: new Map(),
      activeTasks: new Map(),
      taskRepo: { findById: () => undefined, update: vi.fn() },
      logEvent: vi.fn(),
      removeAllListeners: vi.fn(),
    });

    await daemon.shutdown();

    expect(stopAll).toHaveBeenCalledWith("app_shutdown");
  });
});
