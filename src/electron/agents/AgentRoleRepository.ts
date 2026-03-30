import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  AgentRole,
  AgentRoleKind,
  CognitiveOffloadCategory,
  CreateAgentRoleRequest,
  HeartbeatPolicy,
  HeartbeatPolicyInput,
  UpdateAgentRoleRequest,
  AgentCapability,
  AgentToolRestrictions,
  AgentAutonomyLevel,
  HeartbeatStatus,
  HeartbeatConfig,
  HeartbeatProfile,
  HeartbeatActiveHours,
  DEFAULT_AGENT_ROLES,
} from "../../shared/types";
import { normalizeAgentRoleIcon } from "./agent-role-display";
import { HeartbeatPolicyRepository } from "./HeartbeatPolicyRepository";

type Any = any; // oxlint-disable-line typescript-eslint(no-explicit-any)

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

function defaultHeartbeatProfile(autonomyLevel?: AgentAutonomyLevel): HeartbeatProfile {
  if (autonomyLevel === "lead") return "dispatcher";
  if (autonomyLevel === "specialist") return "operator";
  return "observer";
}

function derivePulseEveryMinutes(
  requestedPulseEveryMinutes?: number,
  fallbackHeartbeatIntervalMinutes?: number,
): number {
  return requestedPulseEveryMinutes || fallbackHeartbeatIntervalMinutes || 15;
}

function deriveDispatchCooldownMinutes(
  autonomyLevel?: AgentAutonomyLevel,
  requestedCooldown?: number,
): number {
  if (requestedCooldown) return requestedCooldown;
  return autonomyLevel === "lead" ? 60 : 120;
}

function deriveMaxDispatchesPerDay(
  autonomyLevel?: AgentAutonomyLevel,
  requestedBudget?: number,
): number {
  if (requestedBudget) return requestedBudget;
  return autonomyLevel === "lead" ? 12 : 4;
}

function defaultRoleKind(isSystem: boolean): AgentRoleKind {
  return isSystem ? "system" : "custom";
}

function extractTemplateMetadata(soul?: string): {
  primaryCategories: CognitiveOffloadCategory[];
  proactiveTasks: unknown[];
  sourceTemplateId?: string;
  sourceTemplateVersion?: string;
} {
  if (!soul) {
    return { primaryCategories: [], proactiveTasks: [] };
  }
  try {
    const parsed = JSON.parse(soul) as Record<string, unknown>;
    const cognitiveOffload =
      parsed?.cognitiveOffload && typeof parsed.cognitiveOffload === "object"
        ? (parsed.cognitiveOffload as Record<string, unknown>)
        : null;
    return {
      primaryCategories: Array.isArray(cognitiveOffload?.primaryCategories)
        ? (cognitiveOffload?.primaryCategories as CognitiveOffloadCategory[])
        : [],
      proactiveTasks: Array.isArray(cognitiveOffload?.proactiveTasks)
        ? (cognitiveOffload?.proactiveTasks as unknown[])
        : [],
      sourceTemplateId:
        typeof parsed.sourceTemplateId === "string" ? parsed.sourceTemplateId : undefined,
      sourceTemplateVersion:
        typeof parsed.sourceTemplateVersion === "string" ? parsed.sourceTemplateVersion : undefined,
    };
  } catch {
    return { primaryCategories: [], proactiveTasks: [] };
  }
}

function derivePolicyInputFromLegacy(
  autonomyLevel: AgentAutonomyLevel | undefined,
  soul: string | undefined,
  input: {
    heartbeatPolicy?: HeartbeatPolicyInput;
    heartbeatEnabled?: boolean;
    heartbeatIntervalMinutes?: number;
    heartbeatStaggerOffset?: number;
    pulseEveryMinutes?: number;
    dispatchCooldownMinutes?: number;
    maxDispatchesPerDay?: number;
    heartbeatProfile?: HeartbeatProfile;
    activeHours?: HeartbeatActiveHours | null;
  },
): HeartbeatPolicyInput {
  const legacy = extractTemplateMetadata(soul);
  return {
    enabled: input.heartbeatPolicy?.enabled ?? input.heartbeatEnabled ?? false,
    cadenceMinutes:
      input.heartbeatPolicy?.cadenceMinutes ??
      input.pulseEveryMinutes ??
      input.heartbeatIntervalMinutes ??
      15,
    staggerOffsetMinutes:
      input.heartbeatPolicy?.staggerOffsetMinutes ?? input.heartbeatStaggerOffset ?? 0,
    dispatchCooldownMinutes:
      input.heartbeatPolicy?.dispatchCooldownMinutes ??
      input.dispatchCooldownMinutes ??
      deriveDispatchCooldownMinutes(autonomyLevel, undefined),
    maxDispatchesPerDay:
      input.heartbeatPolicy?.maxDispatchesPerDay ??
      input.maxDispatchesPerDay ??
      deriveMaxDispatchesPerDay(autonomyLevel, undefined),
    profile:
      input.heartbeatPolicy?.profile ??
      input.heartbeatProfile ??
      defaultHeartbeatProfile(autonomyLevel),
    activeHours:
      input.heartbeatPolicy && "activeHours" in input.heartbeatPolicy
        ? (input.heartbeatPolicy.activeHours ?? null)
        : (input.activeHours ?? null),
    primaryCategories: input.heartbeatPolicy?.primaryCategories ?? legacy.primaryCategories,
    proactiveTasks: input.heartbeatPolicy?.proactiveTasks ?? (legacy.proactiveTasks as Any[]),
  };
}

/**
 * Repository for managing agent roles in the database
 */
export class AgentRoleRepository {
  private readonly heartbeatPolicyRepo: HeartbeatPolicyRepository;

  constructor(private db: Database.Database) {
    this.heartbeatPolicyRepo = new HeartbeatPolicyRepository(db);
  }

  private attachHeartbeatPolicy(role: AgentRole): AgentRole {
    const policy =
      this.heartbeatPolicyRepo.findByAgentRoleId(role.id) ||
      this.heartbeatPolicyRepo.upsert(
        role.id,
        derivePolicyInputFromLegacy(role.autonomyLevel, role.soul, {
          heartbeatEnabled: role.heartbeatEnabled,
          heartbeatIntervalMinutes: role.heartbeatIntervalMinutes,
          heartbeatStaggerOffset: role.heartbeatStaggerOffset,
          pulseEveryMinutes: role.pulseEveryMinutes,
          dispatchCooldownMinutes: role.dispatchCooldownMinutes,
          maxDispatchesPerDay: role.maxDispatchesPerDay,
          heartbeatProfile: role.heartbeatProfile,
          activeHours: role.activeHours ?? null,
        }),
      );
    return {
      ...role,
      roleKind: role.roleKind || defaultRoleKind(role.isSystem),
      heartbeatPolicy: policy,
      heartbeatEnabled: policy.enabled,
      heartbeatIntervalMinutes: policy.cadenceMinutes,
      heartbeatStaggerOffset: policy.staggerOffsetMinutes,
      pulseEveryMinutes: policy.cadenceMinutes,
      dispatchCooldownMinutes: policy.dispatchCooldownMinutes,
      maxDispatchesPerDay: policy.maxDispatchesPerDay,
      heartbeatProfile: policy.profile,
      activeHours: policy.activeHours ?? undefined,
    };
  }

  /**
   * Create a new agent role
   */
  create(request: CreateAgentRoleRequest): AgentRole {
    const now = Date.now();
    const resolvedAutonomyLevel = request.autonomyLevel || "specialist";
    const roleKind = request.roleKind || defaultRoleKind(false);
    const sourceTemplateId =
      request.sourceTemplateId || extractTemplateMetadata(request.soul).sourceTemplateId;
    const sourceTemplateVersion =
      request.sourceTemplateVersion || extractTemplateMetadata(request.soul).sourceTemplateVersion;
    const heartbeatPolicyInput = derivePolicyInputFromLegacy(resolvedAutonomyLevel, request.soul, {
      heartbeatPolicy: request.heartbeatPolicy,
      heartbeatEnabled: request.heartbeatEnabled,
      heartbeatIntervalMinutes: request.heartbeatIntervalMinutes,
      heartbeatStaggerOffset: request.heartbeatStaggerOffset,
      pulseEveryMinutes: request.pulseEveryMinutes,
      dispatchCooldownMinutes: request.dispatchCooldownMinutes,
      maxDispatchesPerDay: request.maxDispatchesPerDay,
      heartbeatProfile: request.heartbeatProfile,
      activeHours: request.activeHours,
    });
    const role: AgentRole = {
      id: uuidv4(),
      name: request.name,
      roleKind,
      sourceTemplateId,
      sourceTemplateVersion,
      companyId: request.companyId,
      displayName: request.displayName,
      description: request.description,
      icon: normalizeAgentRoleIcon(request.icon),
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
      // Automation fields
      autonomyLevel: resolvedAutonomyLevel,
      soul: request.soul,
      heartbeatEnabled: heartbeatPolicyInput.enabled,
      heartbeatIntervalMinutes: heartbeatPolicyInput.cadenceMinutes,
      heartbeatStaggerOffset: heartbeatPolicyInput.staggerOffsetMinutes,
      pulseEveryMinutes: heartbeatPolicyInput.cadenceMinutes,
      dispatchCooldownMinutes: heartbeatPolicyInput.dispatchCooldownMinutes,
      maxDispatchesPerDay: heartbeatPolicyInput.maxDispatchesPerDay,
      heartbeatProfile: heartbeatPolicyInput.profile,
      activeHours: heartbeatPolicyInput.activeHours ?? undefined,
      heartbeatStatus: "idle",
      operatorMandate: request.operatorMandate,
      allowedLoopTypes: request.allowedLoopTypes,
      outputTypes: request.outputTypes,
      suppressionPolicy: request.suppressionPolicy,
      maxAutonomousOutputsPerCycle: request.maxAutonomousOutputsPerCycle ?? 1,
      lastUsefulOutputAt: request.lastUsefulOutputAt,
      operatorHealthScore: request.operatorHealthScore,
    };

    const stmt = this.db.prepare(`
      INSERT INTO agent_roles (
        id, name, role_kind, source_template_id, source_template_version, company_id, display_name, description, icon, color,
        personality_id, model_key, provider_type, system_prompt,
        capabilities, tool_restrictions, is_system, is_active,
        sort_order, created_at, updated_at,
        autonomy_level, soul, heartbeat_enabled, heartbeat_interval_minutes,
        heartbeat_stagger_offset, heartbeat_pulse_every_minutes,
        heartbeat_dispatch_cooldown_minutes, heartbeat_max_dispatches_per_day,
        heartbeat_profile, heartbeat_active_hours, heartbeat_status, operator_mandate, allowed_loop_types,
        output_types, suppression_policy, max_autonomous_outputs_per_cycle,
        last_useful_output_at, operator_health_score
      ) VALUES (${new Array(39).fill("?").join(", ")})
    `);

    stmt.run(
      role.id,
      role.name,
      role.roleKind || defaultRoleKind(role.isSystem),
      role.sourceTemplateId || null,
      role.sourceTemplateVersion || null,
      role.companyId || null,
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
      role.pulseEveryMinutes,
      role.dispatchCooldownMinutes,
      role.maxDispatchesPerDay,
      role.heartbeatProfile,
      role.activeHours ? JSON.stringify(role.activeHours) : null,
      role.heartbeatStatus,
      role.operatorMandate || null,
      role.allowedLoopTypes ? JSON.stringify(role.allowedLoopTypes) : null,
      role.outputTypes ? JSON.stringify(role.outputTypes) : null,
      role.suppressionPolicy || null,
      role.maxAutonomousOutputsPerCycle ?? 1,
      role.lastUsefulOutputAt ?? null,
      role.operatorHealthScore ?? null,
    );

    role.heartbeatPolicy = this.heartbeatPolicyRepo.upsert(role.id, heartbeatPolicyInput);
    return role;
  }

  /**
   * Find an agent role by ID
   */
  findById(id: string): AgentRole | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_roles WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.attachHeartbeatPolicy(this.mapRowToAgentRole(row)) : undefined;
  }

  /**
   * Find an agent role by name
   */
  findByName(name: string): AgentRole | undefined {
    const stmt = this.db.prepare("SELECT * FROM agent_roles WHERE name = ?");
    const row = stmt.get(name) as Any;
    return row ? this.attachHeartbeatPolicy(this.mapRowToAgentRole(row)) : undefined;
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
    return rows.map((row) => this.attachHeartbeatPolicy(this.mapRowToAgentRole(row)));
  }

  /**
   * Find all active agent roles
   */
  findActive(): AgentRole[] {
    return this.findAll(false);
  }

  findByCompanyId(companyId: string | null, includeInactive = false): AgentRole[] {
    if (companyId === null) {
      const stmt = includeInactive
        ? this.db.prepare(
            "SELECT * FROM agent_roles WHERE company_id IS NULL ORDER BY sort_order ASC, created_at ASC",
          )
        : this.db.prepare(
            "SELECT * FROM agent_roles WHERE company_id IS NULL AND is_active = 1 ORDER BY sort_order ASC, created_at ASC",
          );
      const rows = stmt.all() as Any[];
      return rows.map((row) => this.attachHeartbeatPolicy(this.mapRowToAgentRole(row)));
    }

    const stmt = includeInactive
      ? this.db.prepare(
          "SELECT * FROM agent_roles WHERE company_id = ? ORDER BY sort_order ASC, created_at ASC",
        )
      : this.db.prepare(
          "SELECT * FROM agent_roles WHERE company_id = ? AND is_active = 1 ORDER BY sort_order ASC, created_at ASC",
        );
    const rows = stmt.all(companyId) as Any[];
    return rows.map((row) => this.attachHeartbeatPolicy(this.mapRowToAgentRole(row)));
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
    if (request.roleKind !== undefined) {
      fields.push("role_kind = ?");
      values.push(request.roleKind);
    }
    if (request.sourceTemplateId !== undefined) {
      fields.push("source_template_id = ?");
      values.push(request.sourceTemplateId);
    }
    if (request.sourceTemplateVersion !== undefined) {
      fields.push("source_template_version = ?");
      values.push(request.sourceTemplateVersion);
    }
    if (request.companyId !== undefined) {
      fields.push("company_id = ?");
      values.push(request.companyId);
    }
    if (request.description !== undefined) {
      fields.push("description = ?");
      values.push(request.description);
    }
    if (request.icon !== undefined) {
      fields.push("icon = ?");
      values.push(normalizeAgentRoleIcon(request.icon));
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
    const nextAutonomyLevel = request.autonomyLevel ?? existing.autonomyLevel;
    const nextSoul = request.soul ?? existing.soul;
    const policyInput =
      request.heartbeatPolicy ||
      request.heartbeatEnabled !== undefined ||
      request.heartbeatIntervalMinutes !== undefined ||
      request.heartbeatStaggerOffset !== undefined ||
      request.pulseEveryMinutes !== undefined ||
      request.dispatchCooldownMinutes !== undefined ||
      request.maxDispatchesPerDay !== undefined ||
      request.heartbeatProfile !== undefined ||
      request.activeHours !== undefined
        ? derivePolicyInputFromLegacy(nextAutonomyLevel, nextSoul, {
            heartbeatPolicy: request.heartbeatPolicy,
            heartbeatEnabled: request.heartbeatEnabled,
            heartbeatIntervalMinutes: request.heartbeatIntervalMinutes,
            heartbeatStaggerOffset: request.heartbeatStaggerOffset,
            pulseEveryMinutes: request.pulseEveryMinutes,
            dispatchCooldownMinutes: request.dispatchCooldownMinutes,
            maxDispatchesPerDay: request.maxDispatchesPerDay,
            heartbeatProfile: request.heartbeatProfile,
            activeHours: request.activeHours,
          })
        : null;

    const mirroredPolicyFields = policyInput
      ? {
          heartbeatEnabled: policyInput.enabled ?? existing.heartbeatEnabled ?? false,
          heartbeatIntervalMinutes:
            policyInput.cadenceMinutes ?? existing.heartbeatIntervalMinutes ?? 15,
          heartbeatStaggerOffset:
            policyInput.staggerOffsetMinutes ?? existing.heartbeatStaggerOffset ?? 0,
          pulseEveryMinutes: policyInput.cadenceMinutes ?? existing.pulseEveryMinutes ?? 15,
          dispatchCooldownMinutes:
            policyInput.dispatchCooldownMinutes ?? existing.dispatchCooldownMinutes ?? 120,
          maxDispatchesPerDay:
            policyInput.maxDispatchesPerDay ?? existing.maxDispatchesPerDay ?? 6,
          heartbeatProfile: policyInput.profile ?? existing.heartbeatProfile ?? "observer",
          activeHours:
            policyInput.activeHours !== undefined ? policyInput.activeHours : (existing.activeHours ?? null),
        }
      : null;

    if (mirroredPolicyFields) {
      fields.push("heartbeat_enabled = ?");
      values.push(mirroredPolicyFields.heartbeatEnabled ? 1 : 0);
      fields.push("heartbeat_interval_minutes = ?");
      values.push(mirroredPolicyFields.heartbeatIntervalMinutes);
      fields.push("heartbeat_stagger_offset = ?");
      values.push(mirroredPolicyFields.heartbeatStaggerOffset);
      fields.push("heartbeat_pulse_every_minutes = ?");
      values.push(mirroredPolicyFields.pulseEveryMinutes);
      fields.push("heartbeat_dispatch_cooldown_minutes = ?");
      values.push(mirroredPolicyFields.dispatchCooldownMinutes);
      fields.push("heartbeat_max_dispatches_per_day = ?");
      values.push(mirroredPolicyFields.maxDispatchesPerDay);
      fields.push("heartbeat_profile = ?");
      values.push(mirroredPolicyFields.heartbeatProfile);
      fields.push("heartbeat_active_hours = ?");
      values.push(mirroredPolicyFields.activeHours ? JSON.stringify(mirroredPolicyFields.activeHours) : null);
    }
    if (request.operatorMandate !== undefined) {
      fields.push("operator_mandate = ?");
      values.push(request.operatorMandate);
    }
    if (request.allowedLoopTypes !== undefined) {
      fields.push("allowed_loop_types = ?");
      values.push(request.allowedLoopTypes ? JSON.stringify(request.allowedLoopTypes) : null);
    }
    if (request.outputTypes !== undefined) {
      fields.push("output_types = ?");
      values.push(request.outputTypes ? JSON.stringify(request.outputTypes) : null);
    }
    if (request.suppressionPolicy !== undefined) {
      fields.push("suppression_policy = ?");
      values.push(request.suppressionPolicy);
    }
    if (request.maxAutonomousOutputsPerCycle !== undefined) {
      fields.push("max_autonomous_outputs_per_cycle = ?");
      values.push(request.maxAutonomousOutputsPerCycle);
    }
    if (request.lastUsefulOutputAt !== undefined) {
      fields.push("last_useful_output_at = ?");
      values.push(request.lastUsefulOutputAt);
    }
    if (request.operatorHealthScore !== undefined) {
      fields.push("operator_health_score = ?");
      values.push(request.operatorHealthScore);
    }

    if (fields.length === 0) {
      return existing;
    }

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(request.id);

    const sql = `UPDATE agent_roles SET ${fields.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    if (policyInput) {
      this.heartbeatPolicyRepo.upsert(request.id, policyInput);
    }

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
        companyId: undefined,
        createdAt: now,
        updatedAt: now,
        // Ensure Mission Control fields have defaults
        heartbeatEnabled: false,
        heartbeatIntervalMinutes: 15,
        heartbeatStaggerOffset: 0,
        pulseEveryMinutes: 15,
        dispatchCooldownMinutes: deriveDispatchCooldownMinutes(defaultRole.autonomyLevel, undefined),
        maxDispatchesPerDay: deriveMaxDispatchesPerDay(defaultRole.autonomyLevel, undefined),
        heartbeatProfile: defaultHeartbeatProfile(defaultRole.autonomyLevel),
        heartbeatStatus: "idle",
      };

      const stmt = this.db.prepare(`
        INSERT INTO agent_roles (
          id, name, company_id, display_name, description, icon, color,
          personality_id, model_key, provider_type, system_prompt,
          capabilities, tool_restrictions, is_system, is_active,
        sort_order, created_at, updated_at,
        autonomy_level, soul, heartbeat_enabled, heartbeat_interval_minutes,
        heartbeat_stagger_offset, heartbeat_pulse_every_minutes,
        heartbeat_dispatch_cooldown_minutes, heartbeat_max_dispatches_per_day,
        heartbeat_profile, heartbeat_active_hours, heartbeat_status, operator_mandate, allowed_loop_types,
        output_types, suppression_policy, max_autonomous_outputs_per_cycle,
        last_useful_output_at, operator_health_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        role.id,
        role.name,
        role.companyId || null,
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
        role.soul || null,
        role.heartbeatEnabled ? 1 : 0,
        role.heartbeatIntervalMinutes,
        role.heartbeatStaggerOffset,
        role.pulseEveryMinutes,
        role.dispatchCooldownMinutes,
        role.maxDispatchesPerDay,
        role.heartbeatProfile,
        role.activeHours ? JSON.stringify(role.activeHours) : null,
        role.heartbeatStatus,
        role.operatorMandate || null,
        role.allowedLoopTypes ? JSON.stringify(role.allowedLoopTypes) : null,
        role.outputTypes ? JSON.stringify(role.outputTypes) : null,
        role.suppressionPolicy || null,
        role.maxAutonomousOutputsPerCycle ?? 1,
        role.lastUsefulOutputAt ?? null,
        role.operatorHealthScore ?? null,
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
        companyId: undefined,
        createdAt: now,
        updatedAt: now,
        heartbeatEnabled: false,
        heartbeatIntervalMinutes: 15,
        heartbeatStaggerOffset: 0,
        pulseEveryMinutes: 15,
        dispatchCooldownMinutes: deriveDispatchCooldownMinutes(defaultRole.autonomyLevel, undefined),
        maxDispatchesPerDay: deriveMaxDispatchesPerDay(defaultRole.autonomyLevel, undefined),
        heartbeatProfile: defaultHeartbeatProfile(defaultRole.autonomyLevel),
        heartbeatStatus: "idle",
      };

      const stmt = this.db.prepare(`
        INSERT INTO agent_roles (
          id, name, company_id, display_name, description, icon, color,
          personality_id, model_key, provider_type, system_prompt,
          capabilities, tool_restrictions, is_system, is_active,
        sort_order, created_at, updated_at,
        autonomy_level, soul, heartbeat_enabled, heartbeat_interval_minutes,
        heartbeat_stagger_offset, heartbeat_pulse_every_minutes,
        heartbeat_dispatch_cooldown_minutes, heartbeat_max_dispatches_per_day,
        heartbeat_profile, heartbeat_active_hours, heartbeat_status, operator_mandate, allowed_loop_types,
        output_types, suppression_policy, max_autonomous_outputs_per_cycle,
        last_useful_output_at, operator_health_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        role.id,
        role.name,
        role.companyId || null,
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
        role.soul || null,
        role.heartbeatEnabled ? 1 : 0,
        role.heartbeatIntervalMinutes,
        role.heartbeatStaggerOffset,
        role.pulseEveryMinutes,
        role.dispatchCooldownMinutes,
        role.maxDispatchesPerDay,
        role.heartbeatProfile,
        role.activeHours ? JSON.stringify(role.activeHours) : null,
        role.heartbeatStatus,
        role.operatorMandate || null,
        role.allowedLoopTypes ? JSON.stringify(role.allowedLoopTypes) : null,
        role.outputTypes ? JSON.stringify(role.outputTypes) : null,
        role.suppressionPolicy || null,
        role.maxAutonomousOutputsPerCycle ?? 1,
        role.lastUsefulOutputAt ?? null,
        role.operatorHealthScore ?? null,
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
      roleKind: (row.role_kind as AgentRoleKind | undefined) || defaultRoleKind(row.is_system === 1),
      sourceTemplateId: row.source_template_id || undefined,
      sourceTemplateVersion: row.source_template_version || undefined,
      companyId: row.company_id || undefined,
      displayName: row.display_name,
      description: row.description || undefined,
      icon: normalizeAgentRoleIcon(row.icon),
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
      // Automation fields
      autonomyLevel: (row.autonomy_level as AgentAutonomyLevel) || "specialist",
      soul: row.soul || undefined,
      heartbeatEnabled: row.heartbeat_enabled === 1,
      heartbeatIntervalMinutes: row.heartbeat_interval_minutes || 15,
      heartbeatStaggerOffset: row.heartbeat_stagger_offset || 0,
      pulseEveryMinutes:
        row.heartbeat_pulse_every_minutes || row.heartbeat_interval_minutes || 15,
      dispatchCooldownMinutes: row.heartbeat_dispatch_cooldown_minutes || 120,
      maxDispatchesPerDay: row.heartbeat_max_dispatches_per_day || 6,
      heartbeatProfile:
        (row.heartbeat_profile as HeartbeatProfile | undefined) ||
        defaultHeartbeatProfile(row.autonomy_level as AgentAutonomyLevel),
      activeHours: safeJsonParse<HeartbeatActiveHours | undefined>(
        row.heartbeat_active_hours,
        undefined,
        "agentRole.activeHours",
      ),
      lastHeartbeatAt: row.last_heartbeat_at || undefined,
      lastPulseAt: row.last_pulse_at || undefined,
      lastDispatchAt: row.last_dispatch_at || undefined,
      lastPulseResult: row.heartbeat_last_pulse_result || undefined,
      lastDispatchKind: row.heartbeat_last_dispatch_kind || undefined,
      heartbeatStatus: (row.heartbeat_status as HeartbeatStatus) || "idle",
      operatorMandate: row.operator_mandate || undefined,
      allowedLoopTypes: safeJsonParse(row.allowed_loop_types, [], "agentRole.allowedLoopTypes"),
      outputTypes: safeJsonParse(row.output_types, [], "agentRole.outputTypes"),
      suppressionPolicy: row.suppression_policy || undefined,
      maxAutonomousOutputsPerCycle:
        typeof row.max_autonomous_outputs_per_cycle === "number"
          ? row.max_autonomous_outputs_per_cycle
          : undefined,
      lastUsefulOutputAt: row.last_useful_output_at || undefined,
      operatorHealthScore:
        typeof row.operator_health_score === "number" ? row.operator_health_score : undefined,
    };
  }

  // ============ Mission Control Methods ============

  /**
   * Find all agents with heartbeat enabled
   */
  findHeartbeatEnabled(): AgentRole[] {
    return this.findAll(false).filter((role) => role.heartbeatPolicy?.enabled);
  }

  /**
   * Update heartbeat configuration for an agent
   */
  updateHeartbeatConfig(id: string, config: HeartbeatConfig): AgentRole | undefined {
    const existing = this.findById(id);
    if (!existing) {
      return undefined;
    }
    const policyInput = derivePolicyInputFromLegacy(existing.autonomyLevel, existing.soul, {
      heartbeatEnabled: config.heartbeatEnabled,
      heartbeatIntervalMinutes: config.heartbeatIntervalMinutes,
      heartbeatStaggerOffset: config.heartbeatStaggerOffset,
      pulseEveryMinutes: config.pulseEveryMinutes,
      dispatchCooldownMinutes: config.dispatchCooldownMinutes,
      maxDispatchesPerDay: config.maxDispatchesPerDay,
      heartbeatProfile: config.heartbeatProfile,
      activeHours: config.activeHours,
    });
    const policy = this.heartbeatPolicyRepo.upsert(id, policyInput);
    this.db.prepare(
      `UPDATE agent_roles
       SET heartbeat_enabled = ?, heartbeat_interval_minutes = ?, heartbeat_stagger_offset = ?,
           heartbeat_pulse_every_minutes = ?, heartbeat_dispatch_cooldown_minutes = ?,
           heartbeat_max_dispatches_per_day = ?, heartbeat_profile = ?, heartbeat_active_hours = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      policy.enabled ? 1 : 0,
      policy.cadenceMinutes,
      policy.staggerOffsetMinutes,
      policy.cadenceMinutes,
      policy.dispatchCooldownMinutes,
      policy.maxDispatchesPerDay,
      policy.profile,
      policy.activeHours ? JSON.stringify(policy.activeHours) : null,
      Date.now(),
      id,
    );

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

  updateHeartbeatRunTimestamps(
    id: string,
    updates: {
      lastPulseAt?: number;
      lastDispatchAt?: number;
      lastHeartbeatAt?: number;
      lastPulseResult?: AgentRole["lastPulseResult"];
      lastDispatchKind?: AgentRole["lastDispatchKind"];
    },
  ): void {
    const fields: string[] = [];
    const values: Any[] = [];

    if (updates.lastPulseAt !== undefined) {
      fields.push("last_pulse_at = ?");
      values.push(updates.lastPulseAt);
    }
    if (updates.lastDispatchAt !== undefined) {
      fields.push("last_dispatch_at = ?");
      values.push(updates.lastDispatchAt);
    }
    if (updates.lastHeartbeatAt !== undefined) {
      fields.push("last_heartbeat_at = ?");
      values.push(updates.lastHeartbeatAt);
    }
    if (updates.lastPulseResult !== undefined) {
      fields.push("heartbeat_last_pulse_result = ?");
      values.push(updates.lastPulseResult);
    }
    if (updates.lastDispatchKind !== undefined) {
      fields.push("heartbeat_last_dispatch_kind = ?");
      values.push(updates.lastDispatchKind);
    }

    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    this.db.prepare(`UPDATE agent_roles SET ${fields.join(", ")} WHERE id = ?`).run(...values);
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
    return rows.map((row) => this.attachHeartbeatPolicy(this.mapRowToAgentRole(row)));
  }
}
