import { useEffect, useState } from "react";

interface Props {
  taskId: string;
  primaryOutputPath?: string;
  onViewOutputs: (taskId: string, path?: string) => void;
}

type LocalState = { inspectedAt: number | null; usefulAt: number | null; returnUse: boolean };

export function RealWorkFeedback({ taskId, primaryOutputPath, onViewOutputs }: Props) {
  const [state, setState] = useState<LocalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [outputOpened, setOutputOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setState(null);
    void window.electronAPI
      .getFirstTaskRealWork(taskId)
      .then((next) => {
        if (current) setState(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [taskId]);

  const inspect = async () => {
    setBusy(true);
    setError(null);
    try {
      onViewOutputs(taskId, primaryOutputPath);
      setOutputOpened(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record output inspection.");
    } finally {
      setBusy(false);
    }
  };

  const confirmInspection = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await window.electronAPI.inspectFirstTaskRealWork(taskId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your inspection.");
    } finally {
      setBusy(false);
    }
  };

  const markUseful = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await window.electronAPI.markFirstTaskRealWorkUseful(taskId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your answer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="first-task-card" aria-label="Real work feedback">
      <h2>Your result</h2>
      <p>
        Open the output and decide whether this task helped with your own work. Your answer stays on
        this device.
      </p>
      <button type="button" disabled={busy} onClick={() => void inspect()}>
        View output
      </button>
      {outputOpened && !state?.inspectedAt && (
        <button type="button" disabled={busy} onClick={() => void confirmInspection()}>
          I reviewed the output
        </button>
      )}
      {state?.inspectedAt && !state.usefulAt && (
        <button type="button" disabled={busy} onClick={() => void markUseful()}>
          Yes, this was useful
        </button>
      )}
      {state?.usefulAt && (
        <p role="status">
          Marked useful.
          {state.returnUse ? " You also returned on a later day for useful work." : ""}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
