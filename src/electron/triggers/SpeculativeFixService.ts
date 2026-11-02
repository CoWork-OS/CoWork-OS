/**
 * SpeculativeFixService — runs the `speculate_fix` trigger action ("Acting Ahead").
 *
 * When a watched chat reports a problem, it starts a background worker task flagged
 * `speculative` in an isolated git worktree, enforces a hard time budget on top of the task's
 * turn budget, and applies the delivery gate when the worker ends:
 * - reproduced, fixed with test evidence, and a real diff under the line limit: deliver
 *   (`draft_only` keeps the worktree and posts a short note in the reporting thread;
 *   `open_pr` pushes the branch and opens a pull request);
 * - anything else: discard the worktree and write one line to the task's event log. The user
 *   is never messaged and no notification is raised.
 *
 * A delivered draft becomes a pull request when the owner answers "open it" in that thread.
 */
import { randomUUID } from "crypto";
import type {
  AgentConfig,
  SpeculativeRun,
  SpeculativeRunListQuery,
  SpeculativeRunOrigin,
  SpeculativeRunOutcome,
  Task,
} from "../../shared/types";
import { createLogger } from "../utils/logger";
import {
  buildDraftReply,
  buildPullRequestBody,
  buildPullRequestReply,
  buildPullRequestTitle,
  buildSpeculativeAgentConfig,
  buildSpeculativeWorkerPrompt,
  canReplyToOrigin,
  checkSpeculativeReport,
  decideSpeculativeDelivery,
  excerpt,
  formatDiffStat,
  isOpenItReply,
  normalizeSpeculativeFixConfig,
  parseSpeculativeFixReport,
  reportedProblemText,
  speculativeOriginFromEvent,
  type SpeculativeDiffStat,
} from "./speculative-fix";
import {
  MAX_STORED_SPECULATIVE_RUNS,
  boundSpeculativeRuns,
  type SpeculativeRunStore,
} from "./speculative-run-store";
import type { SpeculateFixRequest, SpeculateFixStartResult } from "./types";

const logger = createLogger("SpeculativeFix");

const DEFAULT_MAX_CONCURRENT_RUNS = 2;
const DEFAULT_SETTLE_DELAY_MS = 1_000;
const MAX_SETTLE_CHECKS = 5;
const WORKTREE_IDLE_CHECKS = 20;
const MAX_IDEMPOTENCY_KEYS = 500;
/** A draft can still be opened as a pull request for this long after it was delivered. */
const OPEN_IT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_TASK_STATUSES = new Set<string>(["completed", "failed", "cancelled"]);
/** Task events after which the task's status may be about to turn terminal. */
const SETTLING_EVENT_TYPES = new Set<string>(["task_completed", "task_cancelled", "task_status"]);

export type SpeculativeTaskView = Pick<Task, "id" | "status" | "resultSummary" | "worktreeStatus">;

export interface SpeculativeWorktreeOps {
  /** Commit whatever the worker left uncommitted; resolves without a commit when clean. */
  commit(taskId: string, message: string): Promise<void>;
  /** The run branch's changes since it left its base commit; null without a worktree. */
  diffStats(taskId: string): Promise<SpeculativeDiffStat | null>;
  branchName(taskId: string): Promise<string | undefined>;
  openPullRequest(
    taskId: string,
    params: { title: string; body: string },
  ): Promise<{ success: boolean; url?: string; error?: string }>;
  /** Remove the worktree and its local branch. */
  discard(taskId: string): Promise<void>;
}

export interface SpeculativeFixServiceDeps {
  createTask(params: {
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig: AgentConfig;
  }): Promise<{ id: string }>;
  getTask(
    taskId: string,
  ): SpeculativeTaskView | undefined | Promise<SpeculativeTaskView | undefined>;
  cancelTask(taskId: string): Promise<void>;
  /** One line in the worker task's event log. */
  logTaskEvent(taskId: string, payload: Record<string, unknown>): void;
  /** Whether the workspace exists, may be written, and can get a git worktree. */
  canIsolate(workspaceId: string): Promise<boolean>;
  worktree: SpeculativeWorktreeOps;
  /** Reply in the thread a run came from; without it, nothing is ever posted. */
  postToThread?(params: {
    origin: SpeculativeRunOrigin;
    text: string;
    idempotencyKey: string;
  }): Promise<void>;
  /** Whether a chat sender is the workspace owner (only the owner may say "open it"). */
  isOwnerSender?(params: {
    channelType: string;
    channelInstanceId?: string;
    userId: string;
  }): Promise<boolean>;
  store: SpeculativeRunStore;
  now?: () => number;
  maxConcurrentRuns?: number;
  /** Delay between status checks while a just-finished task settles. */
  settleDelayMs?: number;
}

let activeService: SpeculativeFixService | null = null;

/** The running service, for the read-only `speculative_runs` tool and the IPC query. */
export function getActiveSpeculativeFixService(): SpeculativeFixService | null {
  return activeService;
}

export function setActiveSpeculativeFixService(service: SpeculativeFixService | null): void {
  activeService = service;
}

export class SpeculativeFixService {
  private readonly runs = new Map<string, SpeculativeRun>();
  private readonly runByTask = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timedOut = new Set<string>();
  private readonly finalizing = new Map<string, Promise<void>>();
  private readonly startedKeys = new Map<string, string>();
  private readonly openingPullRequests = new Set<string>();
  private readonly settling = new Set<string>();
  private starting = 0;
  private ready: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: SpeculativeFixServiceDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Load the run history and finish or re-arm runs a restart interrupted. */
  init(): Promise<void> {
    this.ready = this.load();
    return this.ready;
  }

  private async load(): Promise<void> {
    let stored: SpeculativeRun[] = [];
    try {
      stored = await this.deps.store.load();
    } catch (error) {
      logger.warn("Could not load the speculative run history:", error);
    }
    for (const run of stored) {
      this.runs.set(run.id, run);
      if (run.taskId) this.runByTask.set(run.taskId, run.id);
    }
    for (const run of stored) {
      if (run.status !== "running") continue;
      if (!run.taskId) {
        await this.close(run, "failed", "task_failed", "The worker task was never created.");
        continue;
      }
      this.armDeadline(run);
      void this.checkRun(run.id);
    }
  }

  dispose(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  listRuns(query: SpeculativeRunListQuery = {}): SpeculativeRun[] {
    const limit = Math.min(100, Math.max(1, Math.round(query.limit ?? 20)));
    return [...this.runs.values()]
      .filter((run) => !query.workspaceId || run.workspaceId === query.workspaceId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((run) => structuredClone(run));
  }

  getRun(runId: string): SpeculativeRun | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  // ── Start ───────────────────────────────────────────────────────

  async start(request: SpeculateFixRequest): Promise<SpeculateFixStartResult> {
    await this.ready;
    if (this.stopped) return { started: false, reason: "stopped" };
    // A bot responsibility's run must stay inside the bot's boundary; a worktree of the user's
    // workspace is not inside it.
    if (request.agentConfig?.responsibilityRun || request.agentConfig?.botContained)
      return { started: false, reason: "responsibility_bound" };

    const key = request.idempotencyKey?.trim();
    if (key && this.startedKeys.has(key))
      return { started: false, reason: "duplicate", runId: this.startedKeys.get(key) || undefined };
    const result = await this.startOnce(request, key);
    if (!result.started && !result.runId && key) this.startedKeys.delete(key);
    return result;
  }

  private async startOnce(
    request: SpeculateFixRequest,
    key: string | undefined,
  ): Promise<SpeculateFixStartResult> {
    // Claimed before the first await, so a concurrent duplicate cannot slip through.
    if (key) this.rememberKey(key, "");
    const { trigger, event } = request;
    const config = normalizeSpeculativeFixConfig(trigger.action.config.speculateFix);
    const workspaceId =
      config.workspaceId || trigger.action.config.workspaceId || trigger.workspaceId;
    if (!workspaceId) return { started: false, reason: "no_workspace" };

    const problem = reportedProblemText(event);
    if (!problem) return { started: false, reason: "empty_report" };
    if (isOpenItReply(problem)) return { started: false, reason: "open_it_reply" };

    const running = [...this.runs.values()].filter((run) => run.status === "running").length;
    if (running + this.starting >= (this.deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS))
      return { started: false, reason: "busy" };

    // Holds a capacity slot until the run is registered below.
    this.starting += 1;
    let isolated = false;
    try {
      isolated = await this.deps.canIsolate(workspaceId);
    } catch (error) {
      logger.debug("Worktree availability check failed:", error);
    } finally {
      this.starting -= 1;
    }
    if (!isolated) return { started: false, reason: "worktree_unavailable" };

    const startedAt = this.now();
    const run: SpeculativeRun = {
      id: randomUUID(),
      triggerId: trigger.id,
      triggerName: trigger.name,
      workspaceId,
      status: "running",
      outcome: "running",
      delivery: config.delivery,
      destination: config.destination,
      maxDiffLines: config.maxDiffLines,
      issueExcerpt: excerpt(problem, 200),
      origin: speculativeOriginFromEvent(event),
      startedAt,
      deadlineAt: startedAt + config.maxMinutes * 60_000,
    };
    if (key) this.rememberKey(key, run.id);
    this.runs.set(run.id, run);
    await this.persist();

    try {
      const task = await this.deps.createTask({
        title: `Speculative fix: ${excerpt(problem, 60)}`,
        prompt: buildSpeculativeWorkerPrompt({ problem, origin: run.origin, config }),
        workspaceId,
        agentConfig: buildSpeculativeAgentConfig({ runId: run.id, config }),
      });
      run.taskId = task.id;
      this.runByTask.set(task.id, run.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.close(run, "failed", "task_failed", `Could not start the worker: ${message}`);
      return { started: false, reason: "task_create_failed", runId: run.id };
    }
    await this.persist();
    this.armDeadline(run);
    // The task may have ended before its id was known here.
    void this.checkRun(run.id);
    return { started: true, runId: run.id, taskId: run.taskId };
  }

  private rememberKey(key: string, runId: string): void {
    this.startedKeys.set(key, runId);
    while (this.startedKeys.size > MAX_IDEMPOTENCY_KEYS) {
      const oldest = this.startedKeys.keys().next().value;
      if (oldest === undefined) break;
      this.startedKeys.delete(oldest);
    }
  }

  // ── Budget and completion ───────────────────────────────────────

  private armDeadline(run: SpeculativeRun): void {
    const existing = this.timers.get(run.id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, run.deadlineAt - this.now());
    const timer = setTimeout(() => void this.onDeadline(run.id), delay);
    timer.unref?.();
    this.timers.set(run.id, timer);
  }

  private async onDeadline(runId: string): Promise<void> {
    this.timers.delete(runId);
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return;
    this.timedOut.add(runId);
    if (run.taskId) {
      const task = await this.readTask(run.taskId);
      if (task && !TERMINAL_TASK_STATUSES.has(task.status)) {
        await this.deps.cancelTask(run.taskId).catch((error) => {
          logger.debug(`Could not cancel speculative task ${run.taskId}:`, error);
        });
      }
    }
    await this.finalize(runId);
  }

  /** Daemon task events come here; only this service's worker tasks are looked at. */
  onTaskEvent(taskId: string | undefined, eventType: string): void {
    const runId = taskId ? this.runByTask.get(taskId) : undefined;
    if (!runId || this.settling.has(runId)) return;
    const settleChecks = SETTLING_EVENT_TYPES.has(eventType) ? MAX_SETTLE_CHECKS : 0;
    // One recheck chain per run, however many events arrive meanwhile.
    if (settleChecks > 0) this.settling.add(runId);
    void this.checkRun(runId, settleChecks);
  }

  private async checkRun(runId: string, settleChecksLeft = 0): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running" || !run.taskId || this.stopped) {
      this.settling.delete(runId);
      return;
    }
    const task = await this.readTask(run.taskId);
    if (!task || TERMINAL_TASK_STATUSES.has(task.status)) {
      this.settling.delete(runId);
      await this.finalize(runId);
      return;
    }
    if (settleChecksLeft <= 0) {
      this.settling.delete(runId);
      return;
    }
    this.settling.add(runId);
    const timer = setTimeout(
      () => void this.checkRun(runId, settleChecksLeft - 1),
      this.deps.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS,
    );
    timer.unref?.();
  }

  private async readTask(taskId: string): Promise<SpeculativeTaskView | undefined> {
    try {
      return await this.deps.getTask(taskId);
    } catch (error) {
      logger.debug(`Could not read speculative task ${taskId}:`, error);
      return undefined;
    }
  }

  private finalize(runId: string): Promise<void> {
    const pending = this.finalizing.get(runId);
    if (pending) return pending;
    const operation = this.finalizeNow(runId)
      .catch((error) => {
        logger.warn(`Speculative run ${runId} could not be finalized:`, error);
      })
      .finally(() => this.finalizing.delete(runId));
    this.finalizing.set(runId, operation);
    return operation;
  }

  private async finalizeNow(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return;
    const timer = this.timers.get(runId);
    if (timer) clearTimeout(timer);
    this.timers.delete(runId);
    const taskId = run.taskId;
    if (!taskId) {
      await this.close(run, "failed", "task_failed", "The worker task was never created.");
      return;
    }

    const task = await this.readTask(taskId);
    const timedOut = this.timedOut.has(runId);
    const report = parseSpeculativeFixReport(task?.resultSummary);
    if (report) run.report = report;
    const taskStatus = task?.status ?? "missing";

    const early = checkSpeculativeReport({ taskStatus, timedOut, report });
    if (early) {
      await this.discard(run, early.outcome, early.reason);
      return;
    }

    let diff: SpeculativeDiffStat | null;
    try {
      await this.waitForWorktreeIdle(taskId);
      await this.deps.worktree.commit(taskId, `Speculative fix: ${excerpt(report!.summary, 60)}`);
      diff = await this.deps.worktree.diffStats(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.discard(run, "delivery_failed", `Could not read the fix: ${message}`);
      return;
    }
    const decision = decideSpeculativeDelivery({
      taskStatus,
      timedOut,
      report,
      diff,
      maxDiffLines: run.maxDiffLines,
    });
    if (!decision.deliver) {
      await this.discard(run, decision.outcome, decision.reason);
      return;
    }
    run.filesChanged = diff!.filesChanged;
    run.linesAdded = diff!.linesAdded;
    run.linesRemoved = diff!.linesRemoved;
    run.branchName = await this.deps.worktree.branchName(taskId).catch(() => undefined);
    await this.deliver(run);
  }

  /** The daemon may still be auto-committing the worktree; let it finish first. */
  private async waitForWorktreeIdle(taskId: string): Promise<void> {
    for (let check = 0; check < WORKTREE_IDLE_CHECKS; check++) {
      const task = await this.readTask(taskId);
      if (task?.worktreeStatus !== "committing") return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  // ── Outcomes ────────────────────────────────────────────────────

  private async discard(
    run: SpeculativeRun,
    outcome: SpeculativeRunOutcome,
    reason: string,
  ): Promise<void> {
    if (run.taskId) {
      await this.deps.worktree.discard(run.taskId).catch((error) => {
        logger.debug(`Could not remove the worktree of speculative run ${run.id}:`, error);
      });
    }
    run.worktreeKept = false;
    await this.close(
      run,
      outcome === "task_failed" || outcome === "delivery_failed" ? "failed" : "discarded",
      outcome,
      reason,
    );
  }

  private async deliver(run: SpeculativeRun): Promise<void> {
    const taskId = run.taskId!;
    const replyHere = run.destination === "origin_thread" && canReplyToOrigin(run.origin);
    run.worktreeKept = true;
    if (run.delivery === "open_pr") {
      const result = await this.openPullRequest(run);
      if (!result.success) {
        await this.close(
          run,
          "failed",
          "delivery_failed",
          `Could not open the pull request: ${excerpt(result.error || "unknown error", 200)}`,
        );
        return;
      }
      if (replyHere) await this.reply(run, buildPullRequestReply(run, result.url!), "pr");
      await this.close(run, "delivered", "pr_opened", `Opened ${result.url}.`);
      return;
    }
    if (replyHere) {
      try {
        await this.deps.postToThread?.({
          origin: run.origin,
          text: buildDraftReply(run),
          idempotencyKey: `speculative-run:${run.id}:draft`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.close(
          run,
          "failed",
          "delivery_failed",
          `Could not post the draft: ${excerpt(message, 200)}`,
        );
        return;
      }
    }
    await this.close(
      run,
      "delivered",
      "draft_ready",
      `Candidate fix kept in ${run.branchName || `the worktree of task ${taskId}`} (${formatDiffStat(
        {
          filesChanged: run.filesChanged ?? 0,
          linesAdded: run.linesAdded ?? 0,
          linesRemoved: run.linesRemoved ?? 0,
        },
      )}).`,
    );
  }

  private async openPullRequest(
    run: SpeculativeRun,
  ): Promise<{ success: boolean; url?: string; error?: string }> {
    try {
      const result = await this.deps.worktree.openPullRequest(run.taskId!, {
        title: buildPullRequestTitle(run),
        body: buildPullRequestBody(run),
      });
      if (result.success && result.url) {
        run.prUrl = result.url;
        return result;
      }
      return { success: false, error: result.error || "No pull request URL was returned." };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** A reply after a successful delivery; failing to post it does not undo the delivery. */
  private async reply(run: SpeculativeRun, text: string, tag: string): Promise<void> {
    try {
      await this.deps.postToThread?.({
        origin: run.origin,
        text,
        idempotencyKey: `speculative-run:${run.id}:${tag}`,
      });
    } catch (error) {
      logger.warn(`Could not reply in the thread of speculative run ${run.id}:`, error);
    }
  }

  private async close(
    run: SpeculativeRun,
    status: SpeculativeRun["status"],
    outcome: SpeculativeRunOutcome,
    note: string,
  ): Promise<void> {
    run.status = status;
    run.outcome = outcome;
    run.note = note;
    run.finishedAt = this.now();
    this.timedOut.delete(run.id);
    if (run.taskId) {
      try {
        this.deps.logTaskEvent(run.taskId, {
          message: `Speculative run ${outcome.replace(/_/g, " ")}: ${note}`,
          runId: run.id,
          outcome,
          status,
        });
      } catch (error) {
        logger.debug(`Could not log the outcome of speculative run ${run.id}:`, error);
      }
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    // Keep memory to what the store keeps: the newest runs, and every running one.
    if (this.runs.size > MAX_STORED_SPECULATIVE_RUNS) {
      const kept = new Set(boundSpeculativeRuns([...this.runs.values()]).map((run) => run.id));
      for (const [id, run] of this.runs) {
        if (kept.has(id)) continue;
        this.runs.delete(id);
        if (run.taskId) this.runByTask.delete(run.taskId);
      }
    }
    try {
      await this.deps.store.save([...this.runs.values()]);
    } catch (error) {
      logger.warn("Could not save the speculative run history:", error);
    }
  }

  // ── "open it" ───────────────────────────────────────────────────

  /**
   * A chat message that may ask to open a delivered draft as a pull request. Returns true when
   * it did. Only the workspace owner may ask, in the thread the draft was posted to.
   */
  async handleChannelMessage(message: {
    channelType: string;
    channelInstanceId?: string;
    chatId: string;
    userId: string;
    text: string;
  }): Promise<boolean> {
    if (!isOpenItReply(message.text)) return false;
    await this.ready;
    const now = this.now();
    const run = [...this.runs.values()]
      .filter(
        (candidate) =>
          candidate.outcome === "draft_ready" &&
          candidate.worktreeKept === true &&
          candidate.destination === "origin_thread" &&
          candidate.origin.channelType === message.channelType &&
          candidate.origin.chatId === message.chatId &&
          (!candidate.origin.channelInstanceId ||
            !message.channelInstanceId ||
            candidate.origin.channelInstanceId === message.channelInstanceId) &&
          now - (candidate.finishedAt ?? candidate.startedAt) <= OPEN_IT_WINDOW_MS,
      )
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    if (!run || !run.taskId || this.openingPullRequests.has(run.id)) return false;
    let owner = false;
    try {
      owner =
        (await this.deps.isOwnerSender?.({
          channelType: message.channelType,
          channelInstanceId: message.channelInstanceId,
          userId: message.userId,
        })) === true;
    } catch (error) {
      logger.debug("Owner check for an open-it reply failed:", error);
    }
    if (!owner) return false;

    this.openingPullRequests.add(run.id);
    try {
      const result = await this.openPullRequest(run);
      if (!result.success) {
        run.note = `Could not open the pull request: ${excerpt(result.error || "unknown error", 200)}`;
        await this.persist();
        await this.reply(
          run,
          `I couldn't open the PR: ${excerpt(result.error || "unknown error", 160)}`,
          `open-failed:${now}`,
        );
        return true;
      }
      run.outcome = "pr_opened";
      run.note = `Opened ${result.url} on request.`;
      this.deps.logTaskEvent(run.taskId, {
        message: `Speculative run pr opened: ${run.note}`,
        runId: run.id,
        outcome: run.outcome,
        status: run.status,
      });
      await this.persist();
      await this.reply(run, `Opened the PR: ${result.url}`, "pr");
      return true;
    } finally {
      this.openingPullRequests.delete(run.id);
    }
  }
}
