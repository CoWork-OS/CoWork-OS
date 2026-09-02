import { useEffect, useState } from "react";
import { FileText, RotateCw } from "lucide-react";
import type { SessionProgressState, Task } from "../../shared/types";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface SessionProgressCardProps {
  task?: Task;
  onSelectTask?: (taskId: string) => void;
  refreshKey?: string | number;
}

function statusLabel(progress: SessionProgressState): string {
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

export function SessionProgressCard({ task, onSelectTask, refreshKey }: SessionProgressCardProps) {
  const [progress, setProgress] = useState<SessionProgressState | undefined>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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

  const canResume =
    progress?.status === "interrupted" ||
    progress?.status === "paused" ||
    progress?.status === "blocked";
  const canResumeFromCheckpoint = canResume && Boolean(progress?.resumeFromEventId);

  // The composer status strip owns routine live progress. This card is reserved
  // for the exceptional state where the user can actually recover a session.
  if (!task || !progress || !canResume) return null;

  const resume = async () => {
    if (!canResume || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await window.electronAPI.resumeTask(task.id);
      const next = await window.electronAPI.getSessionProgress(task.id);
      setProgress(next);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to resume this session.");
    } finally {
      setBusy(false);
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
      {progress.waiting ? (
        <div className="session-progress-card-waiting">{progress.waiting.reason}</div>
      ) : null}
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
