import type Database from "better-sqlite3";
import type { EventTrigger, TriggerHistoryEntry } from "./types";
import {
  assertResponsibilityMailboxEvent,
  selectedResponsibilityMailboxAccount,
  type ResponsibilityMailboxAccountReceipt,
} from "../automation/responsibility-mailbox";

// oxlint-disable-next-line typescript/no-explicit-any -- rows are mapped by EventTriggerService
type Row = any;

const DEFAULT_COOLDOWN_MS = 60_000;
const OCCURRENCE_DEDUPE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Compatibility column for profiles created before responsibility event snapshots. */
export function ensureResponsibilitySnapshotColumn(db: Database.Database): void {
  const occurrenceColumns = db
    .prepare("PRAGMA table_info(event_trigger_occurrences)")
    .all() as Array<{ name: string }>;
  if (
    occurrenceColumns.length > 0 &&
    !occurrenceColumns.some((column) => column.name === "responsibility_snapshot_json")
  )
    db.exec("ALTER TABLE event_trigger_occurrences ADD COLUMN responsibility_snapshot_json TEXT");
}

export type TriggerOccurrenceAdmission = {
  disposition: "accepted" | "duplicate" | "cooldown" | "disabled";
  row?: Row;
  trigger?: { last_fired_at: number | null; fire_count: number };
};

/**
 * The event trigger service's SQL (async SQLite migration plan, DB6): trigger rows, fire
 * history, per-trigger occurrence journal, and legacy durable event queue. As services-domain units these run in the database
 * worker when the domain is routed there. The service keeps its triggers in memory and
 * awaits each write; schema setup stays in `EventTriggerService` on the host.
 */
export class EventTriggerStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Legacy event-queue rows had no action-intent or receipt checkpoint. A row left processing
   * may already have performed an effect, so quarantine it instead of blindly replaying it.
   * Pending legacy rows are still safely promoted through the occurrence journal by the drain.
   */
  recoverProcessing(now: number): void {
    this.db
      .prepare(
        `UPDATE event_trigger_queue
         SET status = 'outcome_unknown',
             error = COALESCE(error, 'Legacy queue row was processing without an action receipt; automatic replay is unsafe.'), updated_at = ?
         WHERE status = 'processing'`,
      )
      .run(now);
  }

  /**
   * Recover work at the action boundary. A claimed occurrence had not crossed the durable
   * intent marker and is safe to retry. An intent may have reached an external system, so
   * it is retained as outcome_unknown and is never automatically resent.
   */
  recoverOccurrences(now: number): void {
    this.db
      .prepare(
        `UPDATE event_trigger_occurrences
         SET status = 'pending', available_at = ?, error = COALESCE(error, 'Recovered before action intent.'), updated_at = ?
         WHERE status = 'processing'`,
      )
      .run(now, now);
    this.db
      .prepare(
        `UPDATE event_trigger_occurrences
         SET status = 'outcome_unknown', error = COALESCE(error, 'Process stopped after action intent; delivery was not replayed.'), updated_at = ?
         WHERE status = 'intent'`,
      )
      .run(now);
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
    this.db
      .prepare(
        `UPDATE event_trigger_occurrences
         SET status = 'failed', error = 'Trigger removed before action intent.', updated_at = ?
         WHERE trigger_id = ? AND status IN ('pending', 'processing')`,
      )
      .run(Date.now(), id);
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

  /**
   * Persist an event/action snapshot and reserve this trigger's cooldown atomically. Duplicate
   * identity lookup precedes cooldown so a pending accepted event can resume after restart.
   */
  acceptOccurrence(
    triggerId: string,
    occurrenceId: string,
    occurrenceKey: string,
    eventJson: string,
    triggerSnapshotJson: string,
    responsibilitySnapshotJson: string,
    now: number,
    cooldownMs: number,
  ): TriggerOccurrenceAdmission {
    // Completed/failed dedupe is intentionally bounded to 90 days. Pending, processing,
    // intent, and outcome_unknown rows are never pruned; in particular, ambiguity is durable.
    this.db
      .prepare(
        `DELETE FROM event_trigger_occurrences
         WHERE updated_at < ? AND status IN ('completed', 'failed')`,
      )
      .run(now - OCCURRENCE_DEDUPE_RETENTION_MS);

    const existing = this.db
      .prepare(
        `SELECT * FROM event_trigger_occurrences
         WHERE trigger_id = ? AND occurrence_key = ?`,
      )
      .get(triggerId, occurrenceKey) as Row | undefined;
    if (existing) return { disposition: "duplicate", row: existing };

    const trigger = this.db
      .prepare("SELECT enabled, last_fired_at FROM event_triggers WHERE id = ?")
      .get(triggerId) as { enabled?: number; last_fired_at?: number | null } | undefined;
    if (!trigger || !trigger.enabled) return { disposition: "disabled" };
    const lastFiredAt = Number(trigger.last_fired_at || 0);
    if (lastFiredAt > 0 && now - lastFiredAt < cooldownMs) return { disposition: "cooldown" };

    this.db
      .prepare(
        `INSERT INTO event_trigger_occurrences
         (id, trigger_id, occurrence_key, event_json, trigger_snapshot_json,
          responsibility_snapshot_json, status, attempt_count,
          available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        occurrenceId,
        triggerId,
        occurrenceKey,
        eventJson,
        triggerSnapshotJson,
        responsibilitySnapshotJson,
        now,
        now,
        now,
      );
    this.db
      .prepare(
        `UPDATE event_triggers
         SET last_fired_at = ?, fire_count = fire_count + 1
         WHERE id = ?`,
      )
      .run(now, triggerId);
    const row = this.db
      .prepare("SELECT * FROM event_trigger_occurrences WHERE id = ?")
      .get(occurrenceId) as Row;
    const updatedTrigger = this.db
      .prepare("SELECT last_fired_at, fire_count FROM event_triggers WHERE id = ?")
      .get(triggerId) as { last_fired_at: number | null; fire_count: number };
    return { disposition: "accepted", row, trigger: updatedTrigger };
  }

  /** Atomically claim the oldest due occurrence before any action intent is written. */
  claimNextOccurrence(now: number): Row | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM event_trigger_occurrences
         WHERE status = 'pending' AND available_at <= ?
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(now) as Row | undefined;
    if (!row) return undefined;
    this.db
      .prepare(
        `UPDATE event_trigger_occurrences
         SET status = 'processing', attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, row.id);
    return { ...row, status: "processing", attempt_count: Number(row.attempt_count || 0) + 1 };
  }

  markOccurrenceIntent(
    id: string,
    expectedDefinitionJson: string,
    expectedResponsibilitySnapshotJson: string,
    now: number,
  ): void {
    const occurrence = this.db
      .prepare(
        `SELECT trigger_id, event_json, trigger_snapshot_json, responsibility_snapshot_json, status
         FROM event_trigger_occurrences WHERE id = ?`,
      )
      .get(id) as
      | {
          trigger_id: string;
          event_json: string;
          trigger_snapshot_json: string;
          responsibility_snapshot_json: string | null;
          status: string;
        }
      | undefined;
    if (!occurrence || occurrence.status !== "processing")
      throw new Error(`Trigger occurrence is no longer processing: ${id}`);
    if (occurrence.trigger_snapshot_json !== expectedDefinitionJson)
      throw new Error(`Trigger occurrence definition snapshot changed: ${id}`);
    if (
      !occurrence.responsibility_snapshot_json ||
      occurrence.responsibility_snapshot_json !== expectedResponsibilitySnapshotJson
    )
      throw new Error("Trigger occurrence responsibility snapshot changed or is unavailable.");
    const current = this.db
      .prepare("SELECT * FROM event_triggers WHERE id = ?")
      .get(occurrence.trigger_id) as Row | undefined;
    if (!current)
      throw new Error("Trigger definition changed or was removed after occurrence acceptance.");
    const currentDefinition = {
      id: current.id,
      name: current.name,
      ...(current.description ? { description: current.description } : {}),
      enabled: !!current.enabled,
      source: current.source,
      conditions: JSON.parse(current.conditions || "[]"),
      conditionLogic: current.condition_logic || "all",
      action: JSON.parse(current.action || "{}"),
      workspaceId: current.workspace_id,
      cooldownMs: current.cooldown_ms ?? DEFAULT_COOLDOWN_MS,
      createdAt: current.created_at,
    };
    if (
      !current.enabled ||
      stableJson(currentDefinition) !== stableJson(JSON.parse(expectedDefinitionJson))
    )
      throw new Error("Trigger definition changed or was removed after occurrence acceptance.");
    const expectedResponsibility = JSON.parse(expectedResponsibilitySnapshotJson) as Record<
      string,
      unknown
    > | null;
    const currentResponsibility = this.loadResponsibilitySnapshot(
      occurrence.trigger_id,
      currentDefinition,
    );
    if (stableJson(expectedResponsibility) !== stableJson(currentResponsibility))
      throw new Error("Event responsibility binding changed after occurrence acceptance.");
    if (expectedResponsibility) this.assertResponsibilityRunnable(expectedResponsibility);
    const expectedMailboxAccount = expectedResponsibility?.mailboxAccount as
      | ResponsibilityMailboxAccountReceipt
      | null
      | undefined;
    if (expectedResponsibility && expectedMailboxAccount)
      assertResponsibilityMailboxEvent(
        this.db,
        currentDefinition,
        JSON.parse(occurrence.event_json) as import("./types").TriggerEvent,
        String(expectedResponsibility.workspaceId),
        expectedMailboxAccount,
      );
    const result = this.db
      .prepare(
        `UPDATE event_trigger_occurrences SET status = 'intent', updated_at = ?
         WHERE id = ? AND status = 'processing'`,
      )
      .run(now, id);
    if (result.changes !== 1) throw new Error(`Trigger occurrence is no longer processing: ${id}`);
  }

  /**
   * Read the binding identity in the same transaction that crosses action intent. This
   * closes the gap between async host preparation and an intervening revision/control edit.
   */
  private loadResponsibilitySnapshot(
    triggerId: string,
    trigger: Pick<EventTrigger, "source" | "conditions">,
  ): Record<string, unknown> | null {
    const exists = (name: string) =>
      !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!exists("bot_responsibilities")) return null;
    const hasControls = exists("bot_responsibility_controls");
    const controlSelect = hasControls ? "COALESCE(c.control_version, 0)" : "0";
    const controlJoin = hasControls
      ? "LEFT JOIN bot_responsibility_controls c ON c.responsibility_id=b.id"
      : "";
    const projection = `SELECT b.id,b.workspace_id,b.agent_role_id,b.revision,
        ${controlSelect} AS control_version,b.engine_kind,b.engine_id,r.definition_json
      FROM bot_responsibilities b
      JOIN bot_responsibility_revisions r ON r.responsibility_id=b.id AND r.revision=b.revision
      ${controlJoin}`;
    const directRows = this.db
      .prepare(`${projection} WHERE b.engine_kind='trigger' AND b.engine_id=?`)
      .all(triggerId) as Row[];
    const routineRows = exists("automation_routines")
      ? (this.db
          .prepare(
            `${projection} JOIN automation_routines a ON a.id=b.engine_id
           WHERE b.engine_kind='routine' AND EXISTS (
             SELECT 1 FROM json_each(a.triggers_json) t
             WHERE json_extract(t.value,'$.managedEventTriggerId')=?
           ) LIMIT 2`,
          )
          .all(triggerId) as Row[])
      : [];
    if (directRows.length + routineRows.length > 1)
      throw new Error("Event trigger has ambiguous responsibility bindings.");
    const binding = directRows[0] ?? routineRows[0];
    if (!binding) return null;
    const definition = JSON.parse(String(binding.definition_json)) as {
      engine?: { kind?: unknown; id?: unknown };
      sources?: Array<{ connectorId?: unknown }>;
    };
    if (
      !definition.engine ||
      typeof definition.engine.kind !== "string" ||
      typeof definition.engine.id !== "string" ||
      !Array.isArray(definition.sources)
    )
      throw new Error("Event trigger responsibility definition is invalid.");
    const channelTypes = [
      ...new Set(
        definition.sources
          .filter(
            (source): source is { connectorId: string } =>
              typeof source.connectorId === "string" && source.connectorId.startsWith("gateway:"),
          )
          .map((source) => source.connectorId.slice("gateway:".length)),
      ),
    ].sort();
    const channelInstances = channelTypes.map((channelType) => {
      const channels = this.db
        .prepare("SELECT id,enabled FROM channels WHERE type=? LIMIT 2")
        .all(channelType) as Array<{ id: string; enabled: number }>;
      if (channels.length !== 1 || channels[0].enabled !== 1)
        throw new Error("Selected history channel instance changed after occurrence acceptance.");
      return { channelType, channelId: channels[0].id };
    });
    const mailboxAccount = selectedResponsibilityMailboxAccount(this.db, trigger);
    return {
      id: String(binding.id),
      revision: Number(binding.revision),
      controlVersion: Number(binding.control_version),
      workspaceId: String(binding.workspace_id),
      agentRoleId: String(binding.agent_role_id),
      engine: { kind: definition.engine.kind, id: definition.engine.id },
      channelInstances,
      mailboxAccount,
    };
  }

  /** Recheck mutable responsibility controls in the same transaction as action intent. */
  private assertResponsibilityRunnable(snapshot: Record<string, unknown>): void {
    const id = snapshot.id;
    const workspaceId = snapshot.workspaceId;
    const agentRoleId = snapshot.agentRoleId;
    if (
      typeof id !== "string" ||
      typeof workspaceId !== "string" ||
      typeof agentRoleId !== "string"
    )
      throw new Error("Event responsibility binding is invalid.");

    const responsibility = this.db
      .prepare("SELECT state FROM bot_responsibilities WHERE id=?")
      .get(id) as { state: string } | undefined;
    if (responsibility?.state !== "active") throw new Error("Responsibility execution is paused");

    const bot = this.db.prepare("SELECT is_active FROM agent_roles WHERE id=?").get(agentRoleId) as
      | { is_active: number }
      | undefined;
    if (bot?.is_active !== 1) throw new Error("Responsibility bot is unavailable");

    const hasTable = (name: string) =>
      !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (hasTable("bot_responsibility_future_controls")) {
      const future = this.db
        .prepare("SELECT paused FROM bot_responsibility_future_controls WHERE responsibility_id=?")
        .get(id) as { paused: number } | undefined;
      if (future?.paused === 1) throw new Error("Responsibility future runs are paused");
    }
    if (hasTable("bot_future_controls")) {
      const future = this.db
        .prepare("SELECT paused FROM bot_future_controls WHERE workspace_id=? AND agent_role_id=?")
        .get(workspaceId, agentRoleId) as { paused: number } | undefined;
      if (future?.paused === 1) throw new Error("Bot future runs are paused");
    }
  }

  /** Record history and a terminal receipt together; a crash cannot persist one without the other. */
  completeOccurrence(
    id: string,
    status: "completed" | "failed",
    receiptJson: string | null,
    error: string | null,
    entry: TriggerHistoryEntry,
    now: number,
  ): void {
    this.saveHistory(entry);
    const result = this.db
      .prepare(
        `UPDATE event_trigger_occurrences
         SET status = ?, receipt_json = ?, error = ?, updated_at = ?
         WHERE id = ? AND status IN ('processing', 'intent')`,
      )
      .run(status, receiptJson, error, now, id);
    if (result.changes !== 1) throw new Error(`Trigger occurrence is no longer active: ${id}`);
  }

  /** Ambiguous effects are retained permanently and never put back in the automatic queue. */
  markOccurrenceUnknown(id: string, message: string, now: number): void {
    this.db
      .prepare(
        `UPDATE event_trigger_occurrences
         SET status = 'outcome_unknown', error = ?, updated_at = ?
         WHERE id = ? AND status IN ('processing', 'intent')`,
      )
      .run(message, now, id);
  }

  markOccurrenceFailed(id: string, message: string, now: number): void {
    this.db
      .prepare(
        `UPDATE event_trigger_occurrences
         SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'processing')`,
      )
      .run(message, now, id);
  }

  releaseOccurrence(id: string, message: string, now: number): void {
    this.db
      .prepare(
        `UPDATE event_trigger_occurrences
         SET status = 'pending', error = ?, available_at = ?, updated_at = ?
         WHERE id = ? AND status = 'processing'`,
      )
      .run(message, now, now, id);
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
