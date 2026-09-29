/**
 * SQL for the "latest task event of a type at or before this usage row" lookups that
 * usage reports and the rollup backfill run per usage row.
 *
 * Matching `type = X OR legacy_type = X` in one statement let SQLite plan the lookup on
 * the plain `task_id` index when a `LIKE` filter was present, so every usage row scanned
 * all events of its task and pattern-matched their payloads (13 s for a 365-day report
 * on the heavy benchmark profile). One branch per column keeps each on its
 * `(task_id, type|legacy_type, timestamp)` index; together they take about 0.1 s.
 */
export function latestTaskEventPayloadSql(options: {
  taskIdExpr: string;
  timestampExpr: string;
  eventType: "llm_routing_changed" | "log";
  payloadLike?: string;
}): string {
  const like = options.payloadLike ? ` AND payload LIKE '${options.payloadLike}'` : "";
  const branch = (column: "type" | "legacy_type") =>
    `SELECT payload, timestamp FROM task_events
       WHERE task_id = ${options.taskIdExpr}
         AND ${column} = '${options.eventType}'
         AND timestamp <= ${options.timestampExpr}${like}`;
  return `(SELECT payload FROM (
     ${branch("type")}
     UNION ALL
     ${branch("legacy_type")}
   ) ORDER BY timestamp DESC LIMIT 1)`;
}

/** Latest routing change of the row's task at or before the row, for `alias`'s row. */
export const routingPayloadAt = (alias: string): string =>
  latestTaskEventPayloadSql({
    taskIdExpr: `${alias}.task_id`,
    timestampExpr: `${alias}.timestamp`,
    eventType: "llm_routing_changed",
  });

/** Latest `provider=` log line of the row's task at or before the row. */
export const providerLogPayloadAt = (alias: string): string =>
  latestTaskEventPayloadSql({
    taskIdExpr: `${alias}.task_id`,
    timestampExpr: `${alias}.timestamp`,
    eventType: "log",
    payloadLike: "%provider=%",
  });
