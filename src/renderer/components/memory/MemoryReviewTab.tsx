import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryCurationChange,
  MemoryReviewState,
} from "../../../shared/memory-review-types";
import { hasHostMethod } from "../../host/browser-capabilities";
import "./memory-knowledge.css";
import "./memory-review.css";
import { MemoryRepoDreamsSection } from "./MemoryRepoDreamsSection";
import { formatRelative } from "./memory-knowledge-model";
import {
  MEMORY_REVIEW_METHODS,
  changeLine,
  undoChange,
  type MemoryReviewApi,
  type ReviewFlowResult,
} from "./memory-review-model";

function ChangeRow(props: {
  change: MemoryCurationChange;
  busy: boolean;
  canWrite: boolean;
  onUndo: () => void;
}) {
  const { change } = props;
  return (
    <li className="memory-review-change" data-change-id={change.id}>
      <div className="memory-review-card-head">
        <span className="settings-badge settings-badge--outline">Commitment</span>
        <span className="memory-review-title">{change.summary}</span>
        <span className="memory-knowledge-count">{formatRelative(change.appliedAt)}</span>
      </div>
      <ul className="memory-review-items">
        {change.items.map((item) => (
          <li key={item.id} className="memory-review-item">
            <span className="memory-review-role">{changeLine(item)}</span>
            <span className="memory-review-item-content">{item.content}</span>
          </li>
        ))}
      </ul>
      {change.rationale && <div className="memory-review-why">{change.rationale}</div>}
      <div className="memory-knowledge-actions">
        {change.undoneAt ? (
          <span className="memory-knowledge-count">Undone {formatRelative(change.undoneAt)}</span>
        ) : change.canUndo ? (
          <button
            type="button"
            className="memory-inline-btn"
            disabled={props.busy || !props.canWrite}
            onClick={props.onUndo}
          >
            Undo
          </button>
        ) : (
          <span className="memory-knowledge-count">Changed since; cannot be undone</span>
        )}
      </div>
    </li>
  );
}

export interface MemoryReviewViewProps {
  state: MemoryReviewState | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  busyId: string | null;
  canWrite: boolean;
  onUndo: (id: string) => void;
  onDismissMessage: () => void;
}

/** The commitments section of the Review tab, without data loading (rendered in tests). */
export function MemoryReviewView(props: MemoryReviewViewProps) {
  const recent = props.state?.recent ?? [];
  return (
    <div className="memory-knowledge memory-review">
      <section className="memory-knowledge-group" data-group="recent">
        <h4>
          Closed commitments <span className="memory-knowledge-count">{recent.length}</span>
        </h4>
        <p className="settings-form-hint">
          Once a day, past-due commitments are closed when later activity says they were done.
          Commitments you made yourself are never closed automatically. Undo reopens one, and it
          will not be closed automatically again.
        </p>
        {props.notice && (
          <div role="status" className="memory-knowledge-notice">
            {props.notice}
          </div>
        )}
        {props.error && (
          <div role="alert" className="memory-knowledge-error">
            {props.error}{" "}
            <button type="button" className="memory-inline-btn" onClick={props.onDismissMessage}>
              Dismiss
            </button>
          </div>
        )}
        {props.loading && !props.state ? (
          <div className="settings-loading">Loading changes...</div>
        ) : recent.length === 0 ? (
          <div className="settings-empty">No commitments were closed automatically.</div>
        ) : (
          <ul className="memory-knowledge-list">
            {recent.map((change) => (
              <ChangeRow
                key={change.id}
                change={change}
                busy={props.busyId !== null}
                canWrite={props.canWrite}
                onUndo={() => props.onUndo(change.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function reviewApi(): MemoryReviewApi {
  return window.electronAPI;
}

export function MemoryReviewTab({
  workspaceId,
  canWrite = true,
  api = reviewApi,
  onDreamCountChange,
}: {
  workspaceId: string;
  canWrite?: boolean;
  api?: () => MemoryReviewApi;
  /** Called with the number of memory folder dreams waiting for review. */
  onDreamCountChange?: (count: number) => void;
}) {
  const [state, setState] = useState<MemoryReviewState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const generation = useRef(0);
  const available = MEMORY_REVIEW_METHODS.every((method) => hasHostMethod(method));

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await api().getMemoryReview({ workspaceId });
      if (current !== generation.current) return;
      setState(next);
      setError(null);
    } catch (loadError) {
      if (current !== generation.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load changes.");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    setNotice(null);
    if (!available) return;
    void load();
  }, [load, available]);

  const apply = async (busy: string, run: () => Promise<ReviewFlowResult>) => {
    setBusyId(busy);
    try {
      const result = await run();
      if (result.state) setState(result.state);
      setError(result.error ?? null);
      setNotice(result.error ? null : (result.notice ?? null));
    } finally {
      setBusyId(null);
    }
  };

  // The memory folder is profile-wide, so its dreams are listed under every workspace.
  const folder = <MemoryRepoDreamsSection onCountChange={onDreamCountChange} />;

  return (
    <>
      {folder}
      {available && (
        <MemoryReviewView
          state={state}
          loading={loading}
          error={error}
          notice={notice}
          busyId={busyId}
          canWrite={canWrite}
          onUndo={(id) => void apply(id, () => undoChange(api(), workspaceId, id))}
          onDismissMessage={() => {
            setError(null);
            setNotice(null);
          }}
        />
      )}
    </>
  );
}
