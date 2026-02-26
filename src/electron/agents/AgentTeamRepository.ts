import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { AgentTeam, CreateAgentTeamRequest, UpdateAgentTeamRequest } from "../../shared/types";

/**
 * Repository for managing agent teams (Team Lead + members) in the database.
 */
export class AgentTeamRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new agent team.
   *
   * Note: team names are unique within a workspace (UNIQUE(workspace_id, name)).
   */
  create(request: CreateAgentTeamRequest): AgentTeam {
    const now = Date.now();
    const team: AgentTeam = {
      id: uuidv4(),
      workspaceId: request.workspaceId,
      name: request.name,
      description: request.description,
      leadAgentRoleId: request.leadAgentRoleId,
      maxParallelAgents: request.maxParallelAgents ?? 4,
      defaultModelPreference: request.defaultModelPreference,
      defaultPersonality: request.defaultPersonality,
      isActive: request.isActive ?? true,
      persistent: request.persistent ?? false,
      defaultWorkspaceId: request.defaultWorkspaceId,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO agent_teams (
        id, workspace_id, name, description, lead_agent_role_id,
        max_parallel_agents, default_model_preference, default_personality,
        is_active, persistent, default_workspace_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      team.id,
      team.workspaceId,
      team.name,
      team.description || null,
      team.leadAgentRoleId,
      team.maxParallelAgents,
      team.defaultModelPreference || null,
      team.defaultPersonality || null,
      team.isActive ? 1 : 0,
      team.persistent ? 1 : 0,
      team.defaultWorkspaceId || null,
      team.createdAt,
      team.updatedAt,
    );

    return team;
  }

  /**
   * Find a team by ID.
   */
  findById(id: string): AgentTeam | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_teams WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToTeam(row) : undefined;
  }

  /**
   * Find a team by name within a workspace.
   */
  findByName(workspaceId: string, name: string): AgentTeam | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_teams WHERE workspace_id = ? AND name = ?");
    const row = stmt.get(workspaceId, name) as Any;
    return row ? this.mapRowToTeam(row) : undefined;
  }

  /**
   * List teams for a workspace.
   */
  listByWorkspace(workspaceId: string, includeInactive = false): AgentTeam[] {
    const stmt = includeInactive
      ? this.db.prepare("SELECT * FROM agent_teams WHERE workspace_id = ? ORDER BY name ASC")
      : this.db.prepare(
          "SELECT * FROM agent_teams WHERE workspace_id = ? AND is_active = 1 ORDER BY name ASC",
        );
    const rows = stmt.all(workspaceId) as Any[];
    return rows.map((row) => this.mapRowToTeam(row));
  }

  /**
   * Update a team.
   */
  update(request: UpdateAgentTeamRequest): AgentTeam | undefined {
    const existing = this.findById(request.id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: Any[] = [];

    if (request.name !== undefined) {
      fields.push("name = ?");
      values.push(request.name);
    }
    if (request.description !== undefined) {
      fields.push("description = ?");
      values.push(request.description);
    }
    if (request.leadAgentRoleId !== undefined) {
      fields.push("lead_agent_role_id = ?");
      values.push(request.leadAgentRoleId);
    }
    if (request.maxParallelAgents !== undefined) {
      fields.push("max_parallel_agents = ?");
      values.push(request.maxParallelAgents);
    }
    if (request.defaultModelPreference !== undefined) {
      fields.push("default_model_preference = ?");
      values.push(request.defaultModelPreference);
    }
    if (request.defaultPersonality !== undefined) {
      fields.push("default_personality = ?");
      values.push(request.defaultPersonality);
    }
    if (request.isActive !== undefined) {
      fields.push("is_active = ?");
      values.push(request.isActive ? 1 : 0);
    }
    if (request.persistent !== undefined) {
      fields.push("persistent = ?");
      values.push(request.persistent ? 1 : 0);
    }
    if (request.defaultWorkspaceId !== undefined) {
      fields.push("default_workspace_id = ?");
      values.push(request.defaultWorkspaceId);
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(request.id);

    const sql = `UPDATE agent_teams SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    return this.findById(request.id);
  }

  /**
   * Delete a team and its related records (members, runs, items).
   *
   * Note: the schema uses ON DELETE CASCADE in some places, but SQLite foreign
   * keys may not be enabled globally in this app; we perform a manual cascade
   * for correctness.
   */
  delete(id: string): boolean {
    const existing = this.findById(id);
    if (!existing) return false;

    const deleteTx = this.db.transaction((teamId: string) => {
      // Delete items for all runs in this team
      this.db
        .prepare(`
        DELETE FROM agent_team_items
        WHERE team_run_id IN (SELECT id FROM agent_team_runs WHERE team_id = ?)
      `)
        .run(teamId);

      // Delete runs
      this.db.prepare("DELETE FROM agent_team_runs WHERE team_id = ?").run(teamId);

      // Delete members
      this.db.prepare("DELETE FROM agent_team_members WHERE team_id = ?").run(teamId);

      // Delete team
      const result = this.db.prepare("DELETE FROM agent_teams WHERE id = ?").run(teamId);
      return result.changes > 0;
    });

    return deleteTx(id);
  }

  /**
   * List all persistent teams across all workspaces.
   */
  listPersistent(): AgentTeam[] {
    const stmt = this.db.prepare(
      "SELECT * FROM agent_teams WHERE persistent = 1 AND is_active = 1 ORDER BY name ASC",
    );
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToTeam(row));
  }

  private mapRowToTeam(row: Any): AgentTeam {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description || undefined,
      leadAgentRoleId: row.lead_agent_role_id,
      maxParallelAgents: row.max_parallel_agents,
      defaultModelPreference: row.default_model_preference || undefined,
      defaultPersonality: row.default_personality || undefined,
      isActive: row.is_active === 1,
      persistent: row.persistent === 1,
      defaultWorkspaceId: row.default_workspace_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
