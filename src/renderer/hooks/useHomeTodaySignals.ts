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

/** What a reply-draft card's action did; `sendAfter` is when a queued reply goes out. */
export type MailDraftResult = { ok: true; sendAfter?: number } | { ok: false; message: string };

const MAIL_UNAVAILABLE: MailDraftResult = {
  ok: false,
  message: "Reply drafts aren't available here.",
};

function mailResult(
  outcome: { ok: true; sendAfter?: number } | { ok: false; message: string } | undefined,
): MailDraftResult {
  if (!outcome) return MAIL_UNAVAILABLE;
  return outcome.ok
    ? { ok: true, ...(outcome.sendAfter ? { sendAfter: outcome.sendAfter } : {}) }
    : { ok: false, message: outcome.message };
}

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
  /** Queues a drafted reply in the outbox; it goes out after the send delay unless undone. */
  sendMailReplyDraft: (draftId: string) => Promise<MailDraftResult>;
  /** Takes back a queued reply; the draft can be edited again. */
  undoMailReplyDraftSend: (draftId: string) => Promise<MailDraftResult>;
  discardMailReplyDraft: (draftId: string) => Promise<MailDraftResult>;
  /** Saves an edited reply's text. */
  saveMailDraftBody: (draftId: string, bodyText: string) => Promise<void>;
  setMailReplyDraftsEnabled: (enabled: boolean) => Promise<void>;
  dismissMailReplyDraftsOffer: () => Promise<void>;
  /** Hides a card right away and, when given, records the row it leaves behind. */
  resolve: (cardId: string, row?: HomeTodayHandledRow) => void;
  /** Brings a card back (after an undo) and drops the row it left. */
  unresolve: (cardId: string, rowId: string) => void;
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

  const unresolve = useCallback((cardId: string, rowId: string) => {
    setResolved((current) => {
      const next = new Set(current);
      next.delete(cardId);
      return next;
    });
    setActedRows((current) => current.filter((item) => item.id !== rowId));
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

  const sendMailReplyDraft = useCallback(async (draftId: string) => {
    const api = window.electronAPI;
    if (typeof api.sendMailReplyDraft !== "function") return MAIL_UNAVAILABLE;
    return mailResult(await api.sendMailReplyDraft(draftId));
  }, []);

  const undoMailReplyDraftSend = useCallback(async (draftId: string) => {
    const api = window.electronAPI;
    if (typeof api.undoMailReplyDraftSend !== "function") return MAIL_UNAVAILABLE;
    return mailResult(await api.undoMailReplyDraftSend(draftId));
  }, []);

  const discardMailReplyDraft = useCallback(async (draftId: string) => {
    const api = window.electronAPI;
    if (typeof api.discardMailReplyDraft !== "function") return MAIL_UNAVAILABLE;
    return mailResult(await api.discardMailReplyDraft(draftId));
  }, []);

  const saveMailDraftBody = useCallback(async (draftId: string, bodyText: string) => {
    await window.electronAPI.updateMailboxDraft(draftId, { bodyText });
  }, []);

  const setMailReplyDraftsEnabled = useCallback(async (enabled: boolean) => {
    await window.electronAPI.setMailReplyDraftsEnabled(enabled);
  }, []);

  const dismissMailReplyDraftsOffer = useCallback(async () => {
    await window.electronAPI.dismissMailReplyDraftsOffer();
  }, []);

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
    sendMailReplyDraft,
    undoMailReplyDraftSend,
    discardMailReplyDraft,
    saveMailDraftBody,
    setMailReplyDraftsEnabled,
    dismissMailReplyDraftsOffer,
    resolve,
    unresolve,
  };
}
