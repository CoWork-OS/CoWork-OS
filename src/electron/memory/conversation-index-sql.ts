import type Database from "better-sqlite3";
import {
  buildFtsMatchQuery,
  extractFtsTerms,
  foldForMatch,
  type FtsQueryMode,
} from "../database/fts-query";
import { taskDisablesMemoryCapture } from "./no-memory-directive";

/**
 * The conversation index (audit §4 "Copies of the conversation", §8.2 Event Log): the
 * one search index over what happened in tasks, part of the durable context store.
 *
 * - Fed from task events for every task (`DurableContextService.indexEvent`, called by
 *   the daemon's event pipeline) and backfilled once from `task_events` and the legacy
 *   `transcript_spans` index, which it replaces.
 * - Rows hold clean text extracted from the event payload (no raw JSON), keyed by the
 *   event (`task_id`, `event_key`), and an external-content FTS5 index keyed by the row's
 *   rowid with a Unicode tokenizer that folds case and diacritics.
 * - Scoped by workspace id; retention follows `task_events` retention; task deletes and
 *   workspace purges remove the rows.
 *
 * Synchronous SQL for the memory domain's transaction units (durable-context-units.ts,
 * transcript-units.ts); free of Electron and service imports so the database worker can
 * load it.
 */

export const CONVERSATION_EVENTS_TABLE = "durable_context_events";
export const CONVERSATION_EVENTS_FTS = "durable_context_events_fts";
const META_TABLE = "durable_context_meta";

/** Indexed text per event; enough for search and snippets, not a second event log. */
export const CONVERSATION_TEXT_MAX_CHARS = 4000;

/** Event types that carry conversation content worth searching. */
export const CONVERSATION_EVENT_TYPES = new Set([
  "task_created",
  "user_message",
  "assistant_message",
  "agent_message",
  "tool_call",
  "tool_result",
  "tool_error",
  "step_feedback",
  "task_completed",
  "follow_up_completed",
  "timeline_error",
  "timeline_command_output",
  "command_output",
  "plan_created",
  "file_created",
  "file_modified",
  "context_summarized",
  "error",
]);

/**
 * Recall tools whose calls and results are not indexed: their output is earlier
 * conversation, and indexing it would echo old hits back into later searches.
 */
const RECALL_TOOL_NAMES = new Set([
  "memory_recall",
  "context_recall",
  "task_history",
  // Retired recall tools (audit §8.3, RETIRED_MEMORY_TOOL_NAMES): no longer registered,
  // but the one-time backfill reads recorded task events that still carry their output.
  "memory_topics_load",
  "memory_curated_read",
  "supermemory_profile",
  "supermemory_search",
  "search_sessions",
  "search_quotes",
  "context_grep",
  "context_describe",
  "search_memories",
  "memory_search_index",
  "memory_timeline",
  "memory_details",
]);

const SKIPPED_PAYLOAD_KEYS = new Set([
  "id",
  "eventid",
  "taskid",
  "stepid",
  "groupid",
  "legacytype",
  "timestamp",
  "ts",
  "seq",
  "providertype",
  "schemaversion",
  "imagebase64",
  "image_base64",
  "screenshotbase64",
  "screenshot_base64",
  "data",
  "base64",
  "signature",
  "usage",
  "tokens",
  "durationms",
  "status",
  "actor",
  "kind",
]);

const PREFERRED_TEXT_FIELDS = [
  "message",
  "text",
  "content",
  "summary",
  "resultSummary",
  "result",
  "output",
  "response",
  "error",
  "reason",
  "prompt",
  "title",
];

export type ConversationRole = "user" | "assistant" | "tool" | "system";

export interface ConversationEventInput {
  workspaceId: string;
  taskId: string;
  eventKey: string;
  eventId?: string | null;
  seq?: number | null;
  type: string;
  role: ConversationRole;
  text: string;
  timestamp: number;
}

export interface ConversationHit {
  /** `dce_<rowid>` (event), `dcs_...` (compaction summary) or `dcl_<rowid>` (legacy span). */
  id: string;
  kind: "event" | "summary";
  workspaceId: string;
  taskId: string;
  /** The event type, or `summary`. */
  type: string;
  role: ConversationRole;
  timestamp: number;
  /** Clean text around the match (no JSON), at most ~600 characters. */
  snippet: string;
  eventId?: string;
  seq?: number;
  /** Fused relevance, higher is better; comparable only within one result list. */
  score: number;
}

export interface ConversationSearchArgs {
  workspaceId: string;
  taskId?: string | null;
  query: string;
  limit: number;
  /**
   * `all`: every term must match. `any`: any term (bm25 ranks overlap). `auto`: `all`
   * first, then filled with `any` matches when it found fewer than `limit`.
   */
  mode?: FtsQueryMode | "auto";
  /** Include compaction summaries recorded by durable context. Default true. */
  includeSummaries?: boolean;
  /** Event types to leave out (e.g. the current prompt's `task_created`). */
  excludeTypes?: string[];
}

export interface ConversationRecentArgs {
  workspaceId: string;
  taskId: string;
  limit: number;
}

export interface ConversationRetentionArgs {
  /** Terminal tasks created before this are pruned, as for `task_events`. */
  cutoff: number;
  /** Tasks handled per call; the caller repeats until `tasks` is below it. */
  maxTasks: number;
}

export interface ConversationRetentionResult {
  tasks: number;
  rows: number;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function looksLikeBinaryText(value: string): boolean {
  if (value.startsWith("data:")) return true;
  // Long runs without whitespace are base64/hex blobs, not prose.
  return value.length > 400 && !/\s/.test(value.slice(0, 400));
}

/** String leaves of a value, depth- and size-bounded, skipping ids and blobs. */
function flattenText(value: unknown, budget: number, depth = 0, out: string[] = []): string[] {
  if (budget <= 0 || depth > 6 || value === null || value === undefined) return out;
  if (typeof value === "string") {
    const text = collapse(value);
    if (text && !looksLikeBinaryText(text)) out.push(text.slice(0, budget));
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") return out;
  if (Array.isArray(value)) {
    let used = out.join(" ").length;
    for (const entry of value.slice(0, 50)) {
      if (used >= budget) break;
      flattenText(entry, budget - used, depth + 1, out);
      used = out.join(" ").length;
    }
    return out;
  }
  if (typeof value === "object") {
    let used = out.join(" ").length;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      if (used >= budget) break;
      if (SKIPPED_PAYLOAD_KEYS.has(key.toLowerCase())) continue;
      flattenText(entry, budget - used, depth + 1, out);
      used = out.join(" ").length;
    }
  }
  return out;
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return payload;
  try {
    return JSON.parse(trimmed);
  } catch {
    return payload;
  }
}

function firstField(record: Record<string, unknown>, fields: string[]): unknown {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") return value;
  }
  return undefined;
}

export function conversationRoleForType(type: string): ConversationRole {
  if (type === "user_message" || type === "task_created" || type === "step_feedback") {
    return "user";
  }
  if (
    type === "assistant_message" ||
    type === "agent_message" ||
    type === "task_completed" ||
    type === "follow_up_completed" ||
    type === "plan_created" ||
    type === "context_summarized"
  ) {
    return "assistant";
  }
  if (type.startsWith("tool_") || type.endsWith("command_output") || type.startsWith("file_")) {
    return "tool";
  }
  return "system";
}

/**
 * Clean, bounded text of an event for the index, or null when the event is not
 * conversation content (unknown type, recall-tool echo, empty or binary payload).
 */
export function extractConversationEventText(type: string, rawPayload: unknown): string | null {
  if (!CONVERSATION_EVENT_TYPES.has(type)) return null;
  const payload = parsePayload(rawPayload);
  const budget = CONVERSATION_TEXT_MAX_CHARS;
  if (typeof payload === "string") {
    const text = collapse(payload);
    return text && !looksLikeBinaryText(text) ? text.slice(0, budget) : null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const tool =
    typeof record.tool === "string"
      ? record.tool
      : typeof record.toolName === "string"
        ? record.toolName
        : typeof record.name === "string" && type.startsWith("tool_")
          ? record.name
          : "";
  if (tool && RECALL_TOOL_NAMES.has(tool)) return null;

  const parts: string[] = [];
  switch (type) {
    case "task_created":
      parts.push(...flattenText(firstField(record, ["title"]), 200));
      parts.push(...flattenText(firstField(record, ["prompt", "message", "text"]), budget));
      break;
    case "tool_call":
      if (tool) parts.push(tool);
      parts.push(
        ...flattenText(firstField(record, ["input", "args", "arguments", "params"]), 1200),
      );
      break;
    case "tool_result":
    case "tool_error":
      if (tool) parts.push(tool);
      parts.push(
        ...flattenText(
          firstField(record, ["error", "result", "output", "content", "message", "summary"]),
          budget,
        ),
      );
      break;
    case "file_created":
    case "file_modified":
      parts.push(...flattenText(firstField(record, ["path", "filePath", "outputPath"]), 400));
      parts.push(...flattenText(firstField(record, ["message", "summary"]), 600));
      break;
    default: {
      const preferred = firstField(record, PREFERRED_TEXT_FIELDS);
      parts.push(...flattenText(preferred ?? record, budget));
    }
  }
  const text = collapse(parts.filter(Boolean).join(" ")).slice(0, budget);
  if (!text || (tool && text === tool)) return null;
  return text;
}

/** Stable key of an event within its task, shared by live indexing and backfills. */
export function conversationEventKey(event: {
  eventId?: string | null;
  seq?: number | null;
  id?: string | null;
  timestamp?: number | null;
  type?: string | null;
}): string {
  if (typeof event.eventId === "string" && event.eventId) return `e:${event.eventId}`;
  if (typeof event.seq === "number" && Number.isFinite(event.seq)) return `s:${event.seq}`;
  if (typeof event.id === "string" && event.id) return `i:${event.id}`;
  return `t:${Number(event.timestamp || 0)}:${event.type || ""}`;
}

/** The indexed type of a stored event: the legacy type for timeline-v2 rows. */
export function conversationIndexedType(type: string, legacyType?: string | null): string {
  if (legacyType && CONVERSATION_EVENT_TYPES.has(legacyType)) return legacyType;
  return type;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function tableExists(db: Pick<Database.Database, "prepare">, name: string): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`)
      .get(name),
  );
}

/** Create the conversation index tables (idempotent); runs on the host before first use. */
export function ensureConversationIndexSchema(db: Pick<Database.Database, "exec">): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONVERSATION_EVENTS_TABLE} (
      id INTEGER PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      event_id TEXT,
      seq INTEGER,
      type TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'event',
      UNIQUE(task_id, event_key)
    );
    CREATE INDEX IF NOT EXISTS idx_durable_context_events_scope
      ON ${CONVERSATION_EVENTS_TABLE}(workspace_id, task_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_durable_context_events_workspace_time
      ON ${CONVERSATION_EVENTS_TABLE}(workspace_id, timestamp DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS ${CONVERSATION_EVENTS_FTS} USING fts5(
      text,
      content='${CONVERSATION_EVENTS_TABLE}',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS durable_context_events_fts_insert
    AFTER INSERT ON ${CONVERSATION_EVENTS_TABLE} BEGIN
      INSERT INTO ${CONVERSATION_EVENTS_FTS}(rowid, text) VALUES (NEW.id, NEW.text);
    END;
    CREATE TRIGGER IF NOT EXISTS durable_context_events_fts_delete
    AFTER DELETE ON ${CONVERSATION_EVENTS_TABLE} BEGIN
      INSERT INTO ${CONVERSATION_EVENTS_FTS}(${CONVERSATION_EVENTS_FTS}, rowid, text)
      VALUES ('delete', OLD.id, OLD.text);
    END;
    CREATE TRIGGER IF NOT EXISTS durable_context_events_fts_update
    AFTER UPDATE OF text ON ${CONVERSATION_EVENTS_TABLE} BEGIN
      INSERT INTO ${CONVERSATION_EVENTS_FTS}(${CONVERSATION_EVENTS_FTS}, rowid, text)
      VALUES ('delete', OLD.id, OLD.text);
      INSERT INTO ${CONVERSATION_EVENTS_FTS}(rowid, text) VALUES (NEW.id, NEW.text);
    END;

    CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const RRF_K = 60;
const SNIPPET_MAX_CHARS = 600;
const TERMINAL_STATUSES_SQL = "('completed', 'failed', 'cancelled')";

/** Meta keys of the one-time migration (see `DurableContextService.migrateLegacyTranscripts`). */
export const LEGACY_SPANS_DONE = "legacy_transcript_spans_migrated_v1";
const LEGACY_SPANS_CURSOR = "legacy_transcript_spans_cursor_v1";
const LEGACY_SPANS_MAX = "legacy_transcript_spans_max_rowid_v1";
export const TASK_EVENTS_DONE = "task_events_backfilled_v1";
const TASK_EVENTS_CURSOR = "task_events_backfill_cursor_v1";
const TASK_EVENTS_MAX = "task_events_backfill_max_rowid_v1";

export type MigrationPhaseState =
  | { status: "done" }
  | { status: "pending"; cursor: number; maxRowid: number };

export interface ConversationMigrationStart {
  spans: MigrationPhaseState;
  events: MigrationPhaseState;
}

function cleanSnippet(text: string, terms: string[], max = SNIPPET_MAX_CHARS): string {
  const compact = collapse(text);
  if (compact.length <= max) return compact;
  const folded = foldForMatch(compact);
  let anchor = -1;
  for (const term of terms) {
    const index = folded.indexOf(foldForMatch(term));
    if (index >= 0 && (anchor < 0 || index < anchor)) anchor = index;
  }
  const start = Math.max(0, (anchor < 0 ? 0 : anchor) - Math.floor(max / 3));
  const end = Math.min(compact.length, start + max);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end).trim()}${end < compact.length ? "…" : ""}`;
}

interface LaneHit extends Omit<ConversationHit, "score"> {
  dedupeKey: string;
}

function fuse(lanes: LaneHit[][], limit: number): ConversationHit[] {
  const fused = new Map<string, { hit: LaneHit; score: number }>();
  for (const lane of lanes) {
    lane.forEach((hit, index) => {
      const score = 1 / (RRF_K + index + 1);
      const existing = fused.get(hit.dedupeKey);
      if (existing) existing.score += score;
      else fused.set(hit.dedupeKey, { hit, score });
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || b.hit.timestamp - a.hit.timestamp)
    .slice(0, limit)
    .map(({ hit, score }) => {
      const { dedupeKey: _dedupeKey, ...rest } = hit;
      return { ...rest, score: Number(score.toFixed(6)) };
    });
}

export class ConversationIndexStore {
  constructor(private readonly db: Database.Database) {}

  /** Insert events; already-indexed events (same task and key) are left unchanged. */
  indexEvents(events: ConversationEventInput[]): number {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO ${CONVERSATION_EVENTS_TABLE} (
         workspace_id, task_id, event_key, event_id, seq, type, role, text, timestamp, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'event')`,
    );
    let inserted = 0;
    for (const event of events.slice(0, 1000)) {
      const text =
        typeof event?.text === "string" ? event.text.slice(0, CONVERSATION_TEXT_MAX_CHARS) : "";
      if (!event?.workspaceId || !event.taskId || !event.eventKey || !text.trim()) continue;
      inserted += insert.run(
        event.workspaceId,
        event.taskId,
        event.eventKey,
        event.eventId ?? null,
        typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : null,
        event.type,
        event.role,
        text,
        Number(event.timestamp) || 0,
      ).changes;
    }
    return inserted;
  }

  search(args: ConversationSearchArgs): ConversationHit[] {
    const limit = Math.min(Math.max(Math.floor(args.limit) || 10, 1), 200);
    const mode = args.mode ?? "auto";
    const terms = extractFtsTerms(args.query);
    if (terms.length === 0 || !args.workspaceId) return [];
    const primaryMode: FtsQueryMode = mode === "any" ? "any" : "all";
    const primary = this.searchLanes(args, primaryMode, terms, limit);
    if (mode !== "auto" || terms.length < 2 || primary.length >= limit) return primary;
    const relaxed = this.searchLanes(args, "any", terms, limit);
    const seen = new Set(primary.map((hit) => hit.id));
    return [...primary, ...relaxed.filter((hit) => !seen.has(hit.id))].slice(0, limit);
  }

  /** The most recent indexed events of a task, oldest first. */
  recent(args: ConversationRecentArgs): ConversationHit[] {
    const limit = Math.min(Math.max(Math.floor(args.limit) || 20, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, task_id, event_id, seq, type, role, text, timestamp
         FROM ${CONVERSATION_EVENTS_TABLE}
         WHERE workspace_id = ? AND task_id = ?
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      )
      .all(args.workspaceId, args.taskId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => ({
      ...this.mapEventRow(row, []),
      score: 0,
    }));
  }

  /** One indexed event by its `dce_` id, within the workspace (and task, when given). */
  describeEvent(args: { workspaceId: string; taskId?: string | null; id: string }): {
    id: string;
    workspaceId: string;
    taskId: string;
    type: string;
    role: string;
    timestamp: number;
    text: string;
    eventId?: string;
    seq?: number;
  } | null {
    const match = /^dce_(\d+)$/.exec(String(args.id || ""));
    if (!match) return null;
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, task_id, event_id, seq, type, role, text, timestamp
         FROM ${CONVERSATION_EVENTS_TABLE}
         WHERE id = ? AND workspace_id = ? AND (? IS NULL OR task_id = ?)`,
      )
      .get(Number(match[1]), args.workspaceId, args.taskId ?? null, args.taskId ?? null) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: `dce_${row.id}`,
      workspaceId: String(row.workspace_id),
      taskId: String(row.task_id),
      type: String(row.type),
      role: String(row.role),
      timestamp: Number(row.timestamp || 0),
      text: String(row.text || ""),
      ...(typeof row.event_id === "string" && row.event_id ? { eventId: row.event_id } : {}),
      ...(typeof row.seq === "number" ? { seq: row.seq } : {}),
    };
  }

  deleteTask(taskId: string): number {
    return this.db.prepare(`DELETE FROM ${CONVERSATION_EVENTS_TABLE} WHERE task_id = ?`).run(taskId)
      .changes;
  }

  clearWorkspace(workspaceId: string): number {
    return this.db
      .prepare(`DELETE FROM ${CONVERSATION_EVENTS_TABLE} WHERE workspace_id = ?`)
      .run(workspaceId).changes;
  }

  /**
   * Retention aligned with `PRUNE_TASK_EVENTS_BATCH_SQL`: removes the index rows (and the
   * durable context history) of terminal tasks created before the cutoff, and of tasks
   * that no longer exist. Without a `tasks` table nothing is known to be expired.
   */
  pruneRetention(args: ConversationRetentionArgs): ConversationRetentionResult {
    if (!tableExists(this.db, "tasks")) return { tasks: 0, rows: 0 };
    const maxTasks = Math.min(Math.max(Math.floor(args.maxTasks) || 100, 1), 1000);
    const historyTasks = tableExists(this.db, "durable_context_conversations")
      ? "UNION SELECT DISTINCT task_id FROM durable_context_conversations"
      : "";
    const taskIds = (
      this.db
        .prepare(
          `SELECT d.task_id AS task_id
           FROM (
             SELECT DISTINCT task_id FROM ${CONVERSATION_EVENTS_TABLE}
             ${historyTasks}
           ) d
           LEFT JOIN tasks t ON t.id = d.task_id
           WHERE t.id IS NULL
              OR (t.status IN ${TERMINAL_STATUSES_SQL} AND t.created_at < ?)
           LIMIT ?`,
        )
        .all(args.cutoff, maxTasks) as Array<{ task_id: string }>
    ).map((row) => row.task_id);
    if (taskIds.length === 0) return { tasks: 0, rows: 0 };
    const ids = JSON.stringify(taskIds);
    let rows = this.db
      .prepare(
        `DELETE FROM ${CONVERSATION_EVENTS_TABLE}
         WHERE task_id IN (SELECT value FROM json_each(?))`,
      )
      .run(ids).changes;
    rows += this.deleteDurableHistory(ids);
    return { tasks: taskIds.length, rows };
  }

  // -------------------------------------------------------------------------
  // One-time migration: legacy transcript spans and task_events → index
  // -------------------------------------------------------------------------

  migrationStart(now: number): ConversationMigrationStart {
    return {
      spans: this.phaseStart(
        LEGACY_SPANS_DONE,
        LEGACY_SPANS_CURSOR,
        LEGACY_SPANS_MAX,
        "transcript_spans",
        now,
      ),
      events: this.phaseStart(
        TASK_EVENTS_DONE,
        TASK_EVENTS_CURSOR,
        TASK_EVENTS_MAX,
        "task_events",
        now,
      ),
    };
  }

  /**
   * One window (lower, upper] of `transcript_spans`: index the spans whose task is known,
   * then delete the window (its FTS rows go with it through the span triggers).
   */
  migrateSpanWindow(
    lower: number,
    upper: number,
    now: number,
  ): { indexed: number; deleted: number } {
    if (!tableExists(this.db, "transcript_spans")) {
      this.writeMeta(LEGACY_SPANS_CURSOR, String(upper), now);
      return { indexed: 0, deleted: 0 };
    }
    const hasTasks = tableExists(this.db, "tasks");
    const rows = this.db
      .prepare(
        hasTasks
          ? `SELECT s.task_id, s.timestamp, s.type, s.payload_json, s.event_id, s.seq,
                    t.workspace_id, t.prompt, t.raw_prompt
             FROM transcript_spans s
             LEFT JOIN tasks t ON t.id = s.task_id
             WHERE s.rowid > ? AND s.rowid <= ?`
          : `SELECT s.task_id, s.timestamp, s.type, s.payload_json, s.event_id, s.seq,
                    NULL AS workspace_id, NULL AS prompt, NULL AS raw_prompt
             FROM transcript_spans s
             WHERE s.rowid > ? AND s.rowid <= ?`,
      )
      .all(lower, upper) as Array<Record<string, unknown>>;
    const events: ConversationEventInput[] = [];
    for (const row of rows) {
      const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : "";
      if (!workspaceId) continue;
      if (
        taskDisablesMemoryCapture({
          prompt: row.prompt as string,
          rawPrompt: row.raw_prompt as string,
        })
      ) {
        continue;
      }
      const type = String(row.type || "");
      const text = extractConversationEventText(type, row.payload_json);
      if (!text) continue;
      const seq = typeof row.seq === "number" ? row.seq : null;
      const eventId = typeof row.event_id === "string" && row.event_id ? row.event_id : null;
      events.push({
        workspaceId,
        taskId: String(row.task_id),
        eventKey: conversationEventKey({
          eventId,
          seq,
          timestamp: Number(row.timestamp || 0),
          type,
        }),
        eventId,
        seq,
        type,
        role: conversationRoleForType(type),
        text,
        timestamp: Number(row.timestamp || 0),
      });
    }
    const indexed = this.indexEventsWithSource(events, "legacy_span");
    const deleted = this.db
      .prepare(`DELETE FROM transcript_spans WHERE rowid > ? AND rowid <= ?`)
      .run(lower, upper).changes;
    this.writeMeta(LEGACY_SPANS_CURSOR, String(upper), now);
    return { indexed, deleted };
  }

  /**
   * Drop what is left of the span index (rows written after the migration started, by an
   * older client) and record completion. Space is returned by the idle VACUUM.
   */
  finishSpanMigration(now: number): { deleted: number } {
    let deleted = 0;
    if (tableExists(this.db, "transcript_spans")) {
      deleted = this.db.prepare(`DELETE FROM transcript_spans`).run().changes;
      if (tableExists(this.db, "transcript_spans_fts")) {
        this.db
          .prepare(`INSERT INTO transcript_spans_fts(transcript_spans_fts) VALUES('delete-all')`)
          .run();
      }
      if (tableExists(this.db, "transcript_span_index_gap")) {
        this.db.prepare(`DELETE FROM transcript_span_index_gap`).run();
      }
    }
    this.writeMeta(LEGACY_SPANS_DONE, JSON.stringify({ completedAt: now }), now);
    this.deleteMeta(LEGACY_SPANS_CURSOR);
    this.deleteMeta(LEGACY_SPANS_MAX);
    return { deleted };
  }

  /** One window (lower, upper] of `task_events`: index its conversation events. */
  backfillEventWindow(lower: number, upper: number, now: number): { indexed: number } {
    if (!tableExists(this.db, "task_events") || !tableExists(this.db, "tasks")) {
      this.writeMeta(TASK_EVENTS_CURSOR, String(upper), now);
      return { indexed: 0 };
    }
    const types = JSON.stringify([...CONVERSATION_EVENT_TYPES]);
    const rows = this.db
      .prepare(
        `SELECT e.id, e.task_id, e.timestamp, e.type, e.legacy_type, e.payload, e.event_id, e.seq,
                t.workspace_id, t.prompt, t.raw_prompt
         FROM task_events e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.rowid > ? AND e.rowid <= ?
           AND (e.type IN (SELECT value FROM json_each(?))
                OR e.legacy_type IN (SELECT value FROM json_each(?)))`,
      )
      .all(lower, upper, types, types) as Array<Record<string, unknown>>;
    const events: ConversationEventInput[] = [];
    for (const row of rows) {
      const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : "";
      if (!workspaceId) continue;
      if (
        taskDisablesMemoryCapture({
          prompt: row.prompt as string,
          rawPrompt: row.raw_prompt as string,
        })
      ) {
        continue;
      }
      const type = conversationIndexedType(
        String(row.type || ""),
        row.legacy_type as string | null,
      );
      const text = extractConversationEventText(type, row.payload);
      if (!text) continue;
      const seq = typeof row.seq === "number" ? row.seq : null;
      const eventId = typeof row.event_id === "string" && row.event_id ? row.event_id : null;
      events.push({
        workspaceId,
        taskId: String(row.task_id),
        eventKey: conversationEventKey({
          eventId,
          seq,
          id: String(row.id || ""),
          timestamp: Number(row.timestamp || 0),
          type,
        }),
        eventId,
        seq,
        type,
        role: conversationRoleForType(type),
        text,
        timestamp: Number(row.timestamp || 0),
      });
    }
    const indexed = this.indexEvents(events);
    this.writeMeta(TASK_EVENTS_CURSOR, String(upper), now);
    return { indexed };
  }

  finishEventBackfill(now: number): void {
    this.writeMeta(TASK_EVENTS_DONE, JSON.stringify({ completedAt: now }), now);
    this.deleteMeta(TASK_EVENTS_CURSOR);
    this.deleteMeta(TASK_EVENTS_MAX);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private indexEventsWithSource(events: ConversationEventInput[], source: string): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO ${CONVERSATION_EVENTS_TABLE} (
         workspace_id, task_id, event_key, event_id, seq, type, role, text, timestamp, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const event of events) {
      inserted += insert.run(
        event.workspaceId,
        event.taskId,
        event.eventKey,
        event.eventId ?? null,
        event.seq ?? null,
        event.type,
        event.role,
        event.text,
        event.timestamp,
        source,
      ).changes;
    }
    return inserted;
  }

  private phaseStart(
    doneKey: string,
    cursorKey: string,
    maxKey: string,
    sourceTable: string,
    now: number,
  ): MigrationPhaseState {
    if (this.readMeta(doneKey)) return { status: "done" };
    if (!tableExists(this.db, sourceTable)) {
      this.writeMeta(doneKey, JSON.stringify({ completedAt: now, skipped: "no_source" }), now);
      return { status: "done" };
    }
    let maxRowid = Number(this.readMeta(maxKey) ?? NaN);
    if (!Number.isFinite(maxRowid)) {
      const row = this.db
        .prepare(`SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM ${sourceTable}`)
        .get() as { max_rowid: number };
      maxRowid = Number(row.max_rowid || 0);
      this.writeMeta(maxKey, String(maxRowid), now);
      this.writeMeta(cursorKey, "0", now);
    }
    const cursor = Number(this.readMeta(cursorKey) ?? 0) || 0;
    return { status: "pending", cursor, maxRowid };
  }

  private legacyLaneActive(): boolean {
    return !this.readMeta(LEGACY_SPANS_DONE) && tableExists(this.db, "transcript_spans");
  }

  private searchLanes(
    args: ConversationSearchArgs,
    mode: FtsQueryMode,
    terms: string[],
    limit: number,
  ): ConversationHit[] {
    const match = buildFtsMatchQuery(terms.join(" "), { mode, prefix: true });
    if (!match) return [];
    const candidateLimit = Math.min(limit * 3, 300);
    const excluded = new Set((args.excludeTypes || []).filter(Boolean));
    const taskId = args.taskId || null;
    const lanes: LaneHit[][] = [];

    lanes.push(
      this.searchEventLane(args.workspaceId, taskId, match, terms, candidateLimit, excluded),
    );
    if (args.includeSummaries !== false && !excluded.has("summary")) {
      lanes.push(this.searchSummaryLane(args.workspaceId, taskId, match, terms, candidateLimit));
    }
    // Read compatibility until the one-time migration has moved every span.
    if (this.legacyLaneActive()) {
      lanes.push(
        this.searchLegacySpanLane(args.workspaceId, taskId, match, terms, candidateLimit, excluded),
      );
    }
    return fuse(lanes, limit);
  }

  private mapEventRow(
    row: Record<string, unknown>,
    terms: string[],
    snippetText?: string,
  ): LaneHit {
    const type = String(row.type || "");
    const eventId = typeof row.event_id === "string" && row.event_id ? row.event_id : undefined;
    const seq = typeof row.seq === "number" ? row.seq : undefined;
    const taskId = String(row.task_id || "");
    return {
      id: `dce_${row.id}`,
      kind: "event",
      workspaceId: String(row.workspace_id || ""),
      taskId,
      type,
      role: (String(row.role || "") as ConversationRole) || conversationRoleForType(type),
      timestamp: Number(row.timestamp || 0),
      snippet: cleanSnippet(snippetText || String(row.text || ""), terms),
      ...(eventId ? { eventId } : {}),
      ...(typeof seq === "number" ? { seq } : {}),
      dedupeKey: `${taskId}:${eventId ? `e:${eventId}` : `r:${row.id}`}`,
    };
  }

  private searchEventLane(
    workspaceId: string,
    taskId: string | null,
    match: string,
    terms: string[],
    limit: number,
    excluded: Set<string>,
  ): LaneHit[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT e.id, e.workspace_id, e.task_id, e.event_id, e.seq, e.type, e.role, e.timestamp,
                  e.text,
                  snippet(${CONVERSATION_EVENTS_FTS}, 0, '', '', '…', 48) AS snip
           FROM ${CONVERSATION_EVENTS_FTS} f
           JOIN ${CONVERSATION_EVENTS_TABLE} e ON e.id = f.rowid
           WHERE ${CONVERSATION_EVENTS_FTS} MATCH ?
             AND e.workspace_id = ?
             AND (? IS NULL OR e.task_id = ?)
           ORDER BY bm25(${CONVERSATION_EVENTS_FTS}), e.timestamp DESC
           LIMIT ?`,
        )
        .all(match, workspaceId, taskId, taskId, limit) as Array<Record<string, unknown>>;
      return rows
        .filter((row) => !excluded.has(String(row.type || "")))
        .map((row) => this.mapEventRow(row, terms, String(row.snip || "")));
    } catch {
      return [];
    }
  }

  private searchSummaryLane(
    workspaceId: string,
    taskId: string | null,
    match: string,
    terms: string[],
    limit: number,
  ): LaneHit[] {
    if (!tableExists(this.db, "durable_context_fts")) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT s.id, s.workspace_id, s.task_id, s.summary_text, s.created_at
           FROM durable_context_fts f
           JOIN durable_context_summaries s ON s.id = f.id
           WHERE durable_context_fts MATCH ?
             AND f.kind = 'summary'
             AND f.workspace_id = ?
             AND (? IS NULL OR f.task_id = ?)
           ORDER BY bm25(durable_context_fts)
           LIMIT ?`,
        )
        .all(match, workspaceId, taskId, taskId, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row.id),
        kind: "summary" as const,
        workspaceId: String(row.workspace_id),
        taskId: String(row.task_id),
        type: "summary",
        role: "assistant" as const,
        timestamp: Number(row.created_at || 0),
        snippet: cleanSnippet(String(row.summary_text || ""), terms),
        dedupeKey: `summary:${row.id}`,
      }));
    } catch {
      return [];
    }
  }

  private searchLegacySpanLane(
    workspaceId: string,
    taskId: string | null,
    match: string,
    terms: string[],
    limit: number,
    excluded: Set<string>,
  ): LaneHit[] {
    if (!tableExists(this.db, "tasks") || !tableExists(this.db, "transcript_spans_fts")) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT s.rowid AS id, s.task_id, s.timestamp, s.type, s.payload_json, s.event_id, s.seq
           FROM transcript_spans_fts f
           JOIN transcript_spans s ON s.rowid = f.rowid
           WHERE transcript_spans_fts MATCH ?
             AND s.task_id IN (SELECT id FROM tasks WHERE workspace_id = ?)
             AND (? IS NULL OR s.task_id = ?)
           ORDER BY bm25(transcript_spans_fts), s.timestamp DESC
           LIMIT ?`,
        )
        .all(match, workspaceId, taskId, taskId, limit) as Array<Record<string, unknown>>;
      const hits: LaneHit[] = [];
      for (const row of rows) {
        const type = String(row.type || "");
        if (excluded.has(type)) continue;
        const text = extractConversationEventText(type, row.payload_json);
        if (!text) continue;
        const eventId = typeof row.event_id === "string" && row.event_id ? row.event_id : undefined;
        const seq = typeof row.seq === "number" ? row.seq : undefined;
        const rowTaskId = String(row.task_id || "");
        hits.push({
          id: `dcl_${row.id}`,
          kind: "event",
          workspaceId,
          taskId: rowTaskId,
          type,
          role: conversationRoleForType(type),
          timestamp: Number(row.timestamp || 0),
          snippet: cleanSnippet(text, terms),
          ...(eventId ? { eventId } : {}),
          ...(typeof seq === "number" ? { seq } : {}),
          dedupeKey: `${rowTaskId}:${eventId ? `e:${eventId}` : `l:${row.id}`}`,
        });
      }
      return hits;
    } catch {
      return [];
    }
  }

  /** Delete durable context history (messages, summaries, payloads) of the given tasks. */
  private deleteDurableHistory(taskIdsJson: string): number {
    if (!tableExists(this.db, "durable_context_conversations")) return 0;
    const db = this.db;
    db.prepare(
      `DELETE FROM durable_context_summary_parents
       WHERE summary_id IN (SELECT id FROM durable_context_summaries
                            WHERE task_id IN (SELECT value FROM json_each(?)))
          OR parent_summary_id IN (SELECT id FROM durable_context_summaries
                                   WHERE task_id IN (SELECT value FROM json_each(?)))`,
    ).run(taskIdsJson, taskIdsJson);
    db.prepare(
      `DELETE FROM durable_context_summary_messages
       WHERE summary_id IN (SELECT id FROM durable_context_summaries
                            WHERE task_id IN (SELECT value FROM json_each(?)))
          OR message_id IN (SELECT id FROM durable_context_messages
                            WHERE task_id IN (SELECT value FROM json_each(?)))`,
    ).run(taskIdsJson, taskIdsJson);
    // One scan of the (non-content) FTS table per batch of tasks, not per task.
    db.prepare(
      `DELETE FROM durable_context_fts WHERE task_id IN (SELECT value FROM json_each(?))`,
    ).run(taskIdsJson);
    let rows = 0;
    for (const table of [
      "durable_context_large_payloads",
      "durable_context_summaries",
      "durable_context_messages",
      "durable_context_conversations",
    ]) {
      rows += db
        .prepare(`DELETE FROM ${table} WHERE task_id IN (SELECT value FROM json_each(?))`)
        .run(taskIdsJson).changes;
    }
    return rows;
  }

  private readMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined;
    return typeof row?.value === "string" ? row.value : null;
  }

  private writeMeta(key: string, value: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO ${META_TABLE} (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  private deleteMeta(key: string): void {
    this.db.prepare(`DELETE FROM ${META_TABLE} WHERE key = ?`).run(key);
  }
}
