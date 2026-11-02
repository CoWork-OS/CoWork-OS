import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../watchdog-settings", () => ({
  WatchdogSettingsManager: {
    loadEffectiveSettings: () => ({
      enabled: false,
      intervalMinutes: 5,
      stallMinutes: 20,
      progressCheckAfterMinutes: 15,
      allowCancel: false,
    }),
  },
}));

import type { Task, WatchdogDecision } from "../../../../shared/types";
import { getWatchdogService } from "../WatchdogService";
import {
  attachPowerMonitorSleepRecovery,
  attachWallClockSleepRecovery,
  createDaemonWatchdogHost,
  startAgentDaemonWatchdog,
  type WatchdogDaemon,
} from "../watchdog-runtime";

function fakeDaemon() {
  const emitter = new EventEmitter();
  const tasks = new Map<string, Task>([
    ["t1", { id: "t1", sessionId: "s1", status: "executing", workspaceId: "ws" } as Task],
    ["t2", { id: "t2", status: "executing", workspaceId: "ws" } as Task],
  ]);
  const leases = {
    listActive: vi.fn((sessionId: string) =>
      sessionId === "s1"
        ? [{ id: "l1", sessionId: "s1", turnId: "turn-1", kind: "tool", operationKey: "op-1" }]
        : [],
    ),
  };
  const reliability = { leases, reclaimAfterSuspend: vi.fn(() => 1) };
  const daemon = {
    listTasksForWatchdog: vi.fn(() => [...tasks.values()]),
    getTask: vi.fn((taskId: string) => tasks.get(taskId)),
    getTaskEvents: vi.fn(() => []),
    getWatchdogTaskRuntime: vi.fn((taskId: string) => ({
      hasExecutor: true,
      executorRunning: taskId === "t1",
      queued: false,
      retryPending: false,
      waitingForUser: false,
      autoResumable: true,
    })),
    getWorkSessionReliabilityService: vi.fn(() => reliability),
    logEvent: vi.fn(),
    sendMessage: vi.fn(async () => ({ queued: true, deliveryStatus: "queued" })),
    pauseTaskForWatchdog: vi.fn(async () => true),
    cancelTask: vi.fn(async () => undefined),
    recoverTaskForWatchdog: vi.fn(async () => true),
    requeueTaskForWatchdog: vi.fn(async () => true),
    listRunningTaskIdsForWatchdog: vi.fn(() => ["t1"]),
    rearmBackgroundProcessCompletions: vi.fn(() => 1),
    creditSuspendedTimeToQueue: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
      emitter.on(event, listener),
    ),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
      emitter.off(event, listener),
    ),
  };
  return { daemon: daemon as unknown as WatchdogDaemon & typeof daemon, emitter, reliability };
}

afterEach(() => {
  getWatchdogService()?.stop();
});

describe("createDaemonWatchdogHost", () => {
  it("sends steering notes as a watchdog runtime notice that keeps the conversation", async () => {
    const { daemon } = fakeDaemon();
    const host = createDaemonWatchdogHost(daemon);
    await expect(
      host.sendSteeringMessage("t1", "Watchdog: refocus", "watchdog:t1:1"),
    ).resolves.toBe(true);
    expect(daemon.sendMessage).toHaveBeenCalledWith(
      "t1",
      "Watchdog: refocus",
      undefined,
      undefined,
      {
        messageSource: "agent",
        senderLabel: "Watchdog",
        notificationKind: "watchdog",
        messageId: "watchdog:t1:1",
        deliveryMode: "follow_up",
        returnOnAccepted: true,
      },
    );
  });

  it("logs decisions as watchdog events and reads leases by session", () => {
    const { daemon } = fakeDaemon();
    const host = createDaemonWatchdogHost(daemon);
    const decision = {
      taskId: "t1",
      pass: "progress",
      action: "steer",
      reason: "looping",
      at: 1,
    } as WatchdogDecision;
    host.logDecision(decision, "Watchdog: refocus");
    expect(daemon.logEvent).toHaveBeenCalledWith("t1", "watchdog", {
      message: "Watchdog: refocus",
      watchdog: decision,
    });
    expect(host.hasActiveLease(daemon.getTask("t1")!)).toBe(true);
    expect(host.hasActiveLease(daemon.getTask("t2")!)).toBe(false);
  });

  it("snapshots leases of running work and reclaims only those still running", () => {
    const { daemon, reliability } = fakeDaemon();
    const host = createDaemonWatchdogHost(daemon);
    const snapshot = host.snapshotLeases(["t1", "t2"]);
    expect(snapshot).toEqual([
      { taskId: "t1", sessionId: "s1", turnId: "turn-1", kind: "tool", operationKey: "op-1" },
    ]);
    const reclaimed = host.reclaimLeases([
      ...snapshot,
      { taskId: "t2", sessionId: "s2", kind: "llm", operationKey: "op-2" },
    ]);
    expect(reliability.reclaimAfterSuspend).toHaveBeenCalledTimes(1);
    expect(reliability.reclaimAfterSuspend).toHaveBeenCalledWith(snapshot);
    expect([...reclaimed]).toEqual([["t1", 1]]);
  });
});

describe("startAgentDaemonWatchdog", () => {
  it("registers the process watchdog, remembers failures and detaches on stop", () => {
    const { daemon, emitter } = fakeDaemon();
    const started = startAgentDaemonWatchdog(daemon, { judge: vi.fn() });
    expect(getWatchdogService()).toBe(started.service);
    const noteSpy = vi.spyOn(started.service, "noteTaskActivity");
    emitter.emit("task_status", { taskId: "t1", status: "failed" });
    emitter.emit("task_status", { taskId: "t2", payload: { status: "failed" } });
    emitter.emit("task_status", { taskId: "t1", status: "completed" });
    expect(noteSpy.mock.calls.map((call) => call[0])).toEqual(["t1", "t2"]);

    started.stop();
    expect(getWatchdogService()).toBeNull();
    expect(emitter.listenerCount("task_status")).toBe(0);
  });
});

describe("sleep detectors", () => {
  it("feeds powerMonitor suspend and resume into the watchdog", async () => {
    const powerMonitor = new EventEmitter();
    const service = {
      noteSuspend: vi.fn(),
      handleResume: vi.fn(async () => []),
    };
    const clock = { now: 1_000 };
    const detach = attachPowerMonitorSleepRecovery(powerMonitor, service, () => clock.now);
    powerMonitor.emit("suspend");
    clock.now = 61_000;
    powerMonitor.emit("resume");
    expect(service.noteSuspend).toHaveBeenCalledWith(1_000);
    expect(service.handleResume).toHaveBeenCalledWith({
      source: "power_monitor",
      suspendedAt: 1_000,
      resumedAt: 61_000,
    });
    detach();
    expect(powerMonitor.listenerCount("suspend")).toBe(0);
    expect(powerMonitor.listenerCount("resume")).toBe(0);
  });

  it("uses a wall-clock jump on the headless daemon", () => {
    const service = {
      refreshLeaseSnapshot: vi.fn(),
      handleResume: vi.fn(async () => []),
    };
    const clock = { now: 0 };
    let tick: (() => void) | undefined;
    const detach = attachWallClockSleepRecovery(service, {
      now: () => clock.now,
      tickMs: 30_000,
      setInterval: (handler) => {
        tick = handler;
        return { unref: vi.fn() } as unknown as NodeJS.Timeout;
      },
      clearInterval: vi.fn(),
    });
    clock.now = 30_000;
    tick?.();
    expect(service.refreshLeaseSnapshot).toHaveBeenCalledTimes(1);
    clock.now = 30_000 + 30_000 + 10 * 60_000;
    tick?.();
    expect(service.handleResume).toHaveBeenCalledWith({
      source: "wall_clock",
      suspendedAt: 30_000,
      resumedAt: clock.now,
    });
    detach();
  });
});
