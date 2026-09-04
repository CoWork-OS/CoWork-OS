import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { WorkSessionOperationalMetric } from "../../shared/types";

type DbRow = Record<string, unknown>;

const MAX_NAME_LENGTH = 128;
const MAX_UNIT_LENGTH = 32;
const MAX_DIMENSION_KEYS = 16;
const MAX_DIMENSION_VALUE_LENGTH = 128;
const MAX_DIMENSIONS_BYTES = 2_048;
const DEFAULT_RETENTION_PER_SCOPE = 1_000;
const SENSITIVE_KEY =
  /(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;
const SECRET_VALUE =
  /(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|bearer\s+[A-Za-z0-9._-]{12,})/i;

function optionalId(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function bounded(value: unknown, max: number): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized.slice(0, max) : undefined;
}

function parseDimensions(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (entries.length >= MAX_DIMENSION_KEYS || SENSITIVE_KEY.test(rawKey)) continue;
    const key = bounded(rawKey, 64);
    const text = bounded(
      typeof rawValue === "string" ? rawValue : String(rawValue),
      MAX_DIMENSION_VALUE_LENGTH,
    );
    if (
      !key ||
      !text ||
      SENSITIVE_KEY.test(key) ||
      SENSITIVE_KEY.test(text) ||
      SECRET_VALUE.test(text)
    )
      continue;
    entries.push([key, text]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  let result = Object.fromEntries(entries);
  while (
    Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_DIMENSIONS_BYTES &&
    entries.length > 0
  ) {
    entries.pop();
    result = Object.fromEntries(entries);
  }
  return result;
}

export interface WorkSessionOperationalMetricInput {
  sessionId?: string;
  workspaceId?: string;
  name: string;
  value: number;
  unit?: string;
  dimensions?: Record<string, string>;
  idempotencyKey?: string;
  recordedAt?: number;
}

/**
 * Bounded operational telemetry.  These rows intentionally never enter the
 * user-visible WorkSession item stream or transcript.
 */
export class WorkSessionOperationalMetricsRepository {
  private readonly now: () => number;
  private readonly retentionPerScope: number;

  constructor(
    private readonly db: Database.Database,
    options?: { now?: () => number; retentionPerScope?: number },
  ) {
    this.now = options?.now || Date.now;
    this.retentionPerScope = Math.min(
      10_000,
      Math.max(10, Math.floor(options?.retentionPerScope || DEFAULT_RETENTION_PER_SCOPE)),
    );
  }

  record(input: WorkSessionOperationalMetricInput): WorkSessionOperationalMetric {
    const name = bounded(input.name, MAX_NAME_LENGTH);
    if (!name) throw new Error("metric name is required");
    if (!Number.isFinite(input.value)) throw new Error("metric value must be finite");
    const sessionId = optionalId(input.sessionId);
    const workspaceId = optionalId(input.workspaceId);
    const idempotencyKey = bounded(input.idempotencyKey, 256);
    if (sessionId && idempotencyKey) {
      const existing = this.findByIdempotency(sessionId, idempotencyKey);
      if (existing) return existing;
    }
    const recordedAt = Number.isFinite(input.recordedAt)
      ? Math.floor(input.recordedAt!)
      : this.now();
    const dimensions = parseDimensions(input.dimensions);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO work_session_operational_metrics (
           id, session_id, workspace_id, name, value, unit,
           dimensions_json, idempotency_key, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId || null,
        workspaceId || null,
        name,
        Math.max(-1e15, Math.min(1e15, input.value)),
        bounded(input.unit, MAX_UNIT_LENGTH) || null,
        JSON.stringify(dimensions),
        idempotencyKey || null,
        recordedAt,
      );
    this.prune(sessionId, workspaceId);
    const row = this.db
      .prepare("SELECT * FROM work_session_operational_metrics WHERE id = ?")
      .get(id) as DbRow | undefined;
    if (!row) throw new Error("Failed to record operational metric");
    return this.map(row);
  }

  list(options?: {
    sessionId?: string;
    workspaceId?: string;
    name?: string;
    limit?: number;
    since?: number;
  }): WorkSessionOperationalMetric[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const sessionId = optionalId(options?.sessionId);
    const workspaceId = optionalId(options?.workspaceId);
    if (sessionId) {
      clauses.push("session_id = ?");
      params.push(sessionId);
    }
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    const name = bounded(options?.name, MAX_NAME_LENGTH);
    if (name) {
      clauses.push("name = ?");
      params.push(name);
    }
    if (typeof options?.since === "number" && Number.isFinite(options.since)) {
      clauses.push("recorded_at >= ?");
      params.push(Math.floor(options.since));
    }
    const limit = Math.min(10_000, Math.max(1, Math.floor(options?.limit || 1_000)));
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM work_session_operational_metrics
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY recorded_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as DbRow[];
    return rows.map((row) => this.map(row));
  }

  summarize(options?: { sessionId?: string; workspaceId?: string; since?: number }): Array<{
    name: string;
    count: number;
    sum: number;
    min: number;
    max: number;
  }> {
    const metrics = this.list({ ...options, limit: 10_000 });
    const grouped = new Map<
      string,
      { name: string; count: number; sum: number; min: number; max: number }
    >();
    for (const metric of metrics) {
      const current = grouped.get(metric.name) || {
        name: metric.name,
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
      };
      current.count += 1;
      current.sum += metric.value;
      current.min = Math.min(current.min, metric.value);
      current.max = Math.max(current.max, metric.value);
      grouped.set(metric.name, current);
    }
    return [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  prune(sessionId?: string, workspaceId?: string): number {
    let changes = 0;
    if (sessionId) {
      const result = this.db
        .prepare(
          `DELETE FROM work_session_operational_metrics
           WHERE session_id = ? AND id NOT IN (
             SELECT id FROM work_session_operational_metrics
             WHERE session_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?
           )`,
        )
        .run(sessionId, sessionId, this.retentionPerScope);
      changes += Number(result.changes || 0);
    }
    if (workspaceId) {
      const result = this.db
        .prepare(
          `DELETE FROM work_session_operational_metrics
           WHERE workspace_id = ? AND id NOT IN (
             SELECT id FROM work_session_operational_metrics
             WHERE workspace_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?
           )`,
        )
        .run(workspaceId, workspaceId, this.retentionPerScope);
      changes += Number(result.changes || 0);
    }
    // Process-wide diagnostics (which intentionally have no user/session
    // scope) need the same bounded retention as scoped rows.  Without this
    // branch a long-lived daemon could grow the operational table forever.
    if (!sessionId && !workspaceId) {
      const result = this.db
        .prepare(
          `DELETE FROM work_session_operational_metrics
           WHERE session_id IS NULL AND workspace_id IS NULL AND id NOT IN (
             SELECT id FROM work_session_operational_metrics
             WHERE session_id IS NULL AND workspace_id IS NULL
             ORDER BY recorded_at DESC, rowid DESC LIMIT ?
           )`,
        )
        .run(this.retentionPerScope);
      changes += Number(result.changes || 0);
    }
    return changes;
  }

  private findByIdempotency(
    sessionId: string,
    idempotencyKey: string,
  ): WorkSessionOperationalMetric | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM work_session_operational_metrics
         WHERE session_id = ? AND idempotency_key = ?`,
      )
      .get(sessionId, idempotencyKey) as DbRow | undefined;
    return row ? this.map(row) : undefined;
  }

  private map(row: DbRow): WorkSessionOperationalMetric {
    let dimensions: Record<string, string> = {};
    try {
      const parsed = JSON.parse(String(row.dimensions_json || "{}"));
      dimensions = parseDimensions(parsed);
    } catch {
      dimensions = {};
    }
    return {
      id: String(row.id),
      ...(typeof row.session_id === "string" && row.session_id
        ? { sessionId: row.session_id }
        : {}),
      ...(typeof row.workspace_id === "string" && row.workspace_id
        ? { workspaceId: row.workspace_id }
        : {}),
      name: String(row.name),
      value: Number(row.value || 0),
      ...(typeof row.unit === "string" && row.unit ? { unit: row.unit } : {}),
      dimensions,
      ...(typeof row.idempotency_key === "string" && row.idempotency_key
        ? { idempotencyKey: row.idempotency_key }
        : {}),
      recordedAt: Number(row.recorded_at || 0),
    };
  }
}
