import { useCallback, useEffect, useState } from "react";
import type { MergeReview, MergeReviewGroup, MergeReviewTask } from "../../../shared/types";

/**
 * Build > Merge review (shared-change coordination, agent-first roadmap WP11): worktree builds
 * of this folder waiting to merge, grouped by intent. A Compare request is one group of
 * alternatives (merge one, discard the rest); different groups must combine, so the card lists
 * files more than one group changed and pairs that would conflict.
 */
export function BuildMergeReview({
  workspaceId,
  onOpenBuild,
}: {
  workspaceId: string;
  onOpenBuild?: (taskId: string) => void;
}) {
  const api = window.electronAPI;
  const [review, setReview] = useState<MergeReview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api?.getMergeReview) return;
    try {
      const next = await api.getMergeReview(workspaceId);
      if (next.workspaceId === workspaceId) setReview(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load the merge review.");
    }
  }, [api, workspaceId]);

  useEffect(() => {
    setReview(null);
    setMessage(null);
    void load();
  }, [load]);

  if (!api?.getMergeReview || !review || review.groups.length === 0) return null;

  const titleOf = (taskId: string) =>
    review.groups.flatMap((group) => group.tasks).find((task) => task.taskId === taskId)?.title ??
    taskId;

  const merge = async (task: MergeReviewTask) => {
    if (busy) return;
    setBusy(task.taskId);
    setMessage(null);
    try {
      const result = (await api.mergeWorktree(task.taskId)) as {
        success?: boolean;
        error?: string;
        conflictFiles?: string[];
      };
      setMessage(
        result?.success
          ? `Merged "${task.title}".`
          : result?.conflictFiles?.length
            ? `"${task.title}" conflicts in ${result.conflictFiles.join(", ")}.`
            : result?.error || `Could not merge "${task.title}".`,
      );
      await load();
    } finally {
      setBusy(null);
    }
  };

  const discardOthers = async (group: MergeReviewGroup, keep: MergeReviewTask) => {
    if (busy) return;
    const others = group.tasks.filter((task) => task.taskId !== keep.taskId);
    const confirmed = window.confirm(
      `Remove the other ${others.length} variant worktree${others.length === 1 ? "" : "s"}? ` +
        "Changes in them that were not merged are lost.",
    );
    if (!confirmed) return;
    setBusy(keep.taskId);
    try {
      for (const task of others) await api.cleanupWorktree(task.taskId);
      setMessage(`Kept variant ${keep.variant ?? ""} and removed the others.`.replace("  ", " "));
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="calm-build-recent calm-build-review" aria-label="Merge review">
      <div className="calm-build-recent-head">
        <span>merge review</span>
        <button type="button" className="calm-build-review-refresh" onClick={() => void load()}>
          refresh
        </button>
      </div>
      <div className="calm-build-review-body">
        {review.groups.map((group) => (
          <div key={group.compareGroupId ?? group.intent} className="calm-build-review-group">
            <div className="calm-build-review-intent">
              {group.compareGroupId
                ? `Compare · ${group.tasks.length} variants · ${group.intent}`
                : group.intent}
            </div>
            <ul>
              {group.tasks.map((task) => (
                <li key={task.taskId} className="calm-build-review-task">
                  <button
                    type="button"
                    className="calm-build-review-title"
                    onClick={() => onOpenBuild?.(task.taskId)}
                    disabled={!onOpenBuild}
                  >
                    {task.variant ? `Variant ${task.variant}` : task.title}
                  </button>
                  <span className="calm-build-review-meta">
                    {task.branch} · {task.status} · +{task.diff.additions} −{task.diff.deletions} in{" "}
                    {task.diff.files} {task.diff.files === 1 ? "file" : "files"}
                  </span>
                  <span
                    className={`calm-build-review-check ${
                      task.check ? (task.check.passed ? "tone-done" : "tone-error") : ""
                    }`}
                    title={task.check?.message}
                  >
                    {task.check
                      ? task.check.passed
                        ? "check passed"
                        : "check failed"
                      : "no check"}
                  </span>
                  <button
                    type="button"
                    className="calm-build-review-action"
                    disabled={Boolean(busy) || task.status !== "completed"}
                    title={
                      task.status === "completed" ? "Merge into the base branch" : "Still running"
                    }
                    onClick={() => void merge(task)}
                  >
                    {busy === task.taskId ? "Working…" : "Merge"}
                  </button>
                  {group.compareGroupId && group.tasks.length > 1 && (
                    <button
                      type="button"
                      className="calm-build-review-action"
                      disabled={Boolean(busy)}
                      onClick={() => void discardOthers(group, task)}
                    >
                      Keep only this
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {(review.checks.overlaps.length > 0 || review.checks.conflicts.length > 0) && (
          <div className="calm-build-review-checks" role="status">
            {review.checks.conflicts.map((conflict) => (
              <p key={conflict.taskIds.join(":")} className="tone-error">
                Would conflict: "{titleOf(conflict.taskIds[0])}" and "{titleOf(conflict.taskIds[1])}
                " in {conflict.files.join(", ")}
              </p>
            ))}
            {review.checks.overlaps.map((overlap) => (
              <p key={overlap.path}>
                Changed by more than one build: {overlap.path} (
                {overlap.taskIds.map(titleOf).join(", ")})
              </p>
            ))}
          </div>
        )}
        {!review.checks.conflictCheckAvailable && (
          <p className="calm-build-review-note">
            The conflict check needs Git 2.38 or later; only overlapping files are shown.
          </p>
        )}
        {message && (
          <p className="calm-build-review-note" role="status">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
