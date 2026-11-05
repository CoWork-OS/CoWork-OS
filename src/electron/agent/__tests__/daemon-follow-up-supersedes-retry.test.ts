import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";

function daemonLike(initialStatus: string) {
  let storedTask: Any = { id: "task-1", status: initialStatus, error: "" };
  const daemon = {
    retryCounts: new Map<string, number>(),
    pendingRetries: new Map<string, ReturnType<typeof setTimeout>>(),
    activeTasks: new Map<string, Any>(),
    maxTaskRetries: 2,
    retryDelayMs: 30_000,
    taskRepo: {
      findById: vi.fn(() => storedTask),
      update: vi.fn((_id: string, updates: Record<string, unknown>) => {
        storedTask = { ...storedTask, ...updates };
      }),
    },
    queueManager: {
      onTaskFinished: vi.fn(),
      isRunning: vi.fn(() => false),
      isQueued: vi.fn(() => false),
    },
    logEvent: vi.fn(),
    startTask: vi.fn(async () => {}),
    finishQueueSlot: vi.fn(),
    isTransientRetryErrorMessage: () => true,
    clearRetryState: (AgentDaemon.prototype as Any).clearRetryState,
  } as Any;
  return { daemon, task: () => storedTask };
}

const supersede = (daemon: Any, taskId: string) =>
  (AgentDaemon.prototype as Any).supersedeTransientRetry.call(daemon, taskId);

describe("AgentDaemon follow-up during a transient retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cancels the pending retry and takes the task out of the queue", async () => {
    const { daemon, task } = daemonLike("executing");
    AgentDaemon.prototype.handleTransientTaskFailure.call(daemon, "task-1", "fetch failed", 1000);
    expect(task()).toMatchObject({ status: "queued" });

    supersede(daemon, "task-1");

    expect(task()).toMatchObject({ status: "executing", error: null });
    expect(daemon.pendingRetries.has("task-1")).toBe(false);
    expect(daemon.retryCounts.has("task-1")).toBe(false);
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "task_dequeued",
      expect.objectContaining({ message: expect.any(String) }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(daemon.startTask).not.toHaveBeenCalled();
  });

  it("leaves a task without a pending retry alone", () => {
    const { daemon, task } = daemonLike("queued");
    supersede(daemon, "task-1");
    expect(task()).toMatchObject({ status: "queued" });
    expect(daemon.taskRepo.update).not.toHaveBeenCalled();
    expect(daemon.logEvent).not.toHaveBeenCalled();
  });
});
