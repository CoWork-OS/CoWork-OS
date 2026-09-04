import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { WorkSessionReadMode, WorkSessionRolloutConfig } from "../../shared/types";

const DEFAULT_SALT = "cowork-work-session-vnext";

export interface WorkSessionRolloutTarget {
  workspaceId: string;
  sessionId?: string;
}

export interface WorkSessionRolloutUpdate {
  enabled?: boolean;
  cohortPercent?: number;
  salt?: string;
  legacyReadRollback?: boolean;
}

function id(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function clampPercent(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(100, Math.max(0, numeric));
}

/** Cohort-gated canonical reads with an instantaneous legacy fallback. */
export class WorkSessionRolloutService {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_session_rollout_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        cohort_percent INTEGER NOT NULL DEFAULT 100,
        salt TEXT NOT NULL DEFAULT '${DEFAULT_SALT}',
        legacy_read_rollback INTEGER NOT NULL DEFAULT 0,
        operator_configured INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    const columns = this.db
      .prepare("PRAGMA table_info(work_session_rollout_config)")
      .all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === "operator_configured")) {
      this.db.exec(
        "ALTER TABLE work_session_rollout_config ADD COLUMN operator_configured INTEGER NOT NULL DEFAULT 0",
      );
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO work_session_rollout_config
         (id, enabled, cohort_percent, salt, legacy_read_rollback, operator_configured, updated_at)
         VALUES (1, 1, 100, ?, 0, 0, ?)`,
      )
      .run(DEFAULT_SALT, this.now());
    // Databases created by the first Phase 5 migration had a disabled
    // placeholder row.  Since rollout is not intentionally gated anymore,
    // promote that untouched row to the safe all-cohort default.  Any
    // operator-edited row is left exactly as configured.
    this.db
      .prepare(
        `UPDATE work_session_rollout_config
         SET enabled = 1, cohort_percent = 100, legacy_read_rollback = 0,
             updated_at = ?
         WHERE id = 1 AND operator_configured = 0 AND enabled = 0 AND cohort_percent = 0`,
      )
      .run(this.now());
  }

  getConfig(): WorkSessionRolloutConfig {
    const row = this.db.prepare("SELECT * FROM work_session_rollout_config WHERE id = 1").get() as
      | Record<string, unknown>
      | undefined;
    return {
      enabled: Number(row?.enabled || 0) === 1,
      cohortPercent: clampPercent(Number(row?.cohort_percent || 0)),
      salt: typeof row?.salt === "string" && row.salt ? row.salt : DEFAULT_SALT,
      legacyReadRollback: Number(row?.legacy_read_rollback || 0) === 1,
      operatorConfigured: Number(row?.operator_configured || 0) === 1,
      updatedAt: Number(row?.updated_at || 0),
    };
  }

  updateConfig(update: WorkSessionRolloutUpdate): WorkSessionRolloutConfig {
    const current = this.getConfig();
    const salt =
      typeof update.salt === "string" && update.salt.trim()
        ? update.salt.trim().slice(0, 128)
        : current.salt;
    this.db
      .prepare(
        `UPDATE work_session_rollout_config
         SET enabled = ?, cohort_percent = ?, salt = ?,
             legacy_read_rollback = ?, operator_configured = 1, updated_at = ?
         WHERE id = 1`,
      )
      .run(
        update.enabled === undefined ? (current.enabled ? 1 : 0) : update.enabled ? 1 : 0,
        update.cohortPercent === undefined
          ? current.cohortPercent
          : clampPercent(update.cohortPercent),
        salt,
        update.legacyReadRollback === undefined
          ? current.legacyReadRollback
            ? 1
            : 0
          : update.legacyReadRollback
            ? 1
            : 0,
        this.now(),
      );
    return this.getConfig();
  }

  setLegacyReadRollback(enabled: boolean): WorkSessionRolloutConfig {
    return this.updateConfig({ legacyReadRollback: enabled });
  }

  cohortBucket(target: WorkSessionRolloutTarget): number {
    const workspaceId = id(target.workspaceId, "workspaceId");
    const sessionId = target.sessionId ? id(target.sessionId, "sessionId") : "*";
    const digest = createHash("sha256")
      .update(`${this.getConfig().salt}:${workspaceId}:${sessionId}`)
      .digest();
    return digest.readUInt32BE(0) % 10_000;
  }

  isVNext(target: WorkSessionRolloutTarget): boolean {
    const config = this.getConfig();
    if (!config.enabled || config.legacyReadRollback || config.cohortPercent <= 0) return false;
    return this.cohortBucket(target) < config.cohortPercent * 100;
  }

  readMode(target: WorkSessionRolloutTarget): WorkSessionReadMode {
    return this.isVNext(target) ? "vnext" : "legacy";
  }

  choose<T>(target: WorkSessionRolloutTarget, vnext: () => T, legacy: () => T): T {
    return this.isVNext(target) ? vnext() : legacy();
  }
}
