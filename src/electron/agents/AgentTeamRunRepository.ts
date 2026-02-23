import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  AgentTeamRun,
  AgentTeamRunPhase,
  AgentTeamRunStatus,
  CreateAgentTeamRunRequest,
} from "../../shared/types";

/**
 * Repository for managing agent team runs (execution sessions) in the database.
 */
export class AgentTeamRunRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new run for a team.
   */
  create(request: CreateAgentTeamRunRequest): AgentTeamRun {
    const now = Date.now();
    const isCollabOrMultiLlm = request.collaborativeMode || request.multiLlmMode;
    const run: AgentTeamRun = {
      id: uuidv4(),
      teamId: request.teamId,
      rootTaskId: request.rootTaskId,
      status: request.status ?? "pending",
      startedAt: request.startedAt ?? now,
      completedAt: undefined,
      error: undefined,
      summary: undefined,
      phase: isCollabOrMultiLlm ? "dispatch" : undefined,
      collaborativeMode: request.collaborativeMode ?? false,
      multiLlmMode: request.multiLlmMode ?? false,
    };

    const stmt = this.db.prepare(`
      INSERT INTO agent_team_runs (
        id, team_id, root_task_id, status, started_at, completed_at, error, summary,
        phase, collaborative_mode, multi_llm_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      run.id,
      run.teamId,
      run.rootTaskId,
      run.status,
      run.startedAt,
      null,
      null,
      null,
      run.phase || null,
      run.collaborativeMode ? 1 : 0,
      run.multiLlmMode ? 1 : 0,
    );

    return run;
  }

  /**
   * Find a run by ID.
   */
  findById(id: string): AgentTeamRun | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_team_runs WHERE id = ?");
    const row = stmt.get(id) as any;
    return row ? this.mapRowToRun(row) : undefined;
  }

  /**
   * Find the most recent run for a given root task.
   */
  findByRootTaskId(rootTaskId: string): AgentTeamRun | undefined {
    const stmt = this.db.prepare(`
      SELECT *
      FROM agent_team_runs
      WHERE root_task_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const row = stmt.get(rootTaskId) as any;
    return row ? this.mapRowToRun(row) : undefined;
  }

  /**
   * List runs for a team.
   */
  listByTeam(teamId: string, limit?: number): AgentTeamRun[] {
    let sql = `
      SELECT *
      FROM agent_team_runs
      WHERE team_id = ?
      ORDER BY started_at DESC
    `;
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(teamId) as any[];
    return rows.map((row) => this.mapRowToRun(row));
  }

  /**
   * Update a run's mutable fields (status, completedAt, error, summary).
   *
   * If status transitions into a terminal state (completed/failed/cancelled) and
   * completedAt is not provided, completedAt is set to now.
   */
  update(
    id: string,
    updates: {
      status?: AgentTeamRunStatus;
      completedAt?: number | null;
      error?: string | null;
      summary?: string | null;
      phase?: AgentTeamRunPhase;
    },
  ): AgentTeamRun | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }

    let completedAt: number | null | undefined = updates.completedAt;
    if (
      updates.status !== undefined &&
      (updates.status === "completed" ||
        updates.status === "failed" ||
        updates.status === "cancelled") &&
      updates.completedAt === undefined
    ) {
      completedAt = Date.now();
    }

    if (completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(completedAt);
    }

    if (updates.error !== undefined) {
      fields.push("error = ?");
      values.push(updates.error);
    }

    if (updates.summary !== undefined) {
      fields.push("summary = ?");
      values.push(updates.summary);
    }

    if (updates.phase !== undefined) {
      fields.push("phase = ?");
      values.push(updates.phase);
    }

    if (fields.length === 0) return existing;

    values.push(id);

    const sql = `UPDATE agent_team_runs SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    return this.findById(id);
  }

  /**
   * Delete a run by ID.
   */
  delete(id: string): boolean {
    const deleteTx = this.db.transaction((runId: string) => {
      // Manual cascade: foreign keys may not be enforced.
      this.db.prepare("DELETE FROM agent_team_thoughts WHERE team_run_id = ?").run(runId);
      this.db.prepare("DELETE FROM agent_team_items WHERE team_run_id = ?").run(runId);
      const result = this.db.prepare("DELETE FROM agent_team_runs WHERE id = ?").run(runId);
      return result.changes > 0;
    });

    return deleteTx(id);
  }

  private mapRowToRun(row: any): AgentTeamRun {
    return {
      id: row.id,
      teamId: row.team_id,
      rootTaskId: row.root_task_id,
      status: row.status as AgentTeamRunStatus,
      startedAt: row.started_at,
      completedAt: row.completed_at || undefined,
      error: row.error || undefined,
      summary: row.summary || undefined,
      phase: (row.phase as AgentTeamRunPhase) || undefined,
      collaborativeMode: row.collaborative_mode === 1,
      multiLlmMode: row.multi_llm_mode === 1,
    };
  }
}
