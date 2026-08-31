import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { CoreMemoryDistillRun, ListCoreMemoryDistillRunsRequest } from "../../shared/types";

type Any = any;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class CoreMemoryDistillRunRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<CoreMemoryDistillRun, "id"> & { id?: string }): CoreMemoryDistillRun {
    const run: CoreMemoryDistillRun = {
      ...input,
      id: input.id || randomUUID(),
    };
    this.db
      .prepare(
        `INSERT INTO core_memory_distill_runs (
          id, profile_id, workspace_id, mode, source_trace_count, candidate_count,
          accepted_count, pruned_count, status, summary_json, error, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.profileId,
        run.workspaceId || null,
        run.mode,
        run.sourceTraceCount,
        run.candidateCount,
        run.acceptedCount,
        run.prunedCount,
        run.status,
        run.summary ? JSON.stringify(run.summary) : null,
        run.error || null,
        run.startedAt,
        run.completedAt || null,
      );
    return run;
  }

  update(id: string, updates: Partial<CoreMemoryDistillRun>): CoreMemoryDistillRun | undefined {
    const fields: string[] = [];
    const values: unknown[] = [];
    const mapped: Record<string, string> = {
      profileId: "profile_id",
      workspaceId: "workspace_id",
      mode: "mode",
      sourceTraceCount: "source_trace_count",
      candidateCount: "candidate_count",
      acceptedCount: "accepted_count",
      prunedCount: "pruned_count",
      status: "status",
      summary: "summary_json",
      error: "error",
      startedAt: "started_at",
      completedAt: "completed_at",
    };
    for (const [key, column] of Object.entries(mapped)) {
      if (!(key in updates)) continue;
      const raw = (updates as Any)[key];
      fields.push(`${column} = ?`);
      values.push(key === "summary" && raw ? JSON.stringify(raw) : (raw ?? null));
    }
    if (!fields.length) return this.findById(id);
    values.push(id);
    this.db
      .prepare(`UPDATE core_memory_distill_runs SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.findById(id);
  }

  findById(id: string): CoreMemoryDistillRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM core_memory_distill_runs WHERE id = ?")
      .get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(request: ListCoreMemoryDistillRunsRequest): CoreMemoryDistillRun[] {
    const conditions = ["profile_id = ?"];
    const values: unknown[] = [request.profileId];
    if (request.workspaceId) {
      conditions.push("workspace_id = ?");
      values.push(request.workspaceId);
    }
    const limit = Math.max(1, Math.min(200, request.limit ?? 20));
    const rows = this.db
      .prepare(
        `SELECT * FROM core_memory_distill_runs
         WHERE ${conditions.join(" AND ")}
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(...values, limit) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Any): CoreMemoryDistillRun {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      workspaceId: row.workspace_id || undefined,
      mode: row.mode,
      sourceTraceCount: Number(row.source_trace_count || 0),
      candidateCount: Number(row.candidate_count || 0),
      acceptedCount: Number(row.accepted_count || 0),
      prunedCount: Number(row.pruned_count || 0),
      status: row.status,
      summary: parseJson<Record<string, unknown> | undefined>(row.summary_json, undefined),
      error: row.error || undefined,
      startedAt: Number(row.started_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
    };
  }
}
