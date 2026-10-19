/**
 * Merge review (shared-change coordination, agent-first roadmap WP11): the worktree changes of
 * one workspace that are waiting to merge, grouped by intent, with checks on their combined
 * state. Tasks of one Build Compare request, or with the same title, are one intent: they are
 * alternatives, and one of them is merged. Different intents must combine, so the review lists
 * files more than one intent changed and pairs of branches that would conflict.
 */
import type {
  MergeReview,
  MergeReviewGroup,
  MergeReviewTask,
  Task,
  WorktreeInfo,
} from "../../shared/types";

const OPEN_WORKTREE_STATUSES = new Set(["creating", "active", "committing", "merging", "conflict"]);
const MAX_TASKS = 8;

export interface MergeReviewSources {
  listWorktrees(workspaceId: string): Promise<WorktreeInfo[]>;
  getTask(taskId: string): Promise<Task | undefined>;
  diffStats(
    info: WorktreeInfo,
  ): Promise<{ filesChanged: number; linesAdded: number; linesRemoved: number } | null>;
  changedFiles(info: WorktreeInfo): Promise<string[]>;
  /** The latest `verification_passed` / `verification_failed` event of a task. */
  latestCheck(taskId: string): Promise<{ passed: boolean; message?: string } | undefined>;
  /** Files that would conflict between two branches; null when git cannot tell. */
  mergeConflicts(repoPath: string, branchA: string, branchB: string): Promise<string[] | null>;
}

function intentKey(task: Task): { key: string; intent: string; compareGroupId?: string } {
  const compareGroupId = task.agentConfig?.compareGroupId;
  if (compareGroupId)
    return { key: `compare:${compareGroupId}`, intent: task.title, compareGroupId };
  const intent = task.title.trim();
  return { key: `title:${intent.toLowerCase().replace(/\s+/g, " ")}`, intent };
}

export async function buildMergeReview(
  workspaceId: string,
  sources: MergeReviewSources,
): Promise<MergeReview> {
  const worktrees = (await sources.listWorktrees(workspaceId))
    .filter((info) => OPEN_WORKTREE_STATUSES.has(info.status))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, MAX_TASKS);

  const groups = new Map<string, MergeReviewGroup>();
  const entries: Array<{ groupKey: string; info: WorktreeInfo; task: MergeReviewTask }> = [];
  for (const info of worktrees) {
    const task = await sources.getTask(info.taskId);
    if (!task) continue;
    const [stats, files, check] = await Promise.all([
      sources.diffStats(info).catch(() => null),
      sources.changedFiles(info).catch(() => []),
      sources.latestCheck(info.taskId).catch(() => undefined),
    ]);
    const { key, intent, compareGroupId } = intentKey(task);
    const reviewTask: MergeReviewTask = {
      taskId: task.id,
      title: task.title,
      branch: info.branchName,
      status: task.status,
      worktreeStatus: info.status,
      ...(task.agentConfig?.compareVariant ? { variant: task.agentConfig.compareVariant } : {}),
      ...(check ? { check } : {}),
      diff: {
        files: stats?.filesChanged ?? files.length,
        additions: stats?.linesAdded ?? 0,
        deletions: stats?.linesRemoved ?? 0,
      },
      changedFiles: files,
    };
    const group = groups.get(key) ?? {
      intent,
      ...(compareGroupId ? { compareGroupId } : {}),
      tasks: [],
    };
    group.tasks.push(reviewTask);
    groups.set(key, group);
    entries.push({ groupKey: key, info, task: reviewTask });
  }

  // Files changed by more than one intent: those changes have to combine.
  const touchedBy = new Map<string, Map<string, string[]>>();
  for (const entry of entries) {
    for (const file of entry.task.changedFiles) {
      const byGroup = touchedBy.get(file) ?? new Map<string, string[]>();
      byGroup.set(entry.groupKey, [...(byGroup.get(entry.groupKey) ?? []), entry.task.taskId]);
      touchedBy.set(file, byGroup);
    }
  }
  const overlaps = [...touchedBy.entries()]
    .filter(([, byGroup]) => byGroup.size > 1)
    .map(([file, byGroup]) => ({ path: file, taskIds: [...byGroup.values()].flat() }))
    .sort((a, b) => a.path.localeCompare(b.path));

  // Pairs from different intents that would conflict if both were merged.
  const conflicts: MergeReview["checks"]["conflicts"] = [];
  let conflictCheckAvailable = true;
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (a.groupKey === b.groupKey) continue;
      const repoPath = a.info.repoPath || b.info.repoPath;
      if (!repoPath) continue;
      const files = await sources
        .mergeConflicts(repoPath, a.info.branchName, b.info.branchName)
        .catch(() => null);
      if (files === null) {
        conflictCheckAvailable = false;
        continue;
      }
      if (files.length > 0) conflicts.push({ taskIds: [a.task.taskId, b.task.taskId], files });
    }
  }

  return {
    workspaceId,
    groups: [...groups.values()],
    checks: { overlaps, conflicts, conflictCheckAvailable },
  };
}
