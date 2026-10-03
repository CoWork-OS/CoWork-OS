/**
 * Memory Hub "Review" (audit §8.4): Dreaming's pending curation proposals with accept /
 * reject, and the recent changes it applied with undo (docs/memory-engine.md §9).
 *
 * Callers pass the workspace the Hub is showing. A proposal or log entry of another
 * workspace is reported as not found; a proposal whose items are no longer active (or not
 * visible in the workspace) is dismissed rather than applied. Accepting applies through
 * MemoryWriter with the user's consent, so it may touch items the user stated.
 */
import { z } from "zod";
import type { MemoryHubItem } from "../../shared/memory-hub-types";
import {
  MEMORY_CURATION_PROMOTION_KINDS,
  type MemoryCurationChange,
  type MemoryCurationOperation,
  type MemoryReviewEvidence,
  type MemoryReviewMutationResult,
  type MemoryReviewProposal,
  type MemoryReviewRunResult,
  type MemoryReviewState,
} from "../../shared/memory-review-types";
import type { DreamingCandidate, MemoryFeaturesSettings } from "../../shared/types";
import { createLogger } from "../utils/logger";
import type { DreamingRepository } from "./DreamingRepository";
import type { DreamingRunResult } from "./DreamingService";
import { isMemoryItemVisibleIn, toMemoryHubItem } from "./MemoryItemsHubService";
import type { MemoryCurationRepository } from "./MemoryCurationRepository";
import { itemOperationFingerprint, proposalItemIds } from "./MemoryCurator";
import type { MemoryWriter } from "./MemoryWriter";
import { CURATION_LLM_DEFAULT_DAILY_BUDGET } from "./memory-curation-llm";
import type { CurationLogEntry, CurationSnapshot } from "./memory-curation-sql";
import type { MemoryItem } from "./memory-items-types";

const logger = createLogger("MemoryReview");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 100;
const MAX_RECENT = 30;

const id = z.string().min(1).max(512);
const ids = z.array(id).min(1).max(50);

/** A stored operation is re-validated before it is shown or applied. */
export const StoredCurationOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("merge"), keepId: id, mergeIds: ids }).strict(),
  z.object({ op: z.literal("resolve_conflict"), keepId: id, dropIds: ids }).strict(),
  z
    .object({
      op: z.literal("promote"),
      kind: z.enum(MEMORY_CURATION_PROMOTION_KINDS),
      content: z.string().trim().min(3).max(1000),
      evidenceIds: z.array(id).max(50),
      taskIds: z.array(id).max(50),
    })
    .strict(),
  z.object({ op: z.literal("decay"), itemIds: ids }).strict(),
  z.object({ op: z.literal("expire_commitment"), itemIds: ids }).strict(),
]);

export function parseStoredCurationOperation(value: unknown): MemoryCurationOperation | null {
  const parsed = StoredCurationOperationSchema.safeParse(value);
  return parsed.success ? (parsed.data as MemoryCurationOperation) : null;
}

export class MemoryReviewError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "unavailable",
  ) {
    super(message);
    this.name = "MemoryReviewError";
  }
}

export interface MemoryReviewDeps {
  dreaming: Pick<
    DreamingRepository,
    "listCandidates" | "findCandidateById" | "reviewCandidate" | "listRuns"
  >;
  curation: Pick<
    MemoryCurationRepository,
    "listLog" | "findLog" | "pendingCount" | "llmTokensSince"
  >;
  getWriter: () => MemoryWriter | null;
  getSettings: () => MemoryFeaturesSettings;
  /** Persist the LLM synthesis switch (merged into the current settings server-side). */
  setLlmEnabled?: (enabled: boolean) => void;
  /** Start a manual Dreaming run for the workspace. */
  runNow?: (workspaceId: string) => Promise<DreamingRunResult | null>;
  /** Re-render the workspace's kit views after a change. */
  syncKitFiles?: (workspaceId: string) => Promise<void>;
  now?: () => number;
}

const OP_TITLES: Record<MemoryCurationOperation["op"], string> = {
  merge: "Merge similar memories",
  resolve_conflict: "Resolve a contradiction",
  promote: "Remember a recurring fact",
  decay: "Archive an unused memory",
  expire_commitment: "Close a past-due commitment",
};

const REFUSAL_MESSAGES: Record<string, string> = {
  missing: "One of its memories no longer exists.",
  not_active: "One of its memories has changed since it was proposed.",
  foreign: "One of its memories belongs to another workspace.",
  protected: "It would change something you said or confirmed.",
  mismatch: "Its memories are no longer of the same kind and scope.",
  outranked: "A more trusted memory would be overridden.",
  duplicate: "CoWork already remembers this.",
  empty: "There is nothing to change.",
  changed: "These memories changed since; undo is no longer possible.",
  conflict: "Undoing would clash with a memory added since.",
  already_undone: "This change was already undone.",
};

function evidenceFromRef(entry: DreamingCandidate["evidenceRefs"][number]): MemoryReviewEvidence {
  const [ref, task] = entry.sourceUrlOrPath.split("#task:");
  const kind = ref.startsWith("memory:")
    ? "item"
    : ref.startsWith("archive:")
      ? "archive"
      : ref.startsWith("event:")
        ? "conversation"
        : "signal";
  return {
    kind,
    ref,
    snippet: entry.snippet ?? "",
    at: entry.capturedAt ?? null,
    taskId: task || null,
  };
}

function statusLabel(snapshot: CurationSnapshot | undefined): string | null {
  return snapshot ? snapshot.status : null;
}

export class MemoryReviewService {
  constructor(private readonly deps: MemoryReviewDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private writer(): MemoryWriter {
    const writer = this.deps.getWriter();
    if (!writer?.supportsCuration) {
      throw new MemoryReviewError("The memory engine is not running yet.", "unavailable");
    }
    return writer;
  }

  /** Number of pending proposals (the Memory Hub tab badge). */
  async count(workspaceId: string): Promise<number> {
    return this.deps.curation.pendingCount(workspaceId);
  }

  async state(workspaceId: string): Promise<MemoryReviewState> {
    const writer = this.deps.getWriter();
    const [pending, recent, runs, used] = await Promise.all([
      writer ? this.pending(workspaceId, writer) : Promise.resolve([]),
      writer ? this.recent(workspaceId, writer) : Promise.resolve([]),
      this.deps.dreaming.listRuns({ workspaceId, limit: 1 }),
      this.deps.curation.llmTokensSince(this.now() - DAY_MS),
    ]);
    const settings = this.deps.getSettings();
    const run = runs[0];
    return {
      pending,
      recent,
      pendingCount: pending.length,
      lastRun: run
        ? {
            id: run.id,
            status: run.status,
            startedAt: run.startedAt,
            completedAt: run.completedAt ?? null,
            applied: run.appliedCount ?? 0,
            queued: run.queuedCount ?? run.candidateCount,
            llmTokens: run.llmTokens ?? 0,
            summary: run.summary ?? null,
          }
        : null,
      llm: {
        enabled: settings.dreamingLlmEnabled === true,
        dailyTokenBudget: settings.dreamingLlmDailyTokenBudget ?? CURATION_LLM_DEFAULT_DAILY_BUDGET,
        tokensUsedToday: used,
      },
    };
  }

  private async loadItems(
    writer: MemoryWriter,
    itemIds: string[],
  ): Promise<Map<string, MemoryItem>> {
    const items = new Map<string, MemoryItem>();
    for (const itemId of new Set(itemIds)) {
      const item = await writer.repository.findById(itemId);
      if (item) items.set(itemId, item);
    }
    return items;
  }

  private async pending(
    workspaceId: string,
    writer: MemoryWriter,
  ): Promise<MemoryReviewProposal[]> {
    const candidates = await this.deps.dreaming.listCandidates({
      workspaceId,
      target: "memory_items",
      status: "proposed",
      limit: MAX_PENDING,
    });
    const proposals: MemoryReviewProposal[] = [];
    for (const candidate of candidates) {
      const operation = parseStoredCurationOperation(candidate.operation);
      if (!operation) {
        await this.dismiss(candidate.id, "Unreadable proposal.");
        continue;
      }
      const itemIds = proposalItemIds(operation);
      const items = await this.loadItems(writer, itemIds);
      const usable = itemIds.every((itemId) => {
        const item = items.get(itemId);
        return item && item.status === "active" && isMemoryItemVisibleIn(item, workspaceId);
      });
      if (!usable) {
        await this.dismiss(candidate.id, "Its memories changed or were removed since.");
        continue;
      }
      proposals.push({
        id: candidate.id,
        runId: candidate.runId,
        op: operation.op,
        title: operation.op === "promote" ? OP_TITLES.promote : candidate.proposedValue,
        rationale: candidate.rationale,
        reviewReason: candidate.reviewReason ?? "",
        confidence: candidate.confidence,
        origin: candidate.origin === "llm" ? "llm" : "heuristic",
        items: itemIds.map((itemId) => toMemoryHubItem(items.get(itemId) as MemoryItem)),
        keepId:
          operation.op === "merge" || operation.op === "resolve_conflict" ? operation.keepId : null,
        proposedContent: operation.op === "promote" ? operation.content : null,
        proposedKind: operation.op === "promote" ? operation.kind : null,
        evidence: candidate.evidenceRefs
          .map(evidenceFromRef)
          .filter((entry) => entry.kind !== "item"),
        createdAt: candidate.createdAt,
      });
    }
    return proposals;
  }

  private async recent(workspaceId: string, writer: MemoryWriter): Promise<MemoryCurationChange[]> {
    const logs = await this.deps.curation.listLog(workspaceId, MAX_RECENT);
    const changes: MemoryCurationChange[] = [];
    for (const log of logs) {
      changes.push({
        id: log.id,
        op: log.op as MemoryCurationChange["op"],
        origin: log.origin,
        summary: log.summary,
        rationale: log.rationale,
        items: this.changeItems(log),
        appliedAt: log.appliedAt,
        undoneAt: log.undoneAt,
        canUndo: log.undoneAt === null && (await this.unchangedSince(log, writer)),
      });
    }
    return changes;
  }

  private changeItems(log: CurationLogEntry): MemoryCurationChange["items"] {
    const before = new Map(log.before.map((entry) => [entry.id, entry]));
    return log.after.map((after) => ({
      id: after.id,
      kind: after.kind as MemoryCurationChange["items"][number]["kind"],
      content: after.content || before.get(after.id)?.content || "",
      before: statusLabel(before.get(after.id)),
      after: after.status,
    }));
  }

  private async unchangedSince(log: CurationLogEntry, writer: MemoryWriter): Promise<boolean> {
    for (const expected of log.after) {
      const current = await writer.repository.findById(expected.id);
      if (
        !current ||
        current.status !== expected.status ||
        current.updatedAt !== expected.updatedAt
      ) {
        return false;
      }
    }
    return true;
  }

  private async dismiss(candidateId: string, resolution: string): Promise<void> {
    try {
      await this.deps.dreaming.reviewCandidate({
        id: candidateId,
        status: "dismissed",
        resolution,
      });
    } catch (error) {
      logger.warn("Could not dismiss a stale review proposal:", error);
    }
  }

  private async requireCandidate(
    workspaceId: string,
    candidateId: string,
  ): Promise<DreamingCandidate> {
    const candidate = await this.deps.dreaming.findCandidateById(candidateId);
    if (
      !candidate ||
      candidate.workspaceId !== workspaceId ||
      candidate.target !== "memory_items"
    ) {
      throw new MemoryReviewError("Proposal not found.", "not_found");
    }
    return candidate;
  }

  async accept(workspaceId: string, candidateId: string): Promise<MemoryReviewMutationResult> {
    const candidate = await this.requireCandidate(workspaceId, candidateId);
    if (candidate.status !== "proposed") {
      return { success: false, error: "This proposal was already reviewed.", reason: "reviewed" };
    }
    const operation = parseStoredCurationOperation(candidate.operation);
    if (!operation) {
      await this.dismiss(candidate.id, "Unreadable proposal.");
      return { success: false, error: "This proposal cannot be applied.", reason: "invalid" };
    }
    const writer = this.writer();
    const items = await this.loadItems(writer, proposalItemIds(operation));
    if ([...items.values()].some((item) => !isMemoryItemVisibleIn(item, workspaceId))) {
      throw new MemoryReviewError("Proposal not found.", "not_found");
    }
    const common = {
      workspaceId,
      runId: candidate.runId,
      candidateId: candidate.id,
      origin: "review" as const,
      fingerprint: candidate.fingerprint ?? itemOperationFingerprint(operation),
      summary:
        operation.op === "promote"
          ? `Remembered: ${operation.content.slice(0, 120)}`
          : candidate.proposedValue.slice(0, 200),
      rationale: candidate.rationale,
      // The user accepted this change, so it may touch what they stated or confirmed.
      allowProtected: true,
    };
    const outcome =
      operation.op === "promote"
        ? await writer.applyCuration({
            ...common,
            operation: {
              op: "promote",
              candidate: {
                content: operation.content,
                kind: operation.kind,
                scope: "workspace",
                workspaceId,
                // Accepted by the user in the Review tab.
                source: "user_confirmed",
                sourceRef: {
                  store: "dreaming",
                  id: common.fingerprint,
                  reason: "accepted_proposal",
                  taskIds: operation.taskIds,
                  aliases: operation.evidenceIds.map((evidenceId) => `archive:${evidenceId}`),
                },
                confidence: candidate.confidence,
              },
            },
          })
        : await writer.applyCuration({ ...common, operation });
    if (outcome.status !== "applied") {
      const reason = outcome.reason;
      const message = REFUSAL_MESSAGES[reason] ?? `It could not be applied (${reason}).`;
      await this.dismiss(candidate.id, message);
      return { success: false, error: message, reason };
    }
    await this.deps.dreaming.reviewCandidate({
      id: candidate.id,
      status: "applied",
      resolution: "Accepted in the Memory Hub.",
    });
    await this.syncKit(workspaceId);
    return { success: true, message: "Applied. You can undo it under Recent changes." };
  }

  async reject(workspaceId: string, candidateId: string): Promise<MemoryReviewMutationResult> {
    const candidate = await this.requireCandidate(workspaceId, candidateId);
    if (candidate.status !== "proposed") {
      return { success: false, error: "This proposal was already reviewed.", reason: "reviewed" };
    }
    await this.deps.dreaming.reviewCandidate({
      id: candidate.id,
      status: "rejected",
      resolution: "Rejected in the Memory Hub.",
    });
    return { success: true, message: "Rejected. Dreaming will not propose it again." };
  }

  async undo(workspaceId: string, logId: string): Promise<MemoryReviewMutationResult> {
    const log = await this.deps.curation.findLog(logId);
    if (!log || log.workspaceId !== workspaceId) {
      throw new MemoryReviewError("Change not found.", "not_found");
    }
    const outcome = await this.writer().undoCuration(logId, workspaceId);
    if (outcome.status !== "undone") {
      const message = REFUSAL_MESSAGES[outcome.reason] ?? "It could not be undone.";
      return { success: false, error: message, reason: outcome.reason };
    }
    await this.syncKit(workspaceId);
    return { success: true, message: "Undone. Dreaming will not make this change again." };
  }

  async runNow(workspaceId: string): Promise<MemoryReviewRunResult> {
    if (!this.deps.runNow) {
      return { success: false, status: "unavailable", applied: 0, queued: 0 };
    }
    const result = await this.deps.runNow(workspaceId);
    if (!result) return { success: false, status: "unavailable", applied: 0, queued: 0 };
    return {
      success: result.run.status !== "failed",
      status: result.run.status,
      applied: result.appliedLogIds?.length ?? 0,
      queued: result.candidates.length,
      ...(result.skipped ? { skipped: result.skipped } : {}),
      ...(result.run.error ? { error: result.run.error } : {}),
    };
  }

  setLlmEnabled(enabled: boolean): MemoryReviewMutationResult {
    if (!this.deps.setLlmEnabled) {
      return {
        success: false,
        error: "This setting cannot be changed here.",
        reason: "unavailable",
      };
    }
    this.deps.setLlmEnabled(enabled);
    return { success: true };
  }

  private async syncKit(workspaceId: string): Promise<void> {
    try {
      await this.deps.syncKitFiles?.(workspaceId);
    } catch (error) {
      logger.warn("Kit file sync after a review change failed:", error);
    }
  }
}

export type { MemoryHubItem };
