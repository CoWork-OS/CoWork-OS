import { useCallback, useEffect, useRef, useState } from "react";
import {
  attentionFromCommitment,
  attentionFromSuggestion,
  rankAttention,
  type AttentionItem,
  type AttentionSourceName,
} from "../../shared/attention";
import type { ProactiveSuggestion } from "../../shared/types";
import type { HomeTodayHandledRow } from "../utils/home-today";

/** Fallback poll; changes normally arrive through the queue's change signal. */
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
/** Collapses a burst of change signals into one reload. */
const RELOAD_DELAY_MS = 250;
const SNOOZE_MS = 24 * 60 * 60 * 1000;
/** Commitments become cards once they are due within this window, or overdue. */
const COMMITMENT_WINDOW_HOURS = 24;

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

interface Loaded {
  items: AttentionItem[];
  failedSources: AttentionSourceName[];
}

/**
 * Hosts without the shared queue (the browser host, for now) still get suggestions and
 * commitments, read directly and mapped the same way the queue maps them. Waiting sessions
 * come from the renderer's own task list in that case.
 */
async function loadWithoutQueue(): Promise<Loaded> {
  const api = window.electronAPI;
  const failedSources: AttentionSourceName[] = [];
  const context = { localLabel: "This device" };
  const now = Date.now();
  const suggestions = await (async () => {
    const workspaces = (await api.listWorkspaces()).filter(
      (workspace) => !workspace.isTemp && !String(workspace.id).startsWith("__temp_workspace__"),
    );
    if (workspaces.length === 0) return [];
    const entries = await api.listSuggestionsForWorkspaces(workspaces.map((item) => item.id));
    return (Array.isArray(entries) ? entries : []).flatMap((entry) =>
      (Array.isArray(entry.suggestions) ? (entry.suggestions as ProactiveSuggestion[]) : [])
        .map((suggestion) => attentionFromSuggestion(suggestion, entry.workspaceId, context))
        .filter((item): item is AttentionItem => item !== null),
    );
  })().catch(() => {
    failedSources.push("suggestions");
    return [];
  });
  const commitments = await api
    .getDueSoonCommitments(COMMITMENT_WINDOW_HOURS)
    .then((result) =>
      (Array.isArray(result?.items) ? result.items : [])
        .filter((item) => typeof item?.id === "string" && typeof item?.text === "string")
        .map((item) => attentionFromCommitment(item, now, context))
        .filter((item): item is AttentionItem => item !== null),
    )
    .catch(() => {
      failedSources.push("commitments");
      return [];
    });
  return { items: rankAttention([...suggestions, ...commitments]), failedSources };
}

async function loadAttention(): Promise<Loaded> {
  const api = window.electronAPI;
  if (typeof api.listAttention !== "function") return loadWithoutQueue();
  const snapshot = await api.listAttention();
  return {
    items: Array.isArray(snapshot?.items) ? snapshot.items : [],
    failedSources: Array.isArray(snapshot?.failedSources) ? snapshot.failedSources : [],
  };
}

/**
 * The shared "needs you" queue for the Calm home's Today stack. Loads while `enabled`, then
 * again when the main process signals a change, when the window regains focus, and every
 * couple of minutes as a fallback. A failed load keeps the last good snapshot.
 */
export function useHomeTodaySignals(enabled: boolean): HomeTodaySignals {
  const [loaded, setLoaded] = useState<Loaded>({ items: [], failedSources: [] });
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  const [actedRows, setActedRows] = useState<HomeTodayHandledRow[]>([]);
  const loadSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++loadSeq.current;
    const next = await loadAttention().catch(() => null);
    if (seq !== loadSeq.current || !next) return;
    setLoaded(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let reloadTimer: number | undefined;
    const scheduleReload = () => {
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => void refresh(), RELOAD_DELAY_MS);
    };
    void refresh();
    const api = window.electronAPI;
    const unsubscribe =
      typeof api.onAttentionChanged === "function" ? api.onAttentionChanged(scheduleReload) : null;
    window.addEventListener("focus", scheduleReload);
    const poll = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", scheduleReload);
      window.clearInterval(poll);
      window.clearTimeout(reloadTimer);
      loadSeq.current += 1;
    };
  }, [enabled, refresh]);

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
    attention: loaded.items,
    failedSources: loaded.failedSources,
    resolved,
    actedRows,
    markSuggestionStarted,
    snoozeSuggestion,
    completeCommitment,
    resolve,
  };
}
