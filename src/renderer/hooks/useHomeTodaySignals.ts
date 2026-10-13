import { useCallback, useState } from "react";
import type { AttentionItem, AttentionSourceName } from "../../shared/attention";
import type { HomeTodayHandledRow } from "../utils/home-today";
import { useAttentionSnapshot } from "./useAttentionSnapshot";

const SNOOZE_MS = 24 * 60 * 60 * 1000;

/** What a calendar card's action did; `message` says why it didn't go through. */
export type CalendarCardResult = { ok: true } | { ok: false; message: string };

const CALENDAR_UNAVAILABLE: CalendarCardResult = {
  ok: false,
  message: "Calendar actions aren't available here.",
};

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
  /** Stops showing a suggestion; ranking learns from it. */
  dismissSuggestion: (workspaceId: string, suggestionId: string) => Promise<void>;
  /** Keeps a follow-up suggestion as a commitment; false when it could not be saved. */
  addSuggestionAsCommitment: (workspaceId: string, suggestionId: string) => Promise<boolean>;
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
  /** Holds the time or declines the event a calendar card names, after a fresh check. */
  acceptCalendarProposal: (proposalId: string) => Promise<CalendarCardResult>;
  /** Stops showing a calendar card. */
  dismissCalendarProposal: (proposalId: string) => Promise<void>;
  /** Holds a free stretch on the calendar for a suggestion about making time. */
  holdCalendarTimeForSuggestion: (hold: {
    workspaceId: string;
    suggestionId: string;
    start: number;
    end: number;
  }) => Promise<CalendarCardResult>;
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

  const dismissSuggestion = useCallback(async (workspaceId: string, suggestionId: string) => {
    await window.electronAPI.dismissSuggestion(workspaceId, suggestionId);
  }, []);

  const addSuggestionAsCommitment = useCallback(
    async (workspaceId: string, suggestionId: string) => {
      const api = window.electronAPI;
      if (typeof api.addSuggestionAsCommitment !== "function") return false;
      const result = await api.addSuggestionAsCommitment(workspaceId, suggestionId);
      return result?.ok === true;
    },
    [],
  );

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

  const acceptCalendarProposal = useCallback(async (proposalId: string) => {
    const api = window.electronAPI;
    if (typeof api.acceptCalendarProposal !== "function") return CALENDAR_UNAVAILABLE;
    const outcome = await api.acceptCalendarProposal(proposalId);
    return outcome.ok ? ({ ok: true } as const) : { ok: false as const, message: outcome.message };
  }, []);

  const dismissCalendarProposal = useCallback(async (proposalId: string) => {
    const api = window.electronAPI;
    if (typeof api.dismissCalendarProposal !== "function") return;
    const result = await api.dismissCalendarProposal(proposalId);
    if (result?.ok === false) throw new Error("not saved");
  }, []);

  const holdCalendarTimeForSuggestion = useCallback(
    async (hold: { workspaceId: string; suggestionId: string; start: number; end: number }) => {
      const api = window.electronAPI;
      if (typeof api.holdCalendarTimeForSuggestion !== "function") return CALENDAR_UNAVAILABLE;
      const outcome = await api.holdCalendarTimeForSuggestion(hold);
      return outcome.ok
        ? ({ ok: true } as const)
        : { ok: false as const, message: outcome.message };
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
    dismissSuggestion,
    addSuggestionAsCommitment,
    completeCommitment,
    undoMemoryChange,
    answerQuestion,
    acceptCalendarProposal,
    dismissCalendarProposal,
    holdCalendarTimeForSuggestion,
    resolve,
  };
}
