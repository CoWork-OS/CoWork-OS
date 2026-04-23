import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  ManagedAgent,
  ManagedAgentVersion,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionEvent,
} from "../../shared/types";

function safeJsonParse<T>(jsonString: string | null | undefined, defaultValue: T): T {
  if (!jsonString) return defaultValue;
  try {
    return JSON.parse(jsonString) as T;
  } catch {
    return defaultValue;
  }
}

export class ManagedAgentRepository {
  constructor(private db: Database.Database) {}

  create(input: Omit<ManagedAgent, "createdAt" | "updatedAt">): ManagedAgent {
    const now = Date.now();
    const agent: ManagedAgent = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `
        INSERT INTO managed_agents (
          id, name, description, status, current_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        agent.id,
        agent.name,
        agent.description || null,
        agent.status,
        agent.currentVersion,
        agent.createdAt,
        agent.updatedAt,
      );

    return agent;
  }

  update(
    id: string,
    updates: Partial<Pick<ManagedAgent, "name" | "description" | "status" | "currentVersion">>,
  ): ManagedAgent | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: Any[] = [];
    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description || null);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.currentVersion !== undefined) {
      fields.push("current_version = ?");
      values.push(updates.currentVersion);
    }
    if (fields.length === 0) return existing;
    fields.push("updated_at = ?");
    values.push(Date.now(), id);

    this.db.prepare(`UPDATE managed_agents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  findById(id: string): ManagedAgent | undefined {
    const row = this.db.prepare("SELECT * FROM managed_agents WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(params?: { limit?: number; offset?: number; status?: ManagedAgent["status"] }): ManagedAgent[] {
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : 100;
    const offset =
      typeof params?.offset === "number" && Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset)) : 0;
    if (params?.status) {
      const rows = this.db
        .prepare(
          `
          SELECT * FROM managed_agents
          WHERE status = ?
          ORDER BY updated_at DESC, created_at DESC
          LIMIT ? OFFSET ?
        `,
        )
        .all(params.status, limit, offset) as Any[];
      return rows.map((row) => this.mapRow(row));
    }
    const rows = this.db
      .prepare(
        `
        SELECT * FROM managed_agents
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(limit, offset) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Any): ManagedAgent {
    return {
      id: String(row.id ?? ""),
      name: String(row.name ?? ""),
      description: row.description ? String(row.description) : undefined,
      status: String(row.status ?? "active") as ManagedAgent["status"],
      currentVersion: Number(row.current_version ?? 1),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }
}

export class ManagedAgentVersionRepository {
  constructor(private db: Database.Database) {}

  create(input: ManagedAgentVersion): ManagedAgentVersion {
    this.db
      .prepare(
        `
        INSERT INTO managed_agent_versions (
          agent_id, version, model_json, system_prompt, execution_mode, runtime_defaults_json,
          skills_json, mcp_servers_json, team_template_json, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.agentId,
        input.version,
        input.model ? JSON.stringify(input.model) : null,
        input.systemPrompt,
        input.executionMode,
        input.runtimeDefaults ? JSON.stringify(input.runtimeDefaults) : null,
        input.skills ? JSON.stringify(input.skills) : null,
        input.mcpServers ? JSON.stringify(input.mcpServers) : null,
        input.teamTemplate ? JSON.stringify(input.teamTemplate) : null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.createdAt,
      );
    return input;
  }

  find(agentId: string, version: number): ManagedAgentVersion | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM managed_agent_versions WHERE agent_id = ? AND version = ?",
      )
      .get(agentId, version) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(agentId: string): ManagedAgentVersion[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM managed_agent_versions
        WHERE agent_id = ?
        ORDER BY version DESC
      `,
      )
      .all(agentId) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  updateMetadata(
    agentId: string,
    version: number,
    metadata: Record<string, unknown> | undefined,
  ): ManagedAgentVersion | undefined {
    this.db
      .prepare(
        `
        UPDATE managed_agent_versions
        SET metadata_json = ?
        WHERE agent_id = ? AND version = ?
      `,
      )
      .run(metadata ? JSON.stringify(metadata) : null, agentId, version);
    return this.find(agentId, version);
  }

  private mapRow(row: Any): ManagedAgentVersion {
    return {
      agentId: String(row.agent_id ?? ""),
      version: Number(row.version ?? 1),
      model: safeJsonParse(row.model_json, undefined),
      systemPrompt: String(row.system_prompt ?? ""),
      executionMode: String(row.execution_mode ?? "solo") as ManagedAgentVersion["executionMode"],
      runtimeDefaults: safeJsonParse(row.runtime_defaults_json, undefined),
      skills: safeJsonParse(row.skills_json, undefined),
      mcpServers: safeJsonParse(row.mcp_servers_json, undefined),
      teamTemplate: safeJsonParse(row.team_template_json, undefined),
      metadata: safeJsonParse(row.metadata_json, undefined),
      createdAt: Number(row.created_at ?? 0),
    };
  }
}

export class ManagedEnvironmentRepository {
  constructor(private db: Database.Database) {}

  create(input: Omit<ManagedEnvironment, "createdAt" | "updatedAt">): ManagedEnvironment {
    const now = Date.now();
    const environment: ManagedEnvironment = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `
        INSERT INTO managed_environments (
          id, name, kind, revision, status, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        environment.id,
        environment.name,
        environment.kind,
        environment.revision,
        environment.status,
        JSON.stringify(environment.config),
        environment.createdAt,
        environment.updatedAt,
      );

    return environment;
  }

  update(
    id: string,
    updates: Partial<Pick<ManagedEnvironment, "name" | "status" | "revision" | "config">>,
  ): ManagedEnvironment | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: Any[] = [];
    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.revision !== undefined) {
      fields.push("revision = ?");
      values.push(updates.revision);
    }
    if (updates.config !== undefined) {
      fields.push("config_json = ?");
      values.push(JSON.stringify(updates.config));
    }
    if (fields.length === 0) return existing;
    fields.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db
      .prepare(`UPDATE managed_environments SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.findById(id);
  }

  findById(id: string): ManagedEnvironment | undefined {
    const row = this.db.prepare("SELECT * FROM managed_environments WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(params?: {
    limit?: number;
    offset?: number;
    status?: ManagedEnvironment["status"];
  }): ManagedEnvironment[] {
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : 100;
    const offset =
      typeof params?.offset === "number" && Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset)) : 0;
    if (params?.status) {
      const rows = this.db
        .prepare(
          `
          SELECT * FROM managed_environments
          WHERE status = ?
          ORDER BY updated_at DESC, created_at DESC
          LIMIT ? OFFSET ?
        `,
        )
        .all(params.status, limit, offset) as Any[];
      return rows.map((row) => this.mapRow(row));
    }
    const rows = this.db
      .prepare(
        `
        SELECT * FROM managed_environments
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(limit, offset) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Any): ManagedEnvironment {
    return {
      id: String(row.id ?? ""),
      name: String(row.name ?? ""),
      kind: String(row.kind ?? "cowork_local") as ManagedEnvironment["kind"],
      revision: Number(row.revision ?? 1),
      status: String(row.status ?? "active") as ManagedEnvironment["status"],
      config: safeJsonParse(row.config_json, { workspaceId: "" }),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }
}

export class ManagedSessionRepository {
  constructor(private db: Database.Database) {}

  create(input: Omit<ManagedSession, "createdAt" | "updatedAt">): ManagedSession {
    const now = Date.now();
    const session: ManagedSession = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `
        INSERT INTO managed_sessions (
          id, agent_id, agent_version, environment_id, title, status, workspace_id,
          backing_task_id, backing_team_run_id, resumed_from_session_id, latest_summary,
          created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        session.id,
        session.agentId,
        session.agentVersion,
        session.environmentId,
        session.title,
        session.status,
        session.workspaceId,
        session.backingTaskId || null,
        session.backingTeamRunId || null,
        session.resumedFromSessionId || null,
        session.latestSummary || null,
        session.createdAt,
        session.updatedAt,
        session.startedAt || null,
        session.completedAt || null,
      );
    return session;
  }

  update(
    id: string,
    updates: Partial<
      Pick<
        ManagedSession,
        | "status"
        | "backingTaskId"
        | "backingTeamRunId"
        | "resumedFromSessionId"
        | "latestSummary"
        | "startedAt"
        | "completedAt"
        | "title"
      >
    >,
  ): ManagedSession | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: Any[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      const dbKey = key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
      fields.push(`${dbKey} = ?`);
      values.push(value ?? null);
    }
    if (fields.length === 0) return existing;
    fields.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE managed_sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  findById(id: string): ManagedSession | undefined {
    const row = this.db.prepare("SELECT * FROM managed_sessions WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findByBackingTaskId(taskId: string): ManagedSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM managed_sessions WHERE backing_task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(params?: {
    limit?: number;
    offset?: number;
    workspaceId?: string;
    status?: ManagedSession["status"];
  }): ManagedSession[] {
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : 100;
    const offset =
      typeof params?.offset === "number" && Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset)) : 0;
    const where: string[] = [];
    const values: Any[] = [];
    if (params?.workspaceId) {
      where.push("workspace_id = ?");
      values.push(params.workspaceId);
    }
    if (params?.status) {
      where.push("status = ?");
      values.push(params.status);
    }
    const sql = `
      SELECT * FROM managed_sessions
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(sql).all(...values, limit, offset) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Any): ManagedSession {
    return {
      id: String(row.id ?? ""),
      agentId: String(row.agent_id ?? ""),
      agentVersion: Number(row.agent_version ?? 1),
      environmentId: String(row.environment_id ?? ""),
      title: String(row.title ?? ""),
      status: String(row.status ?? "pending") as ManagedSession["status"],
      workspaceId: String(row.workspace_id ?? ""),
      backingTaskId: row.backing_task_id ? String(row.backing_task_id) : undefined,
      backingTeamRunId: row.backing_team_run_id ? String(row.backing_team_run_id) : undefined,
      resumedFromSessionId: row.resumed_from_session_id ? String(row.resumed_from_session_id) : undefined,
      latestSummary: row.latest_summary ? String(row.latest_summary) : undefined,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      startedAt: row.started_at ? Number(row.started_at) : undefined,
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
    };
  }
}

export class ManagedSessionEventRepository {
  constructor(private db: Database.Database) {}

  create(
    input: Omit<ManagedSessionEvent, "id" | "seq"> & {
      id?: string;
      seq?: number;
      sourceTaskId?: string;
      sourceTaskEventId?: string;
    },
  ): ManagedSessionEvent {
    const id = input.id || uuidv4();
    const seq = input.seq ?? this.getNextSeq(input.sessionId);
    const timestamp =
      typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
        ? Math.floor(input.timestamp)
        : Date.now();
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO managed_session_events (
          id, session_id, seq, timestamp, type, payload_json, source_task_id, source_task_event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.sessionId,
        seq,
        timestamp,
        input.type,
        JSON.stringify(input.payload),
        input.sourceTaskId || null,
        input.sourceTaskEventId || null,
        Date.now(),
      );
    const stored = this.findById(id);
    if (stored) return stored;
    return {
      id,
      sessionId: input.sessionId,
      seq,
      timestamp,
      type: input.type,
      payload: input.payload,
    };
  }

  findById(id: string): ManagedSessionEvent | undefined {
    const row = this.db.prepare("SELECT * FROM managed_session_events WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  listBySessionId(sessionId: string, limit = 500): ManagedSessionEvent[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM managed_session_events
        WHERE session_id = ?
        ORDER BY seq ASC
        LIMIT ?
      `,
      )
      .all(sessionId, Math.max(1, Math.floor(limit))) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  hasSourceTaskEvent(sessionId: string, sourceTaskEventId: string): boolean {
    const row = this.db
      .prepare(
        `
        SELECT 1
        FROM managed_session_events
        WHERE session_id = ? AND source_task_event_id = ?
        LIMIT 1
      `,
      )
      .get(sessionId, sourceTaskEventId);
    return Boolean(row);
  }

  private getNextSeq(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM managed_session_events WHERE session_id = ?")
      .get(sessionId) as Any;
    return Number(row?.max_seq ?? 0) + 1;
  }

  private mapRow(row: Any): ManagedSessionEvent {
    return {
      id: String(row.id ?? ""),
      sessionId: String(row.session_id ?? ""),
      seq: Number(row.seq ?? 0),
      timestamp: Number(row.timestamp ?? 0),
      type: String(row.type ?? "task.event.bridge") as ManagedSessionEvent["type"],
      payload: safeJsonParse(row.payload_json, {}),
    };
  }
}
