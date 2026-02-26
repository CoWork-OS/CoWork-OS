import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  AgentMention,
  CreateMentionRequest,
  MentionListQuery,
  MentionType,
  MentionStatus,
} from "../../shared/types";

/**
 * Repository for managing agent @mentions in the database
 */
export class MentionRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new mention
   */
  create(request: CreateMentionRequest): AgentMention {
    const now = Date.now();
    const mention: AgentMention = {
      id: uuidv4(),
      workspaceId: request.workspaceId,
      taskId: request.taskId,
      fromAgentRoleId: request.fromAgentRoleId,
      toAgentRoleId: request.toAgentRoleId,
      mentionType: request.mentionType,
      context: request.context,
      status: "pending",
      createdAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO agent_mentions (
        id, workspace_id, task_id, from_agent_role_id, to_agent_role_id,
        mention_type, context, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      mention.id,
      mention.workspaceId,
      mention.taskId,
      mention.fromAgentRoleId || null,
      mention.toAgentRoleId,
      mention.mentionType,
      mention.context || null,
      mention.status,
      mention.createdAt,
    );

    return mention;
  }

  /**
   * Find a mention by ID
   */
  findById(id: string): AgentMention | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_mentions WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToMention(row) : undefined;
  }

  /**
   * List mentions with optional filtering
   */
  list(query: MentionListQuery): AgentMention[] {
    const conditions: string[] = [];
    const params: Any[] = [];

    if (query.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(query.workspaceId);
    }

    if (query.taskId) {
      conditions.push("task_id = ?");
      params.push(query.taskId);
    }

    if (query.toAgentRoleId) {
      conditions.push("to_agent_role_id = ?");
      params.push(query.toAgentRoleId);
    }

    if (query.fromAgentRoleId) {
      conditions.push("from_agent_role_id = ?");
      params.push(query.fromAgentRoleId);
    }

    if (query.status) {
      if (Array.isArray(query.status)) {
        conditions.push(`status IN (${query.status.map(() => "?").join(", ")})`);
        params.push(...query.status);
      } else {
        conditions.push("status = ?");
        params.push(query.status);
      }
    }

    let sql = "SELECT * FROM agent_mentions";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY created_at DESC";

    if (query.limit) {
      sql += ` LIMIT ${query.limit}`;
      if (query.offset) {
        sql += ` OFFSET ${query.offset}`;
      }
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Any[];
    return rows.map((row) => this.mapRowToMention(row));
  }

  /**
   * Get pending mentions for a specific agent role
   */
  getPendingForAgent(toAgentRoleId: string, workspaceId?: string): AgentMention[] {
    const conditions = ["to_agent_role_id = ?", "status = ?"];
    const params: Any[] = [toAgentRoleId, "pending"];

    if (workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(workspaceId);
    }

    const sql = `SELECT * FROM agent_mentions WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Any[];
    return rows.map((row) => this.mapRowToMention(row));
  }

  /**
   * Get pending mention count for an agent role
   */
  getPendingCount(toAgentRoleId: string, workspaceId?: string): number {
    let sql =
      "SELECT COUNT(*) as count FROM agent_mentions WHERE to_agent_role_id = ? AND status = ?";
    const params: Any[] = [toAgentRoleId, "pending"];

    if (workspaceId) {
      sql += " AND workspace_id = ?";
      params.push(workspaceId);
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number };
    return result.count;
  }

  /**
   * Acknowledge a mention (mark as seen)
   */
  acknowledge(id: string): AgentMention | undefined {
    const existing = this.findById(id);
    if (!existing || existing.status !== "pending") return existing;

    const now = Date.now();
    const stmt = this.db.prepare(
      "UPDATE agent_mentions SET status = ?, acknowledged_at = ? WHERE id = ?",
    );
    stmt.run("acknowledged", now, id);

    return { ...existing, status: "acknowledged", acknowledgedAt: now };
  }

  /**
   * Mark a mention as completed
   */
  complete(id: string): AgentMention | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    if (existing.status === "completed" || existing.status === "dismissed") {
      return existing;
    }

    const now = Date.now();
    const stmt = this.db.prepare(
      "UPDATE agent_mentions SET status = ?, completed_at = ? WHERE id = ?",
    );
    stmt.run("completed", now, id);

    return { ...existing, status: "completed", completedAt: now };
  }

  /**
   * Dismiss a mention without completing it
   */
  dismiss(id: string): AgentMention | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    if (existing.status === "completed" || existing.status === "dismissed") {
      return existing;
    }

    const stmt = this.db.prepare("UPDATE agent_mentions SET status = ? WHERE id = ?");
    stmt.run("dismissed", id);

    return { ...existing, status: "dismissed" };
  }

  /**
   * Delete a mention
   */
  delete(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM agent_mentions WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all mentions for a task
   */
  deleteByTask(taskId: string): number {
    const stmt = this.db.prepare("DELETE FROM agent_mentions WHERE task_id = ?");
    const result = stmt.run(taskId);
    return result.changes;
  }

  /**
   * Map database row to AgentMention object
   */
  private mapRowToMention(row: Any): AgentMention {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      taskId: row.task_id,
      fromAgentRoleId: row.from_agent_role_id || undefined,
      toAgentRoleId: row.to_agent_role_id,
      mentionType: row.mention_type as MentionType,
      context: row.context || undefined,
      status: row.status as MentionStatus,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at || undefined,
      completedAt: row.completed_at || undefined,
    };
  }
}
