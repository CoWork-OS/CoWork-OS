import type Database from "better-sqlite3";

/**
 * Storage for `llm_call_events`, shared by the host and the database worker (async
 * SQLite migration plan, DB3). Rows are built on the host (`usage-telemetry.ts`);
 * inserting by generated id is idempotent, so a retried write cannot double-count.
 */
export interface LlmCallRow {
  /** Bound parameters for LLM_CALL_INSERT_SQL, in column order. */
  params: unknown[];
  workspaceId: string | null;
  timestamp: number;
}

const LLM_CALL_INSERT_SQL = `
  INSERT OR IGNORE INTO llm_call_events (
    id, timestamp, workspace_id, task_id, source_kind, source_id, provider_type,
    model_key, model_id, input_tokens, output_tokens, cached_tokens, cost, success,
    error_code, error_message
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function insertLlmCallRow(db: Database.Database, row: LlmCallRow): void {
  db.prepare(LLM_CALL_INSERT_SQL).run(...row.params);
}
