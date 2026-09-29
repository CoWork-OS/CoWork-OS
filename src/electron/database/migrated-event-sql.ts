import type Database from "better-sqlite3";
import type { TaskEvent } from "../../shared/types";
import { sanitizeTimelineEventForStorage } from "../agent/timeline-payload-sanitizer";

/**
 * Writing back legacy task events converted to the v2 timeline shape, shared by the
 * host repository and the database worker (DB4).
 */

export type MigratedEventParams = [
  type: string,
  payload: string,
  eventId: string,
  seq: number | null,
  ts: number,
  status: string | null,
  stepId: string | null,
  groupId: string | null,
  actor: string | null,
  legacyType: string | null,
  id: string,
];

export function migratedEventParams(event: TaskEvent): MigratedEventParams {
  const stored = sanitizeTimelineEventForStorage(event);
  return [
    stored.type,
    JSON.stringify(stored.payload ?? {}),
    stored.eventId || stored.id,
    typeof stored.seq === "number" ? stored.seq : null,
    typeof stored.ts === "number" ? stored.ts : stored.timestamp,
    typeof stored.status === "string" ? stored.status : null,
    typeof stored.stepId === "string" ? stored.stepId : null,
    typeof stored.groupId === "string" ? stored.groupId : null,
    typeof stored.actor === "string" ? stored.actor : null,
    typeof stored.legacyType === "string" ? stored.legacyType : null,
    stored.id,
  ];
}

/** Apply converted rows inside the caller's transaction. */
export function applyMigratedEventParams(
  db: Database.Database,
  rows: readonly MigratedEventParams[],
): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(`
    UPDATE task_events
    SET
      type = ?,
      payload = ?,
      schema_version = 2,
      event_id = ?,
      seq = ?,
      ts = ?,
      status = ?,
      step_id = ?,
      group_id = ?,
      actor = ?,
      legacy_type = ?
    WHERE id = ?
  `);
  for (const row of rows) stmt.run(...row);
}
