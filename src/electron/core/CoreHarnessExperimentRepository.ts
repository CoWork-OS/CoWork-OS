import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  CoreHarnessExperiment,
  CoreHarnessExperimentRun,
  ListCoreExperimentsRequest,
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

export class CoreHarnessExperimentRepository {
  constructor(private readonly db: Database.Database) {}

  createExperiment(
    input: Omit<CoreHarnessExperiment, "id"> & { id?: string },
  ): CoreHarnessExperiment {
    const experiment: CoreHarnessExperiment = {
      ...input,
      id: input.id || randomUUID(),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO core_harness_experiments (
        id, profile_id, workspace_id, cluster_id, change_kind, proposal_json, status,
        summary, promoted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        experiment.id,
        experiment.profileId,
        experiment.workspaceId || null,
        experiment.clusterId,
        experiment.changeKind,
        JSON.stringify(experiment.proposal || {}),
        experiment.status,
        experiment.summary || null,
        experiment.promotedAt || null,
        experiment.createdAt,
        experiment.updatedAt,
      );
    return experiment;
  }

  findExperimentById(id: string): CoreHarnessExperiment | undefined {
    const row = this.db
      .prepare("SELECT * FROM core_harness_experiments WHERE id = ?")
      .get(id) as Any;
    return row ? this.mapExperiment(row) : undefined;
  }

  listExperiments(request: ListCoreExperimentsRequest = {}): CoreHarnessExperiment[] {
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
    const rows = this.db
      .prepare(`SELECT * FROM core_harness_experiments ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...values, limit) as Any[];
    return rows.map((row) => this.mapExperiment(row));
  }

  updateExperiment(
    id: string,
    updates: Partial<CoreHarnessExperiment>,
  ): CoreHarnessExperiment | undefined {
    const existing = this.findExperimentById(id);
    if (!existing) return undefined;
    const mapped: Record<string, string> = {
      profileId: "profile_id",
      workspaceId: "workspace_id",
      clusterId: "cluster_id",
      changeKind: "change_kind",
      proposal: "proposal_json",
      status: "status",
      summary: "summary",
      promotedAt: "promoted_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    };
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(mapped)) {
      if (!(key in updates)) continue;
      fields.push(`${column} = ?`);
      values.push(
        key === "proposal"
          ? JSON.stringify((updates as Any)[key] || {})
          : ((updates as Any)[key] ?? null),
      );
    }
    if (!fields.length) return existing;
    values.push(id);
    this.db
      .prepare(`UPDATE core_harness_experiments SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.findExperimentById(id);
  }

  createRun(
    input: Omit<CoreHarnessExperimentRun, "id"> & { id?: string },
  ): CoreHarnessExperimentRun {
    const run: CoreHarnessExperimentRun = {
      ...input,
      id: input.id || randomUUID(),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO core_harness_experiment_runs (
        id, experiment_id, status, baseline_json, outcome_json, gate_result_id, summary, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.experimentId,
        run.status,
        run.baseline ? JSON.stringify(run.baseline) : null,
        run.outcome ? JSON.stringify(run.outcome) : null,
        run.gateResultId || null,
        run.summary || null,
        run.createdAt,
        run.startedAt || null,
        run.completedAt || null,
      );
    return run;
  }

  updateRun(
    id: string,
    updates: Partial<CoreHarnessExperimentRun>,
  ): CoreHarnessExperimentRun | undefined {
    const existing = this.findRunById(id);
    if (!existing) return undefined;
    const mapped: Record<string, string> = {
      experimentId: "experiment_id",
      status: "status",
      baseline: "baseline_json",
      outcome: "outcome_json",
      gateResultId: "gate_result_id",
      summary: "summary",
      createdAt: "created_at",
      startedAt: "started_at",
      completedAt: "completed_at",
    };
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(mapped)) {
      if (!(key in updates)) continue;
      fields.push(`${column} = ?`);
      if (key === "baseline" || key === "outcome") {
        values.push((updates as Any)[key] ? JSON.stringify((updates as Any)[key]) : null);
      } else {
        values.push((updates as Any)[key] ?? null);
      }
    }
    if (!fields.length) return existing;
    values.push(id);
    this.db
      .prepare(`UPDATE core_harness_experiment_runs SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.findRunById(id);
  }

  findRunById(id: string): CoreHarnessExperimentRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM core_harness_experiment_runs WHERE id = ?")
      .get(id) as Any;
    return row ? this.mapRun(row) : undefined;
  }

  listRunsForExperiment(experimentId: string): CoreHarnessExperimentRun[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM core_harness_experiment_runs WHERE experiment_id = ? ORDER BY created_at DESC",
      )
      .all(experimentId) as Any[];
    return rows.map((row) => this.mapRun(row));
  }

  private mapExperiment(row: Any): CoreHarnessExperiment {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      workspaceId: row.workspace_id || undefined,
      clusterId: String(row.cluster_id),
      changeKind: row.change_kind,
      proposal: parseJson<Record<string, unknown>>(row.proposal_json, {}),
      status: row.status,
      summary: row.summary || undefined,
      promotedAt: row.promoted_at ? Number(row.promoted_at) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapRun(row: Any): CoreHarnessExperimentRun {
    return {
      id: String(row.id),
      experimentId: String(row.experiment_id),
      status: row.status,
      baseline: parseJson<Record<string, unknown> | undefined>(row.baseline_json, undefined),
      outcome: parseJson<Record<string, unknown> | undefined>(row.outcome_json, undefined),
      gateResultId: row.gate_result_id || undefined,
      summary: row.summary || undefined,
      createdAt: Number(row.created_at),
      startedAt: row.started_at ? Number(row.started_at) : undefined,
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
    };
  }
}
