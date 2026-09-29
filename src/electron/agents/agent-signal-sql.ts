import type Database from "better-sqlite3";

export interface RecentTaskEventRow {
  taskId: string;
  timestamp: number;
  payload: string;
}

/**
 * Startup rebuild reads for the agent kit services (cross signals, feedback, lore): recent
 * task events of one type (async SQLite migration plan, DB6). As a services-domain unit
 * the read runs in the database worker when the domain is routed there.
 */
export class AgentSignalStore {
  constructor(private readonly db: Database.Database) {}

  recentEventsOfType(
    type: string,
    sinceMs: number,
    limit: number,
    order: "asc" | "desc",
  ): RecentTaskEventRow[] {
    return this.db
      .prepare(
        `
      SELECT e.task_id as taskId, e.timestamp as timestamp, e.payload as payload
      FROM task_events e
      WHERE (e.type = ? OR e.legacy_type = ?)
        AND e.timestamp >= ?
      ORDER BY e.timestamp ${order === "asc" ? "ASC" : "DESC"}
      LIMIT ?
    `,
      )
      .all(type, type, sinceMs, limit) as RecentTaskEventRow[];
  }

  /** Task events in a time range (with task title and workspace), oldest first. */
  eventsInRange(input: {
    startMs: number;
    endMs: number;
    workspaceId: string | null;
    types: string[];
    limit: number;
  }): Array<{
    id: string;
    taskId: string;
    timestamp: number;
    type: string;
    legacy_type?: string;
    payload: string;
    taskTitle: string;
    workspaceId: string;
  }> {
    let sql = `
      SELECT
        e.id as id,
        e.task_id as taskId,
        e.timestamp as timestamp,
        e.type as type,
        e.legacy_type as legacy_type,
        e.payload as payload,
        t.title as taskTitle,
        t.workspace_id as workspaceId
      FROM task_events e
      JOIN tasks t ON t.id = e.task_id
      WHERE e.timestamp >= ? AND e.timestamp < ?
    `;
    const args: unknown[] = [input.startMs, input.endMs];
    if (input.workspaceId) {
      sql += " AND t.workspace_id = ?";
      args.push(input.workspaceId);
    }
    if (input.types.length > 0) {
      const placeholders = input.types.map(() => "?").join(", ");
      sql += ` AND (e.type IN (${placeholders}) OR e.legacy_type IN (${placeholders}))`;
      args.push(...input.types, ...input.types);
    }
    sql += " ORDER BY e.timestamp ASC LIMIT ?";
    args.push(input.limit);
    return this.db.prepare(sql).all(...args) as ReturnType<AgentSignalStore["eventsInRange"]>;
  }
}
