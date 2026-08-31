import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  DreamingCandidate,
  DreamingRun,
  ListDreamingCandidatesRequest,
  ListDreamingRunsRequest,
  ReviewDreamingCandidateRequest,
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

export class DreamingRepository {
  constructor(private readonly db: Database.Database) {}

  createRun(
    input: Omit<DreamingRun, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): DreamingRun {
    const now = Date.now();
    const run: DreamingRun = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt ?? now,
    };
    this.db
      .prepare(
        `INSERT INTO dreaming_runs (
          id, workspace_id, scope_kind, scope_ref, status, trigger_source,
          trigger_heartbeat_run_id, source_task_id, instructions, summary,
          evidence_count, candidate_count, error, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.workspaceId,
        run.scopeKind,
        run.scopeRef,
        run.status,
        run.triggerSource,
        run.triggerHeartbeatRunId || null,
        run.sourceTaskId || null,
        run.instructions || null,
        run.summary || null,
        run.evidenceCount,
        run.candidateCount,
        run.error || null,
        run.startedAt,
        run.completedAt || null,
        run.createdAt,
      );
    return run;
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        DreamingRun,
        "status" | "summary" | "evidenceCount" | "candidateCount" | "error" | "completedAt"
      >
    >,
  ): DreamingRun | undefined {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      fields.push("status = ?");
      values.push(patch.status);
    }
    if (patch.summary !== undefined) {
      fields.push("summary = ?");
      values.push(patch.summary);
    }
    if (patch.evidenceCount !== undefined) {
      fields.push("evidence_count = ?");
      values.push(patch.evidenceCount);
    }
    if (patch.candidateCount !== undefined) {
      fields.push("candidate_count = ?");
      values.push(patch.candidateCount);
    }
    if (patch.error !== undefined) {
      fields.push("error = ?");
      values.push(patch.error);
    }
    if (patch.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(patch.completedAt);
    }
    if (!fields.length) return this.findRunById(id);
    values.push(id);
    this.db.prepare(`UPDATE dreaming_runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.findRunById(id);
  }

  findRunById(id: string): DreamingRun | undefined {
    const row = this.db.prepare("SELECT * FROM dreaming_runs WHERE id = ?").get(id) as Any;
    return row ? this.mapRun(row) : undefined;
  }

  listRuns(request: ListDreamingRunsRequest = {}): DreamingRun[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (request.workspaceId) {
      conditions.push("workspace_id = ?");
      values.push(request.workspaceId);
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
      .prepare(`SELECT * FROM dreaming_runs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, limit) as Any[];
    return rows.map((row) => this.mapRun(row));
  }

  createCandidate(
    input: Omit<DreamingCandidate, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): DreamingCandidate {
    const candidate: DreamingCandidate = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO dreaming_candidates (
          id, run_id, workspace_id, action, target, current_value, proposed_value,
          rationale, confidence, evidence_refs, status, created_at, reviewed_at, resolution
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.id,
        candidate.runId,
        candidate.workspaceId,
        candidate.action,
        candidate.target,
        candidate.currentValue || null,
        candidate.proposedValue,
        candidate.rationale,
        candidate.confidence,
        JSON.stringify(candidate.evidenceRefs || []),
        candidate.status,
        candidate.createdAt,
        candidate.reviewedAt || null,
        candidate.resolution || null,
      );
    return candidate;
  }

  bulkCreateCandidates(
    inputs: Array<
      Omit<DreamingCandidate, "id" | "createdAt"> & { id?: string; createdAt?: number }
    >,
  ): DreamingCandidate[] {
    const tx = this.db.transaction((items: typeof inputs) =>
      items.map((item) => this.createCandidate(item)),
    );
    return tx(inputs);
  }

  findCandidateById(id: string): DreamingCandidate | undefined {
    const row = this.db.prepare("SELECT * FROM dreaming_candidates WHERE id = ?").get(id) as Any;
    return row ? this.mapCandidate(row) : undefined;
  }

  listCandidates(request: ListDreamingCandidatesRequest = {}): DreamingCandidate[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (request.workspaceId) {
      conditions.push("workspace_id = ?");
      values.push(request.workspaceId);
    }
    if (request.runId) {
      conditions.push("run_id = ?");
      values.push(request.runId);
    }
    if (request.action) {
      conditions.push("action = ?");
      values.push(request.action);
    }
    if (request.status) {
      conditions.push("status = ?");
      values.push(request.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, request.limit ?? 100));
    const rows = this.db
      .prepare(`SELECT * FROM dreaming_candidates ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, limit) as Any[];
    return rows.map((row) => this.mapCandidate(row));
  }

  reviewCandidate(request: ReviewDreamingCandidateRequest): DreamingCandidate | undefined {
    const reviewedAt = Date.now();
    this.db
      .prepare(
        `UPDATE dreaming_candidates
         SET status = ?, resolution = ?, reviewed_at = ?
         WHERE id = ?`,
      )
      .run(request.status, request.resolution || null, reviewedAt, request.id);
    return this.findCandidateById(request.id);
  }

  private mapRun(row: Any): DreamingRun {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      scopeKind: row.scope_kind,
      scopeRef: String(row.scope_ref),
      status: row.status,
      triggerSource: row.trigger_source,
      triggerHeartbeatRunId: row.trigger_heartbeat_run_id || undefined,
      sourceTaskId: row.source_task_id || undefined,
      instructions: row.instructions || undefined,
      summary: row.summary || undefined,
      evidenceCount: Number(row.evidence_count || 0),
      candidateCount: Number(row.candidate_count || 0),
      error: row.error || undefined,
      startedAt: Number(row.started_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
      createdAt: Number(row.created_at),
    };
  }

  private mapCandidate(row: Any): DreamingCandidate {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      workspaceId: String(row.workspace_id),
      action: row.action,
      target: row.target,
      currentValue: row.current_value || undefined,
      proposedValue: String(row.proposed_value),
      rationale: String(row.rationale),
      confidence: Number(row.confidence),
      evidenceRefs: parseJson(row.evidence_refs, []),
      status: row.status,
      createdAt: Number(row.created_at),
      reviewedAt: row.reviewed_at ? Number(row.reviewed_at) : undefined,
      resolution: row.resolution || undefined,
    };
  }
}
