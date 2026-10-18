import { useEffect, useRef, useState } from "react";
import { FileText, RotateCw } from "lucide-react";
import type { SessionProgressState, Task } from "../../shared/types";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface SessionProgressCardProps {
  task?: Task;
  onSelectTask?: (taskId: string) => void;
  refreshKey?: string | number;
}

function statusLabel(progress: SessionProgressState): string {
  if (progress.status === "interrupted") return "Turn interrupted";
  if (progress.waiting?.kind === "approval") return "Approval needed";
  if (progress.waiting?.kind === "input") return "Waiting for your answer";
  if (progress.waiting?.kind === "reconnect") return "Reconnect required";
  if (progress.phase === "completed") return "Completed";
  if (progress.phase === "failed") return "Failed";
  if (progress.phase === "stale") return "Stale session";
  if (progress.phase === "paused") return "Paused";
  if (progress.phase === "blocked") return "Blocked";
  return progress.phase === "queued" ? "Queued" : "In progress";
}

/**
 * Whether the session can be recovered from here. A session waiting on an approval or an
 * answer is not stuck: the card in the conversation asks for that decision, and Resume would
 * not answer it.
 */
export function canOfferSessionRecovery(progress: SessionProgressState | undefined): boolean {
  if (!progress) return false;
  if (progress.waiting?.kind === "approval" || progress.waiting?.kind === "input") return false;
  return (
    progress.status === "interrupted" ||
    progress.status === "paused" ||
    progress.status === "blocked"
  );
}

/** The waiting reason, when it adds to the headline (the headline is often that reason). */
export function sessionRecoveryDetail(progress: SessionProgressState): string | undefined {
  const reason = progress.waiting?.reason?.trim();
  if (!reason) return undefined;
  return reason === progress.headline.trim() ? undefined : reason;
}

export function SessionProgressCard({ task, onSelectTask, refreshKey }: SessionProgressCardProps) {
  const [loadedProgress, setProgress] = useState<SessionProgressState | undefined>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const currentTaskId = useRef(task?.id);
  currentTaskId.current = task?.id;
  useEffect(() => {
    setBusy(false);
    setActionError(null);
  }, [task?.id]);

  useEffect(() => {
    let cancelled = false;
    setProgress(undefined);
    if (!task?.id || !window.electronAPI?.getSessionProgress) {
      setProgress(undefined);
      return;
    }
    void window.electronAPI
      .getSessionProgress(task.id)
      .then((next) => {
        if (!cancelled) setProgress(next);
      })
      .catch(() => {
        if (!cancelled) setProgress(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.updatedAt, refreshKey]);

  // The interrupted task itself is enough to expose recovery, even when its projection is unavailable.
  const progress: SessionProgressState | undefined =
    loadedProgress ??
    (task?.status === "interrupted"
      ? {
          schemaVersion: 1,
          taskId: task.id,
          status: "interrupted",
          phase: "paused",
          headline: "This turn stopped before finishing.",
          completedSteps: 0,
          totalSteps: 0,
          activeAgentCount: 0,
          pendingApprovals: [],
          pendingInputRequests: [],
          connectionState: "stale",
          updatedAt: task.updatedAt,
        }
      : undefined);
  const canResume = canOfferSessionRecovery(progress);
  const canResumeFromCheckpoint = canResume && Boolean(progress?.resumeFromEventId);

  // The composer status strip owns routine live progress. This card is reserved
  // for the exceptional state where the user can actually recover a session.
  if (!task || !progress || !canResume) return null;
  const detail = sessionRecoveryDetail(progress);

  const resume = async () => {
    if (!canResume || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await window.electronAPI.resumeTask(task.id);
      const next = await window.electronAPI.getSessionProgress(task.id);
      if (currentTaskId.current === task.id) setProgress(next);
    } catch (cause) {
      if (currentTaskId.current === task.id)
        setActionError(cause instanceof Error ? cause.message : "Unable to resume this session.");
    } finally {
      if (currentTaskId.current === task.id) setBusy(false);
    }
  };

  const discard = async () => {
    if (busy || task.status !== "interrupted") return;
    setBusy(true);
    setActionError(null);
    try {
      await window.electronAPI.discardInterruptedTask(task.id, task.updatedAt);
      if (currentTaskId.current === task.id) setProgress(undefined);
    } catch (cause) {
      if (currentTaskId.current === task.id)
        setActionError(cause instanceof Error ? cause.message : "Unable to discard this turn.");
    } finally {
      if (currentTaskId.current === task.id) setBusy(false);
    }
  };

  const resumeFromCheckpoint = async () => {
    if (!progress.resumeFromEventId || busy || !window.electronAPI?.forkTaskSession) return;
    setBusy(true);
    setActionError(null);
    try {
      const forked = await window.electronAPI.forkTaskSession({
        taskId: task.id,
        branchLabel: "resume",
        fromEventId: progress.resumeFromEventId,
      });
      if (forked?.id) onSelectTask?.(forked.id);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Unable to resume from this checkpoint.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`session-progress-card ${progress.phase}`} aria-label="Session recovery">
      <div className="session-progress-card-header">
        <span className="session-progress-card-label">
          <RotateCw size={13} aria-hidden="true" />
          Session recovery
        </span>
        <span className="session-progress-card-status">{statusLabel(progress)}</span>
      </div>
      <div className="session-progress-card-headline markdown-content">
        <MarkdownRenderer>{progress.headline}</MarkdownRenderer>
      </div>
      {task.status === "interrupted" && (
        <div className="session-progress-card-waiting">
          {task.error || "The runtime stopped before this turn finished."} Progress and saved
          outputs are preserved.
        </div>
      )}
      {detail ? <div className="session-progress-card-waiting">{detail}</div> : null}
      {progress.latestArtifact ? (
        <div className="session-progress-card-artifact" title={progress.latestArtifact.path}>
          <FileText size={12} aria-hidden="true" />
          <span>{progress.latestArtifact.path.split(/[\\/]/).pop()}</span>
        </div>
      ) : null}
      {actionError ? (
        <div className="session-progress-card-error" role="alert">
          {actionError}
        </div>
      ) : null}
      <div className="session-progress-card-actions">
        {task.status === "interrupted" && (
          <button type="button" disabled={busy} onClick={() => void discard()}>
            Discard turn
          </button>
        )}
        <button type="button" onClick={() => void resume()} disabled={busy}>
          <RotateCw size={12} aria-hidden="true" />
          {busy ? "Resuming…" : "Resume"}
        </button>
        {canResumeFromCheckpoint ? (
          <button type="button" onClick={() => void resumeFromCheckpoint()} disabled={busy}>
            Resume from checkpoint
          </button>
        ) : null}
      </div>
    </section>
  );
}
