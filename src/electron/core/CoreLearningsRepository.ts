import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { CoreLearningsEntry, ListCoreLearningsRequest } from "../../shared/types";

type Any = any;

export class CoreLearningsRepository {
  constructor(private readonly db: Database.Database) {}

  append(input: Omit<CoreLearningsEntry, "id"> & { id?: string }): CoreLearningsEntry {
    const entry: CoreLearningsEntry = {
      ...input,
      id: input.id || randomUUID(),
    };
    this.db
      .prepare(
        `INSERT INTO core_learnings_log (
        id, profile_id, workspace_id, kind, summary, details, related_cluster_id, related_experiment_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.profileId,
        entry.workspaceId || null,
        entry.kind,
        entry.summary,
        entry.details || null,
        entry.relatedClusterId || null,
        entry.relatedExperimentId || null,
        entry.createdAt,
      );
    return entry;
  }

  list(request: ListCoreLearningsRequest = {}): CoreLearningsEntry[] {
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
    if (request.relatedClusterId) {
      conditions.push("related_cluster_id = ?");
      values.push(request.relatedClusterId);
    }
    if (request.relatedExperimentId) {
      conditions.push("related_experiment_id = ?");
      values.push(request.relatedExperimentId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, request.limit ?? 100));
    const rows = this.db
      .prepare(`SELECT * FROM core_learnings_log ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, limit) as Any[];
    return rows.map((row) => ({
      id: String(row.id),
      profileId: String(row.profile_id),
      workspaceId: row.workspace_id || undefined,
      kind: row.kind,
      summary: String(row.summary),
      details: row.details || undefined,
      relatedClusterId: row.related_cluster_id || undefined,
      relatedExperimentId: row.related_experiment_id || undefined,
      createdAt: Number(row.created_at),
    }));
  }
}
