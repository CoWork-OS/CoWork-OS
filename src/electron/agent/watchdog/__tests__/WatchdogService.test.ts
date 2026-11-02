import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WATCHDOG_SETTINGS,
  type Task,
  type TaskEvent,
  type TaskStatus,
  type WatchdogDecision,
  type WatchdogSettings,
} from "../../../../shared/types";
import { findRunStart, trailingProviderErrors, WatchdogService } from "../WatchdogService";
import type { ProgressJudge, ProgressJudgement } from "../watchdog-progress-judge";
import type { WatchdogHost, WatchdogTaskRuntime } from "../watchdog-types";

const MINUTE = 60_000;
const T0 = 10_000_000_000;

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    prompt: "Summarise the quarterly sales report",
    status: "executing",
    workspaceId: "ws-1",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as Task;
}

let eventCounter = 0;
function makeEvent(
  taskId: string,
  type: string,
  timestamp: number,
  payload: Record<string, unknown> = {},
): TaskEvent {
  eventCounter += 1;
  return {
    id: `event-${eventCounter}`,
    taskId,
    timestamp,
    type: "timeline_step_updated",
    legacyType: type,
    payload,
    schemaVersion: 2,
  } as TaskEvent;
}

const assessment = {
  progressScore: 0,
  loopRiskIndex: 0.8,
  repeatedFingerprintCount: 3,
  windowSummary: {
    stepCompleted: 0,
    writeMutations: 0,
    readOperations: 0,
    searchOperations: 0,
    toolSuccesses: 0,
    resolvedErrorRecoveries: 0,
    repeatedErrorPenalty: 0.8,
    emptyNoOpTurns: 0,
  },
};

function judgement(verdict: "progressing" | "drifting", loopingOn?: string): ProgressJudgement {
  return {
    verdict,
    ...(loopingOn ? { loopingOn } : {}),
    reason: verdict === "drifting" ? "Keeps rerunning the same failing command." : "Steady.",
    judge: "model:test/cheap",
    assessment,
  };
}

interface Harness {
  service: WatchdogService;
  host: WatchdogHost & {
    tasks: Map<string, Task>;
    events: Map<string, TaskEvent[]>;
    runtimes: Map<string, Partial<WatchdogTaskRuntime>>;
    leased: Set<string>;
    logged: Array<{ decision: WatchdogDecision; message: string }>;
  };
  clock: { now: number };
  judge: ReturnType<typeof vi.fn>;
  setIntervalSpy: ReturnType<typeof vi.fn>;
  clearIntervalSpy: ReturnType<typeof vi.fn>;
  settings: WatchdogSettings;
}

function createHarness(settingsOverrides: Partial<WatchdogSettings> = {}): Harness {
  const clock = { now: T0 };
  const tasks = new Map<string, Task>();
  const events = new Map<string, TaskEvent[]>();
  const runtimes = new Map<string, Partial<WatchdogTaskRuntime>>();
  const leased = new Set<string>();
  const logged: Array<{ decision: WatchdogDecision; message: string }> = [];
  const host = {
    tasks,
    events,
    runtimes,
    leased,
    logged,
    listTasks: vi.fn((statuses: TaskStatus[]) =>
      [...tasks.values()].filter((task) => statuses.includes(task.status)),
    ),
    getTask: vi.fn((taskId: string) => tasks.get(taskId)),
    getRecentEvents: vi.fn((taskId: string, limit: number) =>
      (events.get(taskId) ?? []).slice(-limit),
    ),
    getRuntime: vi.fn((taskId: string): WatchdogTaskRuntime => ({
      hasExecutor: false,
      executorRunning: false,
      queued: false,
      retryPending: false,
      waitingForUser: false,
      autoResumable: true,
      ...runtimes.get(taskId),
    })),
    hasActiveLease: vi.fn((task: Task) => leased.has(task.id)),
    logDecision: vi.fn((decision: WatchdogDecision, message: string) => {
      logged.push({ decision, message });
    }),
    sendSteeringMessage: vi.fn(async () => true),
    pauseTask: vi.fn(async (taskId: string) => {
      const task = tasks.get(taskId);
      if (!task || task.status === "paused") return false;
      task.status = "paused";
      return true;
    }),
    cancelTask: vi.fn(async (taskId: string) => {
      const task = tasks.get(taskId);
      if (task) task.status = "cancelled";
      return true;
    }),
    recoverTask: vi.fn(async (_taskId: string, _reason: string, _options?: unknown) => true),
    requeueTask: vi.fn(async () => true),
    notify: vi.fn(),
    listRunningTaskIds: vi.fn(() =>
      [...runtimes.entries()]
        .filter(([, runtime]) => runtime.executorRunning)
        .map(([taskId]) => taskId),
    ),
    snapshotLeases: vi.fn((taskIds: string[]) =>
      taskIds.map((taskId) => ({
        taskId,
        sessionId: `session-${taskId}`,
        kind: "tool" as const,
        operationKey: `op-${taskId}`,
      })),
    ),
    reclaimLeases: vi.fn((entries: Array<{ taskId: string }>) => {
      const counts = new Map<string, number>();
      for (const entry of entries) counts.set(entry.taskId, (counts.get(entry.taskId) ?? 0) + 1);
      return counts;
    }),
    rearmBackgroundCompletions: vi.fn(() => 2),
    creditSuspendedTime: vi.fn(),
  };
  const settings: WatchdogSettings = {
    ...DEFAULT_WATCHDOG_SETTINGS,
    enabled: true,
    ...settingsOverrides,
  };
  const judge = vi.fn<ProgressJudge>(async () => judgement("progressing"));
  const setIntervalSpy = vi.fn(() => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout);
  const clearIntervalSpy = vi.fn();
  const service = new WatchdogService({
    host,
    judge,
    loadSettings: () => settings,
    now: () => clock.now,
    setInterval: setIntervalSpy,
    clearInterval: clearIntervalSpy,
    isRetryableError: (message) => /ECONNRESET|socket hang up|fetch failed/i.test(message),
  });
  return { service, host, clock, judge, setIntervalSpy, clearIntervalSpy, settings };
}

describe("WatchdogService scheduling", () => {
  it("stays off by default and makes no decisions while disabled", async () => {
    const harness = createHarness({ enabled: false });
    harness.service.start();
    expect(harness.setIntervalSpy).not.toHaveBeenCalled();
    harness.host.tasks.set("t1", makeTask({ id: "t1", updatedAt: T0 - 60 * MINUTE }));
    await expect(harness.service.runTick()).resolves.toEqual([]);
    expect(harness.host.listTasks).not.toHaveBeenCalled();
  });

  it("runs on the configured interval and stops when the setting turns off", () => {
    const harness = createHarness({ intervalMinutes: 7 });
    harness.service.start();
    expect(harness.setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 7 * MINUTE);
    harness.service.applySettings({ ...harness.settings, enabled: false });
    expect(harness.clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(harness.service.getSettings().enabled).toBe(false);
  });
});

describe("WatchdogService infrastructure pass", () => {
  it("resumes a task the database shows running when no executor runs it", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set("orphan", makeTask({ id: "orphan" }));
    harness.host.events.set("orphan", [makeEvent("orphan", "tool_result", T0)]);
    harness.clock.now = T0 + 30 * MINUTE;

    const decisions = await harness.service.runInfrastructurePass();

    expect(harness.host.recoverTask).toHaveBeenCalledWith(
      "orphan",
      expect.stringContaining("no live activity lease"),
      {},
    );
    expect(decisions).toEqual([
      expect.objectContaining({
        taskId: "orphan",
        action: "resume",
        pass: "infrastructure",
        attempt: 1,
      }),
    ]);
    expect(harness.host.logged[0].message).toContain("resumed this task");
  });

  it("leaves a quiet task alone while it holds a live activity lease", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set("busy", makeTask({ id: "busy" }));
    harness.host.events.set("busy", [makeEvent("busy", "tool_call", T0)]);
    harness.host.runtimes.set("busy", { hasExecutor: true, executorRunning: true });
    harness.host.leased.add("busy");
    harness.clock.now = T0 + 30 * MINUTE;

    expect(await harness.service.runInfrastructurePass()).toEqual([]);

    // A lease cannot hide silence forever: six stall windows later the task is paused.
    harness.clock.now = T0 + 121 * MINUTE;
    const decisions = await harness.service.runInfrastructurePass();
    expect(decisions).toEqual([expect.objectContaining({ taskId: "busy", action: "pause" })]);
  });

  it("pauses (never tears down) a live executor that went silent, and notifies", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set("hung", makeTask({ id: "hung", title: "Build the report" }));
    harness.host.events.set("hung", [makeEvent("hung", "tool_call", T0)]);
    harness.host.runtimes.set("hung", { hasExecutor: true, executorRunning: true });
    harness.clock.now = T0 + 25 * MINUTE;

    const decisions = await harness.service.runInfrastructurePass();

    expect(decisions).toEqual([expect.objectContaining({ taskId: "hung", action: "pause" })]);
    expect(harness.host.recoverTask).not.toHaveBeenCalled();
    expect(harness.host.cancelTask).not.toHaveBeenCalled();
    expect(harness.host.notify).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "hung", title: "Task paused by the watchdog" }),
    );
  });

  it("resumes a task whose cached executor sits idle while the status says executing", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set("drift", makeTask({ id: "drift" }));
    harness.host.events.set("drift", [makeEvent("drift", "assistant_message", T0)]);
    harness.host.runtimes.set("drift", { hasExecutor: true, executorRunning: false });
    harness.clock.now = T0 + 25 * MINUTE;

    expect(await harness.service.runInfrastructurePass()).toEqual([
      expect.objectContaining({ taskId: "drift", action: "resume" }),
    ]);
    expect(harness.host.pauseTask).not.toHaveBeenCalled();
  });

  it("leaves a parent alone while its sub-agents run", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set("parent", makeTask({ id: "parent" }));
    harness.host.events.set("parent", [makeEvent("parent", "tool_call", T0)]);
    harness.host.runtimes.set("parent", { hasExecutor: true, executorRunning: true });
    harness.host.tasks.set("child", makeTask({ id: "child", parentTaskId: "parent" }));
    harness.host.events.set("child", [makeEvent("child", "tool_result", T0 + 24 * MINUTE)]);
    harness.host.runtimes.set("child", { hasExecutor: true, executorRunning: true });
    harness.clock.now = T0 + 25 * MINUTE;

    expect(await harness.service.runInfrastructurePass()).toEqual([]);
  });

  it("skips tasks waiting on a person", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set("asks", makeTask({ id: "asks" }));
    harness.host.runtimes.set("asks", { waitingForUser: true });
    harness.clock.now = T0 + 90 * MINUTE;
    expect(await harness.service.runInfrastructurePass()).toEqual([]);
  });

  it("re-queues a stuck transient retry with backoff, then pauses after three attempts", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set(
      "retry",
      makeTask({
        id: "retry",
        status: "queued",
        error: "Transient provider error. Retry 2/3 in 30s.",
        updatedAt: T0,
      }),
    );
    harness.clock.now = T0 + 15 * MINUTE;
    expect(await harness.service.runInfrastructurePass()).toEqual([
      expect.objectContaining({ action: "requeue", attempt: 1 }),
    ]);

    // Backoff: 5 minutes after the first attempt, 10 after the second.
    harness.clock.now += 1 * MINUTE;
    expect(await harness.service.runInfrastructurePass()).toEqual([]);
    harness.clock.now += 5 * MINUTE;
    expect(await harness.service.runInfrastructurePass()).toEqual([
      expect.objectContaining({ action: "requeue", attempt: 2 }),
    ]);
    harness.clock.now += 10 * MINUTE;
    expect(await harness.service.runInfrastructurePass()).toEqual([
      expect.objectContaining({ action: "requeue", attempt: 3 }),
    ]);
    expect(harness.host.requeueTask).toHaveBeenCalledTimes(3);

    harness.clock.now += 20 * MINUTE;
    expect(await harness.service.runInfrastructurePass()).toEqual([
      expect.objectContaining({ action: "pause" }),
    ]);
    expect(harness.host.tasks.get("retry")?.status).toBe("paused");
  });

  it("pauses a task whose model provider keeps failing", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set("outage", makeTask({ id: "outage" }));
    harness.host.runtimes.set("outage", { hasExecutor: true, executorRunning: true });
    harness.host.events.set("outage", [
      makeEvent("outage", "assistant_message", T0 - MINUTE, { message: "Working on it" }),
      ...[0, 5, 10, 15, 20, 24].map((minute) =>
        makeEvent("outage", "llm_error", T0 + minute * MINUTE, {
          message: "LLM API error: 503 Service Unavailable",
        }),
      ),
    ]);
    harness.clock.now = T0 + 25 * MINUTE;

    const decisions = await harness.service.runInfrastructurePass();

    expect(decisions).toEqual([
      expect.objectContaining({
        action: "pause",
        reason: expect.stringContaining("model provider kept failing for 25 minutes"),
      }),
    ]);
  });

  it("retries a recent failure caused by a transient provider error, but not other failures", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set(
      "net",
      makeTask({ id: "net", status: "failed", error: "socket hang up", completedAt: T0 }),
    );
    harness.host.tasks.set(
      "bug",
      makeTask({ id: "bug", status: "failed", error: "File not found", completedAt: T0 }),
    );
    harness.service.noteTaskActivity("net", T0);
    harness.service.noteTaskActivity("bug", T0);
    harness.clock.now = T0 + 2 * MINUTE;

    const decisions = await harness.service.runInfrastructurePass();

    expect(harness.host.recoverTask).toHaveBeenCalledTimes(1);
    expect(harness.host.recoverTask).toHaveBeenCalledWith("net", expect.any(String), {
      allowFailed: true,
    });
    expect(decisions).toEqual([expect.objectContaining({ taskId: "net", action: "retry" })]);
  });

  it("resumes an interrupted task nobody picked up, but not during startup recovery", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set(
      "stuck",
      makeTask({ id: "stuck", status: "interrupted", updatedAt: T0 - 40 * MINUTE }),
    );
    harness.clock.now = T0 + MINUTE;
    expect(await harness.service.runInfrastructurePass()).toEqual([]);

    harness.clock.now = T0 + 5 * MINUTE;
    expect(await harness.service.runInfrastructurePass()).toEqual([
      expect.objectContaining({ taskId: "stuck", action: "resume" }),
    ]);
  });
});

describe("WatchdogService progress pass", () => {
  function seedLongRunningTask(harness: Harness, id = "long") {
    harness.host.tasks.set(id, makeTask({ id }));
    harness.host.runtimes.set(id, { hasExecutor: true, executorRunning: true });
    harness.host.events.set(id, [
      makeEvent(id, "task_created", T0),
      makeEvent(id, "tool_error", T0 + 10 * MINUTE, { tool: "run_command", error: "exit 1" }),
    ]);
  }

  it("does not judge a task before it ran for the threshold, nor sub-agents", async () => {
    const harness = createHarness();
    harness.service.start();
    seedLongRunningTask(harness);
    harness.host.tasks.set("child", makeTask({ id: "child", parentTaskId: "long" }));
    harness.host.runtimes.set("child", { executorRunning: true, hasExecutor: true });
    harness.host.events.set("child", [makeEvent("child", "task_created", T0 - 60 * MINUTE)]);
    harness.clock.now = T0 + 14 * MINUTE;

    expect(await harness.service.runProgressPass()).toEqual([]);
    expect(harness.judge).not.toHaveBeenCalled();
  });

  it("steers on the first drifting verdict and pauses with a notification on the second", async () => {
    const harness = createHarness();
    harness.service.start();
    seedLongRunningTask(harness);
    harness.judge.mockResolvedValue(judgement("drifting", "rerunning npm test"));
    harness.clock.now = T0 + 20 * MINUTE;

    const first = await harness.service.runProgressPass();
    expect(first).toEqual([
      expect.objectContaining({ action: "steer", verdict: "drifting", driftStrikes: 1 }),
    ]);
    expect(harness.host.sendSteeringMessage).toHaveBeenCalledWith(
      "long",
      expect.stringMatching(
        /^Watchdog: you appear to be looping on rerunning npm test; return to the original request: "Summarise the quarterly sales report"/,
      ),
      expect.stringMatching(/^watchdog:long:/),
    );

    // No new events: the task is not judged again.
    harness.clock.now += 5 * MINUTE;
    expect(await harness.service.runProgressPass()).toEqual([]);

    // The steering note itself is a runtime notice; it does not start a new run.
    harness.host.events.get("long")!.push(
      makeEvent("long", "user_message", harness.clock.now - MINUTE, {
        message: "Watchdog: ...",
        notificationKind: "watchdog",
      }),
      makeEvent("long", "tool_error", harness.clock.now, { tool: "run_command", error: "exit 1" }),
    );
    const second = await harness.service.runProgressPass();
    expect(second).toEqual([expect.objectContaining({ action: "pause", driftStrikes: 2 })]);
    expect(harness.host.tasks.get("long")?.status).toBe("paused");
    expect(harness.host.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Task paused by the watchdog" }),
    );
    expect(harness.host.cancelTask).not.toHaveBeenCalled();
  });

  it("logs a passing check and resets the strikes", async () => {
    const harness = createHarness();
    harness.service.start();
    seedLongRunningTask(harness);
    harness.judge.mockResolvedValueOnce(judgement("drifting", "the same search"));
    harness.clock.now = T0 + 20 * MINUTE;
    await harness.service.runProgressPass();

    harness.judge.mockResolvedValueOnce(judgement("progressing"));
    harness.host.events.get("long")!.push(makeEvent("long", "step_completed", harness.clock.now));
    harness.clock.now += 5 * MINUTE;
    const decisions = await harness.service.runProgressPass();
    expect(decisions).toEqual([
      expect.objectContaining({ action: "none", verdict: "progressing", driftStrikes: 0 }),
    ]);
    expect(harness.service.getStatus("long").task?.driftStrikes).toBe(0);
    expect(harness.host.logged.map((entry) => entry.decision.action)).toEqual(["steer", "none"]);
  });

  it("cancels a repeat offender only when the user allowed it", async () => {
    const harness = createHarness({ allowCancel: true });
    harness.service.start();
    seedLongRunningTask(harness);
    harness.judge.mockResolvedValue(judgement("drifting", "the same edit"));
    const events = harness.host.events.get("long")!;

    harness.clock.now = T0 + 20 * MINUTE;
    await harness.service.runProgressPass(); // steer
    events.push(makeEvent("long", "tool_error", harness.clock.now));
    harness.clock.now += 5 * MINUTE;
    await harness.service.runProgressPass(); // pause
    expect(harness.host.tasks.get("long")?.status).toBe("paused");

    // The person resumes it; a new run starts and drifts twice more.
    const task = harness.host.tasks.get("long")!;
    task.status = "executing";
    events.push(makeEvent("long", "task_resumed", harness.clock.now - 20 * MINUTE));
    events.push(makeEvent("long", "tool_error", harness.clock.now));
    harness.clock.now += 5 * MINUTE;
    expect(await harness.service.runProgressPass()).toEqual([
      expect.objectContaining({ action: "steer" }),
    ]);
    events.push(makeEvent("long", "tool_error", harness.clock.now));
    harness.clock.now += 5 * MINUTE;
    expect(await harness.service.runProgressPass()).toEqual([
      expect.objectContaining({ action: "cancel" }),
    ]);
    expect(harness.host.cancelTask).toHaveBeenCalledTimes(1);
  });

  it("judges at most three tasks per tick", async () => {
    const harness = createHarness();
    harness.service.start();
    for (const id of ["a", "b", "c", "d"]) seedLongRunningTask(harness, id);
    harness.clock.now = T0 + 20 * MINUTE;
    await harness.service.runProgressPass();
    expect(harness.judge).toHaveBeenCalledTimes(3);
  });
});

describe("WatchdogService sleep recovery", () => {
  it("reclaims leases, re-arms completions, credits the queue and runs the infrastructure pass", async () => {
    const harness = createHarness();
    harness.service.start();
    harness.host.tasks.set("run", makeTask({ id: "run" }));
    harness.host.runtimes.set("run", { hasExecutor: true, executorRunning: true });
    harness.host.events.set("run", [makeEvent("run", "tool_call", T0)]);
    harness.host.tasks.set(
      "int",
      makeTask({ id: "int", status: "interrupted", updatedAt: T0 - 10 * MINUTE }),
    );

    harness.clock.now = T0 + 3 * MINUTE;
    harness.service.noteSuspend();
    expect(harness.host.snapshotLeases).toHaveBeenCalledWith(["run"]);

    harness.clock.now = T0 + 63 * MINUTE;
    const decisions = await harness.service.handleResume({ source: "power_monitor" });

    expect(harness.host.creditSuspendedTime).toHaveBeenCalledWith(60 * MINUTE);
    expect(harness.host.reclaimLeases).toHaveBeenCalledWith([
      expect.objectContaining({ taskId: "run", operationKey: "op-run" }),
    ]);
    expect(harness.host.rearmBackgroundCompletions).toHaveBeenCalledTimes(1);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "run",
          action: "reclaim_leases",
          pass: "sleep_recovery",
          suspendedMs: 60 * MINUTE,
        }),
        expect.objectContaining({ taskId: "int", action: "resume", pass: "sleep_recovery" }),
      ]),
    );
    // The infrastructure pass ran too: the running task is silent for an hour, but its lease
    // was reclaimed, so in this fake it has no lease and gets paused.
    expect(decisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: "run", action: "pause" })]),
    );
  });

  it("still recovers leases and interrupted tasks when the watchdog is off", async () => {
    const harness = createHarness({ enabled: false });
    harness.service.start();
    harness.host.tasks.set(
      "int",
      makeTask({ id: "int", status: "interrupted", updatedAt: T0 - 10 * MINUTE }),
    );
    harness.host.runtimes.set("run", { hasExecutor: true, executorRunning: true });
    harness.clock.now = T0 + 5 * MINUTE;
    harness.service.refreshLeaseSnapshot();
    const decisions = await harness.service.handleResume({
      source: "wall_clock",
      suspendedAt: T0 + 5 * MINUTE,
      resumedAt: T0 + 30 * MINUTE,
    });
    expect(harness.host.creditSuspendedTime).toHaveBeenCalledWith(25 * MINUTE);
    expect(harness.host.reclaimLeases).toHaveBeenCalledTimes(1);
    expect(decisions.map((decision) => decision.action).sort()).toEqual([
      "reclaim_leases",
      "resume",
    ]);
  });
});

describe("watchdog helpers", () => {
  it("finds the run start, ignoring runtime notices", () => {
    const events = [
      makeEvent("t", "task_created", 100),
      makeEvent("t", "user_message", 200, { message: "also add charts" }),
      makeEvent("t", "user_message", 300, {
        message: "Watchdog: ...",
        notificationKind: "watchdog",
      }),
      makeEvent("t", "tool_call", 400),
    ];
    expect(findRunStart(events, 50)).toBe(200);
    expect(findRunStart([makeEvent("t", "tool_call", 400)], 50)).toBe(50);
  });

  it("counts trailing provider errors until the last success", () => {
    const events = [
      makeEvent("t", "llm_error", 100, { message: "old" }),
      makeEvent("t", "assistant_message", 200),
      makeEvent("t", "llm_retry", 300, { operation: "createMessage" }),
      makeEvent("t", "log", 350),
      makeEvent("t", "llm_error", 400, { message: "LLM API error: 529 overloaded" }),
    ];
    expect(trailingProviderErrors(events)).toEqual({
      count: 2,
      firstAt: 300,
      lastMessage: "LLM API error: 529 overloaded",
    });
  });
});
