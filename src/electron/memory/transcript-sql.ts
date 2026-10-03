/**
 * SQL of the transcript span index (TranscriptStore): schema setup on the host
 * connection, and the one-time span storage cleanup, whose steps run as memory-domain
 * transaction units (transcript-units.ts) in the database worker when memory is routed
 * there and in one host transaction otherwise. Span reads and writes are catalogued
 * statements (`transcript_*` in memory-statements.ts).
 *
 * Free of Electron and service imports so the database worker can load it. Steps take
 * `now` from the caller instead of reading a clock.
 */
import type Database from "better-sqlite3";

type TranscriptDatabase = Pick<Database.Database, "exec" | "prepare">;

/**
 * Indexed text per span. Spans are stored once (`payload_json`); the FTS column
 * holds a bounded prefix of it so huge payloads are not indexed in full.
 */
export const TRANSCRIPT_SPAN_SEARCH_TEXT_MAX_CHARS = 4096;

/**
 * Largest serialized span payload kept in spans (table and JSONL). Bigger payloads,
 * typically tool results, are replaced by a preview; `task_events` keeps the full
 * event as the system of record.
 */
export const TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS = 32 * 1024;

/**
 * Rows whose rowid lies in (done_upto, max_rowid] are not in the FTS index yet: the
 * one-time storage cleanup empties the index and backfills it in batches. The FTS
 * triggers skip those rows so the external-content index stays consistent while
 * the backfill runs; with no gap row they behave like plain sync triggers.
 */
const SPAN_INDEX_GAP_TABLE = "transcript_span_index_gap";
const TRANSCRIPT_META_TABLE = "transcript_store_meta";

function spanIndexedGuard(rowRef: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM ${SPAN_INDEX_GAP_TABLE} g
    WHERE ${rowRef}.rowid > g.done_upto AND ${rowRef}.rowid <= g.max_rowid
  )`;
}

const SPAN_INDEX_TRIGGERS_SQL = `
  CREATE TRIGGER transcript_spans_fts_insert AFTER INSERT ON transcript_spans
  WHEN ${spanIndexedGuard("NEW")}
  BEGIN
    INSERT INTO transcript_spans_fts(rowid, search_text, raw_line)
    VALUES (NEW.rowid, NEW.search_text, NEW.raw_line);
  END;
  CREATE TRIGGER transcript_spans_fts_delete AFTER DELETE ON transcript_spans
  WHEN ${spanIndexedGuard("OLD")}
  BEGIN
    INSERT INTO transcript_spans_fts(transcript_spans_fts, rowid, search_text, raw_line)
    VALUES('delete', OLD.rowid, OLD.search_text, OLD.raw_line);
  END;
  CREATE TRIGGER transcript_spans_fts_update AFTER UPDATE ON transcript_spans
  WHEN ${spanIndexedGuard("OLD")}
  BEGIN
    INSERT INTO transcript_spans_fts(transcript_spans_fts, rowid, search_text, raw_line)
    VALUES('delete', OLD.rowid, OLD.search_text, OLD.raw_line);
    INSERT INTO transcript_spans_fts(rowid, search_text, raw_line)
    VALUES (NEW.rowid, NEW.search_text, NEW.raw_line);
  END;
`;

/** Replace the original unconditional FTS triggers with the gap-aware ones (idempotent). */
function migrateSpanIndexTriggers(db: TranscriptDatabase): void {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN ('transcript_spans_fts_insert', 'transcript_spans_fts_delete', 'transcript_spans_fts_update')`,
    )
    .all() as Array<{ name: string; sql: string | null }>;
  if (
    rows.length === 3 &&
    rows.every((row) => String(row.sql || "").includes(SPAN_INDEX_GAP_TABLE))
  ) {
    return;
  }
  db.exec("SAVEPOINT transcript_span_triggers");
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS transcript_spans_fts_insert;
      DROP TRIGGER IF EXISTS transcript_spans_fts_delete;
      DROP TRIGGER IF EXISTS transcript_spans_fts_update;
      ${SPAN_INDEX_TRIGGERS_SQL}
    `);
    db.exec("RELEASE transcript_span_triggers");
  } catch (error) {
    db.exec("ROLLBACK TO transcript_span_triggers");
    db.exec("RELEASE transcript_span_triggers");
    throw error;
  }
}

/** Create the span table, FTS index and bookkeeping tables, and migrate the triggers. */
export function ensureTranscriptSchema(db: TranscriptDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_spans (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      task_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      event_id TEXT,
      seq INTEGER,
      raw_line TEXT NOT NULL,
      search_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_spans_workspace_task
      ON transcript_spans(workspace_path, task_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_transcript_spans_workspace_time
      ON transcript_spans(workspace_path, timestamp DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_spans_fts USING fts5(
      search_text,
      raw_line,
      content='transcript_spans',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS ${SPAN_INDEX_GAP_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      done_upto INTEGER NOT NULL,
      max_rowid INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${TRANSCRIPT_META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  migrateSpanIndexTriggers(db);
}

// ---------------------------------------------------------------------------
// One-time storage cleanup (span storage diet); see TranscriptStore.runStorageCleanup.
// ---------------------------------------------------------------------------

const STORAGE_CLEANUP_MARKER = "span_storage_cleanup_v1";
const STORAGE_CLEANUP_REWRITE_CURSOR = "span_storage_cleanup_v1_cursor";

function readMeta(db: TranscriptDatabase, key: string): string | null {
  const row = db.prepare(`SELECT value FROM ${TRANSCRIPT_META_TABLE} WHERE key = ?`).get(key) as
    | { value?: string }
    | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

function writeMeta(db: TranscriptDatabase, key: string, value: string, now: number): void {
  db.prepare(
    `INSERT INTO ${TRANSCRIPT_META_TABLE} (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

function readGap(db: TranscriptDatabase): { doneUpto: number; maxRowid: number } | null {
  const row = db
    .prepare(`SELECT done_upto, max_rowid FROM ${SPAN_INDEX_GAP_TABLE} WHERE id = 1`)
    .get() as { done_upto?: number; max_rowid?: number } | undefined;
  return row
    ? { doneUpto: Number(row.done_upto || 0), maxRowid: Number(row.max_rowid || 0) }
    : null;
}

function readPragmaNumber(db: TranscriptDatabase, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type SpanStorageCleanupStart =
  | { status: "already_done" }
  | {
      status: "pending";
      /** The index gap to rewrite and backfill; null when there is nothing to do. */
      gap: { doneUpto: number; maxRowid: number } | null;
      /** Rows up to here are already rewritten. */
      cursor: number;
    };

/**
 * Step 1: unless the cleanup already completed, open the index gap and empty the span
 * FTS index (first run only), and return where the rewrite and backfill resume.
 */
export function startSpanStorageCleanup(
  db: TranscriptDatabase,
  now: number,
): SpanStorageCleanupStart {
  if (readMeta(db, STORAGE_CLEANUP_MARKER)) return { status: "already_done" };
  let gap = readGap(db);
  if (!gap && readMeta(db, STORAGE_CLEANUP_REWRITE_CURSOR) === null) {
    const maxRow = db
      .prepare(`SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM transcript_spans`)
      .get() as { max_rowid: number };
    db.prepare(
      `INSERT OR REPLACE INTO ${SPAN_INDEX_GAP_TABLE} (id, done_upto, max_rowid) VALUES (1, 0, ?)`,
    ).run(Number(maxRow.max_rowid || 0));
    db.prepare(`INSERT INTO transcript_spans_fts(transcript_spans_fts) VALUES('delete-all')`).run();
    writeMeta(db, STORAGE_CLEANUP_REWRITE_CURSOR, "0", now);
    gap = readGap(db);
  }
  const cursor = gap ? Number(readMeta(db, STORAGE_CLEANUP_REWRITE_CURSOR) ?? gap.maxRowid) : 0;
  return { status: "pending", gap, cursor };
}

export interface SpanStorageRewriteResult {
  deletedSnapshotRows: number;
  rewrittenRows: number;
  /** Approximate characters released, read before the changes. */
  reclaimedChars: number;
}

/**
 * Step 2, one window (lower, upper]: delete snapshot spans, shrink the remaining rows
 * and advance the rewrite cursor.
 */
export function rewriteSpanStorageWindow(
  db: TranscriptDatabase,
  lower: number,
  upper: number,
  now: number,
): SpanStorageRewriteResult {
  const released = db
    .prepare(
      `SELECT COALESCE(SUM(CASE
         WHEN type = 'conversation_snapshot'
           THEN length(payload_json) + length(raw_line) + length(search_text)
         ELSE length(raw_line)
           + MAX(0, length(search_text) - ${TRANSCRIPT_SPAN_SEARCH_TEXT_MAX_CHARS})
           + MAX(0, length(payload_json) - ${TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS})
       END), 0) AS chars
       FROM transcript_spans WHERE rowid > ? AND rowid <= ?`,
    )
    .get(lower, upper) as { chars: number };
  const deletedSnapshotRows = db
    .prepare(
      `DELETE FROM transcript_spans
       WHERE rowid > ? AND rowid <= ? AND type = 'conversation_snapshot'`,
    )
    .run(lower, upper).changes;
  const rewrittenRows = db
    .prepare(
      `UPDATE transcript_spans
       SET raw_line = '',
           search_text = substr(type || ' ' || payload_json, 1, ${TRANSCRIPT_SPAN_SEARCH_TEXT_MAX_CHARS}),
           payload_json = CASE
             WHEN length(payload_json) > ${TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS}
             THEN json_object(
               'spanPayloadTruncated', json('true'),
               'originalChars', length(payload_json),
               'preview', substr(payload_json, 1, ${TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS})
             )
             ELSE payload_json
           END
       WHERE rowid > ? AND rowid <= ?
         AND (
           raw_line != ''
           OR length(search_text) > ${TRANSCRIPT_SPAN_SEARCH_TEXT_MAX_CHARS}
           OR length(payload_json) > ${TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS}
         )`,
    )
    .run(lower, upper).changes;
  writeMeta(db, STORAGE_CLEANUP_REWRITE_CURSOR, String(upper), now);
  return {
    deletedSnapshotRows,
    rewrittenRows,
    reclaimedChars: Number(released.chars || 0),
  };
}

/** Step 3, one window (lower, upper]: index the bounded text and advance the gap. */
export function backfillSpanIndexWindow(
  db: TranscriptDatabase,
  lower: number,
  upper: number,
): number {
  const reindexed = db
    .prepare(
      `INSERT INTO transcript_spans_fts(rowid, search_text, raw_line)
       SELECT rowid, search_text, raw_line FROM transcript_spans
       WHERE rowid > ? AND rowid <= ?`,
    )
    .run(lower, upper).changes;
  db.prepare(`UPDATE ${SPAN_INDEX_GAP_TABLE} SET done_upto = ? WHERE id = 1`).run(upper);
  return reindexed;
}

export interface SpanStorageCleanupFinish {
  incrementalVacuum: boolean;
  freelistBytes?: number;
}

/**
 * Step 4: close the gap, add the task-id index, run `PRAGMA incremental_vacuum` when the
 * database uses incremental auto-vacuum, and record completion.
 */
export function finishSpanStorageCleanup(
  db: TranscriptDatabase,
  args: {
    closeGap: boolean;
    now: number;
    deletedSnapshotRows: number;
    rewrittenRows: number;
    reclaimedChars: number;
  },
): SpanStorageCleanupFinish {
  const result: SpanStorageCleanupFinish = { incrementalVacuum: false };
  if (args.closeGap) db.prepare(`DELETE FROM ${SPAN_INDEX_GAP_TABLE}`).run();

  // Lookups by task id (deletion cascade, retention) no longer scan the table.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transcript_spans_task ON transcript_spans(task_id)`);

  try {
    const autoVacuum = readPragmaNumber(db, "auto_vacuum");
    if (autoVacuum === 2) {
      db.exec("PRAGMA incremental_vacuum");
      result.incrementalVacuum = true;
    }
    result.freelistBytes =
      readPragmaNumber(db, "freelist_count") * readPragmaNumber(db, "page_size");
  } catch {
    // Size reporting is informational.
  }

  writeMeta(
    db,
    STORAGE_CLEANUP_MARKER,
    JSON.stringify({
      completedAt: args.now,
      deletedSnapshotRows: args.deletedSnapshotRows,
      rewrittenRows: args.rewrittenRows,
      reclaimedChars: args.reclaimedChars,
    }),
    args.now,
  );
  db.prepare(`DELETE FROM ${TRANSCRIPT_META_TABLE} WHERE key = ?`).run(
    STORAGE_CLEANUP_REWRITE_CURSOR,
  );
  return result;
}
