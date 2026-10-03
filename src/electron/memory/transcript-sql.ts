/**
 * Legacy transcript span index (`transcript_spans` + FTS), retired by the conversation
 * index (conversation-index-sql.ts). Nothing writes spans any more; the one-time
 * migration (`DurableContextService.migrateLegacyTranscripts`) indexes the existing rows
 * into the conversation index and deletes them. This schema is kept for databases and
 * tests that still hold spans; the conversation index reads it until the migration
 * completes.
 *
 * Free of Electron and service imports so the database worker can load it.
 */
import type Database from "better-sqlite3";

type TranscriptDatabase = Pick<Database.Database, "exec" | "prepare">;

/**
 * Rows whose rowid lies in (done_upto, max_rowid] are not in the FTS index: an earlier
 * span storage cleanup emptied the index and backfilled it in batches, and a database
 * may still hold an unfinished gap. The FTS triggers skip those rows so deletes stay
 * consistent; with no gap row they behave like plain sync triggers.
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
