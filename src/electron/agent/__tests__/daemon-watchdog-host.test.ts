import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";

type Row = { id: string; status: string; terminalStatus?: string; workspaceId?: string };

function daemonLike(options: {
  task?: Row;
  cached?: { status: "active" | "completed"; isRunning?: boolean };
  queued?: boolean;
  retryPending?: boolean;
}) {
  const rows = new Map<string, Row>(options.task ? [[options.task.id, { ...options.task }]] : []);
  const executor = {
    isRunning: options.cached?.isRunning ?? false,
    pause: vi.fn().mockResolvedValue(undefined),
  };
  const activeTasks = new Map(
    options.cached && options.task
      ? [[options.task.id, { executor, status: options.cached.status, lastAccessed: 0 }]]
      : [],
  );
  const target = {
    shutdownRequested: false,
    interruptedDiscards: new Set<string>(),
    activeTasks,
    pendingRetries: new Map(options.retryPending ? [[options.task?.id, 1]] : []),
    queueManager: {
      isQueued: vi.fn(() => options.queued === true),
      creditSuspendedTime: vi.fn(),
    },
    taskRepo: {
      findById: vi.fn((id: string) => rows.get(id)),
      findByStatus: vi.fn((statuses: string[]) =>
        [...rows.values()].filter((row) => statuses.includes(row.status)),
      ),
      update: vi.fn((id: string, updates: Partial<Row>) => {
        const row = rows.get(id);
        if (row) Object.assign(row, updates);
      }),
    },
    logEvent: vi.fn(),
    resumeTask: vi.fn().mockResolvedValue(true),
    startTask: vi.fn().mockResolvedValue(undefined),
    hasPendingUserDecisionForTask: vi.fn(() => false),
    shouldResumeTaskOnStartup: vi.fn(() => true),
    backgroundCompletionsSettled: new Set<string>(options.task ? [options.task.id] : []),
    flushBackgroundProcessCompletions: vi.fn().mockResolvedValue(undefined),
    trackBackgroundWork: vi.fn((work: Promise<unknown>) => work),
  };
  return { target: target as Any, rows, executor, activeTasks };
}

describe("AgentDaemon watchdog host surface", () => {
  it("reports runtime facts only this process knows", () => {
    const { target } = daemonLike({
      task: { id: "t1", status: "executing" },
      cached: { status: "active", isRunning: true },
      queued: true,
    });
    expect(AgentDaemon.prototype.getWatchdogTaskRuntime.call(target, "t1")).toEqual({
      hasExecutor: true,
      executorRunning: true,
      queued: true,
      retryPending: false,
      waitingForUser: false,
      autoResumable: true,
    });
    expect(AgentDaemon.prototype.listRunningTaskIdsForWatchdog.call(target)).toEqual(["t1"]);
  });

  it("recovers an orphaned task through the interrupted resume path", async () => {
    const { target, rows } = daemonLike({ task: { id: "t1", status: "executing" } });
    await expect(
      AgentDaemon.prototype.recoverTaskForWatchdog.call(target, "t1", "No events for 30 minutes."),
    ).resolves.toBe(true);
    expect(rows.get("t1")).toMatchObject({
      status: "interrupted",
      terminalStatus: "resume_available",
    });
    expect(target.logEvent).toHaveBeenCalledWith("t1", "task_interrupted", {
      message: "Watchdog: No events for 30 minutes.",
      reason: "watchdog",
      terminalStatus: "resume_available",
    });
    expect(target.resumeTask).toHaveBeenCalledWith("t1");
  });

  it("never rebuilds a task whose executor is running, and retries failures only when asked", async () => {
    const running = daemonLike({
      task: { id: "t1", status: "executing" },
      cached: { status: "active", isRunning: true },
    });
    await expect(
      AgentDaemon.prototype.recoverTaskForWatchdog.call(running.target, "t1", "stalled"),
    ).resolves.toBe(false);
    expect(running.target.resumeTask).not.toHaveBeenCalled();

    // An idle executor left behind by status drift is replaced, as a restart would.
    const idle = daemonLike({
      task: { id: "t3", status: "executing" },
      cached: { status: "active", isRunning: false },
    });
    await expect(
      AgentDaemon.prototype.recoverTaskForWatchdog.call(idle.target, "t3", "stalled"),
    ).resolves.toBe(true);
    expect(idle.activeTasks.has("t3")).toBe(false);
    expect(idle.target.resumeTask).toHaveBeenCalledWith("t3");

    const failed = daemonLike({
      task: { id: "t2", status: "failed", terminalStatus: "failed" },
      cached: { status: "completed" },
    });
    await expect(
      AgentDaemon.prototype.recoverTaskForWatchdog.call(failed.target, "t2", "socket hang up"),
    ).resolves.toBe(false);
    await expect(
      AgentDaemon.prototype.recoverTaskForWatchdog.call(failed.target, "t2", "socket hang up", {
        allowFailed: true,
      }),
    ).resolves.toBe(true);
    // The finished executor is dropped so the resume rebuilds from the saved state.
    expect(failed.activeTasks.has("t2")).toBe(false);
    expect(failed.rows.get("t2")?.status).toBe("interrupted");
  });

  it("pauses with a visible reason and leaves terminal tasks alone", async () => {
    const { target, rows, executor } = daemonLike({
      task: { id: "t1", status: "executing" },
      cached: { status: "active", isRunning: true },
    });
    await expect(
      AgentDaemon.prototype.pauseTaskForWatchdog.call(target, "t1", "Watchdog paused this task."),
    ).resolves.toBe(true);
    expect(executor.pause).toHaveBeenCalled();
    expect(rows.get("t1")?.status).toBe("paused");
    expect(target.logEvent).toHaveBeenCalledWith("t1", "task_paused", {
      message: "Watchdog paused this task.",
      reason: "watchdog",
    });
    await expect(
      AgentDaemon.prototype.pauseTaskForWatchdog.call(target, "t1", "again"),
    ).resolves.toBe(false);

    const done = daemonLike({ task: { id: "t2", status: "completed" } });
    await expect(
      AgentDaemon.prototype.pauseTaskForWatchdog.call(done.target, "t2", "x"),
    ).resolves.toBe(false);
  });

  it("re-queues a stuck transient retry unless a retry timer is armed", async () => {
    const stuck = daemonLike({ task: { id: "t1", status: "executing" } });
    await expect(
      AgentDaemon.prototype.requeueTaskForWatchdog.call(stuck.target, "t1", "stuck"),
    ).resolves.toBe(true);
    expect(stuck.rows.get("t1")?.status).toBe("queued");
    expect(stuck.target.startTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));

    const armed = daemonLike({ task: { id: "t2", status: "queued" }, retryPending: true });
    await expect(
      AgentDaemon.prototype.requeueTaskForWatchdog.call(armed.target, "t2", "stuck"),
    ).resolves.toBe(false);
    expect(armed.target.startTask).not.toHaveBeenCalled();
  });

  it("re-arms background completions and credits suspended time", () => {
    const { target } = daemonLike({
      task: { id: "t1", status: "executing" },
      cached: { status: "active", isRunning: true },
    });
    expect(AgentDaemon.prototype.rearmBackgroundProcessCompletions.call(target)).toBe(1);
    expect(target.backgroundCompletionsSettled.has("t1")).toBe(false);
    expect(target.flushBackgroundProcessCompletions).toHaveBeenCalledWith("t1");
    AgentDaemon.prototype.creditSuspendedTimeToQueue.call(target, 60_000);
    expect(target.queueManager.creditSuspendedTime).toHaveBeenCalledWith(60_000);
  });
});
