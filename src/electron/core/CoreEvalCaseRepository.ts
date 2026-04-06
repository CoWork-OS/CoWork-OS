import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  CoreEvalCase,
  ListCoreEvalCasesRequest,
} from "../../shared/types";

type Any = any;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class CoreEvalCaseRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<CoreEvalCase, "id"> & { id?: string }): CoreEvalCase {
    const item: CoreEvalCase = {
      ...input,
      id: input.id || randomUUID(),
    };
    this.db.prepare(
      `INSERT OR REPLACE INTO core_eval_cases (
        id, profile_id, workspace_id, cluster_id, title, spec_json, status,
        pass_count, fail_count, last_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.id,
      item.profileId,
      item.workspaceId || null,
      item.clusterId,
      item.title,
      JSON.stringify(item.spec || {}),
      item.status,
      item.passCount,
      item.failCount,
      item.lastRunAt || null,
      item.createdAt,
      item.updatedAt,
    );
    return item;
  }

  findById(id: string): CoreEvalCase | undefined {
    const row = this.db.prepare("SELECT * FROM core_eval_cases WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findByClusterId(clusterId: string): CoreEvalCase | undefined {
    const row = this.db.prepare("SELECT * FROM core_eval_cases WHERE cluster_id = ? LIMIT 1").get(clusterId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(request: ListCoreEvalCasesRequest = {}): CoreEvalCase[] {
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
    if (request.clusterId) {
      conditions.push("cluster_id = ?");
      values.push(request.clusterId);
    }
    if (request.status) {
      conditions.push("status = ?");
      values.push(request.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, request.limit ?? 100));
    const rows = this.db.prepare(
      `SELECT * FROM core_eval_cases ${where} ORDER BY updated_at DESC LIMIT ?`,
    ).all(...values, limit) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  update(id: string, updates: Partial<CoreEvalCase>): CoreEvalCase | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const mapped: Record<string, string> = {
      profileId: "profile_id",
      workspaceId: "workspace_id",
      clusterId: "cluster_id",
      title: "title",
      spec: "spec_json",
      status: "status",
      passCount: "pass_count",
      failCount: "fail_count",
      lastRunAt: "last_run_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    };
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(mapped)) {
      if (!(key in updates)) continue;
      fields.push(`${column} = ?`);
      values.push(key === "spec" ? JSON.stringify((updates as Any)[key] || {}) : (updates as Any)[key] ?? null);
    }
    if (!fields.length) return existing;
    values.push(id);
    this.db.prepare(`UPDATE core_eval_cases SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  recordRun(caseId: string, params: { passed: boolean; summary: string; details?: Record<string, unknown> }): void {
    const existing = this.findById(caseId);
    if (!existing) return;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO core_eval_case_runs (id, case_id, passed, summary, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      caseId,
      params.passed ? 1 : 0,
      params.summary,
      params.details ? JSON.stringify(params.details) : null,
      now,
    );
    this.update(caseId, {
      passCount: existing.passCount + (params.passed ? 1 : 0),
      failCount: existing.failCount + (params.passed ? 0 : 1),
      lastRunAt: now,
      updatedAt: now,
      status: params.passed ? (existing.status === "draft" ? "active" : existing.status) : "failing",
    });
  }

  private mapRow(row: Any): CoreEvalCase {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      workspaceId: row.workspace_id || undefined,
      clusterId: String(row.cluster_id),
      title: String(row.title),
      spec: parseJson<Record<string, unknown>>(row.spec_json, {}),
      status: row.status,
      passCount: Number(row.pass_count || 0),
      failCount: Number(row.fail_count || 0),
      lastRunAt: row.last_run_at ? Number(row.last_run_at) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
