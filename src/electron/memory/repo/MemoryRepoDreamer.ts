/**
 * MemoryRepoDreamer — one dream over the memory folder (docs/memory-repo-phase2-design.md).
 *
 * Gate (folder ready, git, dreaming on, budget, something new, at most one dream at a time
 * across processes) → input (folder, inbox, recent tasks) → one model call → parse, validate
 * and classify the operations → `MemoryRepoService.applyDream` (automatic commit on main,
 * review branch) → a run record in `.git/cowork-dreams/`.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger } from "../../utils/logger";
import type {
  MemoryRepoDreamRecord,
  MemoryRepoDreamTrigger,
  MemoryRepoService,
} from "./MemoryRepoService";
import {
  DREAM_MAX_OUTPUT_TOKENS,
  DREAM_MAX_TASKS,
  buildDreamInput,
  classifyDreamOperations,
  parseDreamOutput,
  type DreamTaskInput,
} from "./memory-repo-dream-plan";
import {
  MEMORY_REPO_INBOX_FILE,
  isSwarmRepoPath,
  parseMemoryRepoEntries,
} from "./memory-repo-format";
import { MemoryRepoBusyError, withMemoryRepoLock } from "./memory-repo-lock";

const logger = createLogger("MemoryRepoDreamer");

/** A daily dream runs when the last one is older than this. */
export const DREAM_DAILY_INTERVAL_MS = 20 * 60 * 60 * 1000;
export const DREAM_DEFAULT_DAILY_TOKEN_BUDGET = 50_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A dream lock older than this belongs to a crashed run. */
const DREAM_LOCK_STALE_MS = 30 * 60 * 1000;

export interface DreamModelClient {
  complete(request: {
    system: string;
    user: string;
    maxTokens: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

export interface MemoryRepoDreamerDeps {
  getService: () => MemoryRepoService | null;
  client: DreamModelClient;
  /** Tasks created after `sinceMs` (newest first), without `<no-memory>` tasks. */
  listRecentTasks: (sinceMs: number, limit: number) => Promise<DreamTaskInput[]>;
  settings: () => { enabled: boolean; dailyTokenBudget: number };
  now?: () => number;
  /** Called after a dream that left changes waiting for review (the user is notified). */
  onReviewPending?: (record: MemoryRepoDreamRecord) => void;
}

export type MemoryRepoDreamOutcome =
  | { ran: true; record: MemoryRepoDreamRecord }
  | {
      ran: false;
      reason:
        | "unavailable"
        | "no_git"
        | "disabled"
        | "not_due"
        | "nothing_new"
        | "budget"
        | "busy"
        | "failed";
      record?: MemoryRepoDreamRecord;
      error?: string;
    };

export class MemoryRepoDreamer {
  private running: Promise<MemoryRepoDreamOutcome> | null = null;

  constructor(private readonly deps: MemoryRepoDreamerDeps) {}

  /** Run a dream unless gated. An overlapping call in this process shares the running one. */
  run(trigger: MemoryRepoDreamTrigger): Promise<MemoryRepoDreamOutcome> {
    if (this.running) return this.running;
    this.running = this.execute(trigger).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Tokens dreams used in the last 24 hours. */
  async tokensUsedToday(service: MemoryRepoService): Promise<number> {
    const since = this.now() - DAY_MS;
    return (await service.listDreams(200))
      .filter((record) => record.finishedAt >= since)
      .reduce((sum, record) => sum + Math.max(0, record.tokens || 0), 0);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async execute(trigger: MemoryRepoDreamTrigger): Promise<MemoryRepoDreamOutcome> {
    const service = this.deps.getService();
    if (!service?.isWritable()) return { ran: false, reason: "unavailable" };
    const status = await service.status();
    if (!status.gitAvailable) return { ran: false, reason: "no_git" };
    const settings = this.deps.settings();
    if (!settings.enabled) return { ran: false, reason: "disabled" };
    const lockPath = path.join(service.root, ".git", "cowork-dream.lock");
    try {
      return await withMemoryRepoLock(lockPath, () => this.dream(service, trigger, settings), {
        timeoutMs: 0,
        staleMs: DREAM_LOCK_STALE_MS,
        now: this.deps.now,
      });
    } catch (error) {
      if (error instanceof MemoryRepoBusyError) return { ran: false, reason: "busy" };
      logger.warn("Dream failed:", error);
      return {
        ran: false,
        reason: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async dream(
    service: MemoryRepoService,
    trigger: MemoryRepoDreamTrigger,
    settings: { enabled: boolean; dailyTokenBudget: number },
  ): Promise<MemoryRepoDreamOutcome> {
    const startedAt = this.now();
    // Dream over the latest memory: pull what other machines wrote first (Phase 4 sync).
    if (service.isSyncConfigured()) await service.syncNow({ push: false }).catch(() => undefined);
    const previous = (await service.listDreams(50)).filter((record) => record.status !== "skipped");
    const last = previous[0];
    if (trigger === "daily" && last && startedAt - last.startedAt < DREAM_DAILY_INTERVAL_MS) {
      return { ran: false, reason: "not_due" };
    }
    const since =
      previous.find((record) => typeof record.lastTaskCreatedAt === "number")?.lastTaskCreatedAt ??
      startedAt - 7 * DAY_MS;
    const tasks = await this.deps.listRecentTasks(since, DREAM_MAX_TASKS);
    const files = await service.readAllFiles();
    // Dreams never read swarm folders (agents' shared notes; phase 5 §2).
    for (const file of [...files.keys()]) if (isSwarmRepoPath(file)) files.delete(file);
    const inboxEntries = parseMemoryRepoEntries(files.get(MEMORY_REPO_INBOX_FILE) ?? "").length;
    if (trigger === "daily" && tasks.length === 0 && inboxEntries === 0) {
      return { ran: false, reason: "nothing_new" };
    }
    const workspaceFiles = [...files.keys()].filter((file) => file.startsWith("workspaces/"));
    const input = buildDreamInput({
      files,
      tasks,
      priority: ["MEMORY.md", "me.md", "lessons.md", ...workspaceFiles],
      now: startedAt,
    });
    const budget = Math.max(0, settings.dailyTokenBudget) - (await this.tokensUsedToday(service));
    const id = `${new Date(startedAt).toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8)}`;
    const lastTaskCreatedAt =
      tasks.reduce<number | null>(
        (max, task) => (max === null || task.createdAt > max ? task.createdAt : max),
        null,
      ) ?? (typeof last?.lastTaskCreatedAt === "number" ? last.lastTaskCreatedAt : null);
    const base = {
      id,
      trigger,
      startedAt,
      summary: "",
      autoCommit: null,
      autoCount: 0,
      reviewBranch: null,
      reviewBase: null,
      reviewCount: 0,
      reviewStatus: null,
      rejected: 0,
      skipped: 0,
      operations: [],
      taskIds: tasks.map((task) => task.taskId),
    } satisfies Omit<
      MemoryRepoDreamRecord,
      "status" | "finishedAt" | "tokens" | "lastTaskCreatedAt"
    >;
    if (budget < input.estimatedInputTokens + DREAM_MAX_OUTPUT_TOKENS) {
      const record: MemoryRepoDreamRecord = {
        ...base,
        status: "skipped",
        skipReason: "budget",
        finishedAt: this.now(),
        tokens: 0,
        lastTaskCreatedAt:
          typeof last?.lastTaskCreatedAt === "number" ? last.lastTaskCreatedAt : null,
      };
      await service.recordDream(record);
      return { ran: false, reason: "budget", record };
    }
    let completion: { text: string; inputTokens: number; outputTokens: number };
    try {
      completion = await this.deps.client.complete({
        system: input.system,
        user: input.user,
        maxTokens: DREAM_MAX_OUTPUT_TOKENS,
      });
    } catch (error) {
      // A failed call is charged its estimated input, so a failing provider cannot loop.
      const record: MemoryRepoDreamRecord = {
        ...base,
        status: "failed",
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        finishedAt: this.now(),
        tokens: input.estimatedInputTokens,
        lastTaskCreatedAt:
          typeof last?.lastTaskCreatedAt === "number" ? last.lastTaskCreatedAt : null,
      };
      await service.recordDream(record);
      return { ran: false, reason: "failed", record, error: record.error };
    }
    const tokens =
      Math.max(0, Math.floor(completion.inputTokens || 0)) +
        Math.max(0, Math.floor(completion.outputTokens || 0)) ||
      input.estimatedInputTokens + Math.ceil(completion.text.length / 4);
    const parsed = parseDreamOutput(completion.text);
    if (parsed.malformed) {
      const record: MemoryRepoDreamRecord = {
        ...base,
        status: "failed",
        error: "The model's answer was not the expected JSON.",
        finishedAt: this.now(),
        tokens,
        lastTaskCreatedAt:
          typeof last?.lastTaskCreatedAt === "number" ? last.lastTaskCreatedAt : null,
      };
      await service.recordDream(record);
      return { ran: false, reason: "failed", record, error: record.error };
    }
    const classified = classifyDreamOperations(parsed.operations, input);
    const record = await service.applyDream({
      id,
      trigger,
      startedAt,
      summary: parsed.summary,
      operations: classified,
      rejected: parsed.invalid,
      tokens,
      taskIds: base.taskIds,
      lastTaskCreatedAt,
    });
    logger.info(
      `Dream ${id}: ${record.autoCount} applied, ${record.reviewCount} for review, ${record.rejected} rejected`,
    );
    if (record.reviewCount > 0 && record.reviewStatus === "pending") {
      try {
        this.deps.onReviewPending?.(record);
      } catch (error) {
        logger.warn("Dream review notification failed:", error);
      }
    }
    return { ran: true, record };
  }
}

let dreamer: MemoryRepoDreamer | null = null;

export function getMemoryRepoDreamer(): MemoryRepoDreamer | null {
  return dreamer;
}

export function setMemoryRepoDreamer(next: MemoryRepoDreamer | null): void {
  dreamer = next;
}
