import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  AgentTeamMember,
  CreateAgentTeamMemberRequest,
  UpdateAgentTeamMemberRequest,
} from "../../shared/types";

/**
 * Repository for managing agent team members (teammates) in the database.
 */
export class AgentTeamMemberRepository {
  constructor(private db: Database.Database) {}

  /**
   * Add a member to a team.
   * If the member already exists (UNIQUE(team_id, agent_role_id)), returns the existing record.
   */
  add(request: CreateAgentTeamMemberRequest): AgentTeamMember {
    const existing = this.findByTeamAndRole(request.teamId, request.agentRoleId);
    if (existing) return existing;

    const now = Date.now();
    const member: AgentTeamMember = {
      id: uuidv4(),
      teamId: request.teamId,
      agentRoleId: request.agentRoleId,
      memberOrder: request.memberOrder ?? 0,
      isRequired: request.isRequired ?? false,
      roleGuidance: request.roleGuidance,
      createdAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO agent_team_members (
        id, team_id, agent_role_id, member_order, is_required, role_guidance, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      member.id,
      member.teamId,
      member.agentRoleId,
      member.memberOrder,
      member.isRequired ? 1 : 0,
      member.roleGuidance || null,
      member.createdAt,
    );

    return member;
  }

  /**
   * Find a member by ID.
   */
  findById(id: string): AgentTeamMember | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_team_members WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToMember(row) : undefined;
  }

  /**
   * Find a team member by team + agent role.
   */
  findByTeamAndRole(teamId: string, agentRoleId: string): AgentTeamMember | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM agent_team_members WHERE team_id = ? AND agent_role_id = ?",
    );
    const row = stmt.get(teamId, agentRoleId) as Any;
    return row ? this.mapRowToMember(row) : undefined;
  }

  /**
   * List members for a team ordered by member_order.
   */
  listByTeam(teamId: string): AgentTeamMember[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM agent_team_members
      WHERE team_id = ?
      ORDER BY member_order ASC, created_at ASC
    `);
    const rows = stmt.all(teamId) as Any[];
    return rows.map((row) => this.mapRowToMember(row));
  }

  /**
   * Update an existing team member.
   */
  update(request: UpdateAgentTeamMemberRequest): AgentTeamMember | undefined {
    const existing = this.findById(request.id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: Any[] = [];

    if (request.memberOrder !== undefined) {
      fields.push("member_order = ?");
      values.push(request.memberOrder);
    }
    if (request.isRequired !== undefined) {
      fields.push("is_required = ?");
      values.push(request.isRequired ? 1 : 0);
    }
    if (request.roleGuidance !== undefined) {
      fields.push("role_guidance = ?");
      values.push(request.roleGuidance);
    }

    if (fields.length === 0) return existing;

    values.push(request.id);

    const sql = `UPDATE agent_team_members SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    return this.findById(request.id);
  }

  /**
   * Remove a member by ID.
   */
  remove(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM agent_team_members WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Remove a member by team + agent role.
   */
  removeByTeamAndRole(teamId: string, agentRoleId: string): boolean {
    const stmt = this.db.prepare(
      "DELETE FROM agent_team_members WHERE team_id = ? AND agent_role_id = ?",
    );
    const result = stmt.run(teamId, agentRoleId);
    return result.changes > 0;
  }

  /**
   * Delete all members for a team.
   */
  deleteByTeam(teamId: string): number {
    const stmt = this.db.prepare("DELETE FROM agent_team_members WHERE team_id = ?");
    const result = stmt.run(teamId);
    return result.changes;
  }

  /**
   * Reorder members for a team by setting member_order based on the provided IDs.
   * Returns the updated list ordered by member_order.
   */
  reorder(teamId: string, orderedMemberIds: string[]): AgentTeamMember[] {
    const current = this.listByTeam(teamId);
    if (current.length === 0) return [];

    const byId = new Map(current.map((m) => [m.id, m]));
    const filtered = orderedMemberIds.filter((id) => byId.has(id));

    // Preserve any missing members at the end in their existing order.
    const missing = current.filter((m) => !filtered.includes(m.id)).map((m) => m.id);
    const finalOrder = [...filtered, ...missing];

    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare(
        "UPDATE agent_team_members SET member_order = ? WHERE id = ? AND team_id = ?",
      );
      finalOrder.forEach((id, index) => {
        // Use gaps to allow future inserts without full reindex.
        stmt.run((index + 1) * 10, id, teamId);
      });
    });

    tx();
    return this.listByTeam(teamId);
  }

  private mapRowToMember(row: Any): AgentTeamMember {
    return {
      id: row.id,
      teamId: row.team_id,
      agentRoleId: row.agent_role_id,
      memberOrder: row.member_order,
      isRequired: row.is_required === 1,
      roleGuidance: row.role_guidance || undefined,
      createdAt: row.created_at,
    };
  }
}
