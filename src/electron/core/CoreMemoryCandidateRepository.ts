import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  CoreMemoryCandidate,
  CoreMemoryCandidateStatus,
  ListCoreMemoryCandidatesRequest,
  ReviewCoreMemoryCandidateRequest,
} from "../../shared/types";
import { normalizeCandidateSummary } from "./core-memory-hygiene";

type Any = any;

/** Which existing duplicate absorbs a new candidate: a user's rejection wins, then the most advanced state. */
const UPSERT_STATUS_RANK: Record<CoreMemoryCandidateStatus, number> = {
  rejected: 4,
  applied: 3,
  accepted: 2,
  proposed: 1,
  merged: 0,
  skipped: 0,
  dismissed: 0,
};

export class CoreMemoryCandidateStore {
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

  /**
   * Inserts candidates unless one with the same fingerprint (profile, scope, type and
   * normalized summary) already exists. An existing open, accepted or applied candidate is
   * reinforced instead: it moves to the newest trace and keeps the strongest scores, so it
   * is reviewed and written once. A rejected match suppresses the new candidate.
   */
  upsertByFingerprint(
    inputs: Array<
      Omit<CoreMemoryCandidate, "id" | "createdAt"> & { id?: string; createdAt?: number }
    >,
  ): CoreMemoryCandidate[] {
    const tx = this.db.transaction((items: typeof inputs) =>
      items.map((item) => this.upsertOne(item)),
    );
    return tx(inputs);
  }

  /** Moves candidates to a distiller-owned lifecycle status (applied, skipped, merged...). */
  markLifecycle(ids: string[], status: CoreMemoryCandidateStatus, resolution?: string): number {
    if (!ids.length) return 0;
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE core_memory_candidates
       SET status = ?, resolution = ?, resolved_at = ?
       WHERE id = ?`,
    );
    const tx = this.db.transaction((values: string[]) => {
      let changed = 0;
      for (const id of values) changed += stmt.run(status, resolution || null, now, id).changes;
      return changed;
    });
    return tx(ids);
  }

  /** Finds a candidate with the same fingerprint that has already been written to memory. */
  findAppliedDuplicate(
    candidate: Pick<
      CoreMemoryCandidate,
      "id" | "profileId" | "scopeKind" | "scopeRef" | "candidateType" | "summary"
    >,
  ): CoreMemoryCandidate | undefined {
    const key = normalizeCandidateSummary(candidate.summary);
    return this.findSameScopeAndType(candidate, ["applied"]).find(
      (row) => row.id !== candidate.id && normalizeCandidateSummary(row.summary) === key,
    );
  }

  private findSameScopeAndType(
    candidate: Pick<CoreMemoryCandidate, "profileId" | "scopeKind" | "scopeRef" | "candidateType">,
    statuses: CoreMemoryCandidateStatus[],
  ): CoreMemoryCandidate[] {
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM core_memory_candidates
         WHERE profile_id = ? AND scope_kind = ? AND scope_ref = ? AND candidate_type = ?
           AND status IN (${placeholders})
         ORDER BY created_at DESC
         LIMIT 500`,
      )
      .all(
        candidate.profileId,
        candidate.scopeKind,
        candidate.scopeRef,
        candidate.candidateType,
        ...statuses,
      ) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  private upsertOne(
    input: Omit<CoreMemoryCandidate, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): CoreMemoryCandidate {
    const key = normalizeCandidateSummary(input.summary);
    const matches = this.findSameScopeAndType(input, [
      "proposed",
      "accepted",
      "applied",
      "rejected",
    ]).filter((candidate) => normalizeCandidateSummary(candidate.summary) === key);
    if (!matches.length) return this.create(input);
    const existing = matches.reduce((best, candidate) =>
      UPSERT_STATUS_RANK[candidate.status] > UPSERT_STATUS_RANK[best.status] ? candidate : best,
    );
    if (existing.status === "rejected") return existing;
    this.db
      .prepare(
        `UPDATE core_memory_candidates
         SET trace_id = ?,
             workspace_id = COALESCE(workspace_id, ?),
             source_run_id = COALESCE(?, source_run_id),
             confidence = MAX(confidence, ?),
             stability_score = MAX(stability_score, ?),
             novelty_score = MIN(novelty_score, ?)
         WHERE id = ?`,
      )
      .run(
        input.traceId,
        input.workspaceId || null,
        input.sourceRunId || null,
        input.confidence,
        input.stabilityScore,
        input.noveltyScore,
        existing.id,
      );
    return this.findById(existing.id) || existing;
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
