import type Database from "better-sqlite3";

/**
 * The daily briefing's task counts as synchronous SQL (async SQLite migration plan, DB6):
 * report units of the reports domain, run on the reporting reader when one is running.
 */
export class DailyBriefingStore {
  constructor(private db: Database.Database) {}

  countTasks(workspaceId: string, status: string, afterMs?: number): number {
    let sql = "SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ? AND status = ?";
    const params: (string | number)[] = [workspaceId, status];
    if (afterMs) {
      sql += " AND updated_at > ?";
      params.push(afterMs);
    }
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as { count: number } | undefined;
    return row?.count ?? 0;
  }
  countScheduledTasks(workspaceId: string): number {
    try {
      const stmt = this.db.prepare(
        "SELECT COUNT(*) as count FROM cron_jobs WHERE workspace_id = ? AND enabled = 1",
      );
      const row = stmt.get(workspaceId) as { count: number } | undefined;
      return row?.count ?? 0;
    } catch {
      // Table may not exist; that's fine
      return 0;
    }
  }
}
