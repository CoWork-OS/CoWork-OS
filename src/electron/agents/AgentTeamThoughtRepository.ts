import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { AgentThought, CreateAgentThoughtRequest, ThoughtPhase } from "../../shared/types";

/**
 * Repository for managing collaborative thoughts during team runs.
 * Each thought represents an agent's analysis or reasoning shared with the team.
 */
export class AgentTeamThoughtRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new thought within a team run.
   */
  create(request: CreateAgentThoughtRequest): AgentThought {
    const now = Date.now();
    const thought: AgentThought = {
      id: uuidv4(),
      teamRunId: request.teamRunId,
      teamItemId: request.teamItemId,
      agentRoleId: request.agentRoleId,
      agentDisplayName: request.agentDisplayName,
      agentIcon: request.agentIcon,
      agentColor: request.agentColor,
      phase: request.phase,
      content: request.content,
      isStreaming: request.isStreaming ?? false,
      sourceTaskId: request.sourceTaskId,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO agent_team_thoughts (
        id, team_run_id, team_item_id, agent_role_id,
        agent_display_name, agent_icon, agent_color,
        phase, content, is_streaming, source_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      thought.id,
      thought.teamRunId,
      thought.teamItemId || null,
      thought.agentRoleId,
      thought.agentDisplayName,
      thought.agentIcon,
      thought.agentColor,
      thought.phase,
      thought.content,
      thought.isStreaming ? 1 : 0,
      thought.sourceTaskId || null,
      thought.createdAt,
      thought.updatedAt,
    );

    return thought;
  }

  /**
   * Find a thought by ID.
   */
  findById(id: string): AgentThought | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_team_thoughts WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToThought(row) : undefined;
  }

  /**
   * List all thoughts for a team run, ordered by creation time.
   */
  listByRun(teamRunId: string): AgentThought[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM agent_team_thoughts
      WHERE team_run_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(teamRunId) as Any[];
    return rows.map((row) => this.mapRowToThought(row));
  }

  /**
   * List thoughts for a specific agent within a team run.
   */
  listByAgent(teamRunId: string, agentRoleId: string): AgentThought[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM agent_team_thoughts
      WHERE team_run_id = ? AND agent_role_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(teamRunId, agentRoleId) as Any[];
    return rows.map((row) => this.mapRowToThought(row));
  }

  /**
   * Update the content and streaming status of a thought.
   */
  updateContent(id: string, content: string, isStreaming: boolean): AgentThought | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;

    const stmt = this.db.prepare(`
      UPDATE agent_team_thoughts
      SET content = ?, is_streaming = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(content, isStreaming ? 1 : 0, Date.now(), id);

    return this.findById(id);
  }

  /**
   * Delete all thoughts for a team run.
   */
  deleteByRun(teamRunId: string): number {
    const stmt = this.db.prepare("DELETE FROM agent_team_thoughts WHERE team_run_id = ?");
    const result = stmt.run(teamRunId);
    return result.changes;
  }

  /**
   * List thoughts linked to a specific source task ID.
   */
  listBySourceTaskId(sourceTaskId: string): AgentThought[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM agent_team_thoughts
      WHERE source_task_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(sourceTaskId) as Any[];
    return rows.map((row) => this.mapRowToThought(row));
  }

  private mapRowToThought(row: Any): AgentThought {
    return {
      id: row.id,
      teamRunId: row.team_run_id,
      teamItemId: row.team_item_id || undefined,
      agentRoleId: row.agent_role_id,
      agentDisplayName: row.agent_display_name,
      agentIcon: row.agent_icon,
      agentColor: row.agent_color,
      phase: row.phase as ThoughtPhase,
      content: row.content,
      isStreaming: row.is_streaming === 1,
      sourceTaskId: row.source_task_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
