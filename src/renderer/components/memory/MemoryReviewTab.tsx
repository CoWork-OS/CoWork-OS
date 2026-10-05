import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryCurationChange,
  MemoryReviewProposal,
  MemoryReviewState,
} from "../../../shared/memory-review-types";
import { hasHostMethod } from "../../host/browser-capabilities";
import "./memory-knowledge.css";
import "./memory-review.css";
import { MemoryRepoDreamsSection } from "./MemoryRepoDreamsSection";
import { KIND_LABELS, SOURCE_LABELS, formatRelative, sourceTone } from "./memory-knowledge-model";
import {
  MEMORY_REVIEW_METHODS,
  OP_LABELS,
  ROLE_LABELS,
  acceptProposal,
  changeLine,
  proposalItemRole,
  rejectProposal,
  runCurationNow,
  setLlmSynthesis,
  undoChange,
  type MemoryReviewApi,
  type ReviewFlowResult,
} from "./memory-review-model";

function ProposalCard(props: {
  proposal: MemoryReviewProposal;
  busy: boolean;
  canWrite: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { proposal } = props;
  return (
    <li className="memory-review-card" data-proposal-id={proposal.id}>
      <div className="memory-review-card-head">
        <span className="settings-badge settings-badge--outline">{OP_LABELS[proposal.op]}</span>
        <span className="memory-review-title">{proposal.title}</span>
        {proposal.origin === "llm" && (
          <span className="settings-badge settings-badge--neutral">AI suggestion</span>
        )}
      </div>
      {proposal.proposedContent && (
        <div className="memory-review-proposed">
          {proposal.proposedKind && (
            <span className="memory-knowledge-kind">{KIND_LABELS[proposal.proposedKind]}</span>
          )}{" "}
          {proposal.proposedContent}
        </div>
      )}
      {proposal.items.length > 0 && (
        <ul className="memory-review-items">
          {proposal.items.map((item) => {
            const role = proposalItemRole(proposal, item);
            return (
              <li key={item.id} className={`memory-review-item memory-review-item--${role}`}>
                <span className="memory-review-role">{ROLE_LABELS[role]}</span>
                <span className="memory-review-item-content">{item.content}</span>
                <span className={`settings-badge settings-badge--${sourceTone(item.source)}`}>
                  {SOURCE_LABELS[item.source]}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="memory-review-why">
        <div>
          <strong>Why:</strong> {proposal.rationale}
        </div>
        {proposal.reviewReason && (
          <div>
            <strong>Needs your review:</strong> {proposal.reviewReason}
          </div>
        )}
      </div>
      {proposal.evidence.length > 0 && (
        <details className="memory-review-evidence">
          <summary>Evidence ({proposal.evidence.length})</summary>
          <ul>
            {proposal.evidence.map((entry) => (
              <li key={entry.ref}>
                <span className="memory-knowledge-count">
                  {entry.kind === "archive"
                    ? "Task outcome"
                    : entry.kind === "conversation"
                      ? "Conversation"
                      : "Signal"}
                  {entry.at ? `, ${formatRelative(entry.at)}` : ""}
                </span>{" "}
                {entry.snippet}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="memory-knowledge-actions">
        <button
          type="button"
          className="settings-button"
          disabled={props.busy || !props.canWrite}
          onClick={props.onAccept}
        >
          Accept
        </button>
        <button
          type="button"
          className="memory-inline-btn"
          disabled={props.busy || !props.canWrite}
          onClick={props.onReject}
        >
          Reject
        </button>
      </div>
    </li>
  );
}

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
        <span className="settings-badge settings-badge--outline">{OP_LABELS[change.op]}</span>
        <span className="memory-review-title">{change.summary}</span>
        <span className="memory-knowledge-count">
          {change.origin === "auto" ? "Automatic" : "Accepted by you"},{" "}
          {formatRelative(change.appliedAt)}
        </span>
      </div>
      <ul className="memory-review-items">
        {change.items.map((item) => (
          <li key={item.id} className="memory-review-item">
            <span className="memory-review-role">{changeLine(item)}</span>
            <span className="memory-review-item-content">{item.content}</span>
          </li>
        ))}
      </ul>
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
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onUndo: (id: string) => void;
  onRunNow: () => void;
  onToggleLlm: (enabled: boolean) => void;
  onDismissMessage: () => void;
}

/** The Review tab's markup, without data loading (rendered directly in tests). */
export function MemoryReviewView(props: MemoryReviewViewProps) {
  const { state } = props;
  const recent = state?.recent ?? [];
  return (
    <div className="memory-knowledge memory-review">
      <p className="settings-form-hint">
        Dreaming keeps memory tidy: it merges duplicates, archives what is no longer used and learns
        facts that keep coming up. Safe changes are applied automatically and can be undone;
        anything that touches what you said, adds a rule or resolves a contradiction waits here for
        you.
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
      <div className="memory-review-toolbar">
        <button
          type="button"
          className="settings-button"
          disabled={props.busyId !== null || !props.canWrite}
          onClick={props.onRunNow}
        >
          {props.busyId === "run" ? "Dreaming..." : "Run Dreaming now"}
        </button>
        <label className="memory-knowledge-checkbox">
          <input
            type="checkbox"
            checked={state?.llm.enabled === true}
            disabled={props.busyId !== null || !props.canWrite || !state}
            onChange={(event) => props.onToggleLlm(event.target.checked)}
          />
          AI synthesis (uses your model; suggestions always need review)
        </label>
        {state?.llm.enabled && (
          <span className="memory-knowledge-count">
            {state.llm.tokensUsedToday.toLocaleString()} /{" "}
            {state.llm.dailyTokenBudget.toLocaleString()} tokens today
          </span>
        )}
        {state?.lastRun && (
          <span className="memory-knowledge-count">
            Last run {formatRelative(state.lastRun.startedAt)}: {state.lastRun.applied} applied,{" "}
            {state.lastRun.queued} queued
          </span>
        )}
      </div>

      <section className="memory-knowledge-group" data-group="pending">
        <h4>
          Waiting for review{" "}
          <span className="memory-knowledge-count">{state?.pendingCount ?? 0}</span>
        </h4>
        {props.loading && !state ? (
          <div className="settings-loading">Loading proposals...</div>
        ) : state && state.pending.length === 0 ? (
          <div className="settings-empty">Nothing to review.</div>
        ) : (
          <ul className="memory-knowledge-list">
            {state?.pending.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                busy={props.busyId !== null}
                canWrite={props.canWrite}
                onAccept={() => props.onAccept(proposal.id)}
                onReject={() => props.onReject(proposal.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="memory-knowledge-group" data-group="recent">
        <h4>
          Recent automatic changes <span className="memory-knowledge-count">{recent.length}</span>
        </h4>
        {state && recent.length === 0 ? (
          <div className="settings-empty">No changes yet.</div>
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
  onCountChange,
  onDreamCountChange,
}: {
  workspaceId: string;
  canWrite?: boolean;
  api?: () => MemoryReviewApi;
  /** Called with the pending proposal count whenever it is (re)loaded. */
  onCountChange?: (count: number) => void;
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

  const publish = useCallback(
    (next: MemoryReviewState | null) => {
      if (!next) return;
      setState(next);
      onCountChange?.(next.pendingCount);
    },
    [onCountChange],
  );

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await api().getMemoryReview({ workspaceId });
      if (current !== generation.current) return;
      publish(next);
      setError(null);
    } catch (loadError) {
      if (current !== generation.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load proposals.");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [api, workspaceId, publish]);

  useEffect(() => {
    setNotice(null);
    if (!available) return;
    void load();
  }, [load, available]);

  const apply = async (busy: string, run: () => Promise<ReviewFlowResult>) => {
    setBusyId(busy);
    try {
      const result = await run();
      publish(result.state);
      setError(result.error ?? null);
      setNotice(result.error ? null : (result.notice ?? null));
    } finally {
      setBusyId(null);
    }
  };

  // The memory folder is profile-wide, so its dreams are listed under every workspace.
  const folder = <MemoryRepoDreamsSection onCountChange={onDreamCountChange} />;

  if (!available) {
    return (
      <>
        <p className="settings-form-hint">
          Memory review is not connected to this browser host yet.
        </p>
        {folder}
      </>
    );
  }

  return (
    <>
      <MemoryReviewView
        state={state}
        loading={loading}
        error={error}
        notice={notice}
        busyId={busyId}
        canWrite={canWrite}
        onAccept={(id) => void apply(id, () => acceptProposal(api(), workspaceId, id))}
        onReject={(id) => void apply(id, () => rejectProposal(api(), workspaceId, id))}
        onUndo={(id) => void apply(id, () => undoChange(api(), workspaceId, id))}
        onRunNow={() => void apply("run", () => runCurationNow(api(), workspaceId))}
        onToggleLlm={(enabled) =>
          void apply("llm", () => setLlmSynthesis(api(), workspaceId, enabled))
        }
        onDismissMessage={() => {
          setError(null);
          setNotice(null);
        }}
      />
      {folder}
    </>
  );
}
