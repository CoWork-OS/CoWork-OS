/**
 * CronService - Manages scheduled task execution
 * Handles job lifecycle, timer management, and task creation
 */

import { v4 as uuidv4 } from "uuid";
import os from "node:os";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronSchedule,
  CronServiceDeps,
  CronStoreFile,
  CronStatusSummary,
  CronSchedulerObservation,
  CronRunResult,
  CronRemoveResult,
  CronAddResult,
  CronUpdateResult,
  CronListResult,
  CronEvent,
  CronRunHistoryEntry,
  CronJobStatus,
  CronRunHistoryResult,
  CronWebhookConfig,
  CronWorkspaceContext,
  CronOutboxEntry,
} from "./types";
import { loadCronStore, saveCronStore, resolveCronStorePath } from "./store";
import {
  reconcileCronOutcomeCounts,
  recordCronRunCompletion,
  resetCronOutcomeCounts,
} from "./outcome-counts";
import { computeNextRunAtMs, validateCronExpression, validateCronTimeZone } from "./schedule";
import { CronWebhookServer } from "./webhook";
import { createLogger } from "../utils/logger";

const cronLogger = createLogger("CronService");

// Maximum timeout value to prevent overflow warnings (2^31 - 1 ms, ~24.8 days)
const MAX_TIMEOUT_MS = 2147483647;

// Defaults
const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_HISTORY_ENTRIES = 10;
const PERSISTED_TASK_RECHECK_INTERVAL_MS = 15_000;
/**
 * Task statuses that mean a scheduled run is still in flight. Interrupted, paused and
 * blocked tasks are run outcomes (see reconcilePersistedTaskOutcome), not active runs.
 */
export const CRON_ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "planning",
  "executing",
]);

// Default logger
const defaultLog = {
  debug: (msg: string, data?: unknown) => cronLogger.debug(msg, data ?? ""),
  info: (msg: string, data?: unknown) => cronLogger.info(msg, data ?? ""),
  warn: (msg: string, data?: unknown) => cronLogger.warn(msg, data ?? ""),
  error: (msg: string, data?: unknown) => cronLogger.error(msg, data ?? ""),
};

/** Run status for a task whose lifecycle status is `completed`, from its terminal status. */
function cronStatusForCompletedTask(terminalStatus: unknown): CronJobStatus {
  switch (terminalStatus) {
    case "failed":
      return "error";
    case "awaiting_approval":
    case "awaiting_verification":
    case "needs_user_action":
      return "needs_user_action";
    case "resume_available":
    case "partial_success":
      return "partial_success";
    default:
      return "ok";
  }
}

interface CronServiceState {
  deps: Required<
    Omit<
      CronServiceDeps,
      | "nowMs"
      | "runnerKind"
      | "onEvent"
      | "log"
      | "maxConcurrentRuns"
      | "defaultTimeoutMs"
      | "maxHistoryEntries"
      | "webhook"
      | "deliverToChannel"
      | "sendTaskMessage"
      | "getTaskStatus"
      | "getTaskResultText"
      | "resolveTemplateVariables"
      | "resolveWorkspaceContext"
      | "findActiveTaskForJob"
      | "executeWorkflow"
    >
  > & {
    nowMs: () => number;
    runnerKind: NonNullable<CronServiceDeps["runnerKind"]>;
    onEvent?: (evt: CronEvent) => void;
    log: typeof defaultLog;
    maxConcurrentRuns: number;
    defaultTimeoutMs: number;
    maxHistoryEntries: number;
    webhook?: CronWebhookConfig;
    getTaskStatus?: CronServiceDeps["getTaskStatus"];
    getTaskResultText?: CronServiceDeps["getTaskResultText"];
    sendTaskMessage?: CronServiceDeps["sendTaskMessage"];
    deliverToChannel?: CronServiceDeps["deliverToChannel"];
    resolveTemplateVariables?: CronServiceDeps["resolveTemplateVariables"];
    resolveWorkspaceContext?: CronServiceDeps["resolveWorkspaceContext"];
    findActiveTaskForJob?: CronServiceDeps["findActiveTaskForJob"];
    executeWorkflow?: CronServiceDeps["executeWorkflow"];
  };
  store: CronStoreFile | null;
  timer: ReturnType<typeof setTimeout> | null;
  outboxTimer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  schedulerStarted: boolean;
  processingOutbox: boolean;
  runningJobIds: Set<string>; // Track currently running jobs
  opLock: Promise<unknown>;
  webhookServer: CronWebhookServer | null;
}

export class CronService {
  private state: CronServiceState;
  private lifecycleOperation: Promise<unknown> = Promise.resolve();

  constructor(deps: CronServiceDeps) {
    this.state = {
      deps: {
        ...deps,
        nowMs: deps.nowMs ?? (() => Date.now()),
        runnerKind: deps.runnerKind ?? "unknown",
        log: deps.log ?? defaultLog,
        maxConcurrentRuns: deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
        defaultTimeoutMs: deps.defaultTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
        maxHistoryEntries: deps.maxHistoryEntries ?? DEFAULT_MAX_HISTORY_ENTRIES,
        webhook: deps.webhook,
        getTaskStatus: deps.getTaskStatus,
        getTaskResultText: deps.getTaskResultText,
        sendTaskMessage: deps.sendTaskMessage,
        deliverToChannel: deps.deliverToChannel,
        resolveTemplateVariables: deps.resolveTemplateVariables,
        resolveWorkspaceContext: deps.resolveWorkspaceContext,
        findActiveTaskForJob: deps.findActiveTaskForJob,
        executeWorkflow: deps.executeWorkflow,
      },
      store: null,
      timer: null,
      outboxTimer: null,
      running: false,
      schedulerStarted: false,
      processingOutbox: false,
      runningJobIds: new Set(),
      opLock: Promise.resolve(),
      webhookServer: null,
    };
  }

  /**
   * Start the cron service
   * Loads jobs from store and arms the timer
   */
  async start(): Promise<void> {
    await this.withLifecycleLock(async () => {
      if (this.state.schedulerStarted) return;
      await this.withLock(async () => {
        const { deps, log } = this.getContext();
        if (this.state.schedulerStarted) return;

        this.stopTimer();
        this.stopOutboxTimer();
        if (!deps.cronEnabled) {
          this.state.schedulerStarted = false;
          log.info("Cron service disabled");
          return;
        }

        const storePath = resolveCronStorePath(deps.storePath);
        this.state.store = await loadCronStore(storePath);
        // Idempotent: classifies retained history once and detects older writers.
        for (const job of this.state.store.jobs) reconcileCronOutcomeCounts(job.state);

        const enabledCount = this.state.store.jobs.filter((j) => j.enabled).length;
        log.info(`Cron service started with ${enabledCount} enabled jobs`);

        const nowMs = deps.nowMs();
        await this.reconcileLoadedJobs(nowMs);

        await this.persist();

        // Start webhook server before marking the timer scheduler live.
        if (deps.webhook?.enabled) {
          await this.startWebhookServer();
        }

        this.state.schedulerStarted = true;
        this.armTimer();
        this.armOutboxTimer();
      });
    });
  }

  /**
   * Start the webhook server for external triggers
   */
  private async startWebhookServer(): Promise<void> {
    const { deps, log } = this.getContext();
    if (!deps.webhook?.enabled) return;

    try {
      this.state.webhookServer = new CronWebhookServer({
        enabled: true,
        port: deps.webhook.port,
        host: deps.webhook.host,
        secret: deps.webhook.secret,
      });

      // Set up the trigger handler
      this.state.webhookServer.setTriggerHandler(async (jobId, force) => {
        return this.run(jobId, force ? "force" : "due");
      });

      // Set up job lookup
      this.state.webhookServer.setJobLookup(async () => {
        const jobs = await this.list({ includeDisabled: true });
        return jobs.map((j) => ({ id: j.id, name: j.name }));
      });

      await this.state.webhookServer.start();
      log.info(`Webhook server started on port ${deps.webhook.port}`);
    } catch (error) {
      log.error("Failed to start webhook server:", error);
    }
  }

  /**
   * Stop the cron service
   */
  async stop(): Promise<void> {
    await this.withLifecycleLock(async () => {
      this.state.schedulerStarted = false;
      this.stopTimer();
      this.stopOutboxTimer();

      // Stop webhook server if running
      if (this.state.webhookServer) {
        await this.state.webhookServer.stop();
        this.state.webhookServer = null;
      }

      // Keep the loaded store object until the service is discarded. Clearing it
      // while ordinary operations are queued can detach their local store reference.
      this.getContext().log.info("Cron service stopped");
    });
  }

  /**
   * Get service status
   */
  async status(): Promise<CronStatusSummary> {
    return this.withLock(async () => {
      const { deps } = this.getContext();
      const store = this.ensureStore();

      const eligibleJobs = store.jobs.filter(
        (job) =>
          (job.enabled || job.state.runningAtMs !== undefined) &&
          !this.state.runningJobIds.has(job.id),
      );
      const nextScheduledJob = eligibleJobs
        .filter(
          (job) =>
            job.enabled &&
            job.state.runningAtMs === undefined &&
            job.state.nextRunAtMs !== undefined,
        )
        .sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity))[0];
      const recoveryJob = eligibleJobs.find((job) => job.state.runningAtMs !== undefined);
      const canCheckRecoveredTask = Boolean(recoveryJob?.state.lastTaskId && deps.getTaskStatus);
      const recoveryAtMs = recoveryJob
        ? canCheckRecoveredTask
          ? deps.nowMs() + PERSISTED_TASK_RECHECK_INTERVAL_MS
          : recoveryJob.state.runningAtMs! + this.getJobTimeoutMs(recoveryJob)
        : Infinity;
      const useRecoveryWake = Boolean(
        recoveryJob &&
        (!nextScheduledJob?.state.nextRunAtMs || recoveryAtMs < nextScheduledJob.state.nextRunAtMs),
      );
      const nextJob = useRecoveryWake ? recoveryJob : nextScheduledJob;
      const nextWakeAtMs = useRecoveryWake ? recoveryAtMs : (nextJob?.state.nextRunAtMs ?? null);

      const webhookAddr = this.state.webhookServer?.getAddress();
      const scheduler = this.getSchedulerObservation(deps);
      const nextWakeTimeZone =
        nextJob?.schedule.kind === "cron"
          ? nextJob.schedule.tz || scheduler.timeZone
          : nextJob?.schedule.kind === "at"
            ? scheduler.timeZone
            : undefined;

      return {
        enabled: deps.cronEnabled,
        storePath: resolveCronStorePath(deps.storePath),
        jobCount: store.jobs.length,
        enabledJobCount: store.jobs.filter((j) => j.enabled).length,
        // Leases persisted by another process (or surviving an app restart) are
        // active work too, even though this process did not start them.
        runningJobCount:
          this.state.runningJobIds.size +
          store.jobs.filter(
            (job) => job.state.runningAtMs !== undefined && !this.state.runningJobIds.has(job.id),
          ).length,
        maxConcurrentRuns: deps.maxConcurrentRuns,
        nextWakeAtMs,
        nextWakeReason: useRecoveryWake
          ? canCheckRecoveredTask
            ? "task_recovery_check"
            : "run_timeout_check"
          : nextJob
            ? "scheduled_job"
            : undefined,
        nextWakeScheduleKind: useRecoveryWake ? undefined : nextJob?.schedule.kind,
        nextWakeTimeZone: useRecoveryWake ? undefined : nextWakeTimeZone,
        scheduler,
        webhook: webhookAddr
          ? {
              enabled: true,
              host: webhookAddr.host,
              port: webhookAddr.port,
            }
          : undefined,
      };
    });
  }

  private getSchedulerObservation(deps: CronServiceDeps): CronSchedulerObservation {
    return {
      profileScope: "current_profile",
      runnerKind: deps.runnerKind ?? "unknown",
      runnerHost: os.hostname(),
      state: !deps.cronEnabled
        ? "disabled"
        : this.state.schedulerStarted
          ? "running"
          : "not_started",
      observedAtMs: deps.nowMs?.() ?? Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      runnerExclusivity: "not_verified",
    };
  }

  /**
   * Get run history for a job
   */
  async getRunHistory(jobId: string): Promise<CronRunHistoryResult | null> {
    return this.withLock(async () => {
      const store = this.ensureStore();
      const job = store.jobs.find((j) => j.id === jobId);
      if (!job) return null;

      return {
        jobId: job.id,
        jobName: job.name,
        entries: job.state.runHistory ?? [],
        totalRuns: job.state.totalRuns ?? 0,
        successfulRuns: job.state.successfulRuns ?? 0,
        failedRuns: job.state.failedRuns ?? 0,
        outcomeCounts: { ...reconcileCronOutcomeCounts(job.state).counts },
      };
    });
  }

  /**
   * List all jobs
   */
  async list(opts?: { includeDisabled?: boolean }): Promise<CronListResult> {
    return this.withLock(async () => {
      const store = this.ensureStore();

      let jobs = [...store.jobs];

      if (!opts?.includeDisabled) {
        jobs = jobs.filter((j) => j.enabled);
      }

      // Sort by next run time
      jobs.sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));

      return jobs;
    });
  }

  /**
   * Get a single job by ID
   */
  async get(id: string): Promise<CronJob | null> {
    return this.withLock(async () => {
      const store = this.ensureStore();
      return store.jobs.find((j) => j.id === id) ?? null;
    });
  }

  /**
   * Add a new job
   */
  async add(input: CronJobCreate): Promise<CronAddResult> {
    return this.withLock(async () => {
      const { deps, log } = this.getContext();
      const store = this.ensureStore();
      const nowMs = deps.nowMs();

      if (input.schedule.kind === "cron") {
        if (!validateCronExpression(input.schedule.expr)) {
          return { ok: false, error: "Schedule must be a valid five-field cron expression." };
        }
        if (!validateCronTimeZone(input.schedule.tz)) {
          return { ok: false, error: "Schedule timezone must be a valid IANA timezone." };
        }
      }

      const schedule =
        input.schedule.kind === "every" && input.schedule.anchorMs === undefined
          ? { ...input.schedule, anchorMs: nowMs }
          : input.schedule;

      const job: CronJob = {
        id: uuidv4(),
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        // A missing profile is resolved from the task/workspace default at
        // execution time. Persist the legacy shell field only when an older
        // caller explicitly supplied it, so new jobs cannot accidentally opt
        // out of the access-profile path.
        accessProfileId:
          typeof input.accessProfileId === "string" && input.accessProfileId.trim()
            ? input.accessProfileId.trim()
            : undefined,
        ...(input.shellAccess !== undefined ? { shellAccess: input.shellAccess } : {}),
        allowUserInput: input.allowUserInput ?? false,
        deleteAfterRun: input.deleteAfterRun,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        schedule,
        workspaceId: input.workspaceId,
        taskPrompt: input.taskPrompt,
        taskTitle: input.taskTitle,
        assignedAgentRoleId: input.assignedAgentRoleId,
        runMode: input.runMode,
        targetTaskId: input.targetTaskId,
        workflowRoutineId: input.workflowRoutineId,
        threadAutomation: input.threadAutomation,
        // Advanced options
        timeoutMs: input.timeoutMs,
        modelKey: input.modelKey,
        maxHistoryEntries: input.maxHistoryEntries,
        delivery: input.delivery,
        state: {
          ...input.state,
          nextRunAtMs: input.enabled ? computeNextRunAtMs(input.schedule, nowMs) : undefined,
          runHistory: [],
          totalRuns: 0,
          successfulRuns: 0,
          failedRuns: 0,
        },
      };

      try {
        const workspaceContext = await this.resolveWorkspaceContext(job, nowMs, "add");
        if (workspaceContext?.workspaceId) {
          job.workspaceId = workspaceContext.workspaceId;
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`Failed to resolve workspace for job "${job.name}"`, error);
        return {
          ok: false,
          error: `Failed to resolve workspace for scheduled job: ${errMsg}`,
        };
      }

      store.jobs.push(job);
      await this.persist();
      this.armTimer();

      log.info(`Added job: ${job.name} (${job.id})`);
      this.emit({ jobId: job.id, action: "added", nextRunAtMs: job.state.nextRunAtMs });

      return { ok: true, job };
    });
  }

  /**
   * Update an existing job
   */
  async update(id: string, patch: CronJobPatch): Promise<CronUpdateResult> {
    return this.withLock(async () => {
      const { deps, log } = this.getContext();
      const store = this.ensureStore();
      const nowMs = deps.nowMs();

      const index = store.jobs.findIndex((j) => j.id === id);
      if (index === -1) {
        return { ok: false, error: "Job not found" };
      }

      const job = store.jobs[index];
      const wasEnabled = job.enabled;
      let proposedSchedule = patch.schedule ?? job.schedule;
      const scheduleWillBeActivated =
        patch.schedule !== undefined || (!wasEnabled && patch.enabled === true);
      if (scheduleWillBeActivated && proposedSchedule.kind === "cron") {
        if (!validateCronExpression(proposedSchedule.expr)) {
          return { ok: false, error: "Schedule must be a valid five-field cron expression." };
        }
        if (!validateCronTimeZone(proposedSchedule.tz)) {
          return { ok: false, error: "Schedule timezone must be a valid IANA timezone." };
        }
      }
      if (
        scheduleWillBeActivated &&
        proposedSchedule.kind === "every" &&
        proposedSchedule.anchorMs === undefined
      ) {
        proposedSchedule = { ...proposedSchedule, anchorMs: nowMs };
      }

      // Apply patch - basic fields
      if (patch.name !== undefined) job.name = patch.name;
      if (patch.description !== undefined) job.description = patch.description;
      if (patch.enabled !== undefined) job.enabled = patch.enabled;
      if (patch.accessProfileId !== undefined) job.accessProfileId = patch.accessProfileId;
      if (patch.shellAccess !== undefined) job.shellAccess = patch.shellAccess;
      if (patch.allowUserInput !== undefined) job.allowUserInput = patch.allowUserInput;
      if (patch.deleteAfterRun !== undefined) job.deleteAfterRun = patch.deleteAfterRun;
      if (scheduleWillBeActivated) job.schedule = proposedSchedule;
      if (patch.workspaceId !== undefined) job.workspaceId = patch.workspaceId;
      if (patch.taskPrompt !== undefined) job.taskPrompt = patch.taskPrompt;
      if (patch.taskTitle !== undefined) job.taskTitle = patch.taskTitle;
      if (patch.assignedAgentRoleId !== undefined)
        job.assignedAgentRoleId = patch.assignedAgentRoleId;
      if (patch.runMode !== undefined) {
        job.runMode = patch.runMode;
        if (patch.runMode === "new_task") {
          job.targetTaskId = undefined;
          job.threadAutomation = undefined;
          job.workflowRoutineId = undefined;
        } else if (patch.runMode === "workflow") {
          job.targetTaskId = undefined;
          job.threadAutomation = undefined;
        }
      }
      if (patch.targetTaskId !== undefined) job.targetTaskId = patch.targetTaskId;
      if (patch.workflowRoutineId !== undefined) job.workflowRoutineId = patch.workflowRoutineId;
      if (patch.threadAutomation !== undefined) job.threadAutomation = patch.threadAutomation;
      // Apply patch - advanced options
      if (patch.timeoutMs !== undefined) job.timeoutMs = patch.timeoutMs;
      if (patch.modelKey !== undefined) job.modelKey = patch.modelKey;
      if (patch.maxHistoryEntries !== undefined) job.maxHistoryEntries = patch.maxHistoryEntries;
      if (patch.delivery !== undefined) job.delivery = patch.delivery;
      if (patch.state) {
        job.state = { ...job.state, ...patch.state };
      }

      job.updatedAtMs = nowMs;

      // Recompute next run time if schedule changed or job was enabled
      if (patch.schedule || (!wasEnabled && job.enabled)) {
        job.state.nextRunAtMs = job.enabled ? computeNextRunAtMs(job.schedule, nowMs) : undefined;
      }

      // Clear next run time if disabled
      if (!job.enabled) {
        job.state.nextRunAtMs = undefined;
      }

      await this.persist();
      this.armTimer();

      log.info(`Updated job: ${job.name} (${job.id})`);
      this.emit({ jobId: job.id, action: "updated", nextRunAtMs: job.state.nextRunAtMs });

      return { ok: true, job };
    });
  }

  /**
   * Remove a job
   */
  async remove(id: string): Promise<CronRemoveResult> {
    return this.withLock(async () => {
      const { log } = this.getContext();
      const store = this.ensureStore();

      const index = store.jobs.findIndex((j) => j.id === id);
      if (index === -1) {
        return { ok: true, removed: false };
      }

      const job = store.jobs[index];
      store.jobs.splice(index, 1);

      await this.persist();
      this.armTimer();

      log.info(`Removed job: ${job.name} (${job.id})`);
      this.emit({ jobId: id, action: "removed" });

      return { ok: true, removed: true };
    });
  }

  /**
   * Run a job immediately or when due
   */
  async run(id: string, mode: "due" | "force" = "due"): Promise<CronRunResult> {
    return this.withLock(async () => {
      const { deps } = this.getContext();
      const store = this.ensureStore();
      const nowMs = deps.nowMs();

      const job = store.jobs.find((j) => j.id === id);
      if (!job) {
        return { ok: true, ran: false, reason: "not-found" };
      }

      if (!job.enabled && mode !== "force") {
        return { ok: true, ran: false, reason: "disabled" };
      }

      if (this.state.runningJobIds.has(job.id)) {
        return { ok: true, ran: false, reason: "already-running" };
      }

      const recoveredOutcome = await this.reconcilePersistedTaskOutcome(job, nowMs);
      if (recoveredOutcome && !store.jobs.some((candidate) => candidate.id === job.id)) {
        return { ok: true, ran: false, reason: "not-found" };
      }

      const activeRun = await this.findActivePersistedRun(job);
      if (activeRun) {
        job.state.lastTaskId = activeRun.id;
        job.state.runningAtMs = job.state.runningAtMs ?? nowMs;
        job.state.runningRunMode = job.state.runningRunMode ?? job.runMode ?? "new_task";
        job.state.lastRunAtMs = job.state.lastRunAtMs ?? job.state.runningAtMs;
        if (
          job.enabled &&
          !job.deleteAfterRun &&
          (!job.state.nextRunAtMs || job.state.nextRunAtMs <= nowMs)
        ) {
          job.state.nextRunAtMs = this.computeNextFutureRunAtMs(job.schedule, nowMs);
        }
        await this.persist();
        return { ok: true, ran: false, reason: "already-running" };
      }

      if (mode === "due") {
        const nextRun = job.state.nextRunAtMs;
        if (!nextRun || nextRun > nowMs) {
          return { ok: true, ran: false, reason: "not-due" };
        }
      }

      // Execute the job
      return this.executeJob(job, nowMs);
    });
  }

  // =====================
  // Private Methods
  // =====================

  private getContext() {
    return {
      deps: this.state.deps,
      log: this.state.deps.log,
    };
  }

  private ensureStore(): CronStoreFile {
    if (!this.state.store) {
      this.state.store = { version: 1, jobs: [], outbox: [] };
    }
    if (!Array.isArray(this.state.store.outbox)) {
      this.state.store.outbox = [];
    }
    return this.state.store;
  }

  private async persist(): Promise<void> {
    const store = this.ensureStore();
    const storePath = resolveCronStorePath(this.state.deps.storePath);
    await saveCronStore(storePath, store);
  }

  private emit(evt: CronEvent): void {
    this.state.deps.onEvent?.(evt);
  }

  private getJobTimeoutMs(job: CronJob): number {
    return Math.max(1, Math.floor(job.timeoutMs ?? this.state.deps.defaultTimeoutMs));
  }

  private computeNextFutureRunAtMs(schedule: CronSchedule, afterMs: number): number | undefined {
    const next = computeNextRunAtMs(schedule, afterMs);
    return next !== undefined && next <= afterMs ? computeNextRunAtMs(schedule, afterMs + 1) : next;
  }

  private isActiveTaskStatus(status: unknown): boolean {
    return typeof status === "string" && CRON_ACTIVE_TASK_STATUSES.has(status);
  }

  private isUniqueEnabledTaskTitle(job: CronJob): boolean {
    const store = this.ensureStore();
    const title = job.taskTitle || `Scheduled: ${job.name}`;
    return (
      store.jobs.filter(
        (candidate) =>
          candidate.enabled &&
          (candidate.taskTitle || `Scheduled: ${candidate.name}`) === title &&
          (candidate.runMode ?? "new_task") === (job.runMode ?? "new_task"),
      ).length === 1
    );
  }

  private async findActivePersistedRun(
    job: CronJob,
  ): Promise<{ id: string; status: string } | null> {
    if (job.state.lastTaskId && this.state.deps.getTaskStatus) {
      const task = await this.state.deps.getTaskStatus(job.state.lastTaskId);
      if (task && this.isActiveTaskStatus(task.status)) {
        return { id: job.state.lastTaskId, status: task.status };
      }
    }

    const finder = this.state.deps.findActiveTaskForJob;
    if (!finder) return null;
    const task = await finder({
      jobId: job.id,
      taskTitle: job.taskTitle || `Scheduled: ${job.name}`,
      workspaceId: job.workspaceId,
      runMode: job.runMode ?? "new_task",
      allowTitleFallback: this.isUniqueEnabledTaskTitle(job),
    });
    if (task && this.isActiveTaskStatus(task.status)) {
      return task;
    }
    return null;
  }

  private async reconcilePersistedTaskOutcome(job: CronJob, nowMs: number): Promise<boolean> {
    const taskId = job.state.lastTaskId;
    const runAtMs = job.state.runningAtMs;
    const runMode = job.state.runningRunMode ?? job.runMode ?? "new_task";
    const getTaskStatus = this.state.deps.getTaskStatus;
    if (runMode !== "new_task" || !taskId || runAtMs === undefined || !getTaskStatus) return false;

    let task: Awaited<ReturnType<NonNullable<CronServiceDeps["getTaskStatus"]>>>;
    try {
      task = await getTaskStatus(taskId);
    } catch {
      return false;
    }
    if (!task || this.isActiveTaskStatus(task.status)) return false;

    let status: CronJobStatus;
    let error: string | undefined;
    if (task.status === "completed") {
      status = cronStatusForCompletedTask(task.terminalStatus);
      if (task.terminalStatus === "failed") error = task.error || "Task failed";
    } else if (task.status === "failed") {
      status = "error";
      error = task.error || "Task failed";
    } else if (task.status === "cancelled") {
      status = "cancelled";
      error = task.error || "Task cancelled";
    } else if (task.status === "paused" || task.status === "blocked") {
      status = "needs_user_action";
      error = task.error || `Task ${task.status}`;
    } else if (task.status === "interrupted") {
      status = task.terminalStatus === "resume_available" ? "partial_success" : "error";
      error = task.error || "Task interrupted";
    } else {
      return false;
    }

    let resultText: string | undefined;
    if (
      (status === "ok" || status === "partial_success" || status === "needs_user_action") &&
      this.state.deps.getTaskResultText
    ) {
      try {
        resultText = await this.state.deps.getTaskResultText(taskId);
      } catch {
        // The durable task status is authoritative; result text is optional for recovery.
      }
    }
    if (!resultText && task.resultSummary?.trim()) resultText = task.resultSummary.trim();
    const historyEntry: CronRunHistoryEntry = {
      runAtMs,
      durationMs: Math.max(0, nowMs - runAtMs),
      status,
      error,
      taskId,
      taskStillRunning: false,
      runMode,
      workspaceId: job.workspaceId,
      deliveryAttempts: 0,
      deliverableStatus: "none",
    };

    job.state.lastDurationMs = historyEntry.durationMs;
    job.state.runningAtMs = undefined;
    job.state.runningRunMode = undefined;
    job.state.lastStatus = status;
    job.state.lastError = error;
    recordCronRunCompletion(
      job.state,
      historyEntry,
      job.maxHistoryEntries ?? this.state.deps.maxHistoryEntries,
    );

    if (job.deleteAfterRun) {
      const jobs = this.ensureStore().jobs;
      const index = jobs.findIndex((candidate) => candidate.id === job.id);
      if (index !== -1) jobs.splice(index, 1);
    } else if (!job.state.nextRunAtMs || job.state.nextRunAtMs <= nowMs) {
      job.state.nextRunAtMs = job.enabled
        ? this.computeNextFutureRunAtMs(job.schedule, nowMs)
        : undefined;
    }

    const deliveryConfig = job.delivery;
    const isSuccess =
      status === "ok" || status === "partial_success" || status === "needs_user_action";
    const shouldQueueDelivery =
      deliveryConfig?.enabled === true &&
      Boolean(deliveryConfig.channelType && deliveryConfig.channelId) &&
      Boolean(this.state.deps.deliverToChannel) &&
      ((isSuccess && deliveryConfig.deliverOnSuccess !== false) ||
        (!isSuccess && deliveryConfig.deliverOnError !== false)) &&
      !(
        isSuccess &&
        deliveryConfig.deliverOnlyIfResult &&
        !(typeof resultText === "string" && resultText.trim())
      );
    if (shouldQueueDelivery && deliveryConfig?.channelType && deliveryConfig.channelId) {
      const idempotencyKey = `${job.id}:${Math.trunc(runAtMs)}:${taskId || "no-task"}:${deliveryConfig.channelType}:${deliveryConfig.channelId}`;
      this.enqueueOutboxEntry({
        job,
        runAtMs,
        status,
        channelType: deliveryConfig.channelType,
        channelDbId: deliveryConfig.channelDbId,
        channelId: deliveryConfig.channelId,
        summaryOnly: deliveryConfig.summaryOnly,
        resultText,
        error,
        taskId,
        idempotencyKey,
        initialAttemptCount: 0,
        attemptImmediately: true,
      });
      historyEntry.deliveryStatus = "skipped";
      historyEntry.deliveryMode = "outbox";
      historyEntry.deliveryAttempts = 0;
      historyEntry.deliverableStatus = "queued";
    }
    // Commit the recovered outcome and any notification intent together. If
    // the process exits, the outbox survives and resumes after the next start.
    await this.persist();
    this.emit({
      jobId: job.id,
      action: "finished",
      runAtMs,
      durationMs: historyEntry.durationMs,
      status,
      error,
      taskId,
      taskStillRunning: false,
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return true;
  }

  private async reconcileLoadedJobs(nowMs: number): Promise<void> {
    const { log } = this.getContext();
    const store = this.ensureStore();

    for (const job of [...store.jobs]) {
      if (await this.reconcilePersistedTaskOutcome(job, nowMs)) continue;

      // A disabled job does not stop work already in flight. Keep checking a
      // persisted lease so its completion still reaches run history and delivery.
      if (job.state.runningAtMs !== undefined) {
        const activeRun = await this.findActivePersistedRun(job);
        if (activeRun) {
          job.state.lastTaskId = activeRun.id;
          job.state.runningRunMode = job.state.runningRunMode ?? job.runMode ?? "new_task";
          job.state.lastRunAtMs = job.state.lastRunAtMs ?? job.state.runningAtMs;
          if (
            job.enabled &&
            (!job.state.nextRunAtMs || job.state.nextRunAtMs <= nowMs) &&
            !job.deleteAfterRun
          ) {
            // Do not replay recurrences that became due while this task was active.
            job.state.nextRunAtMs = this.computeNextFutureRunAtMs(job.schedule, nowMs);
          }
          log.warn(
            `Cron job "${job.name}" has active task ${activeRun.id}; preserving run lease instead of creating a duplicate`,
          );
          continue;
        }

        const timedOutAtMs = job.state.runningAtMs + this.getJobTimeoutMs(job);
        if (timedOutAtMs > nowMs) {
          // The task status could not be confirmed. Keep the lease until its existing
          // timeout instead of starting a second task on an overdue recurrence.
          if (job.enabled && (!job.state.nextRunAtMs || job.state.nextRunAtMs <= nowMs)) {
            job.state.nextRunAtMs = timedOutAtMs;
          }
          continue;
        }

        const interruptedRunAtMs = job.state.runningAtMs;
        job.state.lastStatus = "timeout";
        job.state.lastError =
          `Scheduled run interrupted before completion after app restart; ` +
          `started at ${new Date(interruptedRunAtMs).toISOString()}`;
        job.state.runningAtMs = undefined;
        job.state.runningRunMode = undefined;
        recordCronRunCompletion(
          job.state,
          {
            runAtMs: interruptedRunAtMs,
            durationMs: Math.max(0, nowMs - interruptedRunAtMs),
            status: "timeout",
            error: job.state.lastError,
            taskId: job.state.lastTaskId,
            runMode: job.runMode ?? "new_task",
            workspaceId: job.workspaceId,
            deliveryAttempts: 0,
            deliverableStatus: "none",
          },
          job.maxHistoryEntries ?? this.state.deps.maxHistoryEntries,
        );
      }

      if (!job.enabled) {
        if (job.state.nextRunAtMs !== undefined) {
          job.state.nextRunAtMs = undefined;
        }
        continue;
      }

      const activeRun = await this.findActivePersistedRun(job);
      if (activeRun) {
        job.state.lastTaskId = activeRun.id;
        job.state.runningAtMs = job.state.runningAtMs ?? nowMs;
        job.state.runningRunMode = job.state.runningRunMode ?? job.runMode ?? "new_task";
        job.state.lastRunAtMs = job.state.lastRunAtMs ?? job.state.runningAtMs;
        if (!job.state.nextRunAtMs || job.state.nextRunAtMs <= nowMs) {
          // Do not replay recurrences that became due while the recovered task was active.
          job.state.nextRunAtMs = this.computeNextFutureRunAtMs(job.schedule, nowMs);
        }
        log.warn(
          `Cron job "${job.name}" has active task ${activeRun.id}; preserving run lease instead of creating a duplicate`,
        );
        continue;
      }

      if (!job.state.nextRunAtMs) {
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
        continue;
      }

      if (job.state.nextRunAtMs <= nowMs && (job.state.lastRunAtMs ?? 0) >= job.state.nextRunAtMs) {
        const coveredRunAtMs = job.state.nextRunAtMs;
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, coveredRunAtMs);
        log.warn(
          `Advanced already-recorded cron run for "${job.name}" from ${new Date(coveredRunAtMs).toISOString()}`,
        );
      }
    }
  }

  private async resolveWorkspaceContext(
    job: CronJob,
    nowMs: number,
    phase: "add" | "run",
  ): Promise<CronWorkspaceContext | null> {
    const resolver = this.state.deps.resolveWorkspaceContext;
    if (!resolver) return null;

    const context = await resolver({ job, nowMs, phase });
    if (!context) return null;

    const workspaceId = typeof context.workspaceId === "string" ? context.workspaceId.trim() : "";
    if (!workspaceId) return null;

    return {
      workspaceId,
      workspacePath:
        typeof context.workspacePath === "string" && context.workspacePath.trim().length > 0
          ? context.workspacePath
          : undefined,
      runWorkspacePath:
        typeof context.runWorkspacePath === "string" && context.runWorkspacePath.trim().length > 0
          ? context.runWorkspacePath
          : undefined,
      runWorkspaceRelativePath:
        typeof context.runWorkspaceRelativePath === "string" &&
        context.runWorkspaceRelativePath.trim().length > 0
          ? context.runWorkspaceRelativePath
          : undefined,
    };
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prevOp = this.state.opLock;
    let resolve: (value?: unknown) => void;
    this.state.opLock = new Promise((r) => {
      resolve = r;
    });

    try {
      await prevOp;
      return await fn();
    } finally {
      resolve!();
    }
  }

  private async withLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleOperation;
    let resolve: (value?: unknown) => void;
    this.lifecycleOperation = new Promise((done) => {
      resolve = done;
    });

    try {
      await previous;
      return await fn();
    } finally {
      resolve!();
    }
  }

  /**
   * Execute a job and create a task
   */
  private async executeJob(job: CronJob, nowMs: number): Promise<CronRunResult> {
    const { deps, log } = this.getContext();
    const store = this.ensureStore();

    // Track that this job is running. The try/finally below brackets the entire
    // run so runningJobIds is always cleared, even on an early return or throw.
    this.state.runningJobIds.add(job.id);

    try {
      log.info(`Executing job: ${job.name} (${job.id})`);
      this.emit({ jobId: job.id, action: "started", runAtMs: nowMs });

      const prevRunAtMs = job.state.lastRunAtMs;
      job.state.runningAtMs = nowMs;
      job.state.runningRunMode = job.runMode ?? "new_task";
      job.state.lastRunAtMs = nowMs;
      job.state.lastStatus = undefined;
      job.state.lastError = undefined;
      if (!job.deleteAfterRun) {
        job.state.nextRunAtMs = job.enabled
          ? this.computeNextFutureRunAtMs(job.schedule, nowMs)
          : undefined;
      }
      await this.persist();
      this.armTimer();

      const startTime = Date.now();
      let taskId: string | undefined;
      let status: CronJobStatus = "ok";
      let errorMsg: string | undefined;
      let resultText: string | undefined;
      let workspaceContext: CronWorkspaceContext | null = null;
      let workspaceIdForRun = job.workspaceId;
      let shouldPollTaskStatus = true;
      let taskStillRunning = false;

      try {
        workspaceContext = await this.resolveWorkspaceContext(job, nowMs, "run");
        if (workspaceContext?.workspaceId) {
          workspaceIdForRun = workspaceContext.workspaceId;
        }
        if (workspaceIdForRun !== job.workspaceId) {
          job.workspaceId = workspaceIdForRun;
          job.updatedAtMs = nowMs;
        }

        const renderedPrompt = await this.renderTaskPrompt(
          job,
          nowMs,
          prevRunAtMs,
          workspaceContext,
        );

        const agentConfig = {
          ...job.taskAgentConfig,
          ...(job.accessProfileId ? { accessProfileId: job.accessProfileId } : {}),
          // Profile-selected jobs are governed by the profile resolver. Only
          // legacy jobs without a named profile use the old shell override.
          ...(job.accessProfileId === undefined &&
          typeof job.taskAgentConfig?.accessProfileId !== "string" &&
          job.shellAccess === false
            ? {
                toolRestrictions: Array.from(
                  new Set([...(job.taskAgentConfig?.toolRestrictions ?? []), "run_command"]),
                ),
              }
            : {}),
        };

        if (job.runMode === "workflow") {
          shouldPollTaskStatus = false;
          const routineId = job.workflowRoutineId?.trim();
          if (!routineId || !deps.executeWorkflow) {
            status = "needs_user_action";
            errorMsg = "Scheduled workflow execution is not available in this runtime";
          } else {
            const workflowResult = await deps.executeWorkflow({
              routineId,
              jobId: job.id,
              runAtMs: nowMs,
              agentConfig,
            });
            resultText = workflowResult.resultText;
            errorMsg = workflowResult.error;
            // queued/running means the scheduler did not observe an outcome.
            status =
              workflowResult.status === "completed"
                ? "ok"
                : workflowResult.status === "partial_success"
                  ? "partial_success"
                  : workflowResult.status === "needs_user_action"
                    ? "needs_user_action"
                    : workflowResult.status === "failed"
                      ? "error"
                      : "unknown";
            if (status === "unknown" && !errorMsg) {
              errorMsg = `Routine run ${workflowResult.status}; its outcome was not observed by the scheduler`;
            }
            log.info(`Job ${job.name} executed Routine v2 run ${workflowResult.runId}`);
          }
        } else if (job.runMode === "thread_follow_up") {
          shouldPollTaskStatus = false;
          taskId = job.targetTaskId?.trim();
          if (!taskId) {
            status = "needs_user_action";
            errorMsg = "Thread follow-up scheduled task is missing a target task";
          } else if (!deps.sendTaskMessage) {
            status = "needs_user_action";
            errorMsg = "Thread follow-up execution is not available in this runtime";
          } else {
            if (deps.getTaskStatus) {
              const target = await deps.getTaskStatus(taskId);
              if (!target) {
                status = "needs_user_action";
                errorMsg = `Target task not found: ${taskId}`;
              }
            }

            if (status === "ok") {
              const sent = await deps.sendTaskMessage({
                taskId,
                message: renderedPrompt,
                allowUserInput: job.allowUserInput ?? false,
                agentConfig,
              });
              job.state.lastTaskId = taskId;
              await this.persist();
              if (sent?.queued) {
                // Queued behind an active run of the thread: this schedule did not run
                // now, and the eventual result belongs to that thread, not this run.
                status = "skipped";
                errorMsg = "Follow-up queued behind an active run of the target thread";
                log.info(`Job ${job.name} queued scheduled follow-up for busy task ${taskId}`);
              } else {
                // Sending returns after the follow-up ran; classify the thread's durable
                // result rather than the fact that a message was sent.
                shouldPollTaskStatus = true;
                log.info(`Job ${job.name} sent scheduled follow-up to task ${taskId}`);
              }
            }
          }
        } else {
          // Create a task with optional model override
          const result = await deps.createTask({
            jobId: job.id,
            title: job.taskTitle || `Scheduled: ${job.name}`,
            prompt: renderedPrompt,
            workspaceId: workspaceIdForRun,
            assignedAgentRoleId: job.assignedAgentRoleId,
            modelKey: job.modelKey,
            allowUserInput: job.allowUserInput ?? false,
            agentConfig: { ...agentConfig, scheduledJobId: job.id },
          });

          taskId = result.id;
          job.state.lastTaskId = taskId;
          await this.persist();
          log.info(`Job ${job.name} created task ${taskId}`);
        }

        // If task status hooks are available, wait for completion and capture the final output.
        if (status === "ok" && shouldPollTaskStatus && taskId && deps.getTaskStatus) {
          const timeoutMs = Math.max(1, Math.floor(job.timeoutMs ?? deps.defaultTimeoutMs));
          const deadlineMs = deps.nowMs() + timeoutMs;
          const pollMs = 1500;

          // Track the resultSummary from the last status poll so we can use it
          // as a fallback if getTaskResultText returns nothing.
          let pollResultSummary: string | undefined;

          while (deps.nowMs() < deadlineMs) {
            const task = await deps.getTaskStatus(taskId);
            if (!task) {
              status = "error";
              errorMsg = "Task not found";
              break;
            }

            const taskStatus = typeof task.status === "string" ? task.status : "";
            if (taskStatus === "completed") {
              // Classify the durable task result, not whether polling returned.
              status = cronStatusForCompletedTask(task.terminalStatus);
              if (typeof task.resultSummary === "string" && task.resultSummary.trim()) {
                pollResultSummary = task.resultSummary.trim();
              }
              break;
            }
            if (taskStatus === "failed") {
              status = "error";
              errorMsg = task.error || "Task failed";
              break;
            }
            if (taskStatus === "cancelled") {
              status = "cancelled";
              errorMsg = task.error || "Task cancelled";
              break;
            }
            if (taskStatus === "paused" || taskStatus === "blocked") {
              status = "needs_user_action";
              errorMsg = task.error || `Task ${taskStatus}`;
              break;
            }
            if (taskStatus === "interrupted") {
              status = task.terminalStatus === "resume_available" ? "partial_success" : "error";
              errorMsg = task.error || "Task interrupted";
              break;
            }

            // Sleep (bounded by remaining time)
            const remaining = deadlineMs - deps.nowMs();
            const sleepMs = Math.max(0, Math.min(pollMs, remaining));
            if (sleepMs === 0) break;
            await new Promise((r) => setTimeout(r, sleepMs));
          }

          if (status === "ok" && deps.nowMs() >= deadlineMs) {
            // One last check to avoid misclassifying a completed task as a timeout.
            const finalTask = await deps.getTaskStatus(taskId);
            const finalStatus = typeof finalTask?.status === "string" ? finalTask.status : "";
            if (finalStatus === "completed") {
              status = cronStatusForCompletedTask(finalTask?.terminalStatus);
              if (
                !pollResultSummary &&
                typeof finalTask?.resultSummary === "string" &&
                finalTask.resultSummary.trim()
              ) {
                pollResultSummary = finalTask.resultSummary.trim();
              }
            } else if (finalStatus === "failed") {
              status = "error";
              errorMsg = finalTask?.error || "Task failed";
            } else if (finalStatus === "cancelled") {
              status = "cancelled";
              errorMsg = finalTask?.error || "Task cancelled";
            } else if (finalStatus === "paused" || finalStatus === "blocked") {
              status = "needs_user_action";
              errorMsg = finalTask?.error || `Task ${finalStatus}`;
            } else if (finalStatus === "interrupted") {
              status =
                finalTask?.terminalStatus === "resume_available" ? "partial_success" : "error";
              errorMsg = finalTask?.error || "Task interrupted";
            } else if (!finalTask) {
              status = "error";
              errorMsg = "Task not found";
            } else {
              status = "timeout";
              errorMsg = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
              taskStillRunning = Boolean(finalTask && taskId);
            }
          }

          if (status === "ok" || status === "partial_success" || status === "needs_user_action") {
            if (deps.getTaskResultText) {
              try {
                resultText = await deps.getTaskResultText(taskId);
              } catch (e) {
                log.warn("Failed to load task result text", e);
              }
            }
            // Fall back to resultSummary from the status poll if getTaskResultText
            // returned nothing (e.g. event scan missed the output).
            if (!resultText && pollResultSummary) {
              resultText = pollResultSummary;
            }
          }
        }
      } catch (error) {
        errorMsg = error instanceof Error ? error.message : String(error);
        status = "error";
        log.error(`Job ${job.name} failed: ${errorMsg}`);
      }

      const durationMs = Date.now() - startTime;

      // Update job state
      job.state.lastDurationMs = durationMs;
      job.state.runningAtMs = undefined;
      job.state.runningRunMode = undefined;
      job.state.lastStatus = status;
      job.state.lastError = errorMsg;

      // History, legacy counters and versioned outcome counts are recorded together.
      const historyEntry: CronRunHistoryEntry = {
        runAtMs: nowMs,
        durationMs,
        status,
        error: errorMsg,
        taskId,
        taskStillRunning,
        runMode: job.runMode ?? "new_task",
        workspaceId: workspaceIdForRun,
        runWorkspacePath: workspaceContext?.runWorkspacePath,
        deliveryAttempts: 0,
        deliverableStatus: "none",
      };
      recordCronRunCompletion(
        job.state,
        historyEntry,
        job.maxHistoryEntries ?? deps.maxHistoryEntries,
      );

      // Handle one-shot jobs
      if (job.deleteAfterRun) {
        const index = store.jobs.findIndex((j) => j.id === job.id);
        if (index !== -1) {
          store.jobs.splice(index, 1);
        }
        log.info(`Deleted one-shot job: ${job.name}`);
      } else {
        // Compute next run time
        job.state.nextRunAtMs = job.enabled
          ? this.computeNextFutureRunAtMs(job.schedule, nowMs)
          : undefined;
      }

      await this.persist();
      this.armTimer();
      this.armOutboxTimer();

      // Deliver results to channel if configured
      const deliveryResult = await this.deliverToChannel(
        job,
        status,
        taskId,
        errorMsg,
        resultText,
        nowMs,
      );

      // Update this run's history entry (the object recorded above, which another run
      // of the same job may have moved from the front). Delivery facts are stored
      // beside, never instead of, the execution outcome.
      if (deliveryResult.attempted) {
        historyEntry.deliveryStatus = deliveryResult.success
          ? deliveryResult.deliverableStatus === "queued"
            ? "skipped"
            : "success"
          : "failed";
        if (deliveryResult.error) {
          historyEntry.deliveryError = deliveryResult.error;
        }
        historyEntry.deliveryMode = deliveryResult.mode;
        historyEntry.deliveryAttempts = deliveryResult.attempts;
        historyEntry.deliverableStatus = deliveryResult.deliverableStatus;
        await this.persist();
      }

      this.emit({
        jobId: job.id,
        action: "finished",
        runAtMs: nowMs,
        durationMs,
        status,
        error: errorMsg,
        taskId,
        taskStillRunning,
        nextRunAtMs: job.state.nextRunAtMs,
      });

      if (taskId) {
        return { ok: true, ran: true, taskId };
      } else {
        return { ok: false, error: errorMsg || "Unknown error" };
      }
    } finally {
      this.state.runningJobIds.delete(job.id);
      this.armTimer();
    }
  }

  /**
   * Deliver job results to a configured channel
   */
  private async deliverToChannel(
    job: CronJob,
    status: CronJobStatus,
    taskId?: string,
    error?: string,
    resultText?: string,
    runAtMs?: number,
  ): Promise<{
    attempted: boolean;
    success?: boolean;
    error?: string;
    mode?: "direct" | "outbox";
    attempts: number;
    deliverableStatus: "none" | "queued" | "sent" | "dead_letter";
  }> {
    const { deps, log } = this.getContext();

    // Check if delivery is configured and enabled
    if (!job.delivery?.enabled || !deps.deliverToChannel) {
      return { attempted: false, attempts: 0, deliverableStatus: "none" };
    }

    const {
      channelType,
      channelDbId,
      channelId,
      deliverOnSuccess,
      deliverOnError,
      summaryOnly,
      deliverOnlyIfResult,
    } = job.delivery;

    // Check if we should deliver based on status
    const isSuccess =
      status === "ok" || status === "partial_success" || status === "needs_user_action";
    const shouldDeliver =
      (isSuccess && deliverOnSuccess !== false) || (!isSuccess && deliverOnError !== false);

    if (!shouldDeliver || !channelType || !channelId) {
      return { attempted: false, attempts: 0, deliverableStatus: "none" };
    }

    if (isSuccess && deliverOnlyIfResult) {
      const hasNonEmpty = typeof resultText === "string" && resultText.trim().length > 0;
      if (!hasNonEmpty) {
        log.info(
          `Skipping delivery for job "${job.name}": deliverOnlyIfResult is enabled but no result text available`,
        );
        return { attempted: false, attempts: 0, deliverableStatus: "none" };
      }
    }

    const runKey = Number.isFinite(runAtMs)
      ? Math.trunc(runAtMs as number)
      : this.state.deps.nowMs();
    const idempotencyKey = `${job.id}:${runKey}:${taskId || "no-task"}:${channelType}:${channelId}`;
    const doDeliver = () =>
      deps.deliverToChannel!({
        channelType,
        channelDbId,
        channelId,
        jobName: job.name,
        status,
        taskId,
        error,
        summaryOnly,
        resultText,
        idempotencyKey,
      });

    let attempts = 0;
    try {
      attempts += 1;
      await doDeliver();
      log.info(`Delivered results for job "${job.name}" to ${channelType}:${channelId}`);
      return {
        attempted: true,
        success: true,
        mode: "direct",
        attempts,
        deliverableStatus: "sent",
      };
    } catch (deliveryError) {
      const errMsg = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
      const outboxQueued = this.enqueueOutboxEntry({
        job,
        runAtMs: runAtMs ?? this.state.deps.nowMs(),
        status,
        channelType,
        channelDbId,
        channelId,
        summaryOnly,
        resultText,
        error,
        taskId,
        idempotencyKey,
      });
      if (outboxQueued) {
        log.warn(
          `Direct delivery failed for job "${job.name}"; queued in outbox for retry`,
          deliveryError,
        );
        return {
          attempted: true,
          success: true,
          mode: "outbox",
          attempts,
          error: errMsg,
          deliverableStatus: "queued",
        };
      }

      log.error(`Failed to deliver results for job "${job.name}":`, deliveryError);
      return {
        attempted: true,
        success: false,
        error: errMsg,
        mode: "direct",
        attempts,
        deliverableStatus: "dead_letter",
      };
    }
  }

  private async renderTaskPrompt(
    job: CronJob,
    runAtMs: number,
    prevRunAtMs?: number,
    workspaceContext?: CronWorkspaceContext | null,
  ): Promise<string> {
    const { deps, log } = this.getContext();
    const template = job.taskPrompt;
    if (typeof template !== "string" || template.length === 0) return template;

    const formatLocalYmd = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const base = new Date(runAtMs);
    const today = formatLocalYmd(base);
    const tomorrowDate = new Date(base);
    tomorrowDate.setDate(base.getDate() + 1);
    const tomorrow = formatLocalYmd(tomorrowDate);
    const weekEndDate = new Date(base);
    weekEndDate.setDate(base.getDate() + 6);
    const weekEnd = formatLocalYmd(weekEndDate);

    let rendered = template
      // Keep compatibility with ES2020 builds (String.prototype.replaceAll is ES2021).
      .split("{{now}}")
      .join(base.toISOString())
      .split("{{date}}")
      .join(today)
      .split("{{today}}")
      .join(today)
      .split("{{tomorrow}}")
      .join(tomorrow)
      .split("{{week_end}}")
      .join(weekEnd);

    const vars: Record<string, string> = {
      prev_run: prevRunAtMs ? new Date(prevRunAtMs).toISOString() : "",
    };
    if (workspaceContext?.workspacePath) {
      vars.workspace_path = workspaceContext.workspacePath;
      vars.job_workspace_path = workspaceContext.workspacePath;
    }
    if (workspaceContext?.runWorkspacePath) {
      vars.run_workspace_path = workspaceContext.runWorkspacePath;
      vars.run_workspace = workspaceContext.runWorkspacePath;
      vars.run_workspace_relpath = workspaceContext.runWorkspaceRelativePath || "";
    }

    if (deps.resolveTemplateVariables) {
      try {
        const extra = await deps.resolveTemplateVariables({ job, runAtMs, prevRunAtMs });
        if (extra && typeof extra === "object") {
          for (const [k, v] of Object.entries(extra)) {
            if (!k) continue;
            vars[k] = typeof v === "string" ? v : String(v);
          }
        }
      } catch (e) {
        log.warn("Template variable resolution failed", e);
      }
    }

    for (const [k, v] of Object.entries(vars)) {
      // Escape {{ in values to prevent re-interpolation of user-controlled content
      const safeValue = v.replace(/\{\{/g, "{ {");
      rendered = rendered.split(`{{${k}}}`).join(safeValue);
    }

    const hasEnabledChannelDelivery =
      job.delivery?.enabled === true &&
      Boolean(job.delivery.channelType && job.delivery.channelId && deps.deliverToChannel);
    if (hasEnabledChannelDelivery) {
      rendered = [
        "Scheduled task delivery:",
        "- Produce the final result in your assistant response.",
        "- Do not call channel, messaging, or notification tools to message the user yourself.",
        "- The scheduler will deliver your final response through the configured channel.",
        "",
        rendered,
      ].join("\n");
    }

    if (workspaceContext?.runWorkspacePath) {
      const workspacePath = workspaceContext.workspacePath || "";
      const relativePath = workspaceContext.runWorkspaceRelativePath
        ? `./${workspaceContext.runWorkspaceRelativePath}`
        : workspaceContext.runWorkspacePath;
      rendered = [
        "Scheduled run context:",
        `- Workspace root: ${workspacePath || "(unknown)"}`,
        `- Run folder: ${workspaceContext.runWorkspacePath}`,
        `- Run folder (relative): ${relativePath}`,
        "Use the run folder for temporary or intermediate files for this execution.",
        "Keep durable outputs outside the run folder only when explicitly required.",
        "",
        rendered,
      ].join("\n");
    }

    if (job.runMode === "thread_follow_up") {
      const thread = job.threadAutomation;
      rendered = [
        "Scheduled thread wake:",
        `- Job: ${job.name}`,
        `- Target task ID: ${job.targetTaskId || thread?.sourceTaskId || "(missing)"}`,
        thread?.sourceTaskTitle ? `- Source task: ${thread.sourceTaskTitle}` : null,
        thread?.sourceLink ? `- Source link: ${thread.sourceLink}` : null,
        prevRunAtMs ? `- Previous scheduled wake: ${new Date(prevRunAtMs).toISOString()}` : null,
        thread?.wakeObjective ? `- Wake objective: ${thread.wakeObjective}` : null,
        "- Continue this existing conversation. Use the prior task timeline as context and report only the useful update for this wake.",
        "",
        rendered,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
    }

    return rendered;
  }

  /**
   * Arm the timer for the next job execution
   */
  private armTimer(): void {
    this.stopTimer();

    const { deps, log } = this.getContext();
    if (!deps.cronEnabled || !this.state.schedulerStarted) return;

    const store = this.ensureStore();
    const nowMs = deps.nowMs();

    // Find the next job to run
    const nextWake = store.jobs
      .filter(
        (job) =>
          (job.enabled || job.state.runningAtMs !== undefined) &&
          !this.state.runningJobIds.has(job.id),
      )
      .map((job) => ({
        job,
        atMs: Math.min(
          job.enabled ? (job.state.nextRunAtMs ?? Infinity) : Infinity,
          job.state.runningAtMs !== undefined
            ? job.state.lastTaskId && deps.getTaskStatus
              ? nowMs + PERSISTED_TASK_RECHECK_INTERVAL_MS
              : job.state.runningAtMs + this.getJobTimeoutMs(job)
            : Infinity,
        ),
      }))
      .sort((a, b) => a.atMs - b.atMs)[0];

    if (!nextWake || !Number.isFinite(nextWake.atMs)) {
      log.debug("No jobs scheduled");
      return;
    }

    let delayMs = nextWake.atMs - nowMs;

    // Clamp delay to prevent overflow
    if (delayMs > MAX_TIMEOUT_MS) {
      log.debug(`Clamping timer delay from ${delayMs}ms to ${MAX_TIMEOUT_MS}ms`);
      delayMs = MAX_TIMEOUT_MS;
    }

    // Don't set timer for past times
    if (delayMs <= 0) {
      delayMs = 1;
    }

    log.debug(`Next scheduler wake for "${nextWake.job.name}" in ${Math.round(delayMs / 1000)}s`);

    this.state.timer = setTimeout(() => {
      this.onTimer().catch((err) => {
        log.error("Timer callback error:", err);
      });
    }, delayMs);
  }

  private stopTimer(): void {
    if (this.state.timer) {
      clearTimeout(this.state.timer);
      this.state.timer = null;
    }
  }

  private computeOutboxBackoffMs(attempt: number): number {
    const safeAttempt = Math.max(1, attempt);
    const baseMs = 5000 * Math.pow(2, safeAttempt - 1);
    const cappedMs = Math.min(baseMs, 5 * 60 * 1000);
    const jitterMs = Math.floor(Math.random() * 1000);
    return cappedMs + jitterMs;
  }

  private enqueueOutboxEntry(params: {
    job: CronJob;
    runAtMs: number;
    status: CronJobStatus;
    channelType: NonNullable<CronJob["delivery"]>["channelType"];
    channelDbId?: string;
    channelId: string;
    summaryOnly?: boolean;
    resultText?: string;
    error?: string;
    taskId?: string;
    idempotencyKey: string;
    initialAttemptCount?: number;
    attemptImmediately?: boolean;
  }): boolean {
    const store = this.ensureStore();
    const channelType = params.channelType;
    if (!channelType) return false;

    if (
      store.outbox?.some(
        (entry) =>
          entry.idempotencyKey === params.idempotencyKey &&
          (entry.state === "queued" || entry.state === "sent"),
      )
    ) {
      return true;
    }

    const nowMs = this.state.deps.nowMs();
    const entry: CronOutboxEntry = {
      id: uuidv4(),
      jobId: params.job.id,
      runAtMs: params.runAtMs,
      queuedAtMs: nowMs,
      nextAttemptAtMs: params.attemptImmediately ? nowMs : nowMs + this.computeOutboxBackoffMs(1),
      attempts: 0,
      maxAttempts: 6,
      initialAttemptCount: params.initialAttemptCount ?? 1,
      status: params.status,
      channelType,
      channelDbId: params.channelDbId,
      channelId: params.channelId,
      summaryOnly: params.summaryOnly,
      resultText: params.resultText,
      error: params.error,
      taskId: params.taskId,
      idempotencyKey: params.idempotencyKey,
      state: "queued",
    };
    store.outbox = store.outbox ?? [];
    store.outbox.push(entry);
    this.armOutboxTimer();
    return true;
  }

  private updateRunHistoryDeliveryFromOutbox(entry: CronOutboxEntry): void {
    const store = this.ensureStore();
    const job = store.jobs.find((j) => j.id === entry.jobId);
    if (!job?.state?.runHistory?.length) return;
    const history = job.state.runHistory.find((h) => h.runAtMs === entry.runAtMs);
    if (!history) return;
    history.deliveryMode = "outbox";
    // Include the initial direct delivery attempt that queued this outbox entry.
    const initialAttemptCount = entry.initialAttemptCount ?? 1;
    history.deliveryAttempts = initialAttemptCount + entry.attempts;
    if (entry.state === "sent") {
      history.deliveryStatus = "success";
      history.deliverableStatus = "sent";
      history.deliveryError = undefined;
      return;
    }
    if (entry.state === "dead_letter") {
      history.deliveryStatus = "failed";
      history.deliverableStatus = "dead_letter";
      history.deliveryError = entry.lastError;
      return;
    }
    history.deliveryStatus = "skipped";
    history.deliverableStatus = "queued";
    history.deliveryError = entry.lastError;
  }

  private async processOutboxQueue(): Promise<void> {
    if (this.state.processingOutbox) return;
    this.state.processingOutbox = true;

    try {
      await this.withLock(async () => {
        const { deps, log } = this.getContext();
        if (!deps.deliverToChannel) return;
        const store = this.ensureStore();
        const nowMs = deps.nowMs();
        const outbox = store.outbox ?? [];
        let changed = false;

        const dueEntries = outbox
          .filter((entry) => entry.state === "queued" && entry.nextAttemptAtMs <= nowMs)
          .slice(0, 10);

        for (const entry of dueEntries) {
          entry.attempts += 1;
          entry.lastAttemptAtMs = nowMs;
          try {
            await deps.deliverToChannel({
              channelType: entry.channelType,
              channelDbId: entry.channelDbId,
              channelId: entry.channelId,
              jobName: store.jobs.find((j) => j.id === entry.jobId)?.name || "Scheduled Task",
              status: entry.status,
              taskId: entry.taskId,
              error: entry.error,
              summaryOnly: entry.summaryOnly,
              resultText: entry.resultText,
              idempotencyKey: entry.idempotencyKey,
            });
            entry.state = "sent";
            entry.lastError = undefined;
            this.updateRunHistoryDeliveryFromOutbox(entry);
            changed = true;
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            entry.lastError = errMsg;
            if (entry.attempts >= entry.maxAttempts) {
              entry.state = "dead_letter";
              this.updateRunHistoryDeliveryFromOutbox(entry);
              changed = true;
              log.error("metric cron_dead_letter_total=1", {
                jobId: entry.jobId,
                outboxId: entry.id,
              });
              log.error(
                `Cron outbox dead-lettered entry ${entry.id} (${entry.channelType}:${entry.channelId})`,
                { jobId: entry.jobId, error: errMsg, attempts: entry.attempts },
              );
            } else {
              entry.nextAttemptAtMs = nowMs + this.computeOutboxBackoffMs(entry.attempts + 1);
              this.updateRunHistoryDeliveryFromOutbox(entry);
              changed = true;
              log.warn("metric cron_outbox_retry_total=1", {
                jobId: entry.jobId,
                outboxId: entry.id,
                attempts: entry.attempts,
              });
              log.warn(
                `Cron outbox retry scheduled for entry ${entry.id} in ${Math.round((entry.nextAttemptAtMs - nowMs) / 1000)}s`,
                { jobId: entry.jobId, error: errMsg, attempts: entry.attempts },
              );
            }
          }
        }

        if (changed) {
          await this.persist();
        }
      });
    } finally {
      this.state.processingOutbox = false;
      this.armOutboxTimer();
    }
  }

  private armOutboxTimer(): void {
    this.stopOutboxTimer();
    const store = this.ensureStore();
    const nowMs = this.state.deps.nowMs();
    const next = (store.outbox ?? [])
      .filter((entry) => entry.state === "queued")
      .sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs)[0];
    if (!next) return;
    const delayMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, next.nextAttemptAtMs - nowMs));
    this.state.outboxTimer = setTimeout(() => {
      this.processOutboxQueue().catch((error) => {
        this.getContext().log.error("Outbox processing error", error);
      });
    }, delayMs);
  }

  private stopOutboxTimer(): void {
    if (this.state.outboxTimer) {
      clearTimeout(this.state.outboxTimer);
      this.state.outboxTimer = null;
    }
  }

  /**
   * Timer callback - runs due jobs
   */
  private async onTimer(): Promise<void> {
    // Prevent concurrent timer callbacks
    if (this.state.running || !this.state.schedulerStarted) return;
    this.state.running = true;

    try {
      const prepared = await this.withLock(async () => {
        const { deps, log } = this.getContext();
        const nowMs = deps.nowMs();
        if (!deps.cronEnabled || !this.state.schedulerStarted) {
          return { jobs: [] as CronJob[], nowMs };
        }

        const store = this.ensureStore();
        // Recheck persisted task state at each wake. A run restored after restart
        // must not be duplicated by this timer path, which otherwise bypasses run().
        await this.reconcileLoadedJobs(nowMs);
        if (!this.state.schedulerStarted) return { jobs: [] as CronJob[], nowMs };
        await this.persist();

        const dueJobs = store.jobs.filter(
          (job) =>
            job.enabled &&
            job.state.nextRunAtMs !== undefined &&
            job.state.nextRunAtMs <= nowMs &&
            !this.state.runningJobIds.has(job.id),
        );
        dueJobs.sort((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));

        const availableSlots = deps.maxConcurrentRuns - this.state.runningJobIds.size;
        const jobs = dueJobs.slice(0, Math.max(0, availableSlots));
        for (const job of jobs) this.state.runningJobIds.add(job.id);

        if (dueJobs.length > jobs.length) {
          log.debug(
            `${dueJobs.length} jobs due, running ${jobs.length} (max concurrent: ${deps.maxConcurrentRuns})`,
          );
        }
        return { jobs, nowMs };
      });

      for (const job of prepared.jobs) {
        if (!this.state.schedulerStarted) {
          this.state.runningJobIds.delete(job.id);
          continue;
        }
        try {
          await this.executeJob(job, prepared.nowMs);
        } catch (error) {
          this.getContext().log.error(`Failed to execute job ${job.name}:`, error);
        }
      }
    } finally {
      this.state.running = false;
      this.armTimer();
    }
  }

  /**
   * Clear run history for a job
   */
  async clearRunHistory(jobId: string): Promise<boolean> {
    return this.withLock(async () => {
      const store = this.ensureStore();
      const job = store.jobs.find((j) => j.id === jobId);
      if (!job) return false;

      resetCronOutcomeCounts(job.state);

      await this.persist();
      return true;
    });
  }
}

// Singleton instance
let cronService: CronService | null = null;

export function getCronService(): CronService | null {
  return cronService;
}

export function setCronService(service: CronService | null): void {
  cronService = service;
}
