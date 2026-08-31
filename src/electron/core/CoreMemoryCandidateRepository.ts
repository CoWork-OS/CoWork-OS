import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  CoreMemoryCandidate,
  ListCoreMemoryCandidatesRequest,
  ReviewCoreMemoryCandidateRequest,
} from "../../shared/types";

type Any = any;

export class CoreMemoryCandidateRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    input: Omit<CoreMemoryCandidate, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): CoreMemoryCandidate {
    const candidate: CoreMemoryCandidate = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO core_memory_candidates (
          id, trace_id, profile_id, workspace_id, scope_kind, scope_ref, candidate_type,
          summary, details, confidence, novelty_score, stability_score, status, resolution,
          source_run_id, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.id,
        candidate.traceId,
        candidate.profileId,
        candidate.workspaceId || null,
        candidate.scopeKind,
        candidate.scopeRef,
        candidate.candidateType,
        candidate.summary,
        candidate.details || null,
        candidate.confidence,
        candidate.noveltyScore,
        candidate.stabilityScore,
        candidate.status,
        candidate.resolution || null,
        candidate.sourceRunId || null,
        candidate.createdAt,
        candidate.resolvedAt || null,
      );
    return candidate;
  }

  bulkCreate(
    inputs: Array<
      Omit<CoreMemoryCandidate, "id" | "createdAt"> & { id?: string; createdAt?: number }
    >,
  ): CoreMemoryCandidate[] {
    const tx = this.db.transaction((items: typeof inputs) =>
      items.map((item) => this.create(item)),
    );
    return tx(inputs);
  }

  findById(id: string): CoreMemoryCandidate | undefined {
    const row = this.db.prepare("SELECT * FROM core_memory_candidates WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(request: ListCoreMemoryCandidatesRequest = {}): CoreMemoryCandidate[] {
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
    if (request.scopeKind) {
      conditions.push("scope_kind = ?");
      values.push(request.scopeKind);
    }
    if (request.status) {
      conditions.push("status = ?");
      values.push(request.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, request.limit ?? 100));
    const rows = this.db
      .prepare(
        `SELECT * FROM core_memory_candidates ${where}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...values, limit) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  listForTrace(traceId: string): CoreMemoryCandidate[] {
    return this.list({ traceId, limit: 200 });
  }

  review(request: ReviewCoreMemoryCandidateRequest): CoreMemoryCandidate | undefined {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE core_memory_candidates
         SET status = ?, resolution = ?, resolved_at = ?
         WHERE id = ?`,
      )
      .run(request.status, request.resolution || null, now, request.id);
    return this.findById(request.id);
  }

  private mapRow(row: Any): CoreMemoryCandidate {
    return {
      id: String(row.id),
      traceId: String(row.trace_id),
      profileId: String(row.profile_id),
      workspaceId: row.workspace_id || undefined,
      scopeKind: row.scope_kind,
      scopeRef: String(row.scope_ref),
      candidateType: row.candidate_type,
      summary: String(row.summary),
      details: row.details || undefined,
      confidence: Number(row.confidence),
      noveltyScore: Number(row.novelty_score),
      stabilityScore: Number(row.stability_score),
      status: row.status,
      resolution: row.resolution || undefined,
      sourceRunId: row.source_run_id || undefined,
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
    };
  }
}
