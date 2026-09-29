import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/tmp") } }));

// Detached promises in the daemon must be caught and logged with context rather
// than left as unhandled rejections: the direct CLI registers no handler for them,
// so Node's default would terminate the run.
describe("AgentDaemon detached promise handling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const loggedErrors = () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    return () => spy.mock.calls.map((call) => String(call[0]));
  };

  it("contains a failure to advance the queue when a slot is freed", async () => {
    const onTaskFinished = vi.fn(async () => {
      throw new Error("queue failed");
    });
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      releaseComputerUseSession: vi.fn(),
      queueManager: { onTaskFinished },
    }) as Any;
    const errors = loggedErrors();

    daemon.finishQueueSlot("task-1");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors()).toEqual([
      expect.stringContaining("Failed to advance the task queue after task-1"),
    ]);
    expect(daemon.releaseComputerUseSession).toHaveBeenCalledWith("task-1");
    expect(onTaskFinished).toHaveBeenCalledWith("task-1");
  });

  it("contains a failed transient retry start", async () => {
    vi.useFakeTimers();
    const startTask = vi.fn(async () => {
      throw new Error("start failed");
    });
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      retryCounts: new Map(),
      pendingRetries: new Map(),
      maxTaskRetries: 3,
      retryDelayMs: 1000,
      activeTasks: new Map(),
      taskRepo: {
        update: vi.fn(),
        findById: vi.fn(() => ({ id: "task-1", status: "queued" })),
      },
      queueManager: {
        onTaskFinished: vi.fn(async () => undefined),
        isRunning: vi.fn(() => false),
        isQueued: vi.fn(() => false),
      },
      releaseComputerUseSession: vi.fn(),
      logEvent: vi.fn(),
      isTransientRetryErrorMessage: vi.fn(() => false),
      startTask,
    }) as Any;
    const errors = loggedErrors();

    expect(daemon.handleTransientTaskFailure("task-1", "rate limited", 1000)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);

    expect(errors()).toEqual([expect.stringContaining("Transient retry for task task-1 failed")]);
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(daemon.pendingRetries.has("task-1")).toBe(false);
  });
});
