import type Database from "better-sqlite3";
import type { EventTrigger, TriggerHistoryEntry } from "./types";

// oxlint-disable-next-line typescript/no-explicit-any -- rows are mapped by EventTriggerService
type Row = any;

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * The event trigger service's SQL (async SQLite migration plan, DB6): trigger rows, fire
 * history and the durable event queue. As services-domain units these run in the database
 * worker when the domain is routed there. The service keeps its triggers in memory and
 * awaits each write; schema setup stays in `EventTriggerService` on the host.
 */
export class EventTriggerStore {
  constructor(private readonly db: Database.Database) {}

  /** Requeue events a previous run was processing when it stopped. */
  recoverProcessing(now: number): void {
    this.db
      .prepare(
        `UPDATE event_trigger_queue
         SET status = 'pending', available_at = ?,
             error = COALESCE(error, 'Recovered after application restart.'), updated_at = ?
         WHERE status = 'processing'`,
      )
      .run(now, now);
  }

  loadTriggerRows(): Row[] {
    return this.db.prepare("SELECT * FROM event_triggers").all();
  }

  saveTrigger(trigger: EventTrigger): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO event_triggers
         (id, name, description, enabled, source, conditions, condition_logic, action,
          workspace_id, cooldown_ms, last_fired_at, fire_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trigger.id,
        trigger.name,
        trigger.description || null,
        trigger.enabled ? 1 : 0,
        trigger.source,
        JSON.stringify(trigger.conditions),
        trigger.conditionLogic || "all",
        JSON.stringify(trigger.action),
        trigger.workspaceId,
        trigger.cooldownMs ?? DEFAULT_COOLDOWN_MS,
        trigger.lastFiredAt || null,
        trigger.fireCount,
        trigger.createdAt,
        trigger.updatedAt,
      );
  }

  /** Delete a trigger and its history; as a unit both deletes share one transaction. */
  deleteTrigger(id: string): void {
    this.db.prepare("DELETE FROM event_triggers WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM event_trigger_history WHERE trigger_id = ?").run(id);
  }

  saveHistory(entry: TriggerHistoryEntry): void {
    this.db
      .prepare(
        `INSERT INTO event_trigger_history (id, trigger_id, fired_at, event_data, action_result, task_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.triggerId,
        entry.firedAt,
        JSON.stringify(entry.eventData),
        entry.actionResult || null,
        entry.taskId || null,
      );
  }

  enqueue(id: string, dedupeKey: string, eventJson: string, now: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO event_trigger_queue
         (id, dedupe_key, event_json, status, attempt_count, available_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(id, dedupeKey, eventJson, now, now, now);
  }

  /**
   * The oldest due event, marked as processing; as a unit the read and the claim share one
   * transaction, so two drains cannot claim the same event.
   */
  claimNext(now: number): Row | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM event_trigger_queue
         WHERE status = 'pending' AND available_at <= ?
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(now) as Row | undefined;
    if (!row) return undefined;
    this.db
      .prepare(
        "UPDATE event_trigger_queue SET status = 'processing', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
      )
      .run(now, row.id);
    return row;
  }

  completeQueued(id: string): void {
    this.db.prepare("DELETE FROM event_trigger_queue WHERE id = ?").run(id);
  }

  /** Record a failed attempt: retry with backoff, or give up after five attempts. */
  retryQueued(id: string, message: string, attemptCount: number, now: number): void {
    if (attemptCount >= 5) {
      this.db
        .prepare(
          "UPDATE event_trigger_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        )
        .run(message, now, id);
      return;
    }
    this.db
      .prepare(
        "UPDATE event_trigger_queue SET status = 'pending', error = ?, available_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(message, now + Math.min(60_000, 1_000 * 2 ** attemptCount), now, id);
  }
}
