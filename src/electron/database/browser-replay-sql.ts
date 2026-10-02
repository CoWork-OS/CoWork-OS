import type Database from "better-sqlite3";

/**
 * Statements behind the browser host's timeline replay and artifact pages (async SQLite
 * migration plan, DB7). `TaskEventRepository` and `ArtifactStore` call these only from
 * methods that run as storage-domain units (`taskEvent_*` replay units and
 * `artifact_findByTaskIdPage`): in the database worker when storage is routed there, in one
 * host transaction otherwise. Rows come back raw; the stores map them.
 */

export interface TaskEventMutationJournalState {
  high_water_cursor?: number;
  earliest_available_cursor?: number;
}

export interface TaskEventMutationJournalRow {
  cursor: number;
  event_id: string;
  operation: "insert" | "update" | "delete";
}

export function readTaskEventMutationJournalState(
  db: Database.Database,
  taskId: string,
): TaskEventMutationJournalState | undefined {
  return db
    .prepare(
      `SELECT high_water_cursor, earliest_available_cursor
       FROM task_event_mutation_journal_state
       WHERE task_id = ?`,
    )
    .get(taskId) as TaskEventMutationJournalState | undefined;
}

export function readTaskEventMutationJournalPage(
  db: Database.Database,
  taskId: string,
  afterCursor: number,
  limit: number,
): TaskEventMutationJournalRow[] {
  return db
    .prepare(
      `SELECT cursor, event_id, operation
       FROM task_event_mutation_journal
       WHERE task_id = ? AND cursor > ?
       ORDER BY cursor ASC
       LIMIT ?`,
    )
    .all(taskId, afterCursor, limit) as TaskEventMutationJournalRow[];
}

/** The task's events with these ids, as stored rows. */
export function readTaskEventRowsByIds(
  db: Database.Database,
  taskId: string,
  eventIds: readonly string[],
): Record<string, unknown>[] {
  if (eventIds.length === 0) return [];
  return db
    .prepare(
      `SELECT *
       FROM task_events
       WHERE task_id = ? AND id IN (${eventIds.map(() => "?").join(", ")})`,
    )
    .all(taskId, ...eventIds) as Record<string, unknown>[];
}

/** Whether the task exists in this (existing) workspace. */
export function taskBelongsToWorkspace(
  db: Database.Database,
  taskId: string,
  workspaceId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS available
       FROM tasks AS task
       INNER JOIN workspaces AS workspace ON workspace.id = task.workspace_id
       WHERE task.id = ? AND task.workspace_id = ?
       LIMIT 1`,
    )
    .get(taskId, workspaceId) as { available?: number } | undefined;
  return row?.available === 1;
}

/** One page of a task's artifacts, newest first, as stored rows. */
export function readArtifactRowsByTaskIdPage(
  db: Database.Database,
  taskId: string,
  limit: number,
  offset: number,
): Record<string, unknown>[] {
  return db
    .prepare(
      "SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(taskId, limit, offset) as Record<string, unknown>[];
}
