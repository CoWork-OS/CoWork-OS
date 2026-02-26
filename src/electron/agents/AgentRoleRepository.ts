import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  AgentRole,
  CreateAgentRoleRequest,
  UpdateAgentRoleRequest,
  AgentCapability,
  AgentToolRestrictions,
  AgentAutonomyLevel,
  HeartbeatStatus,
  HeartbeatConfig,
  DEFAULT_AGENT_ROLES,
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
 * Repository for managing agent roles in the database
 */
export class AgentRoleRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new agent role
   */
  create(request: CreateAgentRoleRequest): AgentRole {
    const now = Date.now();
    const role: AgentRole = {
      id: uuidv4(),
      name: request.name,
      displayName: request.displayName,
      description: request.description,
      icon: request.icon || "🤖",
      color: request.color || "#6366f1",
      personalityId: request.personalityId,
      modelKey: request.modelKey,
      providerType: request.providerType,
      systemPrompt: request.systemPrompt,
      capabilities: request.capabilities,
      toolRestrictions: request.toolRestrictions,
      isSystem: false,
      isActive: true,
      sortOrder: 100,
      createdAt: now,
      updatedAt: now,
      // Mission Control fields
      autonomyLevel: request.autonomyLevel || "specialist",
      soul: request.soul,
      heartbeatEnabled: request.heartbeatEnabled || false,
      heartbeatIntervalMinutes: request.heartbeatIntervalMinutes || 15,
      heartbeatStaggerOffset: request.heartbeatStaggerOffset || 0,
      heartbeatStatus: "idle",
    };

    const stmt = this.db.prepare(`
      INSERT INTO agent_roles (
        id, name, display_name, description, icon, color,
        personality_id, model_key, provider_type, system_prompt,
        capabilities, tool_restrictions, is_system, is_active,
        sort_order, created_at, updated_at,
        autonomy_level, soul, heartbeat_enabled, heartbeat_interval_minutes,
        heartbeat_stagger_offset, heartbeat_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      role.id,
      role.name,
      role.displayName,
      role.description || null,
      role.icon,
      role.color,
      role.personalityId || null,
      role.modelKey || null,
      role.providerType || null,
      role.systemPrompt || null,
      JSON.stringify(role.capabilities),
      role.toolRestrictions ? JSON.stringify(role.toolRestrictions) : null,
      role.isSystem ? 1 : 0,
      role.isActive ? 1 : 0,
      role.sortOrder,
      role.createdAt,
      role.updatedAt,
      role.autonomyLevel,
      role.soul || null,
      role.heartbeatEnabled ? 1 : 0,
      role.heartbeatIntervalMinutes,
      role.heartbeatStaggerOffset,
      role.heartbeatStatus,
    );

    return role;
  }

  /**
   * Find an agent role by ID
   */
  findById(id: string): AgentRole | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_roles WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToAgentRole(row) : undefined;
  }

  /**
   * Find an agent role by name
   */
  findByName(name: string): AgentRole | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_roles WHERE name = ?");
    const row = stmt.get(name) as Any;
    return row ? this.mapRowToAgentRole(row) : undefined;
  }

  /**
   * Find all agent roles
   */
  findAll(includeInactive = false): AgentRole[] {
    const stmt = includeInactive
      ? this.db.prepare("SELECT * FROM agent_roles ORDER BY sort_order ASC, created_at ASC")
      : this.db.prepare(
          "SELECT * FROM agent_roles WHERE is_active = 1 ORDER BY sort_order ASC, created_at ASC",
        );
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToAgentRole(row));
  }

  /**
   * Find all active agent roles
   */
  findActive(): AgentRole[] {
    return this.findAll(false);
  }

  /**
   * Update an agent role
   */
  update(request: UpdateAgentRoleRequest): AgentRole | undefined {
    const existing = this.findById(request.id);
    if (!existing) {
      return undefined;
    }

    // Don't allow updating system roles' core properties
    if (existing.isSystem && (request.capabilities || request.toolRestrictions)) {
      console.warn("Cannot modify capabilities or tool restrictions of system agent roles");
    }

    const fields: string[] = [];
    const values: Any[] = [];

    if (request.displayName !== undefined) {
      fields.push("display_name = ?");
      values.push(request.displayName);
    }
    if (request.description !== undefined) {
      fields.push("description = ?");
      values.push(request.description);
    }
    if (request.icon !== undefined) {
      fields.push("icon = ?");
      values.push(request.icon);
    }
    if (request.color !== undefined) {
      fields.push("color = ?");
      values.push(request.color);
    }
    if (request.personalityId !== undefined) {
      fields.push("personality_id = ?");
      values.push(request.personalityId);
    }
    if (request.modelKey !== undefined) {
      fields.push("model_key = ?");
      values.push(request.modelKey);
    }
    if (request.providerType !== undefined) {
      fields.push("provider_type = ?");
      values.push(request.providerType);
    }
    if (request.systemPrompt !== undefined) {
      fields.push("system_prompt = ?");
      values.push(request.systemPrompt);
    }
    if (request.capabilities !== undefined && !existing.isSystem) {
      fields.push("capabilities = ?");
      values.push(JSON.stringify(request.capabilities));
    }
    if (request.toolRestrictions !== undefined && !existing.isSystem) {
      fields.push("tool_restrictions = ?");
      values.push(request.toolRestrictions ? JSON.stringify(request.toolRestrictions) : null);
    }
    if (request.isActive !== undefined) {
      fields.push("is_active = ?");
      values.push(request.isActive ? 1 : 0);
    }
    if (request.sortOrder !== undefined) {
      fields.push("sort_order = ?");
      values.push(request.sortOrder);
    }
    // Mission Control fields
    if (request.autonomyLevel !== undefined) {
      fields.push("autonomy_level = ?");
      values.push(request.autonomyLevel);
    }
    if (request.soul !== undefined) {
      fields.push("soul = ?");
      values.push(request.soul);
    }
    if (request.heartbeatEnabled !== undefined) {
      fields.push("heartbeat_enabled = ?");
      values.push(request.heartbeatEnabled ? 1 : 0);
    }
    if (request.heartbeatIntervalMinutes !== undefined) {
      fields.push("heartbeat_interval_minutes = ?");
      values.push(request.heartbeatIntervalMinutes);
    }
    if (request.heartbeatStaggerOffset !== undefined) {
      fields.push("heartbeat_stagger_offset = ?");
      values.push(request.heartbeatStaggerOffset);
    }

    if (fields.length === 0) {
      return existing;
    }

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(request.id);

    const sql = `UPDATE agent_roles SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    return this.findById(request.id);
  }

  /**
   * Delete an agent role (only non-system roles)
   */
  delete(id: string): boolean {
    const existing = this.findById(id);
    if (!existing) {
      return false;
    }
    if (existing.isSystem) {
      console.warn("Cannot delete system agent roles");
      return false;
    }

    const stmt = this.db.prepare("DELETE FROM agent_roles WHERE id = ? AND is_system = 0");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Seed default agent roles if none exist
   */
  seedDefaults(): AgentRole[] {
    const existing = this.findAll(true);
    if (existing.length > 0) {
      return existing;
    }

    const seeded: AgentRole[] = [];
    const now = Date.now();

    for (const defaultRole of DEFAULT_AGENT_ROLES) {
      const role: AgentRole = {
        id: uuidv4(),
        ...defaultRole,
        createdAt: now,
        updatedAt: now,
        // Ensure Mission Control fields have defaults
        heartbeatEnabled: false,
        heartbeatIntervalMinutes: 15,
        heartbeatStaggerOffset: 0,
        heartbeatStatus: "idle",
      };

      const stmt = this.db.prepare(`
        INSERT INTO agent_roles (
          id, name, display_name, description, icon, color,
          personality_id, model_key, provider_type, system_prompt,
          capabilities, tool_restrictions, is_system, is_active,
          sort_order, created_at, updated_at,
          autonomy_level, heartbeat_enabled, heartbeat_interval_minutes,
          heartbeat_stagger_offset, heartbeat_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        role.id,
        role.name,
        role.displayName,
        role.description || null,
        role.icon,
        role.color,
        role.personalityId || null,
        role.modelKey || null,
        role.providerType || null,
        role.systemPrompt || null,
        JSON.stringify(role.capabilities),
        role.toolRestrictions ? JSON.stringify(role.toolRestrictions) : null,
        role.isSystem ? 1 : 0,
        role.isActive ? 1 : 0,
        role.sortOrder,
        role.createdAt,
        role.updatedAt,
        role.autonomyLevel || "specialist",
        role.heartbeatEnabled ? 1 : 0,
        role.heartbeatIntervalMinutes,
        role.heartbeatStaggerOffset,
        role.heartbeatStatus,
      );

      seeded.push(role);
    }

    return seeded;
  }

  /**
   * Check if any agent roles exist
   */
  hasAny(): boolean {
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM agent_roles");
    const result = stmt.get() as { count: number };
    return result.count > 0;
  }

  /**
   * Sync new default agents to existing workspace
   * This adds any missing default agents without overwriting existing ones
   */
  syncNewDefaults(): AgentRole[] {
    const existing = this.findAll(true);
    const existingNames = new Set(existing.map((a) => a.name));
    const added: AgentRole[] = [];
    const now = Date.now();

    for (const defaultRole of DEFAULT_AGENT_ROLES) {
      // Skip if already exists
      if (existingNames.has(defaultRole.name)) {
        continue;
      }

      const role: AgentRole = {
        id: uuidv4(),
        ...defaultRole,
        createdAt: now,
        updatedAt: now,
        heartbeatEnabled: false,
        heartbeatIntervalMinutes: 15,
        heartbeatStaggerOffset: 0,
        heartbeatStatus: "idle",
      };

      const stmt = this.db.prepare(`
        INSERT INTO agent_roles (
          id, name, display_name, description, icon, color,
          personality_id, model_key, provider_type, system_prompt,
          capabilities, tool_restrictions, is_system, is_active,
          sort_order, created_at, updated_at,
          autonomy_level, heartbeat_enabled, heartbeat_interval_minutes,
          heartbeat_stagger_offset, heartbeat_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        role.id,
        role.name,
        role.displayName,
        role.description || null,
        role.icon,
        role.color,
        role.personalityId || null,
        role.modelKey || null,
        role.providerType || null,
        role.systemPrompt || null,
        JSON.stringify(role.capabilities),
        role.toolRestrictions ? JSON.stringify(role.toolRestrictions) : null,
        role.isSystem ? 1 : 0,
        role.isActive ? 1 : 0,
        role.sortOrder,
        role.createdAt,
        role.updatedAt,
        role.autonomyLevel || "specialist",
        role.heartbeatEnabled ? 1 : 0,
        role.heartbeatIntervalMinutes,
        role.heartbeatStaggerOffset,
        role.heartbeatStatus,
      );

      added.push(role);
      console.log(`[AgentRoleRepository] Added new default agent: ${role.displayName}`);
    }

    if (added.length > 0) {
      console.log(`[AgentRoleRepository] Synced ${added.length} new default agent(s)`);
    }

    return added;
  }

  /**
   * Map database row to AgentRole object
   */
  private mapRowToAgentRole(row: Any): AgentRole {
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      description: row.description || undefined,
      icon: row.icon || "🤖",
      color: row.color || "#6366f1",
      personalityId: row.personality_id || undefined,
      modelKey: row.model_key || undefined,
      providerType: row.provider_type || undefined,
      systemPrompt: row.system_prompt || undefined,
      capabilities: safeJsonParse<AgentCapability[]>(
        row.capabilities,
        [],
        "agentRole.capabilities",
      ),
      toolRestrictions: safeJsonParse<AgentToolRestrictions | undefined>(
        row.tool_restrictions,
        undefined,
        "agentRole.toolRestrictions",
      ),
      isSystem: row.is_system === 1,
      isActive: row.is_active === 1,
      sortOrder: row.sort_order || 100,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Mission Control fields
      autonomyLevel: (row.autonomy_level as AgentAutonomyLevel) || "specialist",
      soul: row.soul || undefined,
      heartbeatEnabled: row.heartbeat_enabled === 1,
      heartbeatIntervalMinutes: row.heartbeat_interval_minutes || 15,
      heartbeatStaggerOffset: row.heartbeat_stagger_offset || 0,
      lastHeartbeatAt: row.last_heartbeat_at || undefined,
      heartbeatStatus: (row.heartbeat_status as HeartbeatStatus) || "idle",
    };
  }

  // ============ Mission Control Methods ============

  /**
   * Find all agents with heartbeat enabled
   */
  findHeartbeatEnabled(): AgentRole[] {
    const stmt = this.db.prepare(
      "SELECT * FROM agent_roles WHERE heartbeat_enabled = 1 AND is_active = 1 ORDER BY sort_order ASC",
    );
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToAgentRole(row));
  }

  /**
   * Update heartbeat configuration for an agent
   */
  updateHeartbeatConfig(id: string, config: HeartbeatConfig): AgentRole | undefined {
    const existing = this.findById(id);
    if (!existing) {
      return undefined;
    }

    const fields: string[] = [];
    const values: Any[] = [];

    if (config.heartbeatEnabled !== undefined) {
      fields.push("heartbeat_enabled = ?");
      values.push(config.heartbeatEnabled ? 1 : 0);
    }
    if (config.heartbeatIntervalMinutes !== undefined) {
      fields.push("heartbeat_interval_minutes = ?");
      values.push(config.heartbeatIntervalMinutes);
    }
    if (config.heartbeatStaggerOffset !== undefined) {
      fields.push("heartbeat_stagger_offset = ?");
      values.push(config.heartbeatStaggerOffset);
    }

    if (fields.length === 0) {
      return existing;
    }

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    const sql = `UPDATE agent_roles SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    return this.findById(id);
  }

  /**
   * Update heartbeat status for an agent
   */
  updateHeartbeatStatus(id: string, status: HeartbeatStatus, lastHeartbeatAt?: number): void {
    const fields = ["heartbeat_status = ?"];
    const values: Any[] = [status];

    if (lastHeartbeatAt !== undefined) {
      fields.push("last_heartbeat_at = ?");
      values.push(lastHeartbeatAt);
    }

    values.push(id);
    const sql = `UPDATE agent_roles SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
  }

  /**
   * Update soul (extended personality) for an agent
   */
  updateSoul(id: string, soul: string): AgentRole | undefined {
    const existing = this.findById(id);
    if (!existing) {
      return undefined;
    }

    const stmt = this.db.prepare("UPDATE agent_roles SET soul = ?, updated_at = ? WHERE id = ?");
    stmt.run(soul, Date.now(), id);

    return this.findById(id);
  }

  /**
   * Update autonomy level for an agent
   */
  updateAutonomyLevel(id: string, level: AgentAutonomyLevel): AgentRole | undefined {
    const existing = this.findById(id);
    if (!existing) {
      return undefined;
    }

    const stmt = this.db.prepare(
      "UPDATE agent_roles SET autonomy_level = ?, updated_at = ? WHERE id = ?",
    );
    stmt.run(level, Date.now(), id);

    return this.findById(id);
  }

  /**
   * Get agents by autonomy level
   */
  findByAutonomyLevel(level: AgentAutonomyLevel): AgentRole[] {
    const stmt = this.db.prepare(
      "SELECT * FROM agent_roles WHERE autonomy_level = ? AND is_active = 1 ORDER BY sort_order ASC",
    );
    const rows = stmt.all(level) as Any[];
    return rows.map((row) => this.mapRowToAgentRole(row));
  }
}
