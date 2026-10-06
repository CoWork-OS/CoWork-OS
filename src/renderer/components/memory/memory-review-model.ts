/**
 * Memory Hub "Review": labels and the IPC flows behind the tab's "Recent changes" list (the
 * commitments closed automatically, with undo). Kept free of React so the flows can be
 * tested with a mocked API.
 */
import type {
  MemoryCurationChange,
  MemoryReviewMutationResult,
  MemoryReviewState,
} from "../../../shared/memory-review-types";

export type MemoryReviewApi = {
  getMemoryReview: (data: { workspaceId: string }) => Promise<MemoryReviewState>;
  undoMemoryChange: (data: {
    workspaceId: string;
    id: string;
  }) => Promise<MemoryReviewMutationResult>;
};

export const MEMORY_REVIEW_METHODS = ["getMemoryReview", "undoMemoryChange"] as const;

export const STATUS_LABELS: Record<string, string> = {
  active: "open",
  superseded: "merged away",
  archived: "closed",
  deleted: "removed",
};

export function changeLine(item: MemoryCurationChange["items"][number]): string {
  const before = item.before ? (STATUS_LABELS[item.before] ?? item.before) : "new";
  const after = STATUS_LABELS[item.after] ?? item.after;
  return before === after ? after : `${before} → ${after}`;
}

export interface ReviewFlowResult {
  state: MemoryReviewState | null;
  notice?: string;
  error?: string;
}

export async function undoChange(
  api: MemoryReviewApi,
  workspaceId: string,
  changeId: string,
): Promise<ReviewFlowResult> {
  try {
    const result = await api.undoMemoryChange({ workspaceId, id: changeId });
    const state = await api.getMemoryReview({ workspaceId });
    if (!result.success) return { state, error: result.error };
    return { state, notice: result.message ?? "Undone." };
  } catch (error) {
    return { state: null, error: error instanceof Error ? error.message : "Failed to undo." };
  }
}
