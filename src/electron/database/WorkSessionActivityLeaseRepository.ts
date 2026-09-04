import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type {
  WorkSessionActivityLease,
  WorkSessionActivityLeaseKind,
  WorkSessionActivityLeaseStatus,
} from "../../shared/types";

type DbRow = Record<string, unknown>;

const LEASE_KINDS = new Set<WorkSessionActivityLeaseKind>([
  "llm",
  "tool",
  "retry",
  "wait",
  "join",
  "reconnect",
]);
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 30 * 60_000;
const MAX_KEY_LENGTH = 256;

function requiredId(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function operationKey(value: unknown): string {
  const normalized = requiredId(value, "operationKey");
  if (normalized.length > MAX_KEY_LENGTH) throw new Error("operationKey is too long");
  return normalized;
}

function normalizeKind(value: unknown): WorkSessionActivityLeaseKind {
  return LEASE_KINDS.has(value as WorkSessionActivityLeaseKind)
    ? (value as WorkSessionActivityLeaseKind)
    : "llm";
}

function clampTtl(value: unknown): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(1_000, numeric));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface WorkSessionActivityLeaseAcquireInput {
  sessionId: string;
  turnId?: string;
  kind: WorkSessionActivityLeaseKind;
  operationKey: string;
  ttlMs?: number;
}

export class WorkSessionActivityLeaseError extends Error {
  constructor(
    message: string,
    readonly code = "WORK_SESSION_ACTIVITY_LEASE_ERROR",
  ) {
    super(message);
    this.name = "WorkSessionActivityLeaseError";
  }
}

/** Durable, provider-independent liveness state for long-running work. */
export class WorkSessionActivityLeaseRepository {
  private readonly now: () => number;
  private readonly issuedTokens = new Map<string, string>();
  private sweeperTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: Database.Database,
    options?: { now?: () => number },
  ) {
    this.now = options?.now || Date.now;
  }

  acquire(input: WorkSessionActivityLeaseAcquireInput): WorkSessionActivityLease {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const key = operationKey(input.operationKey);
    const now = this.now();
    this.expireStale(now);
    const existing = this.findRow(sessionId, key);
    if (existing && existing.status === "active") {
      const knownToken = this.issuedTokens.get(String(existing.id));
      return { ...this.map(existing), ...(knownToken ? { token: knownToken } : {}) };
    }

    const token = randomUUID();
    const id = existing?.id ? String(existing.id) : randomUUID();
    const expiresAt = now + clampTtl(input.ttlMs);
    this.db
      .prepare(
        `INSERT INTO work_session_activity_leases (
           id, session_id, turn_id, kind, operation_key, token_hash, status,
           acquired_at, heartbeat_at, expires_at, released_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
         ON CONFLICT(session_id, operation_key) DO UPDATE SET
           id = excluded.id,
           turn_id = excluded.turn_id,
           kind = excluded.kind,
           token_hash = excluded.token_hash,
           status = 'active',
           acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at,
           expires_at = excluded.expires_at,
           released_at = NULL`,
      )
      .run(
        id,
        sessionId,
        input.turnId ? requiredId(input.turnId, "turnId") : null,
        normalizeKind(input.kind),
        key,
        hashToken(token),
        now,
        now,
        expiresAt,
      );
    const row = this.findRow(sessionId, key);
    if (!row) throw new WorkSessionActivityLeaseError("Failed to acquire activity lease");
    this.issuedTokens.set(String(row.id), token);
    return { ...this.map(row), token };
  }

  /**
   * Start a small durable expiry loop.  Lease state is persisted in SQLite so
   * a restarted daemon can observe and reclaim stale work; the loop is only a
   * convenience for promptly marking rows expired while the process is live.
   */
  startSweeper(intervalMs = 5_000): void {
    if (this.sweeperTimer) return;
    const requested = Number.isFinite(intervalMs) ? Math.floor(intervalMs) : 5_000;
    const interval = Math.min(5 * 60_000, Math.max(1_000, requested));
    this.sweeperTimer = setInterval(() => {
      try {
        this.expireStale();
      } catch {
        // A closing database or shutdown race must not keep the event loop
        // alive; the next daemon start will sweep persisted rows again.
      }
    }, interval);
    this.sweeperTimer.unref?.();
  }

  stopSweeper(): void {
    if (!this.sweeperTimer) return;
    clearInterval(this.sweeperTimer);
    this.sweeperTimer = undefined;
  }

  /** Read the session status without materialising the canonical aggregate. */
  getSessionStatus(sessionId: string): string | undefined {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const row = this.db
      .prepare("SELECT status FROM work_sessions WHERE id = ?")
      .get(normalizedSessionId) as { status?: unknown } | undefined;
    return typeof row?.status === "string" ? row.status : undefined;
  }

  /**
   * Rotate a stale lease after a reconnect.  A fresh lease is never stolen:
   * callers receive ACTIVE_NOT_STALE until its expiry/heartbeat deadline has
   * passed.  The raw token is returned only to the caller and is never stored
   * in the database.
   */
  reclaim(input: WorkSessionActivityLeaseAcquireInput): WorkSessionActivityLease {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const key = operationKey(input.operationKey);
    const now = this.now();
    this.expireStale(now);
    const existing = this.findRow(sessionId, key);
    if (existing && existing.status === "active") {
      const ttlMs = clampTtl(input.ttlMs);
      const heartbeatAt = Number(existing.heartbeat_at || 0);
      const expiresAt = Number(existing.expires_at || 0);
      const staleAfter = Math.max(1_000, Math.floor(ttlMs / 2));
      if (expiresAt > now && now - heartbeatAt < staleAfter) {
        throw new WorkSessionActivityLeaseError(
          "Activity lease is still active",
          "ACTIVE_NOT_STALE",
        );
      }
      this.db
        .prepare(
          `UPDATE work_session_activity_leases
           SET status = 'expired', released_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(now, String(existing.id));
      this.issuedTokens.delete(String(existing.id));
    }
    return this.acquire(input);
  }

  renew(id: string, token: string, ttlMs?: number): WorkSessionActivityLease {
    const normalizedId = requiredId(id, "leaseId");
    const normalizedToken = requiredId(token, "token");
    const row = this.findById(normalizedId);
    if (!row) throw new WorkSessionActivityLeaseError("Activity lease not found", "NOT_FOUND");
    const now = this.now();
    if (row.status !== "active" || Number(row.expires_at || 0) <= now) {
      this.expireStale(now);
      throw new WorkSessionActivityLeaseError("Activity lease is expired", "EXPIRED");
    }
    if (String(row.token_hash) !== hashToken(normalizedToken)) {
      throw new WorkSessionActivityLeaseError("Activity lease token mismatch", "TOKEN_MISMATCH");
    }
    const expiresAt = now + clampTtl(ttlMs);
    this.db
      .prepare(
        `UPDATE work_session_activity_leases
         SET heartbeat_at = ?, expires_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(now, expiresAt, normalizedId);
    const updated = this.findById(normalizedId);
    if (!updated) throw new WorkSessionActivityLeaseError("Activity lease disappeared");
    this.issuedTokens.set(normalizedId, normalizedToken);
    return { ...this.map(updated), token: normalizedToken };
  }

  release(
    id: string,
    token: string,
    status: Extract<WorkSessionActivityLeaseStatus, "released" | "expired"> = "released",
  ): WorkSessionActivityLease {
    const normalizedId = requiredId(id, "leaseId");
    const normalizedToken = requiredId(token, "token");
    const row = this.findById(normalizedId);
    if (!row) throw new WorkSessionActivityLeaseError("Activity lease not found", "NOT_FOUND");
    if (String(row.token_hash) !== hashToken(normalizedToken)) {
      throw new WorkSessionActivityLeaseError("Activity lease token mismatch", "TOKEN_MISMATCH");
    }
    if (row.status === "active") {
      this.db
        .prepare(
          `UPDATE work_session_activity_leases
           SET status = ?, released_at = ?, heartbeat_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(status, this.now(), this.now(), normalizedId);
    }
    const updated = this.findById(normalizedId);
    if (!updated) throw new WorkSessionActivityLeaseError("Activity lease disappeared");
    this.issuedTokens.delete(normalizedId);
    return this.map(updated);
  }

  /** Release an existing activity by its durable operation identity. */
  releaseByOperationKey(
    sessionId: string,
    key: string,
    status: Extract<WorkSessionActivityLeaseStatus, "released" | "expired"> = "released",
  ): WorkSessionActivityLease | undefined {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const normalizedKey = operationKey(key);
    const now = this.now();
    this.expireStale(now);
    const existing = this.findRow(normalizedSessionId, normalizedKey);
    if (!existing) return undefined;
    if (existing.status === "active") {
      this.db
        .prepare(
          `UPDATE work_session_activity_leases
           SET status = ?, released_at = ?, heartbeat_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(status, now, now, String(existing.id));
    }
    const updated = this.findRow(normalizedSessionId, normalizedKey);
    if (!updated) return undefined;
    this.issuedTokens.delete(String(updated.id));
    return this.map(updated);
  }

  /** Internal terminal cleanup; callers cannot use this to renew or execute work. */
  releaseSession(sessionId: string): number {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const now = this.now();
    const active = this.db
      .prepare(
        `SELECT id FROM work_session_activity_leases
         WHERE session_id = ? AND status = 'active'`,
      )
      .all(normalizedSessionId) as Array<{ id?: string }>;
    const result = this.db
      .prepare(
        `UPDATE work_session_activity_leases
         SET status = 'released', released_at = ?
         WHERE session_id = ? AND status = 'active'`,
      )
      .run(now, normalizedSessionId);
    for (const row of active) if (row.id) this.issuedTokens.delete(row.id);
    return Number(result.changes || 0);
  }

  /** Resolve restartable wait/join leases when a generic resume event arrives. */
  releaseKinds(sessionId: string, kinds: WorkSessionActivityLeaseKind[]): number {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const normalizedKinds = [...new Set(kinds.filter((kind) => LEASE_KINDS.has(kind)))];
    if (normalizedKinds.length === 0) return 0;
    const placeholders = normalizedKinds.map(() => "?").join(", ");
    const now = this.now();
    const active = this.db
      .prepare(
        `SELECT id FROM work_session_activity_leases
         WHERE session_id = ? AND status = 'active' AND kind IN (${placeholders})`,
      )
      .all(normalizedSessionId, ...normalizedKinds) as Array<{ id?: string }>;
    const result = this.db
      .prepare(
        `UPDATE work_session_activity_leases
         SET status = 'released', released_at = ?
         WHERE session_id = ? AND status = 'active' AND kind IN (${placeholders})`,
      )
      .run(now, normalizedSessionId, ...normalizedKinds);
    for (const row of active) if (row.id) this.issuedTokens.delete(row.id);
    return Number(result.changes || 0);
  }

  expireStale(now = this.now()): number {
    const stale = this.db
      .prepare(
        `SELECT id FROM work_session_activity_leases
         WHERE status = 'active' AND expires_at <= ?`,
      )
      .all(now) as Array<{ id?: unknown }>;
    const result = this.db
      .prepare(
        `UPDATE work_session_activity_leases
         SET status = 'expired', released_at = ?
         WHERE status = 'active' AND expires_at <= ?`,
      )
      .run(now, now);
    for (const row of stale) {
      if (row.id != null) this.issuedTokens.delete(String(row.id));
    }
    return Number(result.changes || 0);
  }

  listActive(sessionId?: string): WorkSessionActivityLease[] {
    this.expireStale();
    if (sessionId) {
      return (
        this.db
          .prepare(
            `SELECT * FROM work_session_activity_leases
             WHERE session_id = ? AND status = 'active' ORDER BY acquired_at ASC`,
          )
          .all(requiredId(sessionId, "sessionId")) as DbRow[]
      ).map((row) => this.map(row));
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM work_session_activity_leases
         WHERE status = 'active' ORDER BY acquired_at ASC`,
        )
        .all() as DbRow[]
    ).map((row) => this.map(row));
  }

  private findRow(sessionId: string, key: string): DbRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM work_session_activity_leases
         WHERE session_id = ? AND operation_key = ?`,
      )
      .get(sessionId, key) as DbRow | undefined;
  }

  private findById(id: string): DbRow | undefined {
    return this.db.prepare("SELECT * FROM work_session_activity_leases WHERE id = ?").get(id) as
      | DbRow
      | undefined;
  }

  private map(row: DbRow): WorkSessionActivityLease {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      ...(typeof row.turn_id === "string" && row.turn_id ? { turnId: row.turn_id } : {}),
      kind: normalizeKind(row.kind),
      operationKey: String(row.operation_key),
      status: (typeof row.status === "string"
        ? row.status
        : "active") as WorkSessionActivityLeaseStatus,
      acquiredAt: Number(row.acquired_at || 0),
      heartbeatAt: Number(row.heartbeat_at || 0),
      expiresAt: Number(row.expires_at || 0),
      ...(row.released_at == null ? {} : { releasedAt: Number(row.released_at) }),
    };
  }
}
