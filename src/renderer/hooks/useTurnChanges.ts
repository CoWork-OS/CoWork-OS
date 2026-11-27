import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnChangeSet, TurnChangesUndoResult } from "../../shared/turn-changes";

/** Wait this long after the last change before asking again. */
const REFRESH_DELAY_MS = 400;

/**
 * The files each turn of a task changed through the file tools, by turn key, and undoing a
 * turn. Asks again when the turn ends and whenever `refreshToken` changes while it is idle.
 */
export function useTurnChanges(
  taskId: string | undefined,
  isTaskWorking: boolean,
  refreshToken: string | number,
): {
  changeSets: ReadonlyMap<string, TurnChangeSet>;
  undoTurn: (turnKey: string) => Promise<TurnChangesUndoResult>;
} {
  const [changeSets, setChangeSets] = useState<ReadonlyMap<string, TurnChangeSet>>(() => new Map());
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    if (!taskId || typeof api?.listTurnChanges !== "function") {
      setChangeSets(new Map());
      return;
    }
    const request = ++requestRef.current;
    try {
      const sets = await api.listTurnChanges(taskId);
      if (request !== requestRef.current) return;
      setChangeSets(new Map((Array.isArray(sets) ? sets : []).map((set) => [set.turnKey, set])));
    } catch {
      if (request === requestRef.current) setChangeSets(new Map());
    }
  }, [taskId]);

  useEffect(() => {
    setChangeSets(new Map());
  }, [taskId]);

  useEffect(() => {
    if (isTaskWorking) return;
    const timer = window.setTimeout(() => void refresh(), REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [refresh, isTaskWorking, refreshToken]);

  const undoTurn = useCallback(
    async (turnKey: string): Promise<TurnChangesUndoResult> => {
      const api = window.electronAPI;
      if (!taskId || typeof api?.undoTurnChanges !== "function") {
        return { ok: false, restored: [], error: "Undo is not available here." };
      }
      try {
        return await api.undoTurnChanges(taskId, turnKey);
      } catch (error) {
        return {
          ok: false,
          restored: [],
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await refresh();
      }
    },
    [taskId, refresh],
  );

  return { changeSets, undoTurn };
}
