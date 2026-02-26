import Database from "better-sqlite3";
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
 * Repository for managing activity feed entries in the database
 */
export class ActivityRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new activity entry
   */
  create(request: CreateActivityRequest): Activity {
    const now = Date.now();
    const activity: Activity = {
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
      createdAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO activity_feed (
        id, workspace_id, task_id, agent_role_id, actor_type,
        activity_type, title, description, metadata,
        is_read, is_pinned, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

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
    );

    return activity;
  }

  /**
   * Find an activity by ID
   */
  findById(id: string): Activity | undefined {
    const stmt = this.db.prepare("SELECT * FROM activity_feed WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToActivity(row) : undefined;
  }

  /**
   * List activities with optional filtering
   */
  list(query: ActivityListQuery): Activity[] {
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

    if (query.limit) {
      sql += ` LIMIT ${query.limit}`;
      if (query.offset) {
        sql += ` OFFSET ${query.offset}`;
      }
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Any[];
    return rows.map((row) => this.mapRowToActivity(row));
  }

  /**
   * Get unread count for a workspace
   */
  getUnreadCount(workspaceId: string): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM activity_feed WHERE workspace_id = ? AND is_read = 0",
    );
    const result = stmt.get(workspaceId) as { count: number };
    return result.count;
  }

  /**
   * Mark an activity as read
   */
  markRead(id: string): boolean {
    const stmt = this.db.prepare("UPDATE activity_feed SET is_read = 1 WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Mark all activities as read for a workspace
   */
  markAllRead(workspaceId: string): number {
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
    const stmt = this.db.prepare("DELETE FROM activity_feed WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all activities for a workspace (optionally by age)
   */
  deleteOld(workspaceId: string, olderThanMs?: number): number {
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
