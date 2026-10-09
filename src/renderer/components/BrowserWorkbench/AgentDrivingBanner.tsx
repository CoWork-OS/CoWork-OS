import { useEffect, useState } from "react";
import { Hand, LogIn, Play, X } from "lucide-react";

type DrivingState = {
  driving: { toolName: string; label: string; startedAt: number } | null;
  pausedByUser: boolean;
};

/**
 * Agent ↔ user hand-off for the workbench: "CoWork is using this tab" while
 * CoWork acts, a shield that turns a click on the page into "take over", and
 * the paused state with Resume. Also the sign-in hand-back banner.
 */
export function useAgentDriving(taskId: string, sessionId: string): DrivingState {
  const [state, setState] = useState<DrivingState>({ driving: null, pausedByUser: false });
  useEffect(() => {
    setState({ driving: null, pausedByUser: false });
    const unsubscribe = window.electronAPI.onBrowserWorkbenchDriving?.((event) => {
      if (event.taskId !== taskId || event.sessionId !== sessionId) return;
      setState({ driving: event.driving, pausedByUser: event.pausedByUser });
    });
    return () => unsubscribe?.();
  }, [sessionId, taskId]);
  return state;
}

export function AgentDrivingBanner({
  taskId,
  sessionId,
  state,
}: {
  taskId: string;
  sessionId: string;
  state: DrivingState;
}) {
  const setPaused = (paused: boolean) =>
    void window.electronAPI
      .setBrowserWorkbenchPaused?.({ taskId, sessionId, paused })
      .catch(() => undefined);

  if (state.pausedByUser) {
    return (
      <div className="browser-workbench-driving is-paused" role="status">
        <Hand size={14} aria-hidden="true" />
        <span>You have control. CoWork is paused in this browser.</span>
        <button type="button" className="is-primary" onClick={() => setPaused(false)}>
          <Play size={13} aria-hidden="true" />
          Resume CoWork
        </button>
      </div>
    );
  }
  if (!state.driving) return null;
  return (
    <div className="browser-workbench-driving" role="status">
      <span className="browser-workbench-driving-dot" aria-hidden="true" />
      <span>
        CoWork is using this tab
        <span className="browser-workbench-driving-label"> · {state.driving.label}</span>
      </span>
      <button type="button" onClick={() => setPaused(true)}>
        <Hand size={13} aria-hidden="true" />
        Take over
      </button>
    </div>
  );
}

/** Covers the page while CoWork acts so a stray click becomes an explicit take-over. */
export function AgentDrivingShield({ taskId, sessionId }: { taskId: string; sessionId: string }) {
  const [asking, setAsking] = useState(false);
  return (
    <div
      className="browser-workbench-driving-shield"
      onPointerDown={(event) => {
        event.preventDefault();
        setAsking(true);
      }}
    >
      {asking && (
        <div className="browser-workbench-driving-takeover">
          <span>CoWork is controlling this tab.</span>
          <button
            type="button"
            className="is-primary"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setAsking(false);
              void window.electronAPI
                .setBrowserWorkbenchPaused?.({ taskId, sessionId, paused: true })
                .catch(() => undefined);
            }}
          >
            Take over
          </button>
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setAsking(false)}
          >
            Keep watching
          </button>
        </div>
      )}
    </div>
  );
}

export function SignInBanner({
  url,
  onDone,
  onDismiss,
}: {
  url: string;
  onDone: () => void;
  onDismiss: () => void;
}) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Show the raw URL.
  }
  return (
    <div className="browser-workbench-driving is-sign-in" role="status">
      <LogIn size={14} aria-hidden="true" />
      <span>
        Sign in to <strong>{host}</strong> in this tab. CoWork waits and continues when you're done.
      </span>
      <button type="button" className="is-primary" onClick={onDone}>
        Done
      </button>
      <button type="button" aria-label="Dismiss" onClick={onDismiss}>
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
