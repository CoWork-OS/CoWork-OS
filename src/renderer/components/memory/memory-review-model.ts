/**
 * Memory Hub "Review": labels and the IPC flows behind the tab (Dreaming's proposals with
 * accept / reject, recent automatic changes with undo). Kept free of React so the flows
 * can be tested with a mocked API.
 */
import type { MemoryHubItem } from "../../../shared/memory-hub-types";
import type {
  MemoryCurationChange,
  MemoryCurationOp,
  MemoryReviewMutationResult,
  MemoryReviewProposal,
  MemoryReviewRunResult,
  MemoryReviewState,
} from "../../../shared/memory-review-types";

export type MemoryReviewApi = {
  getMemoryReview: (data: { workspaceId: string }) => Promise<MemoryReviewState>;
  getMemoryReviewCount: (data: { workspaceId: string }) => Promise<number>;
  acceptMemoryProposal: (data: {
    workspaceId: string;
    id: string;
  }) => Promise<MemoryReviewMutationResult>;
  rejectMemoryProposal: (data: {
    workspaceId: string;
    id: string;
  }) => Promise<MemoryReviewMutationResult>;
  undoMemoryChange: (data: {
    workspaceId: string;
    id: string;
  }) => Promise<MemoryReviewMutationResult>;
  runMemoryCuration: (data: { workspaceId: string }) => Promise<MemoryReviewRunResult>;
  setMemoryCurationLlmEnabled: (data: {
    workspaceId: string;
    enabled: boolean;
  }) => Promise<MemoryReviewMutationResult>;
};

export const MEMORY_REVIEW_METHODS = [
  "getMemoryReview",
  "getMemoryReviewCount",
  "acceptMemoryProposal",
  "rejectMemoryProposal",
  "undoMemoryChange",
  "runMemoryCuration",
  "setMemoryCurationLlmEnabled",
] as const;

export const OP_LABELS: Record<MemoryCurationOp, string> = {
  merge: "Merge",
  resolve_conflict: "Contradiction",
  promote: "New fact",
  decay: "Unused",
  expire_commitment: "Commitment",
};

export const STATUS_LABELS: Record<string, string> = {
  active: "active",
  superseded: "merged away",
  archived: "archived",
  deleted: "removed",
};

/** What happens to an item if the proposal is accepted. */
export function proposalItemRole(
  proposal: Pick<MemoryReviewProposal, "op" | "keepId">,
  item: Pick<MemoryHubItem, "id">,
): "keep" | "merge" | "drop" | "archive" {
  switch (proposal.op) {
    case "merge":
      return item.id === proposal.keepId ? "keep" : "merge";
    case "resolve_conflict":
      return item.id === proposal.keepId ? "keep" : "drop";
    default:
      return "archive";
  }
}

export const ROLE_LABELS: Record<ReturnType<typeof proposalItemRole>, string> = {
  keep: "Keep",
  merge: "Fold into the kept one",
  drop: "Retire",
  archive: "Archive",
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

async function refreshAfter(
  api: MemoryReviewApi,
  workspaceId: string,
  result: MemoryReviewMutationResult,
  fallbackNotice: string,
): Promise<ReviewFlowResult> {
  const state = await api.getMemoryReview({ workspaceId });
  if (!result.success) return { state, error: result.error };
  return { state, notice: result.message ?? fallbackNotice };
}

export async function acceptProposal(
  api: MemoryReviewApi,
  workspaceId: string,
  proposalId: string,
): Promise<ReviewFlowResult> {
  try {
    const result = await api.acceptMemoryProposal({ workspaceId, id: proposalId });
    return await refreshAfter(api, workspaceId, result, "Applied.");
  } catch (error) {
    return { state: null, error: error instanceof Error ? error.message : "Failed to apply." };
  }
}

export async function rejectProposal(
  api: MemoryReviewApi,
  workspaceId: string,
  proposalId: string,
): Promise<ReviewFlowResult> {
  try {
    const result = await api.rejectMemoryProposal({ workspaceId, id: proposalId });
    return await refreshAfter(api, workspaceId, result, "Rejected.");
  } catch (error) {
    return { state: null, error: error instanceof Error ? error.message : "Failed to reject." };
  }
}

export async function undoChange(
  api: MemoryReviewApi,
  workspaceId: string,
  changeId: string,
): Promise<ReviewFlowResult> {
  try {
    const result = await api.undoMemoryChange({ workspaceId, id: changeId });
    return await refreshAfter(api, workspaceId, result, "Undone.");
  } catch (error) {
    return { state: null, error: error instanceof Error ? error.message : "Failed to undo." };
  }
}

export async function runCurationNow(
  api: MemoryReviewApi,
  workspaceId: string,
): Promise<ReviewFlowResult> {
  try {
    const result = await api.runMemoryCuration({ workspaceId });
    const state = await api.getMemoryReview({ workspaceId });
    if (!result.success) {
      return { state, error: result.error ?? `Dreaming did not run (${result.status}).` };
    }
    if (result.skipped) {
      return { state, notice: "Dreaming is already running for this workspace." };
    }
    return {
      state,
      notice:
        result.status === "skipped"
          ? "Nothing to curate yet."
          : `Dreaming applied ${result.applied} change(s) and queued ${result.queued} for review.`,
    };
  } catch (error) {
    return {
      state: null,
      error: error instanceof Error ? error.message : "Failed to run Dreaming.",
    };
  }
}

export async function setLlmSynthesis(
  api: MemoryReviewApi,
  workspaceId: string,
  enabled: boolean,
): Promise<ReviewFlowResult> {
  try {
    const result = await api.setMemoryCurationLlmEnabled({ workspaceId, enabled });
    return await refreshAfter(
      api,
      workspaceId,
      result,
      enabled ? "AI synthesis is on." : "AI synthesis is off.",
    );
  } catch (error) {
    return {
      state: null,
      error: error instanceof Error ? error.message : "Failed to change the setting.",
    };
  }
}
