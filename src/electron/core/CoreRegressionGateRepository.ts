import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { CoreRegressionGateResult } from "../../shared/types";

type Any = any;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class CoreRegressionGateRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<CoreRegressionGateResult, "id"> & { id?: string }): CoreRegressionGateResult {
    const result: CoreRegressionGateResult = {
      ...input,
      id: input.id || randomUUID(),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO core_regression_gate_results (
        id, experiment_run_id, passed, target_improved, regressions_detected_json, summary, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.id,
        result.experimentRunId,
        result.passed ? 1 : 0,
        result.targetImproved ? 1 : 0,
        JSON.stringify(result.regressionsDetected || []),
        result.summary,
        result.details ? JSON.stringify(result.details) : null,
        result.createdAt,
      );
    return result;
  }

  findById(id: string): CoreRegressionGateResult | undefined {
    const row = this.db
      .prepare("SELECT * FROM core_regression_gate_results WHERE id = ?")
      .get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findByExperimentRunId(experimentRunId: string): CoreRegressionGateResult | undefined {
    const row = this.db
      .prepare("SELECT * FROM core_regression_gate_results WHERE experiment_run_id = ? LIMIT 1")
      .get(experimentRunId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  private mapRow(row: Any): CoreRegressionGateResult {
    return {
      id: String(row.id),
      experimentRunId: String(row.experiment_run_id),
      passed: Number(row.passed) === 1,
      targetImproved: Number(row.target_improved) === 1,
      regressionsDetected: parseJson<string[]>(row.regressions_detected_json, []),
      summary: String(row.summary),
      details: parseJson<Record<string, unknown> | undefined>(row.details_json, undefined),
      createdAt: Number(row.created_at),
    };
  }
}
