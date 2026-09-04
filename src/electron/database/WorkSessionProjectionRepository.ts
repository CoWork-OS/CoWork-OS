import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  WorkSessionItem,
  WorkSessionItemKind,
  WorkSessionProjectionCursor,
  WorkSessionProjectionUpdate,
} from "../../shared/types";

type DbRow = Record<string, unknown>;

export type WorkSessionProjectionReducer<State> = (state: State, item: WorkSessionItem) => State;

export interface WorkSessionProjectionOptions<State> {
  projectionName: string;
  initialState: State;
  reduce: WorkSessionProjectionReducer<State>;
  compareEveryItems?: number;
  compareEveryMs?: number;
  forceCompare?: boolean;
}

export interface WorkSessionProjectionRebuild<State> {
  state: State;
  checksum: string;
  itemCount: number;
  lastSequence: number;
}

const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_COMPARE_EVERY_ITEMS = 100;
const DEFAULT_COMPARE_EVERY_MS = 60_000;
const MAX_PROJECTION_NAME_LENGTH = 128;
const MAX_STATE_BYTES = 128 * 1024;

function requiredId(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function projectionName(value: unknown): string {
  const normalized = requiredId(value, "projectionName");
  if (normalized.length > MAX_PROJECTION_NAME_LENGTH) {
    throw new Error("projectionName is too long");
  }
  return normalized;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function workSessionProjectionChecksum(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function boundedStateJson(value: unknown): string {
  const serialized = JSON.stringify(value === undefined ? null : value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new Error(`Projection state exceeds ${MAX_STATE_BYTES} bytes`);
  }
  return serialized;
}

function mapItem(row: DbRow): WorkSessionItem {
  const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
  const policySnapshot = row.policy_snapshot_json
    ? parseJson<Record<string, unknown>>(row.policy_snapshot_json, {})
    : undefined;
  const item: WorkSessionItem = {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    sequence: Number(row.sequence || 0),
    kind: (typeof row.kind === "string" ? row.kind : "legacy_event") as WorkSessionItemKind,
    actor: typeof row.actor === "string" ? row.actor : "system",
    payload,
    redactionClass: (typeof row.redaction_class === "string"
      ? row.redaction_class
      : "standard") as WorkSessionItem["redactionClass"],
    createdAt: Number(row.created_at || 0),
  };
  if (typeof row.causal_parent_item_id === "string" && row.causal_parent_item_id) {
    item.causalParentItemId = row.causal_parent_item_id;
  }
  if (typeof row.idempotency_key === "string" && row.idempotency_key) {
    item.idempotencyKey = row.idempotency_key;
  }
  if (typeof row.source_event_id === "string" && row.source_event_id) {
    item.sourceEventId = row.source_event_id;
  }
  if (policySnapshot && Object.keys(policySnapshot).length > 0)
    item.policySnapshot = policySnapshot;
  if (typeof row.status === "string" && row.status) {
    item.status = row.status as WorkSessionItem["status"];
  }
  return item;
}

/**
 * Durable cursor/reducer storage for provider-neutral session projections.
 * The append-only item stream remains the source of truth; this repository
 * never writes user-facing timeline rows.
 */
export class WorkSessionProjectionRepository {
  private readonly batchSize: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    options?: { batchSize?: number; now?: () => number },
  ) {
    this.batchSize = Math.min(
      10_000,
      Math.max(1, Math.floor(options?.batchSize || DEFAULT_BATCH_SIZE)),
    );
    this.now = options?.now || Date.now;
  }

  getCursor<State = Record<string, unknown>>(
    sessionId: string,
    projection: string,
  ): WorkSessionProjectionCursor<State> | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM work_session_projection_cursors
         WHERE session_id = ? AND projection_name = ?`,
      )
      .get(requiredId(sessionId, "sessionId"), projectionName(projection)) as DbRow | undefined;
    return row ? this.mapCursor<State>(row) : undefined;
  }

  /** Read a suffix only; callers can instrument this seam for O(delta) checks. */
  readItemsAfterSequence(sessionId: string, afterSequence: number): WorkSessionItem[] {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const after = Number.isFinite(afterSequence) ? Math.max(0, Math.floor(afterSequence)) : 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM work_session_items
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(normalizedSessionId, after, this.batchSize) as DbRow[];
    return rows.map(mapItem);
  }

  getLastSequence(sessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM work_session_items WHERE session_id = ?",
      )
      .get(requiredId(sessionId, "sessionId")) as { last_sequence?: number } | undefined;
    return Math.max(0, Number(row?.last_sequence || 0));
  }

  projectIncremental<State>(
    sessionId: string,
    options: WorkSessionProjectionOptions<State>,
  ): WorkSessionProjectionUpdate<State> {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const name = projectionName(options.projectionName);
    const compareEveryItems = Math.max(
      1,
      Math.floor(options.compareEveryItems || DEFAULT_COMPARE_EVERY_ITEMS),
    );
    const compareEveryMs = Math.max(
      0,
      Math.floor(options.compareEveryMs ?? DEFAULT_COMPARE_EVERY_MS),
    );
    const existing = this.getCursor<State>(normalizedSessionId, name);
    const currentLastSequence = this.getLastSequence(normalizedSessionId);
    const cursorAhead = Boolean(existing && existing.lastSequence > currentLastSequence);
    let state = cursorAhead ? options.initialState : (existing?.state ?? options.initialState);
    let lastSequence = cursorAhead ? 0 : (existing?.lastSequence ?? 0);
    let processed = 0;

    for (;;) {
      const items = this.readItemsAfterSequence(normalizedSessionId, lastSequence);
      if (items.length === 0) break;
      for (const item of items) {
        state = options.reduce(state, item);
        lastSequence = item.sequence;
        processed += 1;
      }
      if (items.length < this.batchSize) break;
    }

    const now = this.now();
    let checksum = workSessionProjectionChecksum(state);
    let lastComparedAt = cursorAhead ? undefined : existing?.lastComparedAt;
    let fullRebuildChecksum = cursorAhead ? undefined : existing?.fullRebuildChecksum;
    let lastComparisonMatched = cursorAhead ? undefined : existing?.lastComparisonMatched;
    let comparisonPerformed = false;

    const previousProcessedItems = cursorAhead ? 0 : existing?.processedItems || 0;
    const cumulativeProcessedItems = previousProcessedItems + processed;
    const dueByItems =
      processed > 0 &&
      Math.floor(cumulativeProcessedItems / compareEveryItems) >
        Math.floor(previousProcessedItems / compareEveryItems);
    const dueByTime =
      lastComparedAt === undefined ||
      (compareEveryMs > 0 && now - lastComparedAt >= compareEveryMs);
    // A projection invocation is also a safe opportunity to detect drift
    // after an idle period.  The rebuild is still gated by the configured
    // cadence; normal hot-path updates only reduce the suffix after the
    // persisted cursor.
    if (options.forceCompare || dueByItems || dueByTime) {
      const rebuilt = this.rebuild(normalizedSessionId, options);
      fullRebuildChecksum = rebuilt.checksum;
      lastComparisonMatched = checksum === rebuilt.checksum;
      lastComparedAt = now;
      comparisonPerformed = true;
    }

    const nextCursor: WorkSessionProjectionCursor<State> = {
      sessionId: normalizedSessionId,
      projectionName: name,
      lastSequence,
      state,
      checksum,
      processedItems: cumulativeProcessedItems,
      ...(lastComparedAt === undefined ? {} : { lastComparedAt }),
      ...(fullRebuildChecksum ? { fullRebuildChecksum } : {}),
      ...(lastComparisonMatched === undefined ? {} : { lastComparisonMatched }),
      updatedAt: now,
    };

    const stateJson = boundedStateJson(nextCursor.state);
    this.db
      .prepare(
        `INSERT INTO work_session_projection_cursors (
           session_id, projection_name, last_sequence, state_json, checksum,
           processed_items, last_compared_at, full_rebuild_checksum,
           last_comparison_matched, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, projection_name) DO UPDATE SET
           last_sequence = excluded.last_sequence,
           state_json = excluded.state_json,
           checksum = excluded.checksum,
           processed_items = excluded.processed_items,
           last_compared_at = excluded.last_compared_at,
           full_rebuild_checksum = excluded.full_rebuild_checksum,
           last_comparison_matched = excluded.last_comparison_matched,
           updated_at = excluded.updated_at`,
      )
      .run(
        normalizedSessionId,
        name,
        nextCursor.lastSequence,
        stateJson,
        nextCursor.checksum,
        nextCursor.processedItems,
        nextCursor.lastComparedAt ?? null,
        nextCursor.fullRebuildChecksum ?? null,
        nextCursor.lastComparisonMatched === undefined
          ? null
          : nextCursor.lastComparisonMatched
            ? 1
            : 0,
        nextCursor.updatedAt,
      );

    return {
      cursor: nextCursor,
      processed,
      deltaItems: processed,
      comparisonPerformed,
      ...(fullRebuildChecksum ? { fullRebuildChecksum } : {}),
      ...(lastComparisonMatched === undefined ? {} : { matches: lastComparisonMatched }),
    };
  }

  rebuild<State>(
    sessionId: string,
    options: Pick<
      WorkSessionProjectionOptions<State>,
      "initialState" | "reduce" | "projectionName"
    >,
  ): WorkSessionProjectionRebuild<State> {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    projectionName(options.projectionName);
    let state = options.initialState;
    let itemCount = 0;
    let lastSequence = 0;
    for (;;) {
      const items = this.readItemsAfterSequence(normalizedSessionId, lastSequence);
      if (items.length === 0) break;
      for (const item of items) {
        state = options.reduce(state, item);
        itemCount += 1;
        lastSequence = item.sequence;
      }
      if (items.length < this.batchSize) break;
    }
    return {
      state,
      checksum: workSessionProjectionChecksum(state),
      itemCount,
      lastSequence,
    };
  }

  compareFullRebuild<State>(
    sessionId: string,
    options: Pick<
      WorkSessionProjectionOptions<State>,
      "initialState" | "reduce" | "projectionName"
    >,
  ): { incrementalChecksum?: string; fullRebuildChecksum: string; matches: boolean } {
    const cursor = this.getCursor<State>(sessionId, options.projectionName);
    const rebuilt = this.rebuild(sessionId, options);
    return {
      ...(cursor ? { incrementalChecksum: cursor.checksum } : {}),
      fullRebuildChecksum: rebuilt.checksum,
      matches: Boolean(cursor && cursor.checksum === rebuilt.checksum),
    };
  }

  private mapCursor<State>(row: DbRow): WorkSessionProjectionCursor<State> {
    const state = parseJson<State>(row.state_json, {} as State);
    return {
      sessionId: String(row.session_id),
      projectionName: String(row.projection_name),
      lastSequence: Math.max(0, Number(row.last_sequence || 0)),
      state,
      checksum:
        typeof row.checksum === "string" ? row.checksum : workSessionProjectionChecksum(state),
      processedItems: Math.max(0, Number(row.processed_items || 0)),
      ...(row.last_compared_at == null ? {} : { lastComparedAt: Number(row.last_compared_at) }),
      ...(typeof row.full_rebuild_checksum === "string" && row.full_rebuild_checksum
        ? { fullRebuildChecksum: row.full_rebuild_checksum }
        : {}),
      ...(row.last_comparison_matched == null
        ? {}
        : { lastComparisonMatched: Number(row.last_comparison_matched) === 1 }),
      updatedAt: Number(row.updated_at || 0),
    };
  }
}
