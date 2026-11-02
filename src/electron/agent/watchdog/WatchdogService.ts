/**
 * Watchdog: an independent control loop outside the agent loop, driven by its own schedule.
 *
 * Each tick runs two passes over the tasks this process runs:
 * - infrastructure (deterministic): tasks that stopped emitting events with no live activity
 *   lease, tasks stuck in transient retry, provider outages, failed resumes and recent failures
 *   from transient provider errors. It applies the existing recovery paths (resume from the
 *   saved state, re-queue, or pause with a clear reason) and retries with backoff.
 * - progress (model-judged): tasks running longer than a threshold are summarised and the
 *   cheapest configured model says whether they progress toward the original request or drift.
 *   The first "drifting" verdict sends a steering note; the second consecutive one pauses the
 *   task with a notification. It cancels only when the user allowed that.
 *
 * Sleep recovery (`noteSuspend` / `handleResume`) reclaims activity leases that expired while the
 * host slept, re-arms background-process completion delivery, credits the slept time to the
 * queue timeout, resumes interrupted tasks and runs the infrastructure pass at once.
 *
 * Every decision is written to the task event log as a "watchdog" event; `watchdog_status`
 * reads them back.
 */
import type {
  Task,
  TaskEvent,
  TaskStatus,
  WatchdogAction,
  WatchdogDecision,
  WatchdogPass,
  WatchdogSettings,
} from "../../../shared/types";
import { DEFAULT_WATCHDOG_SETTINGS } from "../../../shared/types";
import { classifyProviderError } from "../llm/provider-error-classifier";
import { createLogger } from "../../utils/logger";
import {
  createModelProgressJudge,
  effectiveEventType,
  originalRequestOf,
  type ProgressJudge,
} from "./watchdog-progress-judge";
import { WatchdogSettingsManager } from "./watchdog-settings";
import type { WatchdogHost, WatchdogLeaseSnapshotEntry } from "./watchdog-types";

const logger = createLogger("Watchdog");

/** Mirrors AgentDaemon's transient-retry marker on `task.error`. */
const TRANSIENT_RETRY_ERROR_REGEX = /^Transient provider error\.\s*Retry\s+\d+\/\d+\s+in\s+\d+s\./i;
/** Events read per task for the infrastructure checks and to find where the run started. */
const RECENT_EVENT_LIMIT = 200;
/** Events handed to the progress judge (it summarises the most recent ones). */
const JUDGE_EVENT_LIMIT = 60;
/** Model calls per tick, so a busy machine does not pay for many judgements at once. */
const MAX_JUDGED_PER_TICK = 3;
export const WATCHDOG_MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_BACKOFF_BASE_MS = 5 * 60_000;
const RECOVERY_BACKOFF_MAX_MS = 60 * 60_000;
/** Recovery attempts older than this no longer count toward the limit. */
const RECOVERY_MEMORY_MS = 6 * 60 * 60_000;
/** A task left in transient-retry state this long without a retry timer is stuck. */
const TRANSIENT_RETRY_WINDOW_MS = 10 * 60_000;
/** Failures from transient provider errors are retried only this soon after they happened. */
const FAILURE_RETRY_WINDOW_MS = 2 * 60 * 60_000;
/** Consecutive provider errors that, spanning a stall window, count as an outage. */
const PROVIDER_ERROR_RUN_LIMIT = 5;
/** A held lease cannot hide silence longer than this many stall windows. */
const LEASE_SILENCE_FACTOR = 6;
/** An interrupted task this quiet is not in the middle of being resumed. */
const INTERRUPTED_SETTLE_MS = 60_000;
/** Startup recovery owns interrupted tasks for this long after the watchdog starts. */
const STARTUP_GRACE_MS = 2 * 60_000;

const PROVIDER_ERROR_EVENT_TYPES = new Set(["llm_error", "llm_retry"]);
/** Events that show the model or a tool answered: they end a run of provider errors. */
const PROVIDER_SUCCESS_EVENT_TYPES = new Set([
  "assistant_message",
  "llm_usage",
  "tool_result",
  "step_completed",
  "task_completed",
]);

export interface WatchdogTaskState {
  /** Start of the run the counters below belong to. */
  runStartedAt?: number;
  driftStrikes: number;
  driftPauses: number;
  /** Timestamp of the newest event the judge saw, so an unchanged task is not judged twice. */
  lastJudgedEventAt?: number;
  lastJudgedAt?: number;
  recoveryAttempts: number;
  lastRecoveryAt?: number;
  lastDecision?: WatchdogDecision;
}

export interface WatchdogStatusSnapshot {
  enabled: boolean;
  intervalMinutes: number;
  lastTickAt?: number;
  lastResumeAt?: number;
  task?: WatchdogTaskState;
}

export interface WatchdogServiceOptions {
  host: WatchdogHost;
  judge?: ProgressJudge;
  loadSettings?: () => WatchdogSettings;
  now?: () => number;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  /** Whether a stored task error came from a provider failure worth repeating. */
  isRetryableError?: (message: string) => boolean;
}

export interface WatchdogResumeInfo {
  source: "power_monitor" | "wall_clock";
  /** When the host went to sleep, if known; defaults to the last `noteSuspend`. */
  suspendedAt?: number;
  resumedAt?: number;
}

function payloadOf(event: TaskEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function truncate(value: string, max: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function defaultIsRetryableError(message: string): boolean {
  if (!message.trim()) return false;
  try {
    return classifyProviderError(message).retryable;
  } catch {
    return false;
  }
}

/**
 * Where the current run began: the newest turn start (the task's creation, a resume, or a
 * message from the person). Runtime notices such as the watchdog's own nudges do not start a run.
 */
export function findRunStart(events: TaskEvent[], fallback: number): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const type = effectiveEventType(event);
    if (type === "task_created" || type === "task_resumed") return event.timestamp;
    if (type === "user_message") {
      const payload = payloadOf(event);
      if (payload.notificationKind === undefined) return event.timestamp;
    }
  }
  return events.length > 0 ? Math.min(events[0].timestamp, fallback) : fallback;
}

/** Consecutive provider errors at the end of the event list, and when that run began. */
export function trailingProviderErrors(events: TaskEvent[]): {
  count: number;
  firstAt?: number;
  lastMessage?: string;
} {
  let count = 0;
  let firstAt: number | undefined;
  let lastMessage: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const type = effectiveEventType(event);
    if (PROVIDER_SUCCESS_EVENT_TYPES.has(type)) break;
    if (!PROVIDER_ERROR_EVENT_TYPES.has(type)) continue;
    count += 1;
    firstAt = event.timestamp;
    if (lastMessage === undefined) {
      const payload = payloadOf(event);
      const message = payload.message ?? payload.error ?? payload.operation;
      if (typeof message === "string") lastMessage = truncate(message, 200);
    }
  }
  return {
    count,
    ...(firstAt !== undefined ? { firstAt } : {}),
    ...(lastMessage ? { lastMessage } : {}),
  };
}

export class WatchdogService {
  private readonly host: WatchdogHost;
  private readonly judge: ProgressJudge;
  private readonly loadSettings: () => WatchdogSettings;
  private readonly now: () => number;
  private readonly isRetryableError: (message: string) => boolean;
  private settings: WatchdogSettings = { ...DEFAULT_WATCHDOG_SETTINGS };
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<unknown> = Promise.resolve();
  private started = false;
  private startedAt = 0;
  private lastTickAt?: number;
  private lastResumeAt?: number;
  private suspendedAt?: number;
  private leaseSnapshot: WatchdogLeaseSnapshotEntry[] = [];
  private readonly taskStates = new Map<string, WatchdogTaskState>();
  /** Tasks seen running recently, so a later failure from a transient error can be retried. */
  private readonly recentlyActive = new Map<string, number>();

  constructor(private readonly options: WatchdogServiceOptions) {
    this.host = options.host;
    this.judge = options.judge ?? createModelProgressJudge();
    this.loadSettings =
      options.loadSettings ?? (() => WatchdogSettingsManager.loadEffectiveSettings());
    this.now = options.now ?? Date.now;
    this.isRetryableError = options.isRetryableError ?? defaultIsRetryableError;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = this.now();
    try {
      this.settings = this.loadSettings();
    } catch (error) {
      logger.warn("Could not read watchdog settings; staying off:", error);
      this.settings = { ...DEFAULT_WATCHDOG_SETTINGS };
    }
    this.schedule();
    logger.info(
      this.settings.enabled
        ? `Watchdog on: every ${this.settings.intervalMinutes} min`
        : "Watchdog off (enable it in Settings > Automations > Queue)",
    );
  }

  stop(): void {
    this.started = false;
    this.unschedule();
  }

  getSettings(): WatchdogSettings {
    return { ...this.settings };
  }

  /** Apply saved settings: turn the schedule on or off and change its cadence. */
  applySettings(settings: WatchdogSettings): void {
    this.settings = { ...settings };
    if (this.started) this.schedule();
  }

  getStatus(taskId?: string): WatchdogStatusSnapshot {
    const task = taskId ? this.taskStates.get(taskId) : undefined;
    return {
      enabled: this.settings.enabled,
      intervalMinutes: this.settings.intervalMinutes,
      ...(this.lastTickAt !== undefined ? { lastTickAt: this.lastTickAt } : {}),
      ...(this.lastResumeAt !== undefined ? { lastResumeAt: this.lastResumeAt } : {}),
      ...(task ? { task: { ...task } } : {}),
    };
  }

  /** One scheduled tick: both passes. Ticks never overlap. */
  runTick(): Promise<WatchdogDecision[]> {
    return this.exclusive(async () => {
      if (!this.settings.enabled) return [];
      this.lastTickAt = this.now();
      const infrastructure = await this.infrastructurePass("infrastructure");
      const progress = await this.progressPass();
      return [...infrastructure, ...progress];
    });
  }

  /** The deterministic pass on its own (also run right after a resume from sleep). */
  runInfrastructurePass(): Promise<WatchdogDecision[]> {
    return this.exclusive(() => this.infrastructurePass("infrastructure"));
  }

  runProgressPass(): Promise<WatchdogDecision[]> {
    return this.exclusive(() => this.progressPass());
  }

  /** The host is about to sleep: remember the time and the leases of running work. */
  noteSuspend(at = this.now()): void {
    this.suspendedAt = at;
    this.refreshLeaseSnapshot();
  }

  /**
   * A task changed state (it failed, for example). It is checked on the next pass, so a failure
   * from a transient provider error can be retried.
   */
  noteTaskActivity(taskId: string, at = this.now()): void {
    if (taskId) this.recentlyActive.set(taskId, at);
  }

  /** Keep the lease snapshot current (the headless daemon cannot see a suspend coming). */
  refreshLeaseSnapshot(): void {
    try {
      const running = this.host.listRunningTaskIds();
      const now = this.now();
      for (const taskId of running) this.recentlyActive.set(taskId, now);
      this.leaseSnapshot = running.length > 0 ? this.host.snapshotLeases(running) : [];
    } catch (error) {
      logger.debug("Could not snapshot activity leases:", error);
    }
  }

  /**
   * The host woke up. Lease reclaim, background completions, the queue-timeout credit and
   * interrupted-task resume always run; the infrastructure pass runs when the watchdog is on.
   */
  handleResume(info: WatchdogResumeInfo): Promise<WatchdogDecision[]> {
    return this.exclusive(async () => {
      const resumedAt = info.resumedAt ?? this.now();
      const suspendedAt = info.suspendedAt ?? this.suspendedAt;
      const suspendedMs =
        suspendedAt !== undefined && resumedAt > suspendedAt ? resumedAt - suspendedAt : undefined;
      this.lastResumeAt = resumedAt;
      this.suspendedAt = undefined;
      logger.info(
        `Host resumed (${info.source})${suspendedMs ? ` after ${Math.round(suspendedMs / 1000)} s` : ""}`,
      );
      const decisions: WatchdogDecision[] = [];

      if (suspendedMs) {
        try {
          this.host.creditSuspendedTime(suspendedMs);
        } catch (error) {
          logger.warn("Could not credit suspended time to the queue:", error);
        }
      }

      const snapshot = this.leaseSnapshot;
      this.leaseSnapshot = [];
      if (snapshot.length > 0) {
        try {
          const reclaimed = this.host.reclaimLeases(snapshot);
          for (const [taskId, count] of reclaimed) {
            if (count <= 0) continue;
            decisions.push(
              this.record(
                {
                  taskId,
                  pass: "sleep_recovery",
                  action: "reclaim_leases",
                  reason: `Reclaimed ${count} activity lease(s) that expired while the computer slept.`,
                  ...(suspendedMs ? { suspendedMs } : {}),
                },
                "Watchdog: renewed this task's activity leases after the computer woke up.",
              ),
            );
          }
        } catch (error) {
          logger.warn("Could not reclaim activity leases after resume:", error);
        }
      }

      try {
        this.host.rearmBackgroundCompletions();
      } catch (error) {
        logger.warn("Could not re-arm background process completions:", error);
      }

      decisions.push(...(await this.resumeInterruptedTasks(suspendedMs)));
      if (this.settings.enabled) {
        decisions.push(...(await this.infrastructurePass("sleep_recovery", suspendedMs)));
      }
      return decisions;
    });
  }

  // ---------------------------------------------------------------------------------------
  // Infrastructure pass

  private async infrastructurePass(
    pass: WatchdogPass,
    suspendedMs?: number,
  ): Promise<WatchdogDecision[]> {
    const now = this.now();
    const decisions: WatchdogDecision[] = [];
    const stallMs = this.settings.stallMinutes * 60_000;
    const extra = suspendedMs ? { suspendedMs } : {};

    const running = this.safeList(["executing", "planning"]);
    // A parent waiting on sub-agents is quiet by design; the sub-agents are watched themselves.
    const parentsOfRunning = new Set(
      running.map((task) => task.parentTaskId).filter((id): id is string => Boolean(id)),
    );
    for (const task of running) {
      this.recentlyActive.set(task.id, now);
      const runtime = this.host.getRuntime(task.id);
      if (runtime.waitingForUser || runtime.queued || runtime.retryPending) continue;
      if (parentsOfRunning.has(task.id)) continue;
      const events = this.safeEvents(task.id, RECENT_EVENT_LIMIT);

      // Status drift: queued for a transient retry but persisted as executing, with no timer.
      if (TRANSIENT_RETRY_ERROR_REGEX.test(String(task.error || "").trim())) {
        if (!runtime.executorRunning && now - (task.updatedAt || 0) >= TRANSIENT_RETRY_WINDOW_MS) {
          const decision = await this.requeue(task, pass, now, extra);
          if (decision) decisions.push(decision);
        }
        continue;
      }

      const lastEventAt = events.length > 0 ? events[events.length - 1].timestamp : task.updatedAt;
      const idleMs = now - Math.max(lastEventAt || 0, 0);

      if (runtime.executorRunning) {
        const providerErrors = trailingProviderErrors(events);
        if (
          providerErrors.count >= PROVIDER_ERROR_RUN_LIMIT &&
          providerErrors.firstAt !== undefined &&
          now - providerErrors.firstAt >= stallMs
        ) {
          const minutes = Math.round((now - providerErrors.firstAt) / 60_000);
          const decision = await this.pause(
            task,
            pass,
            `The model provider kept failing for ${minutes} minutes (${providerErrors.count} errors in a row${providerErrors.lastMessage ? `; last: ${providerErrors.lastMessage}` : ""}).`,
            "Watchdog paused this task because the model provider kept failing. Resume it when the provider is reachable again.",
            extra,
          );
          if (decision) decisions.push(decision);
          continue;
        }
      }

      if (idleMs < stallMs) continue;
      const leaseHeld = this.safeHasLease(task);
      if (leaseHeld && idleMs < stallMs * LEASE_SILENCE_FACTOR) continue;
      const idleMinutes = Math.round(idleMs / 60_000);
      const silence = leaseHeld
        ? `No events for ${idleMinutes} minutes although an activity lease is still held.`
        : `No events for ${idleMinutes} minutes and no live activity lease.`;

      if (runtime.executorRunning) {
        // A running executor went quiet. The watchdog never tears a running executor down: it
        // pauses with a reason so the person can decide.
        const decision = await this.pause(
          task,
          pass,
          `${silence} The task's executor stopped reporting progress.`,
          `Watchdog paused this task: it reported nothing for ${idleMinutes} minutes. Resume it to continue.`,
          extra,
        );
        if (decision) decisions.push(decision);
        continue;
      }

      // Running in the database, but nothing runs it in this process (no executor, or an idle
      // one): resume from saved state, as a restart would.
      const decision = await this.recover(
        task,
        pass,
        `${silence} Nothing runs it in this process; resuming from its saved state.`,
        "resume",
        extra,
      );
      if (decision) decisions.push(decision);
    }

    for (const task of this.safeList(["queued"])) {
      this.recentlyActive.set(task.id, now);
      if (!TRANSIENT_RETRY_ERROR_REGEX.test(String(task.error || "").trim())) continue;
      const runtime = this.host.getRuntime(task.id);
      if (runtime.queued || runtime.retryPending || runtime.executorRunning) continue;
      if (now - (task.updatedAt || 0) < TRANSIENT_RETRY_WINDOW_MS) continue;
      const decision = await this.requeue(task, pass, now, extra);
      if (decision) decisions.push(decision);
    }

    // Failed resumes: interrupted tasks nobody picked up.
    if (now - this.startedAt >= STARTUP_GRACE_MS) {
      for (const task of this.safeList(["interrupted"])) {
        this.recentlyActive.set(task.id, now);
        const runtime = this.host.getRuntime(task.id);
        if (runtime.hasExecutor || runtime.queued || runtime.retryPending) continue;
        if (!runtime.autoResumable) continue;
        const events = this.safeEvents(task.id, 1);
        const lastAt = Math.max(task.updatedAt || 0, events[0]?.timestamp || 0);
        if (now - lastAt < stallMs) continue;
        const decision = await this.recover(
          task,
          pass,
          `Interrupted for ${Math.round((now - lastAt) / 60_000)} minutes without resuming.`,
          "resume",
          extra,
        );
        if (decision) decisions.push(decision);
      }
    }

    // Recent failures from transient provider errors (a network drop during sleep, an outage).
    // Deleting the current entry while iterating a Map is safe.
    for (const [taskId, seenAt] of this.recentlyActive) {
      if (now - seenAt > FAILURE_RETRY_WINDOW_MS) {
        this.recentlyActive.delete(taskId);
        continue;
      }
      const task = this.safeGet(taskId);
      if (!task || task.status !== "failed") continue;
      const failedAt = task.completedAt || task.updatedAt || seenAt;
      if (now - failedAt > FAILURE_RETRY_WINDOW_MS) continue;
      const error = String(task.error || "");
      if (!this.isRetryableError(error)) continue;
      const runtime = this.host.getRuntime(taskId);
      if (!runtime.autoResumable || runtime.executorRunning || runtime.queued) continue;
      const decision = await this.recover(
        task,
        pass,
        `Failed from a transient provider error (${truncate(error, 160)}); retrying from its saved state.`,
        "retry",
        extra,
        { allowFailed: true, quietWhenExhausted: true },
      );
      if (decision) decisions.push(decision);
    }

    return decisions;
  }

  /** Recovery through the restart path, with attempt limits and exponential backoff. */
  private async recover(
    task: Task,
    pass: WatchdogPass,
    reason: string,
    action: Extract<WatchdogAction, "resume" | "retry">,
    extra: Partial<WatchdogDecision>,
    options: { allowFailed?: boolean; quietWhenExhausted?: boolean } = {},
  ): Promise<WatchdogDecision | null> {
    const now = this.now();
    const state = this.stateFor(task.id);
    this.expireRecoveryMemory(state, now);
    if (state.recoveryAttempts >= WATCHDOG_MAX_RECOVERY_ATTEMPTS) {
      if (options.quietWhenExhausted) return null;
      return this.pause(
        task,
        pass,
        `${reason} Automatic recovery already ran ${state.recoveryAttempts} times without success.`,
        `Watchdog paused this task after ${state.recoveryAttempts} automatic recovery attempts. Resume it to try again.`,
        extra,
      );
    }
    if (!this.backoffElapsed(state, now)) return null;
    const runtime = this.host.getRuntime(task.id);
    if (!runtime.autoResumable && !options.allowFailed) {
      return this.pause(
        task,
        pass,
        `${reason} This kind of task does not resume automatically.`,
        "Watchdog paused this task because nothing was running it. Resume it to continue.",
        extra,
      );
    }
    state.recoveryAttempts += 1;
    state.lastRecoveryAt = now;
    const attempt = state.recoveryAttempts;
    let recovered = false;
    try {
      recovered = await this.host.recoverTask(
        task.id,
        reason,
        options.allowFailed ? { allowFailed: true } : {},
      );
    } catch (error) {
      logger.warn(`Recovery of task ${task.id} failed:`, error);
    }
    return this.record(
      {
        taskId: task.id,
        pass,
        action: recovered ? action : "none",
        reason: recovered ? reason : `${reason} The recovery did not start; will try again later.`,
        attempt,
        ...extra,
      },
      recovered
        ? `Watchdog ${action === "retry" ? "retried" : "resumed"} this task (attempt ${attempt} of ${WATCHDOG_MAX_RECOVERY_ATTEMPTS}).`
        : `Watchdog could not recover this task yet (attempt ${attempt}).`,
    );
  }

  private async requeue(
    task: Task,
    pass: WatchdogPass,
    now: number,
    extra: Partial<WatchdogDecision>,
  ): Promise<WatchdogDecision | null> {
    const state = this.stateFor(task.id);
    this.expireRecoveryMemory(state, now);
    if (state.recoveryAttempts >= WATCHDOG_MAX_RECOVERY_ATTEMPTS) {
      return this.pause(
        task,
        pass,
        `Stuck in transient retry; re-queued ${state.recoveryAttempts} times without success.`,
        "Watchdog paused this task: the model provider kept failing. Resume it when the provider is reachable again.",
        extra,
      );
    }
    if (!this.backoffElapsed(state, now)) return null;
    state.recoveryAttempts += 1;
    state.lastRecoveryAt = now;
    const reason =
      "Stuck in transient retry with no retry scheduled; putting it back in the queue.";
    let requeued = false;
    try {
      requeued = await this.host.requeueTask(task.id, reason);
    } catch (error) {
      logger.warn(`Re-queue of task ${task.id} failed:`, error);
    }
    return this.record(
      {
        taskId: task.id,
        pass,
        action: requeued ? "requeue" : "none",
        reason: requeued ? reason : `${reason} The re-queue did not happen; will try again later.`,
        attempt: state.recoveryAttempts,
        ...extra,
      },
      requeued
        ? `Watchdog re-queued this task after a stuck transient retry (attempt ${state.recoveryAttempts}).`
        : "Watchdog could not re-queue this task yet.",
    );
  }

  private async pause(
    task: Task,
    pass: WatchdogPass,
    reason: string,
    message: string,
    extra: Partial<WatchdogDecision> = {},
  ): Promise<WatchdogDecision | null> {
    let paused = false;
    try {
      paused = await this.host.pauseTask(task.id, message);
    } catch (error) {
      logger.warn(`Pausing task ${task.id} failed:`, error);
    }
    if (!paused) return null;
    const decision = this.record(
      { taskId: task.id, pass, action: "pause", reason, ...extra },
      message,
    );
    this.notify(task, "Task paused by the watchdog", message);
    return decision;
  }

  // ---------------------------------------------------------------------------------------
  // Progress pass

  private async progressPass(): Promise<WatchdogDecision[]> {
    const now = this.now();
    const thresholdMs = this.settings.progressCheckAfterMinutes * 60_000;
    const decisions: WatchdogDecision[] = [];
    let judged = 0;

    for (const task of this.safeList(["executing"])) {
      if (judged >= MAX_JUDGED_PER_TICK) break;
      // Sub-agents report to a parent that is judged on its own.
      if (task.parentTaskId) continue;
      const runtime = this.host.getRuntime(task.id);
      if (!runtime.executorRunning || runtime.waitingForUser) continue;
      const events = this.safeEvents(task.id, RECENT_EVENT_LIMIT);
      if (events.length === 0) continue;
      const runStartedAt = findRunStart(events, task.createdAt || now);
      const state = this.stateFor(task.id);
      if (state.runStartedAt !== runStartedAt) {
        // A new run (a new message or a resume): earlier strikes belonged to the last one.
        state.runStartedAt = runStartedAt;
        state.driftStrikes = 0;
        state.lastJudgedEventAt = undefined;
      }
      if (now - runStartedAt < thresholdMs) continue;
      const newestEventAt = events[events.length - 1].timestamp;
      if (state.lastJudgedEventAt === newestEventAt) continue;

      judged += 1;
      const runEvents = events.filter((event) => event.timestamp >= runStartedAt);
      let judgement;
      try {
        judgement = await this.judge({
          task,
          events: (runEvents.length > 0 ? runEvents : events).slice(-JUDGE_EVENT_LIMIT),
          runningForMs: now - runStartedAt,
          driftStrikes: state.driftStrikes,
        });
      } catch (error) {
        logger.warn(`Progress judge failed for task ${task.id}:`, error);
        continue;
      }
      state.lastJudgedEventAt = newestEventAt;
      state.lastJudgedAt = now;
      const signals = {
        progressScore: Number(judgement.assessment.progressScore.toFixed(2)),
        loopRiskIndex: Number(judgement.assessment.loopRiskIndex.toFixed(2)),
        repeatedFingerprintCount: judgement.assessment.repeatedFingerprintCount,
      };
      const base = {
        taskId: task.id,
        pass: "progress" as const,
        verdict: judgement.verdict,
        judge: judgement.judge,
        signals,
        ...(judgement.loopingOn ? { loopingOn: judgement.loopingOn } : {}),
      };

      if (judgement.verdict !== "drifting") {
        state.driftStrikes = 0;
        decisions.push(
          this.record(
            { ...base, action: "none", reason: judgement.reason, driftStrikes: 0 },
            "Watchdog: progress check passed.",
          ),
        );
        continue;
      }

      state.driftStrikes += 1;
      if (state.driftStrikes === 1) {
        const loopingOn =
          judgement.loopingOn || "the same steps without getting closer to the goal";
        const request = truncate(originalRequestOf(task), 300);
        const steering =
          `Watchdog: you appear to be looping on ${loopingOn}; return to the original request: "${request}". ` +
          "If something is blocking you, say what it is instead of repeating the same step. " +
          "(watchdog_status explains why this note was sent.)";
        let sent = false;
        try {
          sent = await this.host.sendSteeringMessage(
            task.id,
            steering,
            `watchdog:${task.id}:${now}`,
          );
        } catch (error) {
          logger.warn(`Steering note to task ${task.id} failed:`, error);
        }
        decisions.push(
          this.record(
            {
              ...base,
              action: sent ? "steer" : "none",
              reason: sent
                ? judgement.reason
                : `${judgement.reason} The steering note could not be delivered.`,
              driftStrikes: state.driftStrikes,
            },
            sent
              ? steering
              : "Watchdog: the task looks stuck, but the steering note was not delivered.",
          ),
        );
        continue;
      }

      // Second consecutive "drifting": pause, or cancel a repeat offender when allowed.
      state.driftStrikes = 0;
      if (this.settings.allowCancel && state.driftPauses >= 1) {
        const message =
          "Watchdog cancelled this task: it kept drifting from the original request after it was paused once.";
        let cancelled = false;
        try {
          cancelled = await this.host.cancelTask(task.id, message);
        } catch (error) {
          logger.warn(`Cancelling task ${task.id} failed:`, error);
        }
        if (cancelled) {
          decisions.push(
            this.record(
              { ...base, action: "cancel", reason: judgement.reason, driftStrikes: 2 },
              message,
            ),
          );
          this.notify(task, "Task cancelled by the watchdog", message);
          continue;
        }
      }
      const pauseMessage =
        `Watchdog paused this task: it still appears to be looping` +
        (judgement.loopingOn ? ` on ${judgement.loopingOn}` : "") +
        " after a steering note. Resume it to continue, or send new instructions.";
      let paused = false;
      try {
        paused = await this.host.pauseTask(task.id, pauseMessage);
      } catch (error) {
        logger.warn(`Pausing task ${task.id} failed:`, error);
      }
      if (paused) state.driftPauses += 1;
      decisions.push(
        this.record(
          {
            ...base,
            action: paused ? "pause" : "none",
            reason: paused
              ? judgement.reason
              : `${judgement.reason} The pause did not take effect.`,
            driftStrikes: 2,
          },
          pauseMessage,
        ),
      );
      if (paused) this.notify(task, "Task paused by the watchdog", pauseMessage);
    }
    return decisions;
  }

  // ---------------------------------------------------------------------------------------
  // Sleep recovery helpers

  private async resumeInterruptedTasks(suspendedMs?: number): Promise<WatchdogDecision[]> {
    const now = this.now();
    // Startup recovery resumes interrupted tasks itself shortly after launch.
    if (now - this.startedAt < STARTUP_GRACE_MS) return [];
    const decisions: WatchdogDecision[] = [];
    for (const task of this.safeList(["interrupted"])) {
      const runtime = this.host.getRuntime(task.id);
      if (!runtime.autoResumable || runtime.hasExecutor || runtime.queued || runtime.retryPending) {
        continue;
      }
      const events = this.safeEvents(task.id, 1);
      const lastAt = Math.max(task.updatedAt || 0, events[0]?.timestamp || 0);
      // A resume that is starting right now owns the task.
      if (now - lastAt < INTERRUPTED_SETTLE_MS) continue;
      const decision = await this.recover(
        task,
        "sleep_recovery",
        "Interrupted while the computer slept; resuming from its saved state.",
        "resume",
        suspendedMs ? { suspendedMs } : {},
      );
      if (decision) decisions.push(decision);
    }
    return decisions;
  }

  // ---------------------------------------------------------------------------------------
  // Plumbing

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.running.then(work, work);
    this.running = next.catch(() => undefined);
    return next;
  }

  private schedule(): void {
    this.unschedule();
    if (!this.settings.enabled) return;
    const intervalMs = this.settings.intervalMinutes * 60_000;
    const tick = () => {
      void this.runTick().catch((error) => logger.warn("Watchdog tick failed:", error));
    };
    this.timer = this.options.setInterval
      ? this.options.setInterval(tick, intervalMs)
      : setInterval(tick, intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private unschedule(): void {
    if (!this.timer) return;
    (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
  }

  private stateFor(taskId: string): WatchdogTaskState {
    let state = this.taskStates.get(taskId);
    if (!state) {
      state = { driftStrikes: 0, driftPauses: 0, recoveryAttempts: 0 };
      this.taskStates.set(taskId, state);
    }
    return state;
  }

  private expireRecoveryMemory(state: WatchdogTaskState, now: number): void {
    if (state.lastRecoveryAt !== undefined && now - state.lastRecoveryAt > RECOVERY_MEMORY_MS) {
      state.recoveryAttempts = 0;
      state.lastRecoveryAt = undefined;
    }
  }

  /** Attempt n+1 waits base * 2^(n-1) after attempt n; the first attempt runs at once. */
  private backoffElapsed(state: WatchdogTaskState, now: number): boolean {
    if (state.recoveryAttempts === 0 || state.lastRecoveryAt === undefined) return true;
    const delay = Math.min(
      RECOVERY_BACKOFF_MAX_MS,
      RECOVERY_BACKOFF_BASE_MS * 2 ** (state.recoveryAttempts - 1),
    );
    return now - state.lastRecoveryAt >= delay;
  }

  private record(
    input: Omit<WatchdogDecision, "at"> & { at?: number },
    message: string,
  ): WatchdogDecision {
    const decision: WatchdogDecision = { ...input, at: input.at ?? this.now() };
    this.stateFor(decision.taskId).lastDecision = decision;
    try {
      this.host.logDecision(decision, message);
    } catch (error) {
      logger.warn(`Could not log watchdog decision for task ${decision.taskId}:`, error);
    }
    if (decision.action !== "none") {
      logger.info(
        `Task ${decision.taskId}: ${decision.action} (${decision.pass}) — ${decision.reason}`,
      );
    }
    return decision;
  }

  private notify(task: Task, title: string, message: string): void {
    if (!this.host.notify) return;
    try {
      const result = this.host.notify({
        taskId: task.id,
        ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
        title,
        message: `${task.title ? `${truncate(task.title, 80)}: ` : ""}${message}`,
      });
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((error) =>
          logger.debug("Watchdog notification failed:", error),
        );
      }
    } catch (error) {
      logger.debug("Watchdog notification failed:", error);
    }
  }

  private safeList(statuses: TaskStatus[]): Task[] {
    try {
      return this.host.listTasks(statuses);
    } catch (error) {
      logger.warn(`Could not list ${statuses.join("/")} tasks:`, error);
      return [];
    }
  }

  private safeGet(taskId: string): Task | undefined {
    try {
      return this.host.getTask(taskId);
    } catch {
      return undefined;
    }
  }

  private safeEvents(taskId: string, limit: number): TaskEvent[] {
    try {
      return this.host.getRecentEvents(taskId, limit);
    } catch (error) {
      logger.debug(`Could not read events of task ${taskId}:`, error);
      return [];
    }
  }

  private safeHasLease(task: Task): boolean {
    try {
      return this.host.hasActiveLease(task);
    } catch {
      return false;
    }
  }
}

let activeWatchdog: WatchdogService | null = null;

/** The watchdog of this process, for the settings IPC and the `watchdog_status` tool. */
export function getWatchdogService(): WatchdogService | null {
  return activeWatchdog;
}

export function setWatchdogService(service: WatchdogService | null): void {
  activeWatchdog = service;
}
