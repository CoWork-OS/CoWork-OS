import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  AgentWorkingState,
  UpdateWorkingStateRequest,
  WorkingStateQuery,
  WorkingStateHistoryQuery,
  WorkingStateType,
} from "../../shared/types";

/**
 * Repository for managing agent working state in the database
 */
export class WorkingStateRepository {
  constructor(private db: Database.Database) {}

  /**
   * Get a working state by ID
   */
  findById(id: string): AgentWorkingState | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_working_state WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToState(row) : undefined;
  }

  /**
   * Get the current working state for an agent in a workspace
   */
  getCurrent(query: WorkingStateQuery): AgentWorkingState | undefined {
    let sql = `
      SELECT * FROM agent_working_state
      WHERE agent_role_id = ?
        AND workspace_id = ?
        AND is_current = 1
    `;
    const params: Any[] = [query.agentRoleId, query.workspaceId];

    if (query.taskId) {
      sql += " AND task_id = ?";
      params.push(query.taskId);
    } else {
      sql += " AND task_id IS NULL";
    }

    if (query.stateType) {
      sql += " AND state_type = ?";
      params.push(query.stateType);
    }

    sql += " ORDER BY updated_at DESC LIMIT 1";

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as Any;
    return row ? this.mapRowToState(row) : undefined;
  }

  /**
   * Get all current working states for an agent in a workspace
   */
  getAllCurrent(agentRoleId: string, workspaceId: string): AgentWorkingState[] {
    const stmt = this.db.prepare(`
      SELECT * FROM agent_working_state
      WHERE agent_role_id = ? AND workspace_id = ? AND is_current = 1
      ORDER BY state_type, updated_at DESC
    `);
    const rows = stmt.all(agentRoleId, workspaceId) as Any[];
    return rows.map((row) => this.mapRowToState(row));
  }

  /**
   * Update or create a working state
   */
  update(request: UpdateWorkingStateRequest): AgentWorkingState {
    const now = Date.now();

    // Mark existing current states as not current
    const updateStmt = this.db.prepare(`
      UPDATE agent_working_state
      SET is_current = 0, updated_at = ?
      WHERE agent_role_id = ?
        AND workspace_id = ?
        AND state_type = ?
        AND is_current = 1
        ${request.taskId ? "AND task_id = ?" : "AND task_id IS NULL"}
    `);

    const updateParams = [now, request.agentRoleId, request.workspaceId, request.stateType];
    if (request.taskId) {
      updateParams.push(request.taskId);
    }
    updateStmt.run(...updateParams);

    // Create new state
    const state: AgentWorkingState = {
      id: uuidv4(),
      agentRoleId: request.agentRoleId,
      workspaceId: request.workspaceId,
      taskId: request.taskId,
      stateType: request.stateType,
      content: request.content,
      fileReferences: request.fileReferences,
      isCurrent: true,
      createdAt: now,
      updatedAt: now,
    };

    const insertStmt = this.db.prepare(`
      INSERT INTO agent_working_state
        (id, agent_role_id, workspace_id, task_id, state_type, content, file_references, is_current, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);

    insertStmt.run(
      state.id,
      state.agentRoleId,
      state.workspaceId,
      state.taskId || null,
      state.stateType,
      state.content,
      state.fileReferences ? JSON.stringify(state.fileReferences) : null,
      state.createdAt,
      state.updatedAt,
    );

    return state;
  }

  /**
   * Get working state history for an agent
   */
  getHistory(query: WorkingStateHistoryQuery): AgentWorkingState[] {
    const limit = query.limit || 50;
    const offset = query.offset || 0;

    const stmt = this.db.prepare(`
      SELECT * FROM agent_working_state
      WHERE agent_role_id = ? AND workspace_id = ?
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(query.agentRoleId, query.workspaceId, limit, offset) as Any[];
    return rows.map((row) => this.mapRowToState(row));
  }

  /**
   * Get all working states for a specific task
   */
  listForTask(taskId: string): AgentWorkingState[] {
    const stmt = this.db.prepare(`
      SELECT * FROM agent_working_state
      WHERE task_id = ?
      ORDER BY updated_at DESC
    `);
    const rows = stmt.all(taskId) as Any[];
    return rows.map((row) => this.mapRowToState(row));
  }

  /**
   * Restore a previous working state as current
   */
  restore(id: string): AgentWorkingState | undefined {
    const state = this.findById(id);
    if (!state) return undefined;

    const now = Date.now();

    // Mark all states of this type/agent/workspace as not current
    const updateStmt = this.db.prepare(`
      UPDATE agent_working_state
      SET is_current = 0, updated_at = ?
      WHERE agent_role_id = ?
        AND workspace_id = ?
        AND state_type = ?
        AND is_current = 1
        ${state.taskId ? "AND task_id = ?" : "AND task_id IS NULL"}
    `);

    const updateParams = [now, state.agentRoleId, state.workspaceId, state.stateType];
    if (state.taskId) {
      updateParams.push(state.taskId);
    }
    updateStmt.run(...updateParams);

    // Mark the target state as current
    const restoreStmt = this.db.prepare(`
      UPDATE agent_working_state SET is_current = 1, updated_at = ? WHERE id = ?
    `);
    restoreStmt.run(now, id);

    return { ...state, isCurrent: true, updatedAt: now };
  }

  /**
   * Delete a working state
   */
  delete(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM agent_working_state WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all working states for an agent in a workspace
   */
  deleteByAgentAndWorkspace(agentRoleId: string, workspaceId: string): number {
    const stmt = this.db.prepare(
      "DELETE FROM agent_working_state WHERE agent_role_id = ? AND workspace_id = ?",
    );
    const result = stmt.run(agentRoleId, workspaceId);
    return result.changes;
  }

  /**
   * Delete all working states for a task
   */
  deleteByTask(taskId: string): number {
    const stmt = this.db.prepare("DELETE FROM agent_working_state WHERE task_id = ?");
    const result = stmt.run(taskId);
    return result.changes;
  }

  /**
   * Clean up old non-current states (keep last N per agent/workspace)
   */
  cleanupOldStates(keepCount: number = 50): number {
    // Get all agent/workspace combinations with more than keepCount states
    const countStmt = this.db.prepare(`
      SELECT agent_role_id, workspace_id, COUNT(*) as total
      FROM agent_working_state
      WHERE is_current = 0
      GROUP BY agent_role_id, workspace_id
      HAVING total > ?
    `);

    const groups = countStmt.all(keepCount) as Any[];
    let totalDeleted = 0;

    for (const group of groups) {
      // Delete oldest states beyond keepCount
      const deleteStmt = this.db.prepare(`
        DELETE FROM agent_working_state
        WHERE id IN (
          SELECT id FROM agent_working_state
          WHERE agent_role_id = ? AND workspace_id = ? AND is_current = 0
          ORDER BY updated_at ASC
          LIMIT ?
        )
      `);
      const result = deleteStmt.run(
        group.agent_role_id,
        group.workspace_id,
        group.total - keepCount,
      );
      totalDeleted += result.changes;
    }

    return totalDeleted;
  }

  /**
   * Map database row to AgentWorkingState object
   */
  private mapRowToState(row: Any): AgentWorkingState {
    return {
      id: row.id,
      agentRoleId: row.agent_role_id,
      workspaceId: row.workspace_id,
      taskId: row.task_id || undefined,
      stateType: row.state_type as WorkingStateType,
      content: row.content,
      fileReferences: row.file_references ? JSON.parse(row.file_references) : undefined,
      isCurrent: row.is_current === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
