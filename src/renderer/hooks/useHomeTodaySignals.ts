import { useCallback, useState } from "react";
import type { AttentionItem, AttentionSourceName } from "../../shared/attention";
import type { HomeTodayHandledRow } from "../utils/home-today";
import { useAttentionSnapshot } from "./useAttentionSnapshot";

const SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface HomeTodaySignals {
  /** The shared queue's items, most pressing first. */
  attention: AttentionItem[];
  /** Sources the last load could not read; their items are missing, not resolved. */
  failedSources: AttentionSourceName[];
  /** Card ids acted on in this view; hidden until the next load confirms they're gone. */
  resolved: ReadonlySet<string>;
  /** Rows the user's own actions left behind, newest first. */
  actedRows: HomeTodayHandledRow[];
  /** Records that the user started a suggestion, after its task was created. */
  markSuggestionStarted: (workspaceId: string, suggestionId: string) => Promise<void>;
  snoozeSuggestion: (workspaceId: string, suggestionId: string) => Promise<void>;
  completeCommitment: (commitmentId: string) => Promise<boolean>;
  /** Reopens a commitment memory closed on its own; the error says why it could not. */
  undoMemoryChange: (
    workspaceId: string,
    changeId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Answers a single question with one of its options. "handled" and "duplicate" mean the
   * answer is in; "not_found" means the question was already answered or closed.
   */
  answerQuestion: (
    requestId: string,
    questionId: string,
    optionLabel: string,
  ) => Promise<"handled" | "duplicate" | "not_found" | "in_progress">;
  /** Hides a card right away and, when given, records the row it leaves behind. */
  resolve: (cardId: string, row?: HomeTodayHandledRow) => void;
}

/** The shared queue for the Calm home's Today stack, plus the actions its cards take. */
export function useHomeTodaySignals(enabled: boolean): HomeTodaySignals {
  const snapshot = useAttentionSnapshot(enabled);
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  const [actedRows, setActedRows] = useState<HomeTodayHandledRow[]>([]);

  const resolve = useCallback((cardId: string, row?: HomeTodayHandledRow) => {
    setResolved((current) => new Set(current).add(cardId));
    if (row) setActedRows((current) => [row, ...current.filter((item) => item.id !== row.id)]);
  }, []);

  const markSuggestionStarted = useCallback(async (workspaceId: string, suggestionId: string) => {
    await window.electronAPI.actOnSuggestion(workspaceId, suggestionId);
  }, []);

  const snoozeSuggestion = useCallback(async (workspaceId: string, suggestionId: string) => {
    await window.electronAPI.snoozeSuggestion(workspaceId, suggestionId, Date.now() + SNOOZE_MS);
  }, []);

  const completeCommitment = useCallback(async (commitmentId: string) => {
    const updated = await window.electronAPI.updateRelationshipMemory({
      id: commitmentId,
      status: "done",
    });
    return Boolean(updated);
  }, []);

  const undoMemoryChange = useCallback(async (workspaceId: string, changeId: string) => {
    const result = await window.electronAPI.undoMemoryChange({ workspaceId, id: changeId });
    return result?.success
      ? ({ ok: true } as const)
      : ({ ok: false, error: result?.error || "It could not be undone." } as const);
  }, []);

  const answerQuestion = useCallback(
    async (requestId: string, questionId: string, optionLabel: string) => {
      const response = await window.electronAPI.respondToInputRequest({
        requestId,
        status: "submitted",
        answers: { [questionId]: { optionLabel } },
      });
      return response.status;
    },
    [],
  );

  return {
    attention: snapshot.items,
    failedSources: snapshot.failedSources,
    resolved,
    actedRows,
    markSuggestionStarted,
    snoozeSuggestion,
    completeCommitment,
    undoMemoryChange,
    answerQuestion,
    resolve,
  };
}
