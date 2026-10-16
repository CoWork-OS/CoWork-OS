import { useCallback, useEffect, useState } from "react";
import type { TaughtTask } from "../../shared/bot-computer";

/** "8 s", "2 min 5 s". */
export function formatTaughtTaskLength(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

function readError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** Teach a task: the bot's taught tasks, and recording a new one on its own desktop. */
export function useTaughtTasks(taskId: string, enabled: boolean) {
  const [tasks, setTasks] = useState<TaughtTask[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    if (!enabled || !api?.listTaughtTasks) {
      setTasks([]);
      return;
    }
    try {
      const list = await api.listTaughtTasks(taskId);
      setTasks(Array.isArray(list) ? list : []);
    } catch {
      setTasks([]);
    }
  }, [taskId, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A new conversation or bot starts out not recording.
  useEffect(() => {
    setRecording(false);
    setError(null);
  }, [taskId]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(readError(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  const startRecording = useCallback(
    () =>
      run(async () => {
        await window.electronAPI.startTeachingTask(taskId);
        setRecording(true);
      }),
    [run, taskId],
  );

  /** Stops recording and saves it under the name, or discards it when the name is null. */
  const finishRecording = useCallback(
    (name: string | null) =>
      run(async () => {
        await window.electronAPI.finishTeachingTask(taskId, name);
        setRecording(false);
        await refresh();
      }),
    [run, taskId, refresh],
  );

  const deleteTask = useCallback(
    (taughtTaskId: string) =>
      run(async () => {
        await window.electronAPI.deleteTaughtTask(taskId, taughtTaskId);
        await refresh();
      }),
    [run, taskId, refresh],
  );

  return { tasks, recording, busy, error, startRecording, finishRecording, deleteTask };
}
