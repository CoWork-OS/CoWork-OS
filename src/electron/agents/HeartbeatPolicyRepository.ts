import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  CognitiveOffloadCategory,
  HeartbeatActiveHours,
  HeartbeatPolicy,
  HeartbeatPolicyInput,
  ProactiveTaskDefinition,
} from "../../shared/types";

type Any = any; // oxlint-disable-line typescript-eslint(no-explicit-any)

function safeJsonParse<T>(jsonString: string | null, fallback: T): T {
  if (!jsonString) return fallback;
  try {
    return JSON.parse(jsonString) as T;
  } catch {
    return fallback;
  }
}

function defaultPolicy(agentRoleId: string): HeartbeatPolicy {
  const now = Date.now();
  return {
    id: uuidv4(),
    agentRoleId,
    enabled: false,
    cadenceMinutes: 15,
    staggerOffsetMinutes: 0,
    dispatchCooldownMinutes: 120,
    maxDispatchesPerDay: 6,
    profile: "observer",
    activeHours: null,
    primaryCategories: [],
    proactiveTasks: [],
    createdAt: now,
    updatedAt: now,
  };
}

function mergePolicy(
  agentRoleId: string,
  input?: HeartbeatPolicyInput,
  existing?: HeartbeatPolicy,
): HeartbeatPolicy {
  const base = existing || defaultPolicy(agentRoleId);
  const now = Date.now();
  return {
    ...base,
    enabled: input?.enabled ?? base.enabled,
    cadenceMinutes: input?.cadenceMinutes ?? base.cadenceMinutes,
    staggerOffsetMinutes: input?.staggerOffsetMinutes ?? base.staggerOffsetMinutes,
    dispatchCooldownMinutes: input?.dispatchCooldownMinutes ?? base.dispatchCooldownMinutes,
    maxDispatchesPerDay: input?.maxDispatchesPerDay ?? base.maxDispatchesPerDay,
    profile: input?.profile ?? base.profile,
    activeHours:
      input && "activeHours" in input ? (input.activeHours ?? null) : (base.activeHours ?? null),
    primaryCategories: input?.primaryCategories ?? base.primaryCategories,
    proactiveTasks: input?.proactiveTasks ?? base.proactiveTasks,
    updatedAt: now,
  };
}

export class HeartbeatPolicyStore {
  constructor(private db: Database.Database) {}

  private mapRow(row: Any): HeartbeatPolicy {
    return {
      id: row.id,
      agentRoleId: row.agent_role_id,
      enabled: row.enabled === 1,
      cadenceMinutes: row.cadence_minutes || 15,
      staggerOffsetMinutes: row.stagger_offset_minutes || 0,
      dispatchCooldownMinutes: row.dispatch_cooldown_minutes || 120,
      maxDispatchesPerDay: row.max_dispatches_per_day || 6,
      profile: row.profile || "observer",
      activeHours: safeJsonParse<HeartbeatActiveHours | null>(row.active_hours, null),
      primaryCategories: safeJsonParse<CognitiveOffloadCategory[]>(row.primary_categories, []),
      proactiveTasks: safeJsonParse<ProactiveTaskDefinition[]>(row.proactive_tasks, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  findByAgentRoleId(agentRoleId: string): HeartbeatPolicy | undefined {
    const row = this.db
      .prepare("SELECT * FROM heartbeat_policies WHERE agent_role_id = ?")
      .get(agentRoleId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  listAll(): HeartbeatPolicy[] {
    const rows = this.db
      .prepare("SELECT * FROM heartbeat_policies ORDER BY updated_at DESC")
      .all() as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  upsert(agentRoleId: string, input?: HeartbeatPolicyInput): HeartbeatPolicy {
    const existing = this.findByAgentRoleId(agentRoleId);
    const next = mergePolicy(agentRoleId, input, existing);
    if (existing) {
      this.db
        .prepare(
          `UPDATE heartbeat_policies
           SET enabled = ?, cadence_minutes = ?, stagger_offset_minutes = ?,
               dispatch_cooldown_minutes = ?, max_dispatches_per_day = ?,
               profile = ?, active_hours = ?, primary_categories = ?, proactive_tasks = ?,
               updated_at = ?
           WHERE agent_role_id = ?`,
        )
        .run(
          next.enabled ? 1 : 0,
          next.cadenceMinutes,
          next.staggerOffsetMinutes,
          next.dispatchCooldownMinutes,
          next.maxDispatchesPerDay,
          next.profile,
          next.activeHours ? JSON.stringify(next.activeHours) : null,
          JSON.stringify(next.primaryCategories),
          JSON.stringify(next.proactiveTasks),
          next.updatedAt,
          agentRoleId,
        );
      return this.findByAgentRoleId(agentRoleId) || next;
    }

    this.db
      .prepare(
        `INSERT INTO heartbeat_policies (
          id, agent_role_id, enabled, cadence_minutes, stagger_offset_minutes,
          dispatch_cooldown_minutes, max_dispatches_per_day, profile, active_hours,
          primary_categories, proactive_tasks, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next.id,
        next.agentRoleId,
        next.enabled ? 1 : 0,
        next.cadenceMinutes,
        next.staggerOffsetMinutes,
        next.dispatchCooldownMinutes,
        next.maxDispatchesPerDay,
        next.profile,
        next.activeHours ? JSON.stringify(next.activeHours) : null,
        JSON.stringify(next.primaryCategories),
        JSON.stringify(next.proactiveTasks),
        next.createdAt,
        next.updatedAt,
      );
    return next;
  }

  deleteByAgentRoleId(agentRoleId: string): void {
    this.db.prepare("DELETE FROM heartbeat_policies WHERE agent_role_id = ?").run(agentRoleId);
  }
}
