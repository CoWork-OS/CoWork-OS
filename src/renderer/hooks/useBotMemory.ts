import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryRepoBotMemoryReport } from "../../shared/memory-repo-types";

export interface BotMemoryState {
  report: MemoryRepoBotMemoryReport | null;
  loading: boolean;
  error: string | null;
  /** A forget or undo is running. */
  busy: boolean;
  reload: () => void;
  forget: (ref: string, hash: string) => Promise<void>;
  undo: (commit: string) => Promise<void>;
}

/**
 * A bot's own memory (its file in the memory folder) for the bot's details panel. Reloads
 * when the bot changes and when `refreshKey` changes (e.g. after a turn finished).
 */
export function useBotMemory(
  botId: string | null | undefined,
  refreshKey?: unknown,
): BotMemoryState {
  const [report, setReport] = useState<MemoryRepoBotMemoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const api = window.electronAPI;
    if (!botId || !api?.getBotMemory) {
      setReport(null);
      return;
    }
    const request = ++latest.current;
    setLoading(true);
    api
      .getBotMemory({ botId })
      .then((next) => {
        if (request !== latest.current) return;
        setReport(next);
        setError(null);
      })
      .catch(() => {
        if (request === latest.current) setError("Could not load this bot's memory.");
      })
      .finally(() => {
        if (request === latest.current) setLoading(false);
      });
  }, [botId, refreshKey, token]);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  const run = useCallback(
    async (action: () => Promise<{ ok: boolean; error?: string } | undefined>) => {
      setBusy(true);
      try {
        const result = await action();
        setError(result && !result.ok ? (result.error ?? "That did not work.") : null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "That did not work.");
      } finally {
        setBusy(false);
        reload();
      }
    },
    [reload],
  );

  const forget = useCallback(
    (ref: string, hash: string) =>
      run(async () =>
        botId ? window.electronAPI?.forgetBotMemoryEntry?.({ botId, ref, hash }) : undefined,
      ),
    [botId, run],
  );

  const undo = useCallback(
    (commit: string) =>
      run(async () =>
        botId ? window.electronAPI?.undoBotMemoryChange?.({ botId, commit }) : undefined,
      ),
    [botId, run],
  );

  return { report, loading, error, busy, reload, forget, undo };
}
