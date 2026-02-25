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
  };
  store: CronStoreFile | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
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
      },
      store: null,
      timer: null,
      running: false,
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
      const { deps } = this.getContext();
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
      const { deps, log } = this.getContext();
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
      this.state.store = { version: 1, jobs: [] };
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
    let status: "ok" | "error" | "timeout" = "ok";
    let errorMsg: string | undefined;
    let resultText: string | undefined;

    try {
      const renderedPrompt = await this.renderTaskPrompt(job, nowMs, prevRunAtMs);

      // Create a task with optional model override
      const result = await deps.createTask({
        title: job.taskTitle || `Scheduled: ${job.name}`,
        prompt: renderedPrompt,
        workspaceId: job.workspaceId,
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
            status = "ok";
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
            status = "ok";
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

        if (status === "ok") {
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
    if (status === "ok") {
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

    // Deliver results to channel if configured
    const deliveryResult = await this.deliverToChannel(job, status, taskId, errorMsg, resultText);

    // Update history entry with delivery status
    if (deliveryResult.attempted && job.state.runHistory?.[0]) {
      job.state.runHistory[0].deliveryStatus = deliveryResult.success ? "success" : "failed";
      if (deliveryResult.error) {
        job.state.runHistory[0].deliveryError = deliveryResult.error;
      }
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
    status: "ok" | "error" | "timeout",
    taskId?: string,
    error?: string,
    resultText?: string,
  ): Promise<{ attempted: boolean; success?: boolean; error?: string }> {
    const { deps, log } = this.getContext();

    // Check if delivery is configured and enabled
    if (!job.delivery?.enabled || !deps.deliverToChannel) {
      return { attempted: false };
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
    const isSuccess = status === "ok";
    const shouldDeliver =
      (isSuccess && deliverOnSuccess !== false) || (!isSuccess && deliverOnError !== false);

    if (!shouldDeliver || !channelType || !channelId) {
      return { attempted: false };
    }

    if (status === "ok" && deliverOnlyIfResult) {
      const hasNonEmpty = typeof resultText === "string" && resultText.trim().length > 0;
      if (!hasNonEmpty) {
        log.info(
          `Skipping delivery for job "${job.name}": deliverOnlyIfResult is enabled but no result text available`,
        );
        return { attempted: false };
      }
    }

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
      });

    try {
      await doDeliver();
      log.info(`Delivered results for job "${job.name}" to ${channelType}:${channelId}`);
      return { attempted: true, success: true };
    } catch (firstError) {
      // Single retry after a short delay for transient failures
      // (e.g. momentary WhatsApp disconnect, network blip).
      log.warn(`First delivery attempt failed for job "${job.name}", retrying in 3s…`);
      await new Promise((r) => setTimeout(r, 3000));
      try {
        await doDeliver();
        log.info(
          `Delivered results for job "${job.name}" to ${channelType}:${channelId} (retry succeeded)`,
        );
        return { attempted: true, success: true };
      } catch (retryError) {
        const errMsg = retryError instanceof Error ? retryError.message : String(retryError);
        log.error(`Failed to deliver results for job "${job.name}" after retry:`, retryError);
        return { attempted: true, success: false, error: errMsg };
      }
    }
  }

  private async renderTaskPrompt(
    job: CronJob,
    runAtMs: number,
    prevRunAtMs?: number,
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
