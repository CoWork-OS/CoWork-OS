import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { CoreFailureRecord, ListCoreFailureRecordsRequest } from "../../shared/types";

type Any = any;

export class CoreFailureRecordRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<CoreFailureRecord, "id"> & { id?: string }): CoreFailureRecord {
    const record: CoreFailureRecord = {
      ...input,
      id: input.id || randomUUID(),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO core_failure_records (
        id, trace_id, profile_id, workspace_id, target_key, category, severity, fingerprint,
        summary, details, status, source_surface, task_id, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.traceId,
        record.profileId,
        record.workspaceId || null,
        record.targetKey || null,
        record.category,
        record.severity,
        record.fingerprint,
        record.summary,
        record.details || null,
        record.status,
        record.sourceSurface,
        record.taskId || null,
        record.createdAt,
        record.resolvedAt || null,
      );
    return record;
  }

  findById(id: string): CoreFailureRecord | undefined {
    const row = this.db.prepare("SELECT * FROM core_failure_records WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findByTraceId(traceId: string): CoreFailureRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM core_failure_records WHERE trace_id = ? ORDER BY created_at DESC")
      .all(traceId) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  list(request: ListCoreFailureRecordsRequest = {}): CoreFailureRecord[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (request.profileId) {
      conditions.push("profile_id = ?");
      values.push(request.profileId);
    }
    if (request.workspaceId) {
      conditions.push("workspace_id = ?");
      values.push(request.workspaceId);
    }
    if (request.traceId) {
      conditions.push("trace_id = ?");
      values.push(request.traceId);
    }
    if (request.category) {
      conditions.push("category = ?");
      values.push(request.category);
    }
    if (request.status) {
      conditions.push("status = ?");
      values.push(request.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, request.limit ?? 100));
    const rows = this.db
      .prepare(`SELECT * FROM core_failure_records ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, limit) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  update(id: string, updates: Partial<CoreFailureRecord>): CoreFailureRecord | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const mapped: Record<string, string> = {
      traceId: "trace_id",
      profileId: "profile_id",
      workspaceId: "workspace_id",
      targetKey: "target_key",
      category: "category",
      severity: "severity",
      fingerprint: "fingerprint",
      summary: "summary",
      details: "details",
      status: "status",
      sourceSurface: "source_surface",
      taskId: "task_id",
      createdAt: "created_at",
      resolvedAt: "resolved_at",
    };
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(mapped)) {
      if (!(key in updates)) continue;
      fields.push(`${column} = ?`);
      values.push((updates as Any)[key] ?? null);
    }
    if (!fields.length) return existing;
    values.push(id);
    this.db
      .prepare(`UPDATE core_failure_records SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.findById(id);
  }

  private mapRow(row: Any): CoreFailureRecord {
    return {
      id: String(row.id),
      traceId: String(row.trace_id),
      profileId: String(row.profile_id),
      workspaceId: row.workspace_id || undefined,
      targetKey: row.target_key || undefined,
      category: row.category,
      severity: row.severity,
      fingerprint: String(row.fingerprint),
      summary: String(row.summary),
      details: row.details || undefined,
      status: row.status,
      sourceSurface: row.source_surface,
      taskId: row.task_id || undefined,
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
    };
  }
}
