import type Database from "better-sqlite3";
import { insertLlmCallRow, type LlmCallRow } from "../../database/llm-call-events";

/** A prepared Jev decision usage row (`jev_call_events`). */
export interface JevCallRow {
  id: string;
  timestamp: number;
  workspaceId: string | null;
  taskId: string | null;
  sourceKind: string;
  sourceId: string | null;
  providerType: string | null;
  modelId: string | null;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
  status: string;
  fromCache: number;
  success: number;
  requestId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Usage telemetry rows (async SQLite migration plan, DB6): LLM calls, Jev decision calls,
 * and the local task-cost history read from them. Rows are prepared on the host; as
 * services-domain units the inserts and reads run in the database worker when the domain
 * is routed there.
 */
export class UsageTelemetryStore {
  constructor(private readonly db: Database.Database) {}

  insertLlmCall(row: LlmCallRow): void {
    insertLlmCallRow(this.db, row);
  }

  insertJevCall(row: JevCallRow): void {
    this.db
      .prepare(
        `INSERT INTO jev_call_events (
          id, timestamp, workspace_id, task_id, source_kind, source_id, provider_type,
          model_id, purpose, input_tokens, output_tokens, cost, latency_ms, status,
          from_cache, success, request_id, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.timestamp,
        row.workspaceId,
        row.taskId,
        row.sourceKind,
        row.sourceId,
        row.providerType,
        row.modelId,
        row.purpose,
        row.inputTokens,
        row.outputTokens,
        row.cost,
        row.latencyMs,
        row.status,
        row.fromCache,
        row.success,
        row.requestId,
        row.errorCode,
        row.errorMessage,
      );
  }

  /** Total cost of each of the last 30 successful tasks on a model. */
  taskCostTotals(model: string): number[] {
    return (
      this.db
        .prepare(
          `SELECT task_id, SUM(cost) AS total
             FROM llm_call_events
            WHERE (model_id = ? OR model_key = ?) AND task_id IS NOT NULL AND success = 1
            GROUP BY task_id
           HAVING SUM(cost) > 0
            ORDER BY MAX(timestamp) DESC
            LIMIT 30`,
        )
        .all(model, model) as Array<{ task_id: string; total: number }>
    ).map((row) => Number(row.total));
  }
}
