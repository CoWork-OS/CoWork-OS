/**
 * CronService - Manages scheduled task execution
 * Handles job lifecycle, timer management, and task creation
 */

import { v4 as uuidv4 } from "uuid";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronServiceDeps,
  CronStoreFile,
  CronStatusSummary,
  CronRunResult,
  CronRemoveResult,
  CronAddResult,
  CronUpdateResult,
  CronListResult,
  CronEvent,
  CronRunHistoryEntry,
  CronRunHistoryResult,
  CronWebhookConfig,
  CronWorkspaceContext,
  CronOutboxEntry,
} from "./types";
import { loadCronStore, saveCronStore, resolveCronStorePath } from "./store";
import { computeNextRunAtMs } from "./schedule";
import { CronWebhookServer } from "./webhook";

// Maximum timeout value to prevent overflow warnings (2^31 - 1 ms, ~24.8 days)
const MAX_TIMEOUT_MS = 2147483647;

// Defaults
const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_HISTORY_ENTRIES = 10;

// Default logger
const defaultLog = {
  debug: (msg: string, data?: unknown) => console.log(`[Cron] ${msg}`, data ?? ""),
  info: (msg: string, data?: unknown) => console.log(`[Cron] ${msg}`, data ?? ""),
  warn: (msg: string, data?: unknown) => console.warn(`[Cron] ${msg}`, data ?? ""),
  error: (msg: string, data?: unknown) => console.error(`[Cron] ${msg}`, data ?? ""),
};

interface CronServiceState {
  deps: Required<
    Omit<
      CronServiceDeps,
      | "nowMs"
      | "onEvent"
      | "log"
      | "maxConcurrentRuns"
      | "defaultTimeoutMs"
      | "maxHistoryEntries"
      | "webhook"
      | "deliverToChannel"
      | "getTaskStatus"
      | "getTaskResultText"
      | "resolveTemplateVariables"
      | "resolveWorkspaceContext"
    >
  > & {
    nowMs: () => number;
    onEvent?: (evt: CronEvent) => void;
    log: typeof defaultLog;
    maxConcurrentRuns: number;
    defaultTimeoutMs: number;
    maxHistoryEntries: number;
    webhook?: CronWebhookConfig;
    getTaskStatus?: CronServiceDeps["getTaskStatus"];
    getTaskResultText?: CronServiceDeps["getTaskResultText"];
    deliverToChannel?: CronServiceDeps["deliverToChannel"];
    resolveTemplateVariables?: CronServiceDeps["resolveTemplateVariables"];
    resolveWorkspaceContext?: CronServiceDeps["resolveWorkspaceContext"];
  };
  store: CronStoreFile | null;
  timer: ReturnType<typeof setTimeout> | null;
  outboxTimer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  processingOutbox: boolean;
  runningJobIds: Set<string>; // Track currently running jobs
  opLock: Promise<unknown>;
  webhookServer: CronWebhookServer | null;
}

export class CronService {
  private state: CronServiceState;

  constructor(deps: CronServiceDeps) {
    this.state = {
      deps: {
        ...deps,
        nowMs: deps.nowMs ?? (() => Date.now()),
        log: deps.log ?? defaultLog,
        maxConcurrentRuns: deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
        defaultTimeoutMs: deps.defaultTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
        maxHistoryEntries: deps.maxHistoryEntries ?? DEFAULT_MAX_HISTORY_ENTRIES,
        webhook: deps.webhook,
        getTaskStatus: deps.getTaskStatus,
        getTaskResultText: deps.getTaskResultText,
        deliverToChannel: deps.deliverToChannel,
        resolveTemplateVariables: deps.resolveTemplateVariables,
        resolveWorkspaceContext: deps.resolveWorkspaceContext,
      },
      store: null,
      timer: null,
      outboxTimer: null,
      running: false,
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
    await this.withLock(async () => {
      const { deps, log } = this.getContext();

      if (!deps.cronEnabled) {
        log.info("Cron service disabled");
        return;
      }

      const storePath = resolveCronStorePath(deps.storePath);
      this.state.store = await loadCronStore(storePath);

      const enabledCount = this.state.store.jobs.filter((j) => j.enabled).length;
      log.info(`Cron service started with ${enabledCount} enabled jobs`);

      // Compute next run times for all enabled jobs
      const nowMs = deps.nowMs();
      for (const job of this.state.store.jobs) {
        if (job.enabled && !job.state.nextRunAtMs) {
          job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);
        }
      }

      await this.persist();
      this.armTimer();
      this.armOutboxTimer();

      // Start webhook server if configured
      if (deps.webhook?.enabled) {
        await this.startWebhookServer();
      }
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
    this.stopTimer();
    this.stopOutboxTimer();

    // Stop webhook server if running
    if (this.state.webhookServer) {
      await this.state.webhookServer.stop();
      this.state.webhookServer = null;
    }

    this.state.store = null;
    this.getContext().log.info("Cron service stopped");
  }

  /**
   * Get service status
   */
  async status(): Promise<CronStatusSummary> {
    return this.withLock(async () => {
      const { deps } = this.getContext();
      const store = this.ensureStore();

      const nextJob = store.jobs
        .filter((j) => j.enabled && j.state.nextRunAtMs)
        .sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity))[0];

      const webhookAddr = this.state.webhookServer?.getAddress();

      return {
        enabled: deps.cronEnabled,
        storePath: resolveCronStorePath(deps.storePath),
        jobCount: store.jobs.length,
        enabledJobCount: store.jobs.filter((j) => j.enabled).length,
        runningJobCount: this.state.runningJobIds.size,
        maxConcurrentRuns: deps.maxConcurrentRuns,
        nextWakeAtMs: nextJob?.state.nextRunAtMs ?? null,
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

      const job: CronJob = {
        id: uuidv4(),
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        deleteAfterRun: input.deleteAfterRun,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        schedule: input.schedule,
        workspaceId: input.workspaceId,
        taskPrompt: input.taskPrompt,
        taskTitle: input.taskTitle,
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

      // Apply patch - basic fields
      if (patch.name !== undefined) job.name = patch.name;
      if (patch.description !== undefined) job.description = patch.description;
      if (patch.enabled !== undefined) job.enabled = patch.enabled;
      if (patch.deleteAfterRun !== undefined) job.deleteAfterRun = patch.deleteAfterRun;
      if (patch.schedule !== undefined) job.schedule = patch.schedule;
      if (patch.workspaceId !== undefined) job.workspaceId = patch.workspaceId;
      if (patch.taskPrompt !== undefined) job.taskPrompt = patch.taskPrompt;
      if (patch.taskTitle !== undefined) job.taskTitle = patch.taskTitle;
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

      // Check if due (unless forcing)
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

  private async resolveWorkspaceContext(
    job: CronJob,
    nowMs: number,
    phase: "add" | "run",
  ): Promise<CronWorkspaceContext | null> {
    const resolver = this.state.deps.resolveWorkspaceContext;
    if (!resolver) return null;

    const context = await resolver({ job, nowMs, phase });
    if (!context) return null;

    const workspaceId =
      typeof context.workspaceId === "string" ? context.workspaceId.trim() : "";
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

  /**
   * Execute a job and create a task
   */
  private async executeJob(job: CronJob, nowMs: number): Promise<CronRunResult> {
    const { deps, log } = this.getContext();
    const store = this.ensureStore();

    // Track that this job is running
    this.state.runningJobIds.add(job.id);

    log.info(`Executing job: ${job.name} (${job.id})`);
    this.emit({ jobId: job.id, action: "started", runAtMs: nowMs });

    const prevRunAtMs = job.state.lastRunAtMs;
    job.state.runningAtMs = nowMs;
    job.state.lastRunAtMs = nowMs;

    const startTime = Date.now();
    let taskId: string | undefined;
    let status: "ok" | "partial_success" | "error" | "timeout" = "ok";
    let errorMsg: string | undefined;
    let resultText: string | undefined;
    let workspaceContext: CronWorkspaceContext | null = null;
    let workspaceIdForRun = job.workspaceId;

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

      // Create a task with optional model override
      const result = await deps.createTask({
        title: job.taskTitle || `Scheduled: ${job.name}`,
        prompt: renderedPrompt,
        workspaceId: workspaceIdForRun,
        modelKey: job.modelKey,
        allowUserInput: false,
        agentConfig: job.taskAgentConfig,
      });

      taskId = result.id;
      job.state.lastTaskId = taskId;
      log.info(`Job ${job.name} created task ${taskId}`);

      // If task status hooks are available, wait for completion and capture the final output.
      if (deps.getTaskStatus) {
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
            status = task.terminalStatus === "partial_success" ? "partial_success" : "ok";
            if (typeof task.resultSummary === "string" && task.resultSummary.trim()) {
              pollResultSummary = task.resultSummary.trim();
            }
            break;
          }
          if (taskStatus === "failed" || taskStatus === "cancelled") {
            status = "error";
            errorMsg = task.error || `Task ${taskStatus}`;
            break;
          }
          if (taskStatus === "paused" || taskStatus === "blocked") {
            status = "error";
            errorMsg = `Task ${taskStatus}`;
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
            status = finalTask?.terminalStatus === "partial_success" ? "partial_success" : "ok";
            if (
              !pollResultSummary &&
              typeof finalTask?.resultSummary === "string" &&
              finalTask.resultSummary.trim()
            ) {
              pollResultSummary = finalTask.resultSummary.trim();
            }
          } else if (finalStatus === "failed" || finalStatus === "cancelled") {
            status = "error";
            errorMsg = finalTask?.error || `Task ${finalStatus || "failed"}`;
          } else {
            status = "timeout";
            errorMsg = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
          }
        }

        if (status === "ok" || status === "partial_success") {
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
    job.state.lastStatus = status;
    job.state.lastError = errorMsg;

    // Update run statistics
    job.state.totalRuns = (job.state.totalRuns ?? 0) + 1;
    if (status === "ok" || status === "partial_success") {
      job.state.successfulRuns = (job.state.successfulRuns ?? 0) + 1;
    } else {
      job.state.failedRuns = (job.state.failedRuns ?? 0) + 1;
    }

    // Add to run history
    const historyEntry: CronRunHistoryEntry = {
      runAtMs: nowMs,
      durationMs,
      status,
      error: errorMsg,
      taskId,
      workspaceId: workspaceIdForRun,
      runWorkspacePath: workspaceContext?.runWorkspacePath,
      deliveryAttempts: 0,
      deliverableStatus: "none",
    };
    job.state.runHistory = job.state.runHistory ?? [];
    job.state.runHistory.unshift(historyEntry);

    // Trim history to max entries
    const maxEntries = job.maxHistoryEntries ?? deps.maxHistoryEntries;
    if (job.state.runHistory.length > maxEntries) {
      job.state.runHistory = job.state.runHistory.slice(0, maxEntries);
    }

    // Remove from running jobs
    this.state.runningJobIds.delete(job.id);

    // Handle one-shot jobs
    if (job.deleteAfterRun) {
      const index = store.jobs.findIndex((j) => j.id === job.id);
      if (index !== -1) {
        store.jobs.splice(index, 1);
      }
      log.info(`Deleted one-shot job: ${job.name}`);
    } else {
      // Compute next run time
      job.state.nextRunAtMs = job.enabled ? computeNextRunAtMs(job.schedule, nowMs) : undefined;
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

    // Update history entry with delivery status
    if (deliveryResult.attempted && job.state.runHistory?.[0]) {
      job.state.runHistory[0].deliveryStatus = deliveryResult.success
        ? deliveryResult.deliverableStatus === "queued"
          ? "skipped"
          : "success"
        : "failed";
      if (deliveryResult.error) {
        job.state.runHistory[0].deliveryError = deliveryResult.error;
      }
      job.state.runHistory[0].deliveryMode = deliveryResult.mode;
      job.state.runHistory[0].deliveryAttempts = deliveryResult.attempts;
      job.state.runHistory[0].deliverableStatus = deliveryResult.deliverableStatus;
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
      nextRunAtMs: job.state.nextRunAtMs,
    });

    if (taskId) {
      return { ok: true, ran: true, taskId };
    } else {
      return { ok: false, error: errorMsg || "Unknown error" };
    }
  }

  /**
   * Deliver job results to a configured channel
   */
  private async deliverToChannel(
    job: CronJob,
    status: "ok" | "partial_success" | "error" | "timeout",
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
    const isSuccess = status === "ok" || status === "partial_success";
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

    const runKey = Number.isFinite(runAtMs) ? Math.trunc(runAtMs as number) : this.state.deps.nowMs();
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
      rendered = rendered.split(`{{${k}}}`).join(v);
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

    return rendered;
  }

  /**
   * Arm the timer for the next job execution
   */
  private armTimer(): void {
    this.stopTimer();

    const { deps, log } = this.getContext();
    if (!deps.cronEnabled) return;

    const store = this.ensureStore();
    const nowMs = deps.nowMs();

    // Find the next job to run
    const nextJob = store.jobs
      .filter((j) => j.enabled && j.state.nextRunAtMs)
      .sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity))[0];

    if (!nextJob || !nextJob.state.nextRunAtMs) {
      log.debug("No jobs scheduled");
      return;
    }

    let delayMs = nextJob.state.nextRunAtMs - nowMs;

    // Clamp delay to prevent overflow
    if (delayMs > MAX_TIMEOUT_MS) {
      log.debug(`Clamping timer delay from ${delayMs}ms to ${MAX_TIMEOUT_MS}ms`);
      delayMs = MAX_TIMEOUT_MS;
    }

    // Don't set timer for past times
    if (delayMs <= 0) {
      delayMs = 1;
    }

    log.debug(`Next job "${nextJob.name}" in ${Math.round(delayMs / 1000)}s`);

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
    status: "ok" | "partial_success" | "error" | "timeout";
    channelType: NonNullable<CronJob["delivery"]>["channelType"];
    channelDbId?: string;
    channelId: string;
    summaryOnly?: boolean;
    resultText?: string;
    error?: string;
    taskId?: string;
    idempotencyKey: string;
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
      nextAttemptAtMs: nowMs + this.computeOutboxBackoffMs(1),
      attempts: 0,
      maxAttempts: 6,
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
    history.deliveryAttempts = Math.max(1, entry.attempts + 1);
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
    if (this.state.running) return;
    this.state.running = true;

    try {
      const { deps, log } = this.getContext();
      const store = this.ensureStore();
      const nowMs = deps.nowMs();

      // Find all due jobs that aren't already running
      const dueJobs = store.jobs.filter(
        (j) =>
          j.enabled &&
          j.state.nextRunAtMs &&
          j.state.nextRunAtMs <= nowMs &&
          !this.state.runningJobIds.has(j.id),
      );

      // Sort by next run time (oldest first)
      dueJobs.sort((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));

      // Execute due jobs up to max concurrent limit
      const availableSlots = deps.maxConcurrentRuns - this.state.runningJobIds.size;
      const jobsToRun = dueJobs.slice(0, Math.max(0, availableSlots));

      if (dueJobs.length > jobsToRun.length) {
        log.debug(
          `${dueJobs.length} jobs due, running ${jobsToRun.length} (max concurrent: ${deps.maxConcurrentRuns})`,
        );
      }

      // Execute jobs
      for (const job of jobsToRun) {
        try {
          await this.executeJob(job, nowMs);
        } catch (error) {
          log.error(`Failed to execute job ${job.name}:`, error);
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

      job.state.runHistory = [];
      job.state.totalRuns = 0;
      job.state.successfulRuns = 0;
      job.state.failedRuns = 0;

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
