/**
 * Wiring of the watchdog into a running AgentDaemon, shared by the Electron main process and the
 * headless daemon, plus the two sleep detectors: Electron's powerMonitor and, where that does
 * not exist, a wall-clock jump detector.
 */
import type { AgentDaemon } from "../daemon";
import type { Task } from "../../../shared/types";
import { createLogger } from "../../utils/logger";
import { getWatchdogService, setWatchdogService, WatchdogService } from "./WatchdogService";
import type { ProgressJudge } from "./watchdog-progress-judge";
import type {
  WatchdogHost,
  WatchdogLeaseSnapshotEntry,
  WatchdogNotification,
} from "./watchdog-types";
import {
  WallClockJumpDetector,
  type WallClockJumpDetectorOptions,
} from "./wall-clock-jump-detector";

const logger = createLogger("Watchdog");

/** The AgentDaemon methods the watchdog uses; a narrow surface keeps the coupling visible. */
export type WatchdogDaemon = Pick<
  AgentDaemon,
  | "listTasksForWatchdog"
  | "getTask"
  | "getTaskEvents"
  | "getWatchdogTaskRuntime"
  | "getWorkSessionReliabilityService"
  | "logEvent"
  | "sendMessage"
  | "pauseTaskForWatchdog"
  | "cancelTask"
  | "recoverTaskForWatchdog"
  | "requeueTaskForWatchdog"
  | "listRunningTaskIdsForWatchdog"
  | "rearmBackgroundProcessCompletions"
  | "creditSuspendedTimeToQueue"
  | "on"
  | "off"
>;

export interface DaemonWatchdogHostOptions {
  notify?: (notification: WatchdogNotification) => void | Promise<void>;
}

export function createDaemonWatchdogHost(
  daemon: WatchdogDaemon,
  options: DaemonWatchdogHostOptions = {},
): WatchdogHost {
  const leases = () => daemon.getWorkSessionReliabilityService().leases;
  return {
    listTasks: (statuses) => daemon.listTasksForWatchdog(statuses),
    getTask: (taskId) => daemon.getTask(taskId),
    getRecentEvents: (taskId, limit) => daemon.getTaskEvents(taskId, { limit }),
    getRuntime: (taskId) => daemon.getWatchdogTaskRuntime(taskId),
    hasActiveLease: (task: Task) =>
      Boolean(task.sessionId) && leases().listActive(task.sessionId).length > 0,
    logDecision: (decision, message) =>
      daemon.logEvent(decision.taskId, "watchdog", { message, watchdog: decision }),
    sendSteeringMessage: async (taskId, message, messageId) => {
      const result = await daemon.sendMessage(taskId, message, undefined, undefined, {
        messageSource: "agent",
        senderLabel: "Watchdog",
        notificationKind: "watchdog",
        messageId,
        deliveryMode: "follow_up",
        returnOnAccepted: true,
      });
      return result.deliveryStatus !== "failed" && result.deliveryStatus !== "quarantined";
    },
    pauseTask: (taskId, message) => daemon.pauseTaskForWatchdog(taskId, message),
    cancelTask: async (taskId) => {
      await daemon.cancelTask(taskId);
      return true;
    },
    recoverTask: (taskId, reason, recoverOptions) =>
      daemon.recoverTaskForWatchdog(taskId, reason, recoverOptions),
    requeueTask: (taskId, reason) => daemon.requeueTaskForWatchdog(taskId, reason),
    ...(options.notify ? { notify: options.notify } : {}),
    listRunningTaskIds: () => daemon.listRunningTaskIdsForWatchdog(),
    snapshotLeases: (taskIds) => {
      const entries: WatchdogLeaseSnapshotEntry[] = [];
      for (const taskId of taskIds) {
        const sessionId = daemon.getTask(taskId)?.sessionId;
        if (!sessionId) continue;
        for (const lease of leases().listActive(sessionId)) {
          entries.push({
            taskId,
            sessionId,
            ...(lease.turnId ? { turnId: lease.turnId } : {}),
            kind: lease.kind,
            operationKey: lease.operationKey,
          });
        }
      }
      return entries;
    },
    reclaimLeases: (entries) => {
      const byTask = new Map<string, WatchdogLeaseSnapshotEntry[]>();
      for (const entry of entries) {
        // Only work still running here gets its lease back.
        if (!daemon.getWatchdogTaskRuntime(entry.taskId).executorRunning) continue;
        const group = byTask.get(entry.taskId) ?? [];
        group.push(entry);
        byTask.set(entry.taskId, group);
      }
      const reclaimed = new Map<string, number>();
      const reliability = daemon.getWorkSessionReliabilityService();
      for (const [taskId, group] of byTask) {
        reclaimed.set(taskId, reliability.reclaimAfterSuspend(group));
      }
      return reclaimed;
    },
    rearmBackgroundCompletions: () => daemon.rearmBackgroundProcessCompletions(),
    creditSuspendedTime: (ms) => daemon.creditSuspendedTimeToQueue(ms),
  };
}

export interface StartedWatchdog {
  service: WatchdogService;
  stop(): void;
}

export interface StartAgentDaemonWatchdogOptions extends DaemonWatchdogHostOptions {
  judge?: ProgressJudge;
}

/** Start the watchdog for this process's daemon and make it the process-wide instance. */
export function startAgentDaemonWatchdog(
  daemon: WatchdogDaemon,
  options: StartAgentDaemonWatchdogOptions = {},
): StartedWatchdog {
  const service = new WatchdogService({
    host: createDaemonWatchdogHost(daemon, options),
    ...(options.judge ? { judge: options.judge } : {}),
  });
  // Failures are remembered so one caused by a transient provider error can be retried.
  const onTaskStatus = (event: {
    taskId?: string;
    status?: unknown;
    payload?: { status?: unknown };
  }) => {
    const status = event?.status ?? event?.payload?.status;
    if (status === "failed" && typeof event.taskId === "string")
      service.noteTaskActivity(event.taskId);
  };
  daemon.on("task_status", onTaskStatus);
  service.start();
  setWatchdogService(service);
  return {
    service,
    stop: () => {
      daemon.off("task_status", onTaskStatus);
      service.stop();
      if (getWatchdogService() === service) setWatchdogService(null);
    },
  };
}

/** The part of Electron's powerMonitor sleep recovery needs. */
export interface PowerMonitorLike {
  on(event: "suspend" | "resume", listener: () => void): unknown;
  removeListener(event: "suspend" | "resume", listener: () => void): unknown;
}

/** Desktop: powerMonitor tells us when the machine sleeps and wakes. */
export function attachPowerMonitorSleepRecovery(
  powerMonitor: PowerMonitorLike,
  service: Pick<WatchdogService, "noteSuspend" | "handleResume">,
  now: () => number = Date.now,
): () => void {
  let suspendedAt: number | undefined;
  const onSuspend = () => {
    suspendedAt = now();
    service.noteSuspend(suspendedAt);
  };
  const onResume = () => {
    const info = {
      source: "power_monitor" as const,
      resumedAt: now(),
      ...(suspendedAt !== undefined ? { suspendedAt } : {}),
    };
    suspendedAt = undefined;
    void service
      .handleResume(info)
      .catch((error) => logger.warn("Sleep recovery after resume failed:", error));
  };
  powerMonitor.on("suspend", onSuspend);
  powerMonitor.on("resume", onResume);
  return () => {
    powerMonitor.removeListener("suspend", onSuspend);
    powerMonitor.removeListener("resume", onResume);
  };
}

/** Headless daemon: no powerMonitor, so a jump of the wall clock between timer ticks says it slept. */
export function attachWallClockSleepRecovery(
  service: Pick<WatchdogService, "refreshLeaseSnapshot" | "handleResume">,
  options: Omit<WallClockJumpDetectorOptions, "onJump" | "onTick"> = {},
): () => void {
  const detector = new WallClockJumpDetector({
    ...options,
    onTick: () => service.refreshLeaseSnapshot(),
    onJump: (jump) => {
      logger.info(
        `Wall clock jumped ${Math.round(jump.driftMs / 1000)} s past the timer; treating it as a resume from sleep`,
      );
      void service
        .handleResume({
          source: "wall_clock",
          suspendedAt: jump.suspendedAt,
          resumedAt: jump.resumedAt,
        })
        .catch((error) => logger.warn("Sleep recovery after a clock jump failed:", error));
    },
  });
  detector.start();
  return () => detector.stop();
}
