import type Database from "better-sqlite3";

/**
 * Startup recovery of user follow-ups a crash left queued or started (async SQLite
 * migration plan, DB6). A follow-up is journaled before an idle executor moves a finished
 * task back to executing; a host exit in between leaves the receipt attached to a task
 * that looks finished. The scan reads every follow-up receipt on the profile, so it runs
 * as a storage-domain report unit in the reporting reader instead of on the host thread.
 */

/** Task statuses a stranded follow-up can be attached to. */
export const FOLLOW_UP_RECOVERY_TASK_STATUSES = [
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

/**
 * Whether the latest receipt of any follow-up (by message id, in timeline order) is still
 * queued or started. Shared by the worker scan and the host's per-task check.
 */
export function hasUnstartedFollowUpReceipt(payloads: Iterable<unknown>): boolean {
  const latestReceipts = new Map<string, Record<string, unknown>>();
  for (const value of payloads) {
    const payload =
      value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    const messageId = typeof payload?.messageId === "string" ? payload.messageId.trim() : "";
    if (messageId && payload?.deliveryMode === "follow_up") {
      latestReceipts.set(messageId, payload);
    }
  }
  for (const payload of latestReceipts.values()) {
    const status = payload.deliveryStatus ?? payload.status;
    if (status === "queued" || status === "started") return true;
  }
  return false;
}

// `COALESCE(legacy_type, type) = 'user_message'`, split so each side can use its
// (type|legacy_type, timestamp, task_id) index. Every follow-up receipt's payload holds the
// JSON text "follow_up", so `instr` skips other user messages before they are parsed.
const FOLLOW_UP_RECEIPT_ROWS_SQL = `
  SELECT e.task_id AS task_id, e.payload AS payload
  FROM task_events e
  WHERE (e.legacy_type = 'user_message' OR (e.legacy_type IS NULL AND e.type = 'user_message'))
    AND instr(e.payload, 'follow_up') > 0
    AND e.task_id IN (
      SELECT id FROM tasks
      WHERE status IN (${FOLLOW_UP_RECOVERY_TASK_STATUSES.map(() => "?").join(", ")})
    )
  ORDER BY e.task_id, COALESCE(e.seq, e.timestamp), e.timestamp, e.id
`;

export class FollowUpRecoveryStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Ids of tasks in a recovery status whose latest follow-up receipt is queued or started.
   * Candidates only: the host re-reads each task and its receipts before changing it.
   */
  findUnstartedFollowUpTaskIds(): string[] {
    const rows = this.db
      .prepare(FOLLOW_UP_RECEIPT_ROWS_SQL)
      .all(...FOLLOW_UP_RECOVERY_TASK_STATUSES) as Array<{ task_id: unknown; payload: unknown }>;
    const payloadsByTask = new Map<string, unknown[]>();
    for (const row of rows) {
      if (typeof row.task_id !== "string" || typeof row.payload !== "string") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const payloads = payloadsByTask.get(row.task_id) ?? [];
      payloads.push(payload);
      payloadsByTask.set(row.task_id, payloads);
    }
    return [...payloadsByTask]
      .filter(([, payloads]) => hasUnstartedFollowUpReceipt(payloads))
      .map(([taskId]) => taskId);
  }
}
