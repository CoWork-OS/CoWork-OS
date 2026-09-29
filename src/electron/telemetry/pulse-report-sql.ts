import type Database from "better-sqlite3";

/** One UTC day's raw Pulse aggregates; the service turns them into the daily package. */
export interface PulseDayAggregates {
  created: Record<string, number>;
  terminal: Record<string, number>;
  eventRows: Array<{ type: string; legacy_type?: string; payload: string }>;
  llm: { errors: number };
}

/**
 * Pulse's reads (async SQLite migration plan, DB6): the outbox head, send receipts, consent
 * windows, and the daily aggregates a package is built from. As services-domain units
 * these run in the database worker when the domain is routed there; decisions and
 * delivery commit through the settings-domain Pulse commands as before.
 */
export class PulseReportStore {
  constructor(private readonly db: Database.Database) {}

  queueHead(
    installationId: string,
  ): { package_id: string; period_start: string; payload_json: string } | undefined {
    // One selector for sending and for the preview: oldest eligible queued day first.
    return this.db
      .prepare(
        `SELECT package_id, period_start, payload_json FROM pulse_outbox
         WHERE installation_id = ?
         AND package_id NOT IN (SELECT package_id FROM pulse_sent_days)
         ORDER BY period_start, created_at LIMIT 1`,
      )
      .get(installationId) as
      | { package_id: string; period_start: string; payload_json: string }
      | undefined;
  }

  receiptFor(packageId: string): { acknowledged_at: number } | undefined {
    return this.db
      .prepare("SELECT acknowledged_at FROM pulse_sent_days WHERE package_id = ?")
      .get(packageId) as { acknowledged_at: number } | undefined;
  }

  /** Whether one consent window covers the whole day. */
  hasConsentWindow(start: number, end: number): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM pulse_consent_windows WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) LIMIT 1",
        )
        .get(start, end),
    );
  }

  /** Start of the latest open consent window, if any. */
  openConsentStart(): number | null {
    const open = this.db
      .prepare(
        "SELECT MAX(started_at) AS started_at FROM pulse_consent_windows WHERE ended_at IS NULL",
      )
      .get() as { started_at: number | null } | undefined;
    return open?.started_at ?? null;
  }

  dayAggregates(start: number, end: number): PulseDayAggregates {
    const taskColumns = new Set(
      (this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const rootClause = taskColumns.has("parent_task_id") ? "AND parent_task_id IS NULL" : "";
    const evalClause = taskColumns.has("eval_case_id") ? "AND eval_case_id IS NULL" : "";
    const sampleClause = taskColumns.has("source")
      ? "AND COALESCE(source, 'manual') <> 'sample'"
      : "";
    const sessionExpr = taskColumns.has("session_id") ? "COALESCE(session_id, id)" : "id";
    const created = this.db
      .prepare(
        `SELECT COUNT(*) AS tasks_started, COUNT(DISTINCT ${sessionExpr}) AS sessions_started
       FROM tasks WHERE created_at >= ? AND created_at < ? ${rootClause} ${evalClause} ${sampleClause}`,
      )
      .get(start, end) as Record<string, number>;
    const terminal = this.db
      .prepare(
        `SELECT
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS tasks_completed,
         SUM(CASE WHEN status = 'completed' AND (terminal_status IS NULL OR terminal_status IN ('ok','partial_success')) THEN 1 ELSE 0 END) AS useful_tasks,
         SUM(CASE WHEN status = 'failed' OR terminal_status = 'failed' THEN 1 ELSE 0 END) AS failed_tasks,
         SUM(CASE WHEN status = 'cancelled' OR terminal_status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_tasks,
         SUM(CASE WHEN status = 'completed' THEN COALESCE(last_run_duration_ms, 0) ELSE 0 END) AS active_ms
       FROM tasks WHERE completed_at >= ? AND completed_at < ? ${rootClause} ${evalClause} ${sampleClause}`,
      )
      .get(start, end) as Record<string, number>;
    const eventRows = this.db
      .prepare(
        `SELECT e.type, e.legacy_type, e.payload FROM task_events e
       LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.timestamp >= ? AND e.timestamp < ?
       ${taskColumns.has("parent_task_id") ? "AND (t.parent_task_id IS NULL OR t.id IS NULL)" : ""}
       ${taskColumns.has("eval_case_id") ? "AND (t.eval_case_id IS NULL OR t.id IS NULL)" : ""}
       ${taskColumns.has("source") ? "AND (t.source IS NULL OR t.source <> 'sample')" : ""}
       AND COALESCE(e.type, e.legacy_type) IN ('tool_call','tool_error','approval_requested','approval_denied')`,
      )
      .all(start, end) as Array<{ type: string; legacy_type?: string; payload: string }>;
    const llm = this.db
      .prepare(
        `SELECT COUNT(*) AS errors FROM llm_call_events l
         LEFT JOIN tasks t ON t.id = l.task_id
         WHERE l.timestamp >= ? AND l.timestamp < ? AND l.success = 0
         ${taskColumns.has("source") ? "AND (t.source IS NULL OR t.source <> 'sample')" : ""}`,
      )
      .get(start, end) as { errors: number };
    return { created, terminal, eventRows, llm };
  }
}
