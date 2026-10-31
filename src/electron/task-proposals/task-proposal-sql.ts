import type Database from "better-sqlite3";
import {
  TASK_PROPOSAL_STATUSES,
  type TaskProposal,
  type TaskProposalStatus,
} from "../../shared/task-proposals";

/**
 * Tasks an agent proposed (`propose_task`), one row per proposal. Rows belong to the task
 * that proposed them and are deleted with it.
 */
export const TASK_PROPOSAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_proposals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    brief TEXT NOT NULL,
    suggested_worktree INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    started_task_id TEXT,
    withdraw_reason TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_task_proposals_task ON task_proposals(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_task_proposals_started_task ON task_proposals(started_task_id);
`;

type TaskProposalRow = {
  id: string;
  task_id: string;
  workspace_id: string;
  title: string;
  summary: string;
  brief: string;
  suggested_worktree: number;
  status: string;
  started_task_id: string | null;
  withdraw_reason: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
};

const SELECT_COLUMNS = `id, task_id, workspace_id, title, summary, brief, suggested_worktree,
  status, started_task_id, withdraw_reason, created_at, expires_at, decided_at`;

function toProposal(row: TaskProposalRow): TaskProposal {
  const status = (TASK_PROPOSAL_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as TaskProposalStatus)
    : "dismissed";
  return {
    id: row.id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    title: row.title,
    summary: row.summary,
    brief: row.brief,
    suggestedWorktree: row.suggested_worktree === 1,
    status,
    ...(row.started_task_id ? { startedTaskId: row.started_task_id } : {}),
    ...(row.withdraw_reason ? { withdrawReason: row.withdraw_reason } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
  };
}

/** Deletes a task's proposals inside the task-delete transaction. */
export function deleteTaskProposalsForTask(db: Database.Database, taskId: string): void {
  db.exec(TASK_PROPOSAL_SCHEMA);
  db.prepare("DELETE FROM task_proposals WHERE task_id = ?").run(taskId);
}

export class TaskProposalSqlStore {
  constructor(private readonly db: Database.Database) {}

  /** Keeps a proposal for an existing task; returns false when the task is gone. */
  insert(proposal: TaskProposal): boolean {
    const hasTasks = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get();
    if (hasTasks && !this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(proposal.taskId)) {
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO task_proposals (${SELECT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        proposal.taskId,
        proposal.workspaceId,
        proposal.title,
        proposal.summary,
        proposal.brief,
        proposal.suggestedWorktree ? 1 : 0,
        proposal.status,
        proposal.startedTaskId ?? null,
        proposal.withdrawReason ?? null,
        proposal.createdAt,
        proposal.expiresAt,
        proposal.decidedAt ?? null,
      );
    return true;
  }

  get(id: string): TaskProposal | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM task_proposals WHERE id = ?`)
      .get(id) as TaskProposalRow | undefined;
    return row ? toProposal(row) : null;
  }

  listForTask(taskId: string): TaskProposal[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM task_proposals
         WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(taskId) as TaskProposalRow[];
    return rows.map(toProposal);
  }

  findByStartedTask(startedTaskId: string): TaskProposal | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM task_proposals WHERE started_task_id = ? LIMIT 1`)
      .get(startedTaskId) as TaskProposalRow | undefined;
    return row ? toProposal(row) : null;
  }

  /**
   * Moves a still-pending proposal to its next status. Returns false when it was not
   * pending (someone else decided first), so a double click starts nothing twice.
   */
  settle(
    id: string,
    status: Exclude<TaskProposalStatus, "pending">,
    decidedAt: number,
    details: { startedTaskId?: string; withdrawReason?: string } = {},
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_proposals
         SET status = ?, decided_at = ?, started_task_id = COALESCE(?, started_task_id),
             withdraw_reason = COALESCE(?, withdraw_reason)
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, decidedAt, details.startedTaskId ?? null, details.withdrawReason ?? null, id);
    return result.changes > 0;
  }

  /** Points a started proposal at its task once that task exists. */
  setStartedTask(id: string, startedTaskId: string): void {
    this.db
      .prepare("UPDATE task_proposals SET started_task_id = ? WHERE id = ?")
      .run(startedTaskId, id);
  }

  /** Puts a proposal back to pending when starting it, or sending it here, failed. */
  reopen(id: string): void {
    this.db
      .prepare(
        `UPDATE task_proposals SET status = 'pending', decided_at = NULL, started_task_id = NULL
         WHERE id = ? AND status IN ('started', 'done_here')`,
      )
      .run(id);
  }
}
