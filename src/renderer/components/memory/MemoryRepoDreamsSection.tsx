import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryRepoDreamActionResult,
  MemoryRepoDreamPart,
  MemoryRepoDreamSummary,
  MemoryRepoDreamsReport,
} from "../../../shared/memory-repo-types";
import { hasHostMethods } from "../../host/browser-capabilities";
import "./memory-knowledge.css";
import "./memory-review.css";
import { formatRelative } from "./memory-knowledge-model";
import {
  MEMORY_REPO_DREAM_METHODS,
  dreamDiffLineKind,
  dreamErrorMessage,
  splitDreams,
  type MemoryRepoDreamsApi,
} from "./memory-repo-dreams-model";

export type DreamDiffState = { loading: boolean; text?: string; error?: string };

/** The diff of a dream part in a <pre>, one span per line, + and - lines marked. */
export function DreamDiff({ state }: { state: DreamDiffState | undefined }) {
  if (!state || state.loading) return <div className="settings-loading">Loading the diff...</div>;
  if (state.error) {
    return (
      <div role="alert" className="memory-knowledge-error">
        {state.error}
      </div>
    );
  }
  if (!state.text) return <div className="settings-empty">No diff available.</div>;
  return (
    <pre className="memory-review-diff">
      {state.text.split("\n").map((line, index) => (
        <span
          key={index}
          className={`memory-review-diff-line memory-review-diff-line--${dreamDiffLineKind(line)}`}
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function diffKey(id: string, part: MemoryRepoDreamPart): string {
  return `${part}:${id}`;
}

export interface MemoryRepoDreamsViewProps {
  report: MemoryRepoDreamsReport | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  busyId: string | null;
  diffs: Record<string, DreamDiffState>;
  onToggleDiff: (id: string, part: MemoryRepoDreamPart, open: boolean) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onUndo: (id: string) => void;
}

function PendingDream(props: MemoryRepoDreamsViewProps & { dream: MemoryRepoDreamSummary }) {
  const { dream } = props;
  const review = dream.operations.filter((op) => op.decision === "review");
  const key = diffKey(dream.id, "review");
  return (
    <li className="memory-review-card" data-dream-id={dream.id}>
      <div className="memory-review-card-head">
        <span className="settings-badge settings-badge--outline">Dream</span>
        <span className="memory-review-title">
          {dream.reviewCount} {dream.reviewCount === 1 ? "change" : "changes"} for review
        </span>
        <span className="memory-knowledge-count">{formatRelative(dream.startedAt)}</span>
      </div>
      {dream.summary && <div className="memory-review-proposed">{dream.summary}</div>}
      {review.length > 0 && (
        <ul className="memory-review-items">
          {review.map((op, index) => (
            <li key={index} className="memory-review-item">
              <span className="memory-review-item-content">
                {op.description}
                {(op.reason || op.why) && (
                  <span className="memory-review-why">
                    {op.reason && (
                      <span>
                        <strong>Why:</strong> {op.reason}
                      </span>
                    )}
                    {op.why && (
                      <span>
                        <strong>Needs your review:</strong> {op.why}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <details
        className="memory-review-evidence"
        onToggle={(event) => props.onToggleDiff(dream.id, "review", event.currentTarget.open)}
      >
        <summary>Show the diff</summary>
        {props.diffs[key] !== undefined && <DreamDiff state={props.diffs[key]} />}
      </details>
      <div className="memory-knowledge-actions">
        <button
          type="button"
          className="settings-button"
          disabled={props.busyId !== null}
          onClick={() => props.onAccept(dream.id)}
        >
          {props.busyId === `accept:${dream.id}` ? "Accepting..." : "Accept"}
        </button>
        <button
          type="button"
          className="memory-inline-btn"
          disabled={props.busyId !== null}
          onClick={() => props.onReject(dream.id)}
        >
          Reject
        </button>
      </div>
    </li>
  );
}

function AutomaticDream(props: MemoryRepoDreamsViewProps & { dream: MemoryRepoDreamSummary }) {
  const { dream } = props;
  const applied = dream.operations.filter((op) => op.decision === "auto");
  const key = diffKey(dream.id, "auto");
  return (
    <li className="memory-review-change" data-dream-id={dream.id}>
      <div className="memory-review-card-head">
        <span className="settings-badge settings-badge--outline">Dream</span>
        <span className="memory-review-title">
          {dream.autoCount} {dream.autoCount === 1 ? "change" : "changes"} applied
        </span>
        <span className="memory-knowledge-count">
          {dream.trigger === "manual" ? "Dream now" : "Daily"}, {formatRelative(dream.startedAt)}
        </span>
      </div>
      {dream.summary && <div className="memory-review-proposed">{dream.summary}</div>}
      {applied.length > 0 && (
        <ul className="memory-review-items">
          {applied.map((op, index) => (
            <li key={index} className="memory-review-item">
              <span className="memory-review-item-content">
                {op.description}
                {op.reason ? ` (${op.reason})` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {dream.canUndo && (
        <details
          className="memory-review-evidence"
          onToggle={(event) => props.onToggleDiff(dream.id, "auto", event.currentTarget.open)}
        >
          <summary>Show the diff</summary>
          {props.diffs[key] !== undefined && <DreamDiff state={props.diffs[key]} />}
        </details>
      )}
      <div className="memory-knowledge-actions">
        {dream.undone ? (
          <span className="memory-knowledge-count">
            Undone{dream.undoneAt ? ` ${formatRelative(dream.undoneAt)}` : ""}
          </span>
        ) : (
          <button
            type="button"
            className="memory-inline-btn"
            disabled={props.busyId !== null || !dream.canUndo}
            title={
              dream.canUndo
                ? undefined
                : (dream.historyNote ?? "This change can no longer be undone.")
            }
            onClick={() => props.onUndo(dream.id)}
          >
            {props.busyId === `undo:${dream.id}` ? "Undoing..." : "Undo"}
          </button>
        )}
        {!dream.canUndo && !dream.undone && dream.historyNote && (
          <span className="memory-knowledge-count">Cannot be undone: {dream.historyNote}</span>
        )}
      </div>
    </li>
  );
}

/** The Review tab's "Memory folder" section, without data loading (rendered in tests). */
export function MemoryRepoDreamsView(props: MemoryRepoDreamsViewProps) {
  const { pending, automatic } = splitDreams(props.report);
  return (
    <div className="memory-knowledge memory-review memory-review-folder">
      <section className="memory-knowledge-group" data-group="memory-folder">
        <h4>
          Memory folder <span className="memory-knowledge-count">{pending.length}</span>
        </h4>
        <p className="settings-form-hint">
          Dreams keep the memory folder accurate. Safe changes are committed automatically and can
          be undone; changes to what you wrote, to MEMORY.md or from the inbox wait here.
        </p>
        {props.notice && (
          <div role="status" className="memory-knowledge-notice">
            {props.notice}
          </div>
        )}
        {props.error && (
          <div role="alert" className="memory-knowledge-error">
            {props.error}
          </div>
        )}
        {props.loading && !props.report ? (
          <div className="settings-loading">Loading dreams...</div>
        ) : (
          <>
            {pending.length === 0 ? (
              <div className="settings-empty">No dream proposals waiting for review.</div>
            ) : (
              <ul className="memory-knowledge-list">
                {pending.map((dream) => (
                  <PendingDream key={dream.id} {...props} dream={dream} />
                ))}
              </ul>
            )}
            {automatic.length > 0 && (
              <>
                <h4>
                  Recent dream changes{" "}
                  <span className="memory-knowledge-count">{automatic.length}</span>
                </h4>
                <ul className="memory-knowledge-list">
                  {automatic.map((dream) => (
                    <AutomaticDream key={dream.id} {...props} dream={dream} />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function dreamsApi(): MemoryRepoDreamsApi {
  return window.electronAPI;
}

/**
 * Loads the dreams and shows the section while the memory folder is on and ready. Renders
 * nothing when the host lacks the methods or the folder is off.
 */
export function MemoryRepoDreamsSection({
  api = dreamsApi,
  onCountChange,
}: {
  api?: () => MemoryRepoDreamsApi;
  /** Called with the number of dreams waiting for review whenever it is (re)loaded. */
  onCountChange?: (count: number) => void;
}) {
  const available = hasHostMethods(...MEMORY_REPO_DREAM_METHODS);
  const [report, setReport] = useState<MemoryRepoDreamsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DreamDiffState>>({});
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await api().getMemoryRepoDreams();
      if (current !== generation.current) return;
      setReport(next);
      onCountChange?.(next.pendingReviews);
    } catch (loadError) {
      if (current !== generation.current) return;
      setError(dreamErrorMessage(loadError, "Failed to load the dreams."));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [api, onCountChange]);

  useEffect(() => {
    if (available) void load();
  }, [available, load]);

  const toggleDiff = (id: string, part: MemoryRepoDreamPart, open: boolean) => {
    const key = diffKey(id, part);
    if (!open || diffs[key]?.text !== undefined || diffs[key]?.loading) return;
    setDiffs((prev) => ({ ...prev, [key]: { loading: true } }));
    api()
      .getMemoryRepoDreamDiff(id, part)
      .then((text) => setDiffs((prev) => ({ ...prev, [key]: { loading: false, text } })))
      .catch((diffError) =>
        setDiffs((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            error: dreamErrorMessage(diffError, "Failed to load the diff."),
          },
        })),
      );
  };

  const act = async (
    busy: string,
    run: () => Promise<MemoryRepoDreamActionResult>,
    done: string,
  ) => {
    setBusyId(busy);
    setError(null);
    setNotice(null);
    try {
      const result = await run();
      if (result.ok) setNotice(done);
      else setError(result.error || "The memory folder did not change.");
    } catch (actionError) {
      setError(dreamErrorMessage(actionError, "The memory folder did not change."));
    } finally {
      setBusyId(null);
      setDiffs({});
      await load();
    }
  };

  if (!available || !report?.folderReady) return null;

  return (
    <MemoryRepoDreamsView
      report={report}
      loading={loading}
      error={error}
      notice={notice}
      busyId={busyId}
      diffs={diffs}
      onToggleDiff={toggleDiff}
      onAccept={(id) =>
        void act(`accept:${id}`, () => api().acceptMemoryRepoDream(id), "Dream changes accepted.")
      }
      onReject={(id) =>
        void act(`reject:${id}`, () => api().rejectMemoryRepoDream(id), "Dream changes rejected.")
      }
      onUndo={(id) =>
        void act(`undo:${id}`, () => api().undoMemoryRepoDream(id), "Dream changes undone.")
      }
    />
  );
}
