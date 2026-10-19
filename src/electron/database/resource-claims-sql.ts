import type Database from "better-sqlite3";
import type { ResourceClaimHolder, ResourceOverlap } from "../../shared/types";

/**
 * Shared-change coordination (agent-first roadmap WP11): which task is about to change which
 * resource. A claim is written just before a task's first write to a file, keyed by the
 * workspace and the file's workspace-relative path, so tasks in separate worktrees of one
 * repository line up. Runs only as storage-domain units behind `ResourceClaimRepository`.
 *
 * A claim counts while its task can still change the resource: a task in the shared folder
 * until it stops running, a worktree task until its worktree is merged or removed.
 */
export interface ResourceClaimInput {
  id: string;
  taskId: string;
  workspaceId: string;
  /** `file:<workspace-relative path>`. */
  resourceKey: string;
  label: string;
  /** What the task intends, shown to the other task's owner (its title). */
  intent?: string;
  /** The task works in its own worktree. */
  isolated: boolean;
  /**
   * The top task of the claimant's parent/child tree. Tasks of one tree (a lead task and the
   * sub-agents it starts) work on the same files together and never block each other.
   */
  familyRoot: string;
  at: number;
}

export interface ResourceClaimResult {
  /** False when another task in the same folder is changing the resource right now. */
  claimed: boolean;
  /** Other tasks holding a claim on the same resource. */
  others: ResourceClaimHolder[];
}

const RUNNING_STATUSES = "('pending', 'queued', 'planning', 'executing', 'paused', 'blocked')";
/** A task in the shared folder that has not moved for this long no longer blocks others. */
const STALE_BLOCK_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 1_000;
const MAX_OVERLAPS = 200;
/** Claims that no longer count are removed after this long, a bounded batch per claim. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 100;

/** SQL for "this claim still counts": `c` is resource_claims, `t` its task. */
const ACTIVE_CLAIM = `(t.status IN ${RUNNING_STATUSES}
  OR (c.isolated = 1 AND t.worktree_path IS NOT NULL
      AND COALESCE(t.worktree_status, 'active') NOT IN ('merged', 'cleaned', 'failed')))`;

type Row = Record<string, unknown>;

function holder(row: Row): ResourceClaimHolder {
  return {
    taskId: String(row.task_id),
    title: String(row.title ?? row.intent ?? ""),
    isolated: Number(row.isolated) === 1,
    status: String(row.status ?? ""),
  };
}

export class ResourceClaimStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Claim a resource for a task. A task in the shared folder is refused while another task in
   * that folder is changing the same resource; worktree tasks always get their claim, and the
   * overlap is reported for the merge review.
   */
  claim(input: ResourceClaimInput): ResourceClaimResult {
    this.pruneInactive(input.at);
    const others = (
      this.db
        .prepare(
          `SELECT c.task_id, c.isolated, c.intent, t.title, t.status, t.updated_at
           FROM resource_claims c JOIN tasks t ON t.id = c.task_id
           WHERE c.workspace_id = ? AND c.resource_key = ? AND c.task_id != ?
             AND c.family_root != ? AND ${ACTIVE_CLAIM}
           ORDER BY c.claimed_at ASC`,
        )
        .all(input.workspaceId, input.resourceKey, input.taskId, input.familyRoot) as Row[]
    ).map((row) => ({ row, holder: holder(row) }));
    const blocking = input.isolated
      ? []
      : others.filter(
          ({ row, holder: other }) =>
            !other.isolated &&
            RUNNING_STATUSES.includes(`'${other.status}'`) &&
            Number(row.updated_at) > input.at - STALE_BLOCK_MS,
        );
    if (blocking.length > 0) {
      return { claimed: false, others: others.map((entry) => entry.holder) };
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO resource_claims
           (id, task_id, workspace_id, resource_key, resource_label, intent, isolated,
            family_root, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.taskId,
        input.workspaceId,
        input.resourceKey.slice(0, MAX_TEXT),
        input.label.slice(0, MAX_TEXT),
        input.intent ? input.intent.slice(0, 300) : null,
        input.isolated ? 1 : 0,
        input.familyRoot,
        input.at,
      );
    return { claimed: true, others: others.map((entry) => entry.holder) };
  }

  /** Remove old claims that no longer count, so the table stays small. */
  private pruneInactive(at: number): void {
    this.db
      .prepare(
        `DELETE FROM resource_claims WHERE id IN (
           SELECT c.id FROM resource_claims c LEFT JOIN tasks t ON t.id = c.task_id
           WHERE c.claimed_at < ? AND (t.id IS NULL OR NOT ${ACTIVE_CLAIM})
           LIMIT ${PRUNE_BATCH})`,
      )
      .run(at - PRUNE_AFTER_MS);
  }

  /** Resources two or more tasks are changing, optionally in one workspace. */
  listOverlaps(input: { workspaceId?: string } = {}): ResourceOverlap[] {
    const scope = input.workspaceId ? "AND c.workspace_id = ?" : "";
    const rows = this.db
      .prepare(
        `SELECT c.workspace_id, c.resource_key, c.resource_label, c.task_id, c.isolated, c.intent,
                t.title, t.status
         FROM resource_claims c JOIN tasks t ON t.id = c.task_id
         WHERE ${ACTIVE_CLAIM} ${scope}
           AND (c.workspace_id, c.resource_key) IN (
             SELECT c.workspace_id, c.resource_key
             FROM resource_claims c JOIN tasks t ON t.id = c.task_id
             WHERE ${ACTIVE_CLAIM} ${scope}
             GROUP BY c.workspace_id, c.resource_key
             HAVING COUNT(DISTINCT c.family_root) > 1
             LIMIT ${MAX_OVERLAPS})
         ORDER BY c.workspace_id, c.resource_key, c.claimed_at`,
      )
      .all(...(input.workspaceId ? [input.workspaceId, input.workspaceId] : [])) as Row[];
    const overlaps = new Map<string, ResourceOverlap>();
    for (const row of rows) {
      const key = `${String(row.workspace_id)}\n${String(row.resource_key)}`;
      const overlap = overlaps.get(key) ?? {
        workspaceId: String(row.workspace_id),
        resourceKey: String(row.resource_key),
        label: String(row.resource_label),
        holders: [],
      };
      overlap.holders.push(holder(row));
      overlaps.set(key, overlap);
    }
    return [...overlaps.values()];
  }

  /** The resources a task has claimed, oldest first. */
  listForTask(taskId: string): Array<{ resourceKey: string; label: string; claimedAt: number }> {
    return (
      this.db
        .prepare(
          `SELECT resource_key, resource_label, claimed_at FROM resource_claims
           WHERE task_id = ? ORDER BY claimed_at ASC LIMIT 1000`,
        )
        .all(taskId) as Row[]
    ).map((row) => ({
      resourceKey: String(row.resource_key),
      label: String(row.resource_label),
      claimedAt: Number(row.claimed_at),
    }));
  }
}
