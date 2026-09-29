import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  Activity,
  CreateActivityRequest,
  ActivityListQuery,
  ActivityActorType,
  ActivityType,
} from "../../shared/types";

/**
 * Safely parse JSON with error handling
 */
function safeJsonParse<T>(jsonString: string | null, defaultValue: T, context?: string): T {
  if (!jsonString) return defaultValue;
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error(`Failed to parse JSON${context ? ` in ${context}` : ""}:`, error);
    return defaultValue;
  }
}

/**
 * The activity feed's SQL (async SQLite migration plan, DB6). As services-domain units
 * these run in the database worker when the domain is routed there; callers use the async
 * `ActivityRepository` facade in `activity-repository-facades.ts`, which passes the
 * activity rows the host's timeline writer has accepted but not committed yet. Reads merge
 * those rows; writes insert them first (the inserts are idempotent, so the writer later
 * skips them), so a write never misses a row the feed already showed.
 */
export class ActivityStore {
  constructor(
    private db: Database.Database,
    private readonly pending: Activity[] = [],
  ) {}

  /** Commit the pending rows in this transaction before a write reads or changes them. */
  private commitPending(): void {
    for (const activity of this.pending) this.insertIfAbsent(activity);
  }

  /** Pending rows the database does not hold yet. */
  private uncommittedPending(): Activity[] {
    if (this.pending.length === 0) return [];
    const committed = new Set(
      (
        this.db
          .prepare("SELECT id FROM activity_feed WHERE id IN (SELECT value FROM json_each(?))")
          .all(JSON.stringify(this.pending.map((activity) => activity.id))) as Array<{
          id: string;
        }>
      ).map((row) => row.id),
    );
    return this.pending.filter((activity) => !committed.has(activity.id));
  }

  /**
   * Create a new activity entry
   */
  /** Build the stored activity without touching the database (the worker may write it). */
  static prepareForInsert(request: CreateActivityRequest): Activity {
    return {
      id: uuidv4(),
      workspaceId: request.workspaceId,
      taskId: request.taskId,
      agentRoleId: request.agentRoleId,
      actorType: request.actorType,
      activityType: request.activityType,
      title: request.title,
      description: request.description,
      metadata: request.metadata,
      isRead: false,
      isPinned: false,
      createdAt: Date.now(),
    };
  }

  create(request: CreateActivityRequest): Activity {
    const activity = ActivityStore.prepareForInsert(request);
    this.insertIfAbsent(activity);
    return activity;
  }

  /** Insert a prepared activity; a repeated attempt for the same id is ignored. */
  insertIfAbsent(activity: Activity): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO activity_feed (
        id, workspace_id, task_id, agent_role_id, actor_type,
        activity_type, title, description, metadata,
        is_read, is_pinned, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return (
      stmt.run(
        activity.id,
        activity.workspaceId,
        activity.taskId || null,
        activity.agentRoleId || null,
        activity.actorType,
        activity.activityType,
        activity.title,
        activity.description || null,
        activity.metadata ? JSON.stringify(activity.metadata) : null,
        activity.isRead ? 1 : 0,
        activity.isPinned ? 1 : 0,
        activity.createdAt,
      ).changes === 1
    );
  }

  /**
   * Find an activity by ID
   */
  findById(id: string): Activity | undefined {
    const stmt = this.db.prepare("SELECT * FROM activity_feed WHERE id = ?");
    const row = stmt.get(id) as Any;
    if (row) return this.mapRowToActivity(row);
    // Accepted but not committed yet (DB6): reads merge it instead of committing it.
    return this.pending.find((activity) => activity.id === id);
  }

  /** Pending activity rows that match a list query's filters (DB6). */
  private pendingMatching(query: ActivityListQuery): Activity[] {
    const types = query.activityType
      ? new Set(Array.isArray(query.activityType) ? query.activityType : [query.activityType])
      : null;
    // A pending row the worker has committed since is read from the table instead, so a
    // later change to it (read, pinned) is not hidden by the accepted copy.
    return this.uncommittedPending().filter(
      (activity) =>
        activity.workspaceId === query.workspaceId &&
        (!query.taskId || activity.taskId === query.taskId) &&
        (!query.agentRoleId || activity.agentRoleId === query.agentRoleId) &&
        (!types || types.has(activity.activityType)) &&
        (!query.actorType || activity.actorType === query.actorType) &&
        (query.isRead === undefined || Boolean(activity.isRead) === query.isRead) &&
        (query.isPinned === undefined || Boolean(activity.isPinned) === query.isPinned),
    );
  }

  /**
   * List activities with optional filtering
   */
  list(query: ActivityListQuery): Activity[] {
    const pending = this.pendingMatching(query);
    const conditions: string[] = ["workspace_id = ?"];
    const params: Any[] = [query.workspaceId];

    if (query.taskId) {
      conditions.push("task_id = ?");
      params.push(query.taskId);
    }

    if (query.agentRoleId) {
      conditions.push("agent_role_id = ?");
      params.push(query.agentRoleId);
    }

    if (query.activityType) {
      if (Array.isArray(query.activityType)) {
        conditions.push(`activity_type IN (${query.activityType.map(() => "?").join(", ")})`);
        params.push(...query.activityType);
      } else {
        conditions.push("activity_type = ?");
        params.push(query.activityType);
      }
    }

    if (query.actorType) {
      conditions.push("actor_type = ?");
      params.push(query.actorType);
    }

    if (query.isRead !== undefined) {
      conditions.push("is_read = ?");
      params.push(query.isRead ? 1 : 0);
    }

    if (query.isPinned !== undefined) {
      conditions.push("is_pinned = ?");
      params.push(query.isPinned ? 1 : 0);
    }

    let sql = `SELECT * FROM activity_feed WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`;

    // With pending rows to merge, read the whole window from the top and page after the
    // merge; otherwise let SQLite page.
    const offset = query.offset ?? 0;
    if (query.limit) {
      sql += ` LIMIT ${pending.length > 0 ? offset + query.limit : query.limit}`;
      if (offset && pending.length === 0) {
        sql += ` OFFSET ${offset}`;
      }
    }

    const stmt = this.db.prepare(sql);
    const rows = (stmt.all(...params) as Any[]).map((row) => this.mapRowToActivity(row));
    if (pending.length === 0) return rows;
    const ids = new Set(rows.map((activity) => activity.id));
    const merged = [...rows, ...pending.filter((activity) => !ids.has(activity.id))].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    return query.limit ? merged.slice(offset, offset + query.limit) : merged.slice(offset);
  }

  /**
   * Get unread count for a workspace
   */
  getUnreadCount(workspaceId: string): number {
    // Pending rows (DB6) count too; one the worker committed since is counted once.
    const pending = this.pending
      .filter((activity) => activity.workspaceId === workspaceId && !activity.isRead)
      .map((activity) => activity.id);
    const stmt = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM activity_feed WHERE workspace_id = ? AND is_read = 0) AS count,
        (SELECT COUNT(*) FROM activity_feed WHERE id IN (SELECT value FROM json_each(?))) AS committed_pending
    `);
    const result = stmt.get(workspaceId, JSON.stringify(pending)) as {
      count: number;
      committed_pending: number;
    };
    return result.count + pending.length - result.committed_pending;
  }

  /**
   * Mark an activity as read
   */
  markRead(id: string): boolean {
    this.commitPending();
    const stmt = this.db.prepare("UPDATE activity_feed SET is_read = 1 WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Mark all activities as read for a workspace
   */
  markAllRead(workspaceId: string): number {
    this.commitPending();
    const stmt = this.db.prepare(
      "UPDATE activity_feed SET is_read = 1 WHERE workspace_id = ? AND is_read = 0",
    );
    const result = stmt.run(workspaceId);
    return result.changes;
  }

  /**
   * Toggle pin status of an activity
   */
  togglePin(id: string): Activity | undefined {
    this.commitPending();
    const existing = this.findById(id);
    if (!existing) return undefined;

    const newPinned = !existing.isPinned;
    const stmt = this.db.prepare("UPDATE activity_feed SET is_pinned = ? WHERE id = ?");
    stmt.run(newPinned ? 1 : 0, id);

    return { ...existing, isPinned: newPinned };
  }

  /**
   * Delete an activity
   */
  delete(id: string): boolean {
    this.commitPending();
    const stmt = this.db.prepare("DELETE FROM activity_feed WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all activities for a workspace (optionally by age)
   */
  deleteOld(workspaceId: string, olderThanMs?: number): number {
    this.commitPending();
    if (olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      const stmt = this.db.prepare(
        "DELETE FROM activity_feed WHERE workspace_id = ? AND created_at < ? AND is_pinned = 0",
      );
      const result = stmt.run(workspaceId, cutoff);
      return result.changes;
    } else {
      const stmt = this.db.prepare(
        "DELETE FROM activity_feed WHERE workspace_id = ? AND is_pinned = 0",
      );
      const result = stmt.run(workspaceId);
      return result.changes;
    }
  }

  /**
   * Map database row to Activity object
   */
  private mapRowToActivity(row: Any): Activity {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      taskId: row.task_id || undefined,
      agentRoleId: row.agent_role_id || undefined,
      actorType: row.actor_type as ActivityActorType,
      activityType: row.activity_type as ActivityType,
      title: row.title,
      description: row.description || undefined,
      metadata: safeJsonParse<Record<string, unknown> | undefined>(
        row.metadata,
        undefined,
        "activity.metadata",
      ),
      isRead: row.is_read === 1,
      isPinned: row.is_pinned === 1,
      createdAt: row.created_at,
    };
  }
}
