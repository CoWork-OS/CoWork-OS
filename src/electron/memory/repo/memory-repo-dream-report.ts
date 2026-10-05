/**
 * The renderer's view of dreams over the memory folder (docs/memory-repo-phase2-design.md
 * §5-§7): run records mapped to `MemoryRepoDreamSummary` (no branch names or full shas),
 * the dreams report, the capped diff, and the results of Accept, Reject, Undo and Dream now.
 * Shared by the desktop IPC (memory-repo-handlers.ts) and the browser host.
 */
import {
  MEMORY_REPO_DREAM_DIFF_MAX,
  MEMORY_REPO_DREAMS_LIMIT,
  type MemoryRepoDreamActionResult,
  type MemoryRepoDreamNowResult,
  type MemoryRepoDreamPart,
  type MemoryRepoDreamSummary,
  type MemoryRepoDreamsReport,
} from "../../../shared/memory-repo-types";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { DREAM_DEFAULT_DAILY_TOKEN_BUDGET, type MemoryRepoDreamOutcome } from "./MemoryRepoDreamer";
import type { MemoryRepoDreamRecord, MemoryRepoService } from "./MemoryRepoService";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Records read for the token sum and the pending count (newest first). */
const RECORDS_SCANNED = 200;
const MAX_OPERATIONS = 60;

export type MemoryRepoDreamServicePort = Pick<
  MemoryRepoService,
  "isReady" | "listDreams" | "dreamDiff" | "acceptDream" | "rejectDream" | "undoDream"
>;

export interface MemoryRepoDreamSettings {
  /** `memoryRepoDreamingEnabled`. */
  enabled: boolean;
  /** `memoryRepoDreamDailyTokenBudget`. */
  dailyTokenBudget: number;
}

/** The dream settings as stored (defaults applied by the settings manager). */
export function loadMemoryRepoDreamSettings(): MemoryRepoDreamSettings {
  const settings = MemoryFeaturesManager.loadSettings();
  return {
    enabled: settings.memoryRepoDreamingEnabled !== false,
    dailyTokenBudget: settings.memoryRepoDreamDailyTokenBudget ?? DREAM_DEFAULT_DAILY_TOKEN_BUDGET,
  };
}

export function toMemoryRepoDreamSummary(record: MemoryRepoDreamRecord): MemoryRepoDreamSummary {
  const undone = typeof record.undoneAt === "number";
  const autoCommit =
    typeof record.autoCommit === "string" && record.autoCommit ? record.autoCommit : null;
  return {
    id: record.id,
    trigger: record.trigger === "daily" ? "daily" : "manual",
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    summary: typeof record.summary === "string" ? record.summary : "",
    ...(record.skipReason ? { skipReason: record.skipReason } : {}),
    ...(record.error ? { error: record.error } : {}),
    tokens: Math.max(0, record.tokens || 0),
    autoCount: Math.max(0, record.autoCount || 0),
    ...(autoCommit ? { autoCommitShort: autoCommit.slice(0, 8) } : {}),
    ...(undone ? { undoneAt: record.undoneAt } : {}),
    undone,
    canUndo: Boolean(autoCommit) && !undone,
    reviewCount: Math.max(0, record.reviewCount || 0),
    reviewStatus: record.reviewStatus ?? null,
    rejected: Math.max(0, record.rejected || 0),
    operations: (Array.isArray(record.operations) ? record.operations : [])
      .slice(0, MAX_OPERATIONS)
      .map((op) => ({
        decision: String(op.decision),
        description: String(op.description),
        ...(op.reason ? { reason: String(op.reason) } : {}),
        ...(op.why ? { why: String(op.why) } : {}),
      })),
    ...(record.historyNote ? { historyNote: record.historyNote } : {}),
  };
}

/** Tokens the records used in the 24 hours before `now` (the dreamer's rolling budget). */
export function dreamTokensUsedSince(records: MemoryRepoDreamRecord[], now: number): number {
  const since = now - DAY_MS;
  return records
    .filter((record) => record.finishedAt >= since)
    .reduce((sum, record) => sum + Math.max(0, record.tokens || 0), 0);
}

export async function buildMemoryRepoDreamsReport(params: {
  service: Pick<MemoryRepoDreamServicePort, "isReady" | "listDreams"> | null;
  settings: MemoryRepoDreamSettings;
  now?: number;
}): Promise<MemoryRepoDreamsReport> {
  const { service, settings } = params;
  const base = {
    dailyBudget: Math.max(0, Math.floor(settings.dailyTokenBudget)),
    dreamingEnabled: settings.enabled,
  };
  if (!service?.isReady()) {
    return { ...base, dreams: [], tokensUsedToday: 0, folderReady: false, pendingReviews: 0 };
  }
  const records = await service.listDreams(RECORDS_SCANNED);
  return {
    ...base,
    dreams: records.slice(0, MEMORY_REPO_DREAMS_LIMIT).map(toMemoryRepoDreamSummary),
    tokensUsedToday: dreamTokensUsedSince(records, params.now ?? Date.now()),
    folderReady: true,
    pendingReviews: records.filter((record) => record.reviewStatus === "pending").length,
  };
}

/** The diff of a dream part, capped at `MEMORY_REPO_DREAM_DIFF_MAX` characters. */
export async function memoryRepoDreamDiffText(
  service: Pick<MemoryRepoDreamServicePort, "dreamDiff"> | null,
  id: string,
  part: MemoryRepoDreamPart,
): Promise<string> {
  if (!service) return "";
  const diff = await service.dreamDiff(id, part);
  if (diff.length <= MEMORY_REPO_DREAM_DIFF_MAX) return diff;
  return `${diff.slice(0, MEMORY_REPO_DREAM_DIFF_MAX)}\n... (diff truncated)\n`;
}

export async function runMemoryRepoDreamAction(
  service: Pick<MemoryRepoDreamServicePort, "acceptDream" | "rejectDream" | "undoDream"> | null,
  action: "accept" | "reject" | "undo",
  id: string,
): Promise<MemoryRepoDreamActionResult> {
  if (!service) return { ok: false, error: "The memory folder is off." };
  if (action === "accept") {
    const result = await service.acceptDream(id);
    return result.accepted ? { ok: true } : { ok: false, error: result.error };
  }
  if (action === "reject") {
    const result = await service.rejectDream(id);
    return result.rejected ? { ok: true } : { ok: false, error: result.error };
  }
  const result = await service.undoDream(id);
  return result.undone ? { ok: true } : { ok: false, error: result.error };
}

export function toMemoryRepoDreamNowResult(
  outcome: MemoryRepoDreamOutcome | null,
): MemoryRepoDreamNowResult {
  if (!outcome) return { ran: false, reason: "unavailable" };
  if (outcome.ran) return { ran: true, dream: toMemoryRepoDreamSummary(outcome.record) };
  return {
    ran: false,
    reason: outcome.reason,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.record ? { dream: toMemoryRepoDreamSummary(outcome.record) } : {}),
  };
}
