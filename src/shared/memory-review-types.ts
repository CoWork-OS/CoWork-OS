/**
 * Memory Hub "Review" contract: Dreaming's curation proposals over `memory_items` and the
 * log of changes it applied (docs/memory-engine.md §9). Renderer-facing; the engine's
 * operation vocabulary is defined here and reused by `src/electron/memory`.
 */
import type { MemoryHubItem, MemoryHubKind } from "./memory-hub-types";

/** Operations the curator may propose. Anything else is refused at every layer. */
export const MEMORY_CURATION_OPS = [
  "merge",
  "resolve_conflict",
  "promote",
  "decay",
  "expire_commitment",
] as const;
export type MemoryCurationOp = (typeof MEMORY_CURATION_OPS)[number];

/** Kinds a promotion may create (facts learned from recurring archive outcomes). */
export const MEMORY_CURATION_PROMOTION_KINDS = [
  "correction",
  "rule",
  "preference",
  "project_fact",
] as const satisfies readonly MemoryHubKind[];
export type MemoryCurationPromotionKind = (typeof MEMORY_CURATION_PROMOTION_KINDS)[number];

/** One curation operation. Item operations reference existing `memory_items` ids only. */
export type MemoryCurationOperation =
  /** Near-duplicates: keep `keepId`, supersede the others into it. */
  | { op: "merge"; keepId: string; mergeIds: string[] }
  /** Contradiction: keep `keepId`, supersede `dropIds`. */
  | { op: "resolve_conflict"; keepId: string; dropIds: string[] }
  /** A recurring archive outcome becomes an `inferred` workspace fact. */
  | {
      op: "promote";
      kind: MemoryCurationPromotionKind;
      content: string;
      /** Archive row ids (`memories.id`) the fact was learned from. */
      evidenceIds: string[];
      /** Distinct tasks behind the evidence (at least two). */
      taskIds: string[];
    }
  /** Unused, low-trust items are archived. */
  | { op: "decay"; itemIds: string[] }
  /** Commitments past due with a "done" signal are archived. */
  | { op: "expire_commitment"; itemIds: string[] };

export type MemoryCurationOrigin = "heuristic" | "llm";

export interface MemoryReviewEvidence {
  kind: "item" | "archive" | "conversation" | "signal";
  /** `memory:<id>`, `archive:<id>`, `event:<id>`. */
  ref: string;
  snippet: string;
  at: number | null;
  taskId: string | null;
}

export interface MemoryReviewProposal {
  id: string;
  runId: string;
  op: MemoryCurationOp;
  title: string;
  /** Why Dreaming proposes it. */
  rationale: string;
  /** Why it was not applied automatically. */
  reviewReason: string;
  confidence: number;
  origin: MemoryCurationOrigin;
  /** The items the operation touches, as they are now. */
  items: MemoryHubItem[];
  keepId: string | null;
  /** Content of a promoted fact. */
  proposedContent: string | null;
  proposedKind: MemoryHubKind | null;
  evidence: MemoryReviewEvidence[];
  createdAt: number;
}

export interface MemoryCurationChangeItem {
  id: string;
  kind: MemoryHubKind;
  content: string;
  before: string | null;
  after: string;
}

export interface MemoryCurationChange {
  id: string;
  op: MemoryCurationOp;
  /** `auto`: applied by Dreaming; `review`: applied when you accepted a proposal. */
  origin: "auto" | "review";
  summary: string;
  rationale: string | null;
  items: MemoryCurationChangeItem[];
  appliedAt: number;
  undoneAt: number | null;
  canUndo: boolean;
}

export interface MemoryReviewState {
  pending: MemoryReviewProposal[];
  recent: MemoryCurationChange[];
  pendingCount: number;
  lastRun: {
    id: string;
    status: string;
    startedAt: number;
    completedAt: number | null;
    applied: number;
    queued: number;
    llmTokens: number;
    summary: string | null;
  } | null;
  llm: { enabled: boolean; dailyTokenBudget: number; tokensUsedToday: number };
}

export type MemoryReviewMutationResult =
  | { success: true; message?: string }
  | { success: false; error: string; reason?: string };

export interface MemoryReviewRunResult {
  success: boolean;
  status: string;
  applied: number;
  queued: number;
  skipped?: string;
  error?: string;
}
