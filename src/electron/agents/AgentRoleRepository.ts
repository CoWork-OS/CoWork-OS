import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  AgentRole,
  AgentRoleKind,
  CognitiveOffloadCategory,
  CreateAgentRoleRequest,
  UpdateAgentRoleRequest,
  AgentCapability,
  AgentToolRestrictions,
  AgentAutonomyLevel,
  HeartbeatStatus,
  HeartbeatConfig,
  HeartbeatProfile,
  HeartbeatActiveHours,
  HeartbeatPolicy,
  ProactiveTaskDefinition,
  DEFAULT_AGENT_ROLES,
} from "../../shared/types";
import { normalizeAgentRoleIcon } from "./agent-role-display";
import { AutomationProfileRepository } from "./AutomationProfileRepository";
import { createLogger } from "../utils/logger";

type Any = any; // oxlint-disable-line typescript-eslint(no-explicit-any)
const logger = createLogger("AgentRoleRepository");

/**
 * Safely parse JSON with error handling
 */
function safeJsonParse<T>(jsonString: string | null, defaultValue: T, context?: string): T {
  if (!jsonString) return defaultValue;
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    logger.warn(`Failed to parse JSON${context ? ` in ${context}` : ""}:`, error);
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
    const profileMetadata =
      parsed?.automationProfileMetadata && typeof parsed.automationProfileMetadata === "object"
        ? (parsed.automationProfileMetadata as Record<string, unknown>)
        : parsed?.cognitiveOffload && typeof parsed.cognitiveOffload === "object"
          ? (parsed.cognitiveOffload as Record<string, unknown>)
          : null;
    return {
      primaryCategories: Array.isArray(profileMetadata?.primaryCategories)
        ? (profileMetadata?.primaryCategories as CognitiveOffloadCategory[])
        : [],
      proactiveTasks: Array.isArray(profileMetadata?.proactiveTasks)
        ? (profileMetadata?.proactiveTasks as unknown[])
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

function mergeAutomationProfileMetadataIntoSoul(
  soul: string | undefined,
  heartbeatPolicy?: CreateAgentRoleRequest["heartbeatPolicy"],
): string | undefined {
  const hasMetadata =
    Boolean(heartbeatPolicy?.primaryCategories?.length) ||
    Boolean(heartbeatPolicy?.proactiveTasks?.length);
  if (!hasMetadata) {
    return soul;
  }

  let parsed: Record<string, unknown> = {};
  if (soul) {
    try {
      parsed = JSON.parse(soul) as Record<string, unknown>;
    } catch (error) {
      logger.warn("Failed to parse agent soul while merging automation profile metadata:", error);
    }
  }

  if (hasMetadata) {
    parsed.automationProfileMetadata = {
      primaryCategories: heartbeatPolicy?.primaryCategories ?? [],
      proactiveTasks: heartbeatPolicy?.proactiveTasks ?? [],
    };
  }

  return JSON.stringify(parsed);
}

/**
 * Repository for managing agent roles in the database
 */
export class AgentRoleRepository {
  private readonly automationProfileRepo: AutomationProfileRepository;

  constructor(private db: Database.Database) {
    this.automationProfileRepo = new AutomationProfileRepository(db);
  }

  private buildHeartbeatPolicyAlias(role: AgentRole): HeartbeatPolicy | undefined {
    const profile = this.automationProfileRepo.findByAgentRoleId(role.id);
    const metadata = extractTemplateMetadata(role.soul);
    const enabled = profile?.enabled ?? role.heartbeatEnabled ?? false;
    const cadenceMinutes =
      profile?.cadenceMinutes ?? role.pulseEveryMinutes ?? role.heartbeatIntervalMinutes ?? 15;
    const staggerOffsetMinutes = profile?.staggerOffsetMinutes ?? role.heartbeatStaggerOffset ?? 0;
    const dispatchCooldownMinutes =
      profile?.dispatchCooldownMinutes ?? role.dispatchCooldownMinutes ?? 120;
    const maxDispatchesPerDay = profile?.maxDispatchesPerDay ?? role.maxDispatchesPerDay ?? 6;
    const heartbeatProfile =
      profile?.profile ?? role.heartbeatProfile ?? defaultHeartbeatProfile(role.autonomyLevel);
    const activeHours = profile?.activeHours ?? role.activeHours ?? null;
    const shouldExposeAlias =
      Boolean(profile) ||
      enabled ||
      Boolean(role.heartbeatIntervalMinutes) ||
      Boolean(role.pulseEveryMinutes) ||
      Boolean(role.dispatchCooldownMinutes) ||
      Boolean(role.maxDispatchesPerDay) ||
      Boolean(role.heartbeatProfile) ||
      Boolean(role.activeHours) ||
      metadata.primaryCategories.length > 0 ||
      metadata.proactiveTasks.length > 0;

    if (!shouldExposeAlias) {
      return undefined;
    }

    return {
      id: profile?.id ?? `legacy:${role.id}`,
      agentRoleId: role.id,
      enabled,
      cadenceMinutes,
      staggerOffsetMinutes,
      dispatchCooldownMinutes,
      maxDispatchesPerDay,
      profile: heartbeatProfile,
      activeHours,
      primaryCategories: metadata.primaryCategories,
      proactiveTasks: metadata.proactiveTasks as ProactiveTaskDefinition[],
      createdAt: profile?.createdAt ?? role.createdAt,
      updatedAt: profile?.updatedAt ?? role.updatedAt,
    };
  }

  private attachHeartbeatPolicy(role: AgentRole): AgentRole {
    const profile = this.automationProfileRepo.findByAgentRoleId(role.id);
    const heartbeatPolicy = this.buildHeartbeatPolicyAlias(role);
    return {
      ...role,
      roleKind: role.roleKind || defaultRoleKind(role.isSystem),
      heartbeatPolicy,
      heartbeatEnabled: heartbeatPolicy?.enabled ?? role.heartbeatEnabled ?? false,
      heartbeatIntervalMinutes: heartbeatPolicy?.cadenceMinutes ?? role.heartbeatIntervalMinutes,
      heartbeatStaggerOffset: heartbeatPolicy?.staggerOffsetMinutes ?? role.heartbeatStaggerOffset,
      pulseEveryMinutes: heartbeatPolicy?.cadenceMinutes ?? role.pulseEveryMinutes,
      dispatchCooldownMinutes:
        heartbeatPolicy?.dispatchCooldownMinutes ?? role.dispatchCooldownMinutes,
      maxDispatchesPerDay: heartbeatPolicy?.maxDispatchesPerDay ?? role.maxDispatchesPerDay,
      heartbeatProfile: heartbeatPolicy?.profile ?? role.heartbeatProfile,
      activeHours: heartbeatPolicy?.activeHours ?? role.activeHours ?? undefined,
      lastHeartbeatAt: profile?.lastHeartbeatAt,
      lastPulseAt: profile?.lastPulseAt,
      lastDispatchAt: profile?.lastDispatchAt,
      lastPulseResult: profile?.lastPulseResult,
      lastDispatchKind: profile?.lastDispatchKind,
      heartbeatStatus: profile?.heartbeatStatus ?? role.heartbeatStatus,
    };
  }

  /**
   * Create a new agent role
   */
  create(request: CreateAgentRoleRequest): AgentRole {
    const now = Date.now();
    const resolvedAutonomyLevel = request.autonomyLevel || "specialist";
    const roleKind = request.roleKind || defaultRoleKind(false);
    const heartbeatPolicyInput = request.heartbeatPolicy;
    const sourceTemplateId =
      request.sourceTemplateId || extractTemplateMetadata(request.soul).sourceTemplateId;
    const sourceTemplateVersion =
      request.sourceTemplateVersion || extractTemplateMetadata(request.soul).sourceTemplateVersion;
    const resolvedHeartbeatEnabled =
      heartbeatPolicyInput?.enabled ?? request.heartbeatEnabled ?? false;
    const resolvedPulseEveryMinutes =
      heartbeatPolicyInput?.cadenceMinutes ??
      derivePulseEveryMinutes(request.pulseEveryMinutes, request.heartbeatIntervalMinutes);
    const resolvedHeartbeatStaggerOffset =
      heartbeatPolicyInput?.staggerOffsetMinutes ?? request.heartbeatStaggerOffset ?? 0;
    const resolvedDispatchCooldownMinutes = deriveDispatchCooldownMinutes(
      resolvedAutonomyLevel,
      heartbeatPolicyInput?.dispatchCooldownMinutes ?? request.dispatchCooldownMinutes,
    );
    const resolvedMaxDispatchesPerDay = deriveMaxDispatchesPerDay(
      resolvedAutonomyLevel,
      heartbeatPolicyInput?.maxDispatchesPerDay ?? request.maxDispatchesPerDay,
    );
    const resolvedHeartbeatProfile =
      heartbeatPolicyInput?.profile ??
      request.heartbeatProfile ??
      defaultHeartbeatProfile(resolvedAutonomyLevel);
    const resolvedActiveHours =
      heartbeatPolicyInput && "activeHours" in heartbeatPolicyInput
        ? (heartbeatPolicyInput.activeHours ?? undefined)
        : (request.activeHours ?? undefined);
    const resolvedSoul = mergeAutomationProfileMetadataIntoSoul(request.soul, heartbeatPolicyInput);
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
      soul: resolvedSoul,
      heartbeatEnabled: resolvedHeartbeatEnabled,
      heartbeatIntervalMinutes: resolvedPulseEveryMinutes,
      heartbeatStaggerOffset: resolvedHeartbeatStaggerOffset,
      pulseEveryMinutes: resolvedPulseEveryMinutes,
      dispatchCooldownMinutes: resolvedDispatchCooldownMinutes,
      maxDispatchesPerDay: resolvedMaxDispatchesPerDay,
      heartbeatProfile: resolvedHeartbeatProfile,
      activeHours: resolvedActiveHours,
      heartbeatStatus: "idle",
      monthlyBudgetCost: request.monthlyBudgetCost,
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
        last_useful_output_at, operator_health_score, monthly_budget_cost, auto_paused_at
      ) VALUES (${new Array(41).fill("?").join(", ")})
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
      role.monthlyBudgetCost ?? null,
      role.autoPausedAt ?? null,
    );

    const shouldPersistAutomationProfile =
      heartbeatPolicyInput !== undefined ||
      request.heartbeatEnabled !== undefined ||
      request.heartbeatIntervalMinutes !== undefined ||
      request.heartbeatStaggerOffset !== undefined ||
      request.pulseEveryMinutes !== undefined ||
      request.dispatchCooldownMinutes !== undefined ||
      request.maxDispatchesPerDay !== undefined ||
      request.heartbeatProfile !== undefined ||
      request.activeHours !== undefined;

    if (shouldPersistAutomationProfile) {
      this.automationProfileRepo.createOrReplace({
        agentRoleId: role.id,
        enabled: resolvedHeartbeatEnabled,
        cadenceMinutes: resolvedPulseEveryMinutes,
        staggerOffsetMinutes: resolvedHeartbeatStaggerOffset,
        dispatchCooldownMinutes: resolvedDispatchCooldownMinutes,
        maxDispatchesPerDay: resolvedMaxDispatchesPerDay,
        profile: resolvedHeartbeatProfile,
        activeHours: resolvedActiveHours ?? null,
      });
    }

    return this.findById(role.id) ?? role;
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
      logger.warn("Cannot modify capabilities or tool restrictions of system agent roles");
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
    if (request.monthlyBudgetCost !== undefined) {
      fields.push("monthly_budget_cost = ?");
      values.push(request.monthlyBudgetCost);
    }
    if (request.autoPausedAt !== undefined) {
      fields.push("auto_paused_at = ?");
      values.push(request.autoPausedAt);
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
      logger.warn("Cannot delete system agent roles");
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
        dispatchCooldownMinutes: deriveDispatchCooldownMinutes(
          defaultRole.autonomyLevel,
          undefined,
        ),
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
        dispatchCooldownMinutes: deriveDispatchCooldownMinutes(
          defaultRole.autonomyLevel,
          undefined,
        ),
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
      logger.info(`Added new default agent: ${role.displayName}`);
    }

    if (added.length > 0) {
      logger.info(`Synced ${added.length} new default agent(s)`);
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
      roleKind:
        (row.role_kind as AgentRoleKind | undefined) || defaultRoleKind(row.is_system === 1),
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
      pulseEveryMinutes: row.heartbeat_pulse_every_minutes || row.heartbeat_interval_minutes || 15,
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
      monthlyBudgetCost:
        typeof row.monthly_budget_cost === "number" ? row.monthly_budget_cost : undefined,
      autoPausedAt: typeof row.auto_paused_at === "number" ? row.auto_paused_at : undefined,
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
    const enabledRoleIds = new Set(
      this.automationProfileRepo.listEnabled().map((profile) => profile.agentRoleId),
    );
    return this.findAll(false).filter((role) => enabledRoleIds.has(role.id));
  }

  /**
   * Update heartbeat configuration for an agent
   */
  updateHeartbeatConfig(id: string, config: HeartbeatConfig): AgentRole | undefined {
    const existing = this.findById(id);
    if (!existing) {
      return undefined;
    }
    if (existing.roleKind === "persona_template") {
      throw new Error("Digital Twin roles cannot own core automation profiles");
    }
    this.automationProfileRepo.createOrReplace({
      agentRoleId: id,
      enabled: config.heartbeatEnabled,
      cadenceMinutes: config.pulseEveryMinutes ?? config.heartbeatIntervalMinutes,
      staggerOffsetMinutes: config.heartbeatStaggerOffset,
      dispatchCooldownMinutes: config.dispatchCooldownMinutes,
      maxDispatchesPerDay: config.maxDispatchesPerDay,
      profile: config.heartbeatProfile,
      activeHours: config.activeHours,
    });

    return this.findById(id);
  }

  /**
   * Update heartbeat status for an agent
   */
  updateHeartbeatStatus(id: string, status: HeartbeatStatus, lastHeartbeatAt?: number): void {
    this.automationProfileRepo.updateRuntimeState(id, {
      heartbeatStatus: status,
      lastHeartbeatAt,
    });
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
    this.automationProfileRepo.updateRuntimeState(id, updates);
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
