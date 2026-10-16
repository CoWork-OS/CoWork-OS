import { useCallback, useEffect, useState } from "react";
import type { ComputerViewState } from "../../shared/computer-view";

/** A task's computer as the bot's panel shows it: latest frame, status, and take-over. */
export function useComputerView(taskId: string | undefined, enabled = true) {
  const [state, setState] = useState<ComputerViewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    setState(null);
    setError(null);
    if (!taskId || !enabled || !api?.watchComputerView) return;
    let cancelled = false;
    const unsubscribe = api.onComputerViewEvent?.((next) => {
      if (!cancelled && next?.taskId === taskId) setState(next);
    });
    api
      .watchComputerView(taskId)
      .then((initial) => {
        if (!cancelled && initial) setState(initial);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe?.();
      void api.unwatchComputerView?.(taskId).catch(() => undefined);
    };
  }, [taskId, enabled]);

  const run = useCallback(
    async (action: (id: string) => Promise<unknown> | undefined) => {
      if (!taskId) return;
      setBusy(true);
      setError(null);
      try {
        const next = await action(taskId);
        if (next && typeof next === "object" && "status" in next) {
          setState(next as ComputerViewState);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not change who has control.");
      } finally {
        setBusy(false);
      }
    },
    [taskId],
  );

  const takeOver = useCallback(
    () => run((id) => window.electronAPI?.takeOverComputer?.(id)),
    [run],
  );
  const handBack = useCallback(
    () => run((id) => window.electronAPI?.handBackComputer?.(id)),
    [run],
  );

  const openDesktop = useCallback(
    () => run((id) => window.electronAPI?.openBotDesktop?.(id)),
    [run],
  );
  const stopDesktop = useCallback(
    () => run((id) => window.electronAPI?.stopBotDesktop?.(id)),
    [run],
  );

  return { state, busy, error, takeOver, handBack, openDesktop, stopDesktop };
}
