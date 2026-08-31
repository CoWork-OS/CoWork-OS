import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { CoreFailureCluster, ListCoreFailureClustersRequest } from "../../shared/types";

type Any = any;

export class CoreFailureClusterRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<CoreFailureCluster, "id"> & { id?: string }): CoreFailureCluster {
    const cluster: CoreFailureCluster = {
      ...input,
      id: input.id || randomUUID(),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO core_failure_clusters (
        id, profile_id, workspace_id, category, fingerprint, root_cause_summary, status,
        recurrence_count, linked_eval_case_id, linked_experiment_id, first_seen_at, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cluster.id,
        cluster.profileId,
        cluster.workspaceId || null,
        cluster.category,
        cluster.fingerprint,
        cluster.rootCauseSummary,
        cluster.status,
        cluster.recurrenceCount,
        cluster.linkedEvalCaseId || null,
        cluster.linkedExperimentId || null,
        cluster.firstSeenAt,
        cluster.lastSeenAt,
        cluster.createdAt,
        cluster.updatedAt,
      );
    return cluster;
  }

  findById(id: string): CoreFailureCluster | undefined {
    const row = this.db.prepare("SELECT * FROM core_failure_clusters WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findByFingerprint(
    profileId: string,
    workspaceId: string | undefined,
    fingerprint: string,
  ): CoreFailureCluster | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM core_failure_clusters
       WHERE profile_id = ?
         AND COALESCE(workspace_id, '') = COALESCE(?, '')
         AND fingerprint = ?
       LIMIT 1`,
      )
      .get(profileId, workspaceId || null, fingerprint) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(request: ListCoreFailureClustersRequest = {}): CoreFailureCluster[] {
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
      .prepare(`SELECT * FROM core_failure_clusters ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...values, limit) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  update(id: string, updates: Partial<CoreFailureCluster>): CoreFailureCluster | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const mapped: Record<string, string> = {
      profileId: "profile_id",
      workspaceId: "workspace_id",
      category: "category",
      fingerprint: "fingerprint",
      rootCauseSummary: "root_cause_summary",
      status: "status",
      recurrenceCount: "recurrence_count",
      linkedEvalCaseId: "linked_eval_case_id",
      linkedExperimentId: "linked_experiment_id",
      firstSeenAt: "first_seen_at",
      lastSeenAt: "last_seen_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
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
      .prepare(`UPDATE core_failure_clusters SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.findById(id);
  }

  addMember(clusterId: string, failureRecordId: string, createdAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO core_failure_cluster_members (
        cluster_id, failure_record_id, created_at
      ) VALUES (?, ?, ?)`,
      )
      .run(clusterId, failureRecordId, createdAt);
  }

  listMemberIds(clusterId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT failure_record_id FROM core_failure_cluster_members WHERE cluster_id = ? ORDER BY created_at ASC",
      )
      .all(clusterId) as Any[];
    return rows.map((row) => String(row.failure_record_id));
  }

  private mapRow(row: Any): CoreFailureCluster {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      workspaceId: row.workspace_id || undefined,
      category: row.category,
      fingerprint: String(row.fingerprint),
      rootCauseSummary: String(row.root_cause_summary),
      status: row.status,
      recurrenceCount: Number(row.recurrence_count || 1),
      linkedEvalCaseId: row.linked_eval_case_id || undefined,
      linkedExperimentId: row.linked_experiment_id || undefined,
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
