import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  AgentTeamItem,
  AgentTeamItemStatus,
  CreateAgentTeamItemRequest,
  UpdateAgentTeamItemRequest,
} from "../../shared/types";

/**
 * Repository for managing agent team items (shared checklist) in the database.
 */
export class AgentTeamItemRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new item within a team run.
   */
  create(request: CreateAgentTeamItemRequest): AgentTeamItem {
    const now = Date.now();
    const item: AgentTeamItem = {
      id: uuidv4(),
      teamRunId: request.teamRunId,
      parentItemId: request.parentItemId,
      title: request.title,
      description: request.description,
      ownerAgentRoleId: request.ownerAgentRoleId,
      sourceTaskId: request.sourceTaskId,
      status: request.status ?? "todo",
      resultSummary: undefined,
      sortOrder: request.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO agent_team_items (
        id, team_run_id, parent_item_id, title, description,
        owner_agent_role_id, source_task_id, status, result_summary,
        sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      item.id,
      item.teamRunId,
      item.parentItemId || null,
      item.title,
      item.description || null,
      item.ownerAgentRoleId || null,
      item.sourceTaskId || null,
      item.status,
      null,
      item.sortOrder,
      item.createdAt,
      item.updatedAt,
    );

    return item;
  }

  /**
   * Find an item by ID.
   */
  findById(id: string): AgentTeamItem | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_team_items WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToItem(row) : undefined;
  }

  /**
   * List items for a run.
   */
  listByRun(teamRunId: string): AgentTeamItem[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM agent_team_items
      WHERE team_run_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `);
    const rows = stmt.all(teamRunId) as Any[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  /**
   * Update an item.
   */
  update(request: UpdateAgentTeamItemRequest): AgentTeamItem | undefined {
    const existing = this.findById(request.id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: Any[] = [];

    if (request.parentItemId !== undefined) {
      fields.push("parent_item_id = ?");
      values.push(request.parentItemId);
    }
    if (request.title !== undefined) {
      fields.push("title = ?");
      values.push(request.title);
    }
    if (request.description !== undefined) {
      fields.push("description = ?");
      values.push(request.description);
    }
    if (request.ownerAgentRoleId !== undefined) {
      fields.push("owner_agent_role_id = ?");
      values.push(request.ownerAgentRoleId);
    }
    if (request.sourceTaskId !== undefined) {
      fields.push("source_task_id = ?");
      values.push(request.sourceTaskId);
    }
    if (request.status !== undefined) {
      fields.push("status = ?");
      values.push(request.status);
    }
    if (request.resultSummary !== undefined) {
      fields.push("result_summary = ?");
      values.push(request.resultSummary);
    }
    if (request.sortOrder !== undefined) {
      fields.push("sort_order = ?");
      values.push(request.sortOrder);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(request.id);

    const sql = `UPDATE agent_team_items SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    return this.findById(request.id);
  }

  /**
   * Delete an item by ID.
   */
  delete(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM agent_team_items WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all items for a run.
   */
  deleteByRun(teamRunId: string): number {
    const stmt = this.db.prepare("DELETE FROM agent_team_items WHERE team_run_id = ?");
    const result = stmt.run(teamRunId);
    return result.changes;
  }

  /**
   * Set the result summary for items linked to a source task ID.
   *
   * Used to propagate `tasks.result_summary` into the shared team checklist.
   */
  setResultSummaryBySourceTaskId(sourceTaskId: string, resultSummary: string | null): number {
    const stmt = this.db.prepare(`
      UPDATE agent_team_items
      SET result_summary = ?, updated_at = ?
      WHERE source_task_id = ?
    `);
    const result = stmt.run(resultSummary, Date.now(), sourceTaskId);
    return result.changes;
  }

  /**
   * List items linked to a specific source task ID.
   */
  listBySourceTaskId(sourceTaskId: string): AgentTeamItem[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM agent_team_items
      WHERE source_task_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(sourceTaskId) as Any[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  private mapRowToItem(row: Any): AgentTeamItem {
    return {
      id: row.id,
      teamRunId: row.team_run_id,
      parentItemId: row.parent_item_id || undefined,
      title: row.title,
      description: row.description || undefined,
      ownerAgentRoleId: row.owner_agent_role_id || undefined,
      sourceTaskId: row.source_task_id || undefined,
      status: row.status as AgentTeamItemStatus,
      resultSummary: row.result_summary || undefined,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
