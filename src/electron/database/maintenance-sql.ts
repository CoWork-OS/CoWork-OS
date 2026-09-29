/**
 * Delete up to `?2` events of terminal tasks created before `?1`. Shared by the host
 * repository and the database worker so both paths prune identically; each run is
 * one bounded batch.
 */
export const PRUNE_TASK_EVENTS_BATCH_SQL = `
  DELETE FROM task_events
  WHERE rowid IN (
    SELECT rowid FROM task_events
    WHERE task_id IN (
      SELECT id FROM tasks WHERE status IN ('completed', 'failed', 'cancelled') AND created_at < ?
    )
    LIMIT ?
  )
`;

export const MAX_PRUNE_BATCH_SIZE = 5_000;
