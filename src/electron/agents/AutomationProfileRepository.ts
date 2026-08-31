import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  AutomationProfile,
  CreateAutomationProfileRequest,
  HeartbeatActiveHours,
  HeartbeatConfig,
  HeartbeatDispatchKind,
  HeartbeatPulseResultKind,
  HeartbeatStatus,
  UpdateAutomationProfileRequest,
} from "../../shared/types";
import { createLogger } from "../utils/logger";

type Any = any;
const logger = createLogger("AutomationProfileRepository");

function safeJsonParse<T>(jsonString: string | null, fallback: T): T {
  if (!jsonString) return fallback;
  try {
    return JSON.parse(jsonString) as T;
  } catch {
    return fallback;
  }
}

function normalizeInput(
  input?: Partial<
    CreateAutomationProfileRequest & UpdateAutomationProfileRequest & HeartbeatConfig
  >,
): Omit<
  AutomationProfile,
  | "id"
  | "agentRoleId"
  | "heartbeatStatus"
  | "lastHeartbeatAt"
  | "lastPulseAt"
  | "lastDispatchAt"
  | "lastPulseResult"
  | "lastDispatchKind"
  | "createdAt"
  | "updatedAt"
> {
  return {
    enabled: input?.enabled ?? input?.heartbeatEnabled ?? false,
    cadenceMinutes:
      input?.cadenceMinutes ?? input?.pulseEveryMinutes ?? input?.heartbeatIntervalMinutes ?? 15,
    staggerOffsetMinutes: input?.staggerOffsetMinutes ?? input?.heartbeatStaggerOffset ?? 0,
    dispatchCooldownMinutes: input?.dispatchCooldownMinutes ?? 120,
    maxDispatchesPerDay: input?.maxDispatchesPerDay ?? 6,
    profile: input?.profile ?? input?.heartbeatProfile ?? "observer",
    activeHours: input && "activeHours" in input ? (input.activeHours ?? null) : null,
  };
}

export class AutomationProfileRepository {
  constructor(private readonly db: Database.Database) {}

  private profileHasHistoricalDependencies(profileId: string): boolean {
    const tables = [
      "core_traces",
      "core_memory_candidates",
      "core_memory_distill_runs",
      "core_failure_records",
      "core_failure_clusters",
      "core_eval_cases",
      "core_harness_experiments",
      "core_learnings_log",
    ];
    for (const table of tables) {
      try {
        const row = this.db
          .prepare(`SELECT 1 FROM ${table} WHERE profile_id = ? LIMIT 1`)
          .get(profileId) as { 1?: number } | undefined;
        if (row) {
          return true;
        }
      } catch {
        // Table may not exist on older schema versions.
      }
    }
    return false;
  }

  private disableInsteadOfDelete(profileId: string): void {
    this.db
      .prepare("UPDATE automation_profiles SET enabled = 0, updated_at = ? WHERE id = ?")
      .run(Date.now(), profileId);
  }

  private mapRow(row: Any): AutomationProfile {
    return {
      id: String(row.id),
      agentRoleId: String(row.agent_role_id),
      enabled: row.enabled === 1,
      cadenceMinutes: Number(row.cadence_minutes || 15),
      staggerOffsetMinutes: Number(row.stagger_offset_minutes || 0),
      dispatchCooldownMinutes: Number(row.dispatch_cooldown_minutes || 120),
      maxDispatchesPerDay: Number(row.max_dispatches_per_day || 6),
      profile: row.profile || "observer",
      activeHours: safeJsonParse<HeartbeatActiveHours | null>(row.active_hours, null),
      heartbeatStatus: (row.heartbeat_status as HeartbeatStatus) || "idle",
      lastHeartbeatAt: row.last_heartbeat_at ? Number(row.last_heartbeat_at) : undefined,
      lastPulseAt: row.last_pulse_at ? Number(row.last_pulse_at) : undefined,
      lastDispatchAt: row.last_dispatch_at ? Number(row.last_dispatch_at) : undefined,
      lastPulseResult:
        (row.heartbeat_last_pulse_result as HeartbeatPulseResultKind | null) || undefined,
      lastDispatchKind:
        (row.heartbeat_last_dispatch_kind as HeartbeatDispatchKind | null) || undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  listAll(): AutomationProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM automation_profiles ORDER BY updated_at DESC")
      .all() as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  listEnabled(): AutomationProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM automation_profiles WHERE enabled = 1 ORDER BY updated_at DESC")
      .all() as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  findById(id: string): AutomationProfile | undefined {
    const row = this.db.prepare("SELECT * FROM automation_profiles WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findByAgentRoleId(agentRoleId: string): AutomationProfile | undefined {
    const row = this.db
      .prepare("SELECT * FROM automation_profiles WHERE agent_role_id = ?")
      .get(agentRoleId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  create(request: CreateAutomationProfileRequest): AutomationProfile {
    const now = Date.now();
    const normalized = normalizeInput(request);
    const profile: AutomationProfile = {
      id: uuidv4(),
      agentRoleId: request.agentRoleId,
      heartbeatStatus: "idle",
      createdAt: now,
      updatedAt: now,
      ...normalized,
    };
    this.db
      .prepare(
        `INSERT INTO automation_profiles (
          id, agent_role_id, enabled, cadence_minutes, stagger_offset_minutes,
          dispatch_cooldown_minutes, max_dispatches_per_day, profile, active_hours,
          heartbeat_status, last_heartbeat_at, last_pulse_at, last_dispatch_at,
          heartbeat_last_pulse_result, heartbeat_last_dispatch_kind, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        profile.id,
        profile.agentRoleId,
        profile.enabled ? 1 : 0,
        profile.cadenceMinutes,
        profile.staggerOffsetMinutes,
        profile.dispatchCooldownMinutes,
        profile.maxDispatchesPerDay,
        profile.profile,
        profile.activeHours ? JSON.stringify(profile.activeHours) : null,
        profile.heartbeatStatus,
        profile.createdAt,
        profile.updatedAt,
      );
    return profile;
  }

  createOrReplace(request: CreateAutomationProfileRequest): AutomationProfile {
    const existing = this.findByAgentRoleId(request.agentRoleId);
    if (existing) {
      return this.update({
        id: existing.id,
        ...request,
      })!;
    }
    return this.create(request);
  }

  update(
    request: UpdateAutomationProfileRequest & { agentRoleId?: string },
  ): AutomationProfile | undefined {
    const existing = this.findById(request.id);
    if (!existing) return undefined;
    const normalized = normalizeInput({ ...existing, ...request });
    const updatedAt = Date.now();
    this.db
      .prepare(
        `UPDATE automation_profiles
         SET enabled = ?, cadence_minutes = ?, stagger_offset_minutes = ?,
             dispatch_cooldown_minutes = ?, max_dispatches_per_day = ?, profile = ?,
             active_hours = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        normalized.enabled ? 1 : 0,
        normalized.cadenceMinutes,
        normalized.staggerOffsetMinutes,
        normalized.dispatchCooldownMinutes,
        normalized.maxDispatchesPerDay,
        normalized.profile,
        normalized.activeHours ? JSON.stringify(normalized.activeHours) : null,
        updatedAt,
        request.id,
      );
    return this.findById(request.id);
  }

  updateByAgentRoleId(agentRoleId: string, config: HeartbeatConfig): AutomationProfile | undefined {
    const existing = this.findByAgentRoleId(agentRoleId);
    if (!existing) return undefined;
    return this.update({ id: existing.id, ...config });
  }

  updateRuntimeState(
    agentRoleId: string,
    updates: {
      heartbeatStatus?: HeartbeatStatus;
      lastHeartbeatAt?: number;
      lastPulseAt?: number;
      lastDispatchAt?: number;
      lastPulseResult?: HeartbeatPulseResultKind;
      lastDispatchKind?: HeartbeatDispatchKind;
    },
  ): void {
    const fields: string[] = ["updated_at = ?"];
    const values: Any[] = [Date.now()];
    if (updates.heartbeatStatus !== undefined) {
      fields.push("heartbeat_status = ?");
      values.push(updates.heartbeatStatus);
    }
    if (updates.lastHeartbeatAt !== undefined) {
      fields.push("last_heartbeat_at = ?");
      values.push(updates.lastHeartbeatAt);
    }
    if (updates.lastPulseAt !== undefined) {
      fields.push("last_pulse_at = ?");
      values.push(updates.lastPulseAt);
    }
    if (updates.lastDispatchAt !== undefined) {
      fields.push("last_dispatch_at = ?");
      values.push(updates.lastDispatchAt);
    }
    if (updates.lastPulseResult !== undefined) {
      fields.push("heartbeat_last_pulse_result = ?");
      values.push(updates.lastPulseResult);
    }
    if (updates.lastDispatchKind !== undefined) {
      fields.push("heartbeat_last_dispatch_kind = ?");
      values.push(updates.lastDispatchKind);
    }
    values.push(agentRoleId);
    this.db
      .prepare(`UPDATE automation_profiles SET ${fields.join(", ")} WHERE agent_role_id = ?`)
      .run(...values);
  }

  deleteById(id: string): void {
    if (this.profileHasHistoricalDependencies(id)) {
      logger.warn(
        `Preserving automation profile ${id} because it owns core history; disabling instead.`,
      );
      this.disableInsteadOfDelete(id);
      return;
    }
    this.db.prepare("DELETE FROM automation_profiles WHERE id = ?").run(id);
  }

  deleteByAgentRoleId(agentRoleId: string): void {
    const existing = this.findByAgentRoleId(agentRoleId);
    if (!existing) {
      return;
    }
    this.deleteById(existing.id);
  }
}
