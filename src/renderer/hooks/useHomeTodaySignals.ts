import { useCallback, useEffect, useRef, useState } from "react";
import type { ProactiveSuggestion } from "../../shared/types";
import {
  HOME_COMMITMENT_WINDOW_HOURS,
  type HomeTodayCommitment,
  type HomeTodayHandledRow,
  type HomeTodaySuggestion,
} from "../utils/home-today";

const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface HomeTodaySignals {
  suggestions: HomeTodaySuggestion[];
  commitments: HomeTodayCommitment[];
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

function isCommitment(value: unknown): value is HomeTodayCommitment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<HomeTodayCommitment>;
  return typeof item.id === "string" && typeof item.text === "string";
}

async function loadSuggestions(): Promise<HomeTodaySuggestion[]> {
  const api = window.electronAPI;
  const workspaces = (await api.listWorkspaces()).filter(
    (workspace) => !String(workspace.id || "").startsWith("__temp_workspace__"),
  );
  if (workspaces.length === 0) return [];
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const entries = await api.listSuggestionsForWorkspaces(workspaces.map((item) => item.id));
  return (Array.isArray(entries) ? entries : []).flatMap((entry) =>
    (Array.isArray(entry.suggestions) ? (entry.suggestions as ProactiveSuggestion[]) : []).map(
      (suggestion) => ({
        ...suggestion,
        workspaceId: entry.workspaceId,
        workspaceName: names.get(entry.workspaceId),
      }),
    ),
  );
}

async function loadCommitments(): Promise<HomeTodayCommitment[]> {
  const result = await window.electronAPI.getDueSoonCommitments(HOME_COMMITMENT_WINDOW_HOURS);
  return (Array.isArray(result?.items) ? result.items : []).filter(isCommitment);
}

/**
 * Suggestions and due commitments for the Calm home's Today stack. Loads while
 * `enabled`, then again when the window regains focus and every couple of minutes.
 * Each source fails on its own: a broken suggestion store still shows commitments.
 */
export function useHomeTodaySignals(enabled: boolean): HomeTodaySignals {
  const [suggestions, setSuggestions] = useState<HomeTodaySuggestion[]>([]);
  const [commitments, setCommitments] = useState<HomeTodayCommitment[]>([]);
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  const [actedRows, setActedRows] = useState<HomeTodayHandledRow[]>([]);
  const loadSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [nextSuggestions, nextCommitments] = await Promise.all([
      loadSuggestions().catch(() => null),
      loadCommitments().catch(() => null),
    ]);
    if (seq !== loadSeq.current) return;
    if (nextSuggestions) setSuggestions(nextSuggestions);
    if (nextCommitments) setCommitments(nextCommitments);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
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
    suggestions,
    commitments,
    resolved,
    actedRows,
    markSuggestionStarted,
    snoozeSuggestion,
    completeCommitment,
    resolve,
  };
}
