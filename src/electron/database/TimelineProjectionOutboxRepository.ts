import type Database from "better-sqlite3";

/**
 * Durable queue of timeline events whose WorkSession projections have not run yet
 * (async SQLite migration plan, DB3). The host inserts a row in the same transaction
 * as the TaskEvent; whoever projects the event deletes the row in the same transaction
 * as the projection writes. A crash therefore leaves either both or neither, and the
 * next drain repairs derived state without replaying provider or tool effects.
 */
export class TimelineProjectionOutboxRepository {
  constructor(private readonly db: Database.Database) {}

  static ensureSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS timeline_projection_outbox (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_projection_outbox_task
        ON timeline_projection_outbox(task_id);
    `);
  }

  enqueue(eventId: string, taskId: string, now = Date.now()): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO timeline_projection_outbox (event_id, task_id, enqueued_at) VALUES (?, ?, ?)",
      )
      .run(eventId, taskId, now);
  }

  /** Oldest entries first, so projections run in event order. */
  listBatch(limit: number): Array<{ eventId: string; taskId: string }> {
    return (
      this.db
        .prepare(
          "SELECT event_id, task_id FROM timeline_projection_outbox ORDER BY rowid ASC LIMIT ?",
        )
        .all(Math.max(1, Math.floor(limit))) as Array<{ event_id: string; task_id: string }>
    ).map((row) => ({ eventId: row.event_id, taskId: row.task_id }));
  }

  remove(eventId: string): void {
    this.db.prepare("DELETE FROM timeline_projection_outbox WHERE event_id = ?").run(eventId);
  }

  count(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS total FROM timeline_projection_outbox").get() as {
        total: number;
      }
    ).total;
  }
}
