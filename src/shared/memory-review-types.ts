/**
 * Memory Hub "Review" contract for `memory_items`: the commitments CommitmentExpiryService
 * closed automatically, with undo (docs/memory-repo-phase3-design.md §6). The memory
 * folder's dreams have their own contract (memory-repo-types).
 */
import type { MemoryHubKind } from "./memory-hub-types";

/** Evidence that a commitment was done (kept in the expiry's rationale). */
export interface MemoryReviewEvidence {
  kind: "item" | "archive" | "conversation" | "signal";
  /** `memory:<id>`, `archive:<id>`, `event:<id>`. */
  ref: string;
  snippet: string;
  at: number | null;
  taskId: string | null;
}

export interface MemoryCurationChangeItem {
  id: string;
  kind: MemoryHubKind;
  content: string;
  before: string | null;
  after: string;
}

/** One automatic commitment expiry from the curation log. */
export interface MemoryCurationChange {
  id: string;
  op: "expire_commitment";
  origin: "auto" | "review";
  summary: string;
  rationale: string | null;
  items: MemoryCurationChangeItem[];
  appliedAt: number;
  undoneAt: number | null;
  canUndo: boolean;
}

export interface MemoryReviewState {
  recent: MemoryCurationChange[];
}

export type MemoryReviewMutationResult =
  | { success: true; message?: string }
  | { success: false; error: string; reason?: string };
