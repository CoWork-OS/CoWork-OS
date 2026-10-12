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

  return {
    attention: snapshot.items,
    failedSources: snapshot.failedSources,
    resolved,
    actedRows,
    markSuggestionStarted,
    snoozeSuggestion,
    completeCommitment,
    resolve,
  };
}
