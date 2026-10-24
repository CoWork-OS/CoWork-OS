import { useState } from "react";
import type { Task } from "../../shared/types";
import { useComputerView } from "../hooks/useComputerView";
import "./task-computer-panel.css";

/** One computer identity for the task, including non-bot tasks. Recovery never replays work. */
export function TaskComputerPanel({ task }: { task: Task }) {
  const binding = task.agentConfig?.executionEnvironmentBinding;
  const selection = binding?.selection || task.agentConfig?.executionEnvironment;
  const { state, busy, error, takeOver, handBack, openDesktop } = useComputerView(task.id, true);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const environment =
    state?.environment ||
    (binding
      ? {
          id: binding.id,
          backend: binding.selection.backend,
          lifetime: binding.selection.lifetime,
          state: binding.state,
          error: binding.error,
        }
      : undefined);
  const recover = async () => {
    setRecoveryBusy(true);
    setRecoveryMessage("");
    try {
      const result = (await window.electronAPI.computerEnvironmentAction(task.id, "reconcile")) as {
        outcome_unknown?: boolean;
      };
      setRecoveryMessage(
        result?.outcome_unknown
          ? "No completion receipt yet. Work was retained and has not been replayed."
          : "Computer state refreshed. Resume the task when it is ready.",
      );
    } catch (cause) {
      setRecoveryMessage(cause instanceof Error ? cause.message : "Recovery is still pending.");
    } finally {
      setRecoveryBusy(false);
    }
  };
  const held = state?.status === "held";
  return (
    <aside className="task-computer-panel" aria-label="Task computer">
      <div>
        <strong>
          {(environment?.backend || selection?.backend) === "cua"
            ? "Cua Space"
            : "Dedicated Linux computer"}
        </strong>
        <span>
          {" "}
          ·{" "}
          {(environment?.lifetime || selection?.lifetime) === "persistent"
            ? "Kept for this bot"
            : "Fresh for this task"}{" "}
          · {environment?.state || "Not started"}
        </span>
      </div>
      {environment?.id ? <small>Computer {environment.id.slice(0, 8)}</small> : null}
      {environment?.error ? <p role="status">{environment.error}</p> : null}
      {state?.frame && !held ? (
        <img src={state.frame.dataUrl} alt={state.frame.label || "Task computer preview"} />
      ) : null}
      {environment?.state !== "released" ? (
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void (held ? handBack() : takeOver())}
          >
            {held ? "Hand back" : "Take over"}
          </button>
          <button type="button" disabled={busy} onClick={() => void openDesktop()}>
            Open desktop
          </button>
          {["unknown", "allocating", "cleanup_pending"].includes(environment?.state || "") ? (
            <button type="button" disabled={recoveryBusy} onClick={() => void recover()}>
              {recoveryBusy ? "Checking…" : "Reconcile computer"}
            </button>
          ) : null}
        </div>
      ) : null}
      {held ? (
        <p>
          You have control. Agent actions are paused; previously started background jobs may still
          run.
        </p>
      ) : null}
      {error || recoveryMessage ? <p role="status">{error || recoveryMessage}</p> : null}
    </aside>
  );
}
