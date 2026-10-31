import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Hand, Maximize2, Minus, Monitor, X } from "lucide-react";
import type { ComputerViewFrame, ComputerViewState } from "../../shared/computer-view";
import { useComputerView } from "../hooks/useComputerView";
import { usePageVisible } from "../hooks/usePageVisible";
import { ModalDialog } from "./ModalDialog";
import "./computer-use-live-card.css";

const COLLAPSED_KEY = "computer-use-live-collapsed";
/** A frame older than this no longer counts as live. */
const LIVE_FRAME_MAX_AGE_MS = 4_000;
/** Windows it used before stay stacked behind the live one. */
const MAX_FRAMES_BEHIND = 2;

export interface StackedFrame {
  dataUrl: string;
  label?: string;
}

/** The windows to keep behind the live one when the task moves to another window. */
export function nextFramesBehind(
  behind: StackedFrame[],
  previous: ComputerViewFrame | undefined,
  next: ComputerViewFrame | undefined,
): StackedFrame[] {
  if (!previous || !next || previous.label === next.label) return behind;
  const left = { dataUrl: previous.dataUrl, label: previous.label };
  return [left, ...behind.filter((frame) => frame.label !== next.label)].slice(
    0,
    MAX_FRAMES_BEHIND,
  );
}

/** Shown while a task uses this computer: waiting for it, working on it, or paused for you. */
export function isComputerUseLiveActive(state: ComputerViewState | null): boolean {
  if (!state || state.surface !== "this_computer") return false;
  if (state.status === "waiting" || state.status === "held") return true;
  return state.status === "working" && Boolean(state.frame);
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, "1");
    else localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // Unavailable storage just forgets the choice.
  }
}

export interface ComputerUseLiveCardViewProps {
  state: ComputerViewState;
  behind: StackedFrame[];
  live: boolean;
  enlarged: boolean;
  collapsed: boolean;
  busy: boolean;
  error: string | null;
  agentName: string;
  onEnlarge: (enlarged: boolean) => void;
  onCollapse: (collapsed: boolean) => void;
  onTakeOver: () => void;
  onHandBack: () => void;
}

/** What the agent is doing on this computer, live, at the top of the right sidebar. */
export function ComputerUseLiveCardView({
  state,
  behind,
  live,
  enlarged,
  collapsed,
  busy,
  error,
  agentName,
  onEnlarge,
  onCollapse,
  onTakeOver,
  onHandBack,
}: ComputerUseLiveCardViewProps) {
  const held = state.status === "held";
  const waiting = state.status === "waiting";
  const request = !held ? state.takeoverRequest : undefined;
  const frame = state.frame;
  const where = frame?.label || "this computer";
  const tone = held || request ? "attention" : waiting ? "waiting" : live ? "live" : "quiet";
  const status = held
    ? "You have control"
    : request
      ? `${agentName} needs you`
      : waiting
        ? "Waiting for this computer"
        : where;
  const dot = <span className={`computer-use-live-dot is-${tone}`} aria-hidden="true" />;
  const control = held ? (
    <button
      type="button"
      className="computer-use-live-text-button"
      onClick={onHandBack}
      disabled={busy}
    >
      Hand back
    </button>
  ) : (
    <button
      type="button"
      className={`computer-use-live-icon-button${request ? " is-primary" : ""}`}
      onClick={onTakeOver}
      disabled={busy || waiting}
      title={`Take over: ${agentName} stops using this computer until you hand it back`}
      aria-label="Take over"
    >
      <Hand size={13} />
    </button>
  );

  if (collapsed) {
    return (
      <button
        type="button"
        className="computer-use-live-trigger"
        onClick={() => onCollapse(false)}
        title={`Show what ${agentName} is doing`}
      >
        {dot}
        <Monitor size={12} aria-hidden="true" />
        <span className="computer-use-live-trigger-text">{status}</span>
      </button>
    );
  }

  return (
    <section
      className={["computer-use-live", held && "is-held", frame && behind.length > 0 && "has-stack"]
        .filter(Boolean)
        .join(" ")}
      aria-label={`What ${agentName} is doing on this computer`}
    >
      <div className="computer-use-live-bar">
        {dot}
        <span className="computer-use-live-status" title={frame?.label || status}>
          {status}
        </span>
        <div className="computer-use-live-actions">
          {control}
          {frame ? (
            <button
              type="button"
              className="computer-use-live-icon-button"
              onClick={() => onEnlarge(true)}
              title="Make larger"
              aria-label="Make larger"
            >
              <Maximize2 size={13} />
            </button>
          ) : null}
          <button
            type="button"
            className="computer-use-live-icon-button"
            onClick={() => onCollapse(true)}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={13} />
          </button>
        </div>
      </div>
      {frame ? (
        <div className="computer-use-live-stage">
          {behind.map((each, index) => (
            <img
              key={`${each.label ?? ""}-${index}`}
              className={`computer-use-live-behind is-${index + 1}`}
              src={each.dataUrl}
              alt=""
              aria-hidden="true"
            />
          ))}
          <button
            type="button"
            className="computer-use-live-screen"
            onClick={() => onEnlarge(true)}
            title="Make larger"
          >
            <img src={frame.dataUrl} alt={`Live view of ${where}`} />
          </button>
        </div>
      ) : null}
      {request ? <p className="computer-use-live-note">{request.reason}</p> : null}
      {error ? (
        <p className="computer-use-live-note" role="status">
          {error}
        </p>
      ) : null}
      {enlarged && frame
        ? createPortal(
            <ModalDialog
              className="computer-use-live-overlay"
              aria-label={`Live view of ${where}`}
              onClose={() => onEnlarge(false)}
              onClick={(event) => {
                if (event.target === event.currentTarget) onEnlarge(false);
              }}
            >
              <div className="computer-use-live-overlay-panel">
                <div className="computer-use-live-bar">
                  {dot}
                  <span className="computer-use-live-status" title={frame.label || status}>
                    {status}
                  </span>
                  <div className="computer-use-live-actions">
                    {control}
                    <button
                      type="button"
                      className="computer-use-live-icon-button"
                      onClick={() => onEnlarge(false)}
                      title="Close"
                      aria-label="Close"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
                <img
                  className="computer-use-live-overlay-image"
                  src={frame.dataUrl}
                  alt={`Live view of ${where}`}
                />
              </div>
            </ModalDialog>,
            document.body,
          )
        : null}
    </section>
  );
}

/**
 * While a task works in an app on this computer in the background, the window it controls
 * stays visible, live, at the top of the right sidebar.
 */
export function ComputerUseLiveCard({ taskId, agentName }: { taskId: string; agentName: string }) {
  const visible = usePageVisible();
  const { state, busy, error, takeOver, handBack } = useComputerView(taskId, visible);
  const [enlarged, setEnlarged] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [behind, setBehind] = useState<StackedFrame[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const lastFrame = useRef<ComputerViewFrame | undefined>(undefined);
  const active = isComputerUseLiveActive(state);
  const frame = state?.frame;

  useEffect(() => {
    setBehind([]);
    setEnlarged(false);
    lastFrame.current = undefined;
  }, [taskId]);

  useEffect(() => {
    if (!frame) return;
    const previous = lastFrame.current;
    lastFrame.current = frame;
    setBehind((current) => nextFramesBehind(current, previous, frame));
  }, [frame]);

  // Ticks only while it shows a working task, so a stalled frame stops reading as live.
  useEffect(() => {
    if (!active || state?.status !== "working") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, state?.status]);

  if (!state || !active) return null;
  const live =
    state.status === "working" && Boolean(frame && now - frame.capturedAt < LIVE_FRAME_MAX_AGE_MS);

  return (
    <ComputerUseLiveCardView
      state={state}
      behind={behind}
      live={live}
      enlarged={enlarged}
      collapsed={collapsed}
      busy={busy}
      error={error}
      agentName={agentName}
      onEnlarge={setEnlarged}
      onCollapse={(next) => {
        setCollapsed(next);
        writeCollapsed(next);
      }}
      onTakeOver={() => void takeOver()}
      onHandBack={() => void handBack()}
    />
  );
}
