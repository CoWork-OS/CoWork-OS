import type Database from "better-sqlite3";

/**
 * The mailbox search index. Rows live in a regular table, `mailbox_search_records`,
 * keyed by `(record_type, record_id)`. An external-content FTS5 index,
 * `mailbox_search_records_fts`, sits on top of it and triggers keep the two in sync.
 * Re-indexing a message or attachment deletes and upserts by key through the table's
 * index. The earlier layout was a standalone FTS5 table whose key columns were
 * `UNINDEXED`, so every re-index scanned the whole index.
 *
 * Builds from before this layout create and write their own `mailbox_search_fts`. It
 * never touches these tables, so running an older build cannot corrupt the index. On
 * the next start its rows are imported here and the legacy table is dropped.
 *
 * Without FTS5, the records table is still written and search falls back to row
 * matching. When FTS5 becomes available, the index is rebuilt from the table.
 */

const SEARCH_COLUMNS = [
  "record_type",
  "record_id",
  "thread_id",
  "message_id",
  "attachment_id",
  "subject",
  "sender",
  "body",
  "attachment_filename",
  "attachment_text",
] as const;

const columnList = SEARCH_COLUMNS.join(", ");
const valuesFrom = (row: "new" | "old") => SEARCH_COLUMNS.map((c) => `${row}.${c}`).join(", ");

function tableExists(db: Database.Database, name: string): boolean {
  return (db.pragma(`table_xinfo(${name})`) as unknown[]).length > 0;
}

export function initializeMailboxSearchIndex(
  db: Database.Database,
  warn: (message: string, error: unknown) => void,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox_search_records (
      id INTEGER PRIMARY KEY,
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      attachment_id TEXT,
      subject TEXT,
      sender TEXT,
      body TEXT,
      attachment_filename TEXT,
      attachment_text TEXT,
      UNIQUE (record_type, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mailbox_search_records_thread
      ON mailbox_search_records(thread_id, record_type);
  `);

  let indexAvailable = false;
  try {
    db.transaction(() => {
      const created = !tableExists(db, "mailbox_search_records_fts");
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS mailbox_search_records_fts USING fts5(
          record_type UNINDEXED,
          record_id UNINDEXED,
          thread_id UNINDEXED,
          message_id UNINDEXED,
          attachment_id UNINDEXED,
          subject,
          sender,
          body,
          attachment_filename,
          attachment_text,
          content = 'mailbox_search_records',
          content_rowid = 'id'
        );
        CREATE TRIGGER IF NOT EXISTS mailbox_search_records_ai AFTER INSERT ON mailbox_search_records BEGIN
          INSERT INTO mailbox_search_records_fts (rowid, ${columnList})
          VALUES (new.id, ${valuesFrom("new")});
        END;
        CREATE TRIGGER IF NOT EXISTS mailbox_search_records_ad AFTER DELETE ON mailbox_search_records BEGIN
          INSERT INTO mailbox_search_records_fts (mailbox_search_records_fts, rowid, ${columnList})
          VALUES ('delete', old.id, ${valuesFrom("old")});
        END;
        CREATE TRIGGER IF NOT EXISTS mailbox_search_records_au AFTER UPDATE ON mailbox_search_records BEGIN
          INSERT INTO mailbox_search_records_fts (mailbox_search_records_fts, rowid, ${columnList})
          VALUES ('delete', old.id, ${valuesFrom("old")});
          INSERT INTO mailbox_search_records_fts (rowid, ${columnList})
          VALUES (new.id, ${valuesFrom("new")});
        END;
      `);
      // Rows written while FTS5 was unavailable are indexed now.
      if (created) {
        db.exec(
          "INSERT INTO mailbox_search_records_fts (mailbox_search_records_fts) VALUES ('rebuild')",
        );
      }
    })();
    indexAvailable = true;
  } catch (error) {
    warn(
      "[DatabaseManager] Mailbox FTS5 initialization failed, mailbox search will use fallback matching:",
      error,
    );
  }

  if (!indexAvailable || !tableExists(db, "mailbox_search_fts")) return;
  try {
    db.transaction(() => {
      // Later legacy rows win for a key, as they did for the searches that read them.
      db.exec(`
        INSERT INTO mailbox_search_records (${columnList})
        SELECT ${columnList} FROM mailbox_search_fts WHERE true ORDER BY rowid
        ON CONFLICT (record_type, record_id) DO UPDATE SET
          ${SEARCH_COLUMNS.slice(2)
            .map((c) => `${c} = excluded.${c}`)
            .join(",\n          ")};
        DROP TABLE mailbox_search_fts;
      `);
      // An older build may have deleted messages or attachments since these rows were
      // indexed here; their rows go with them.
      db.exec(`
        DELETE FROM mailbox_search_records
        WHERE (record_type = 'message'
               AND NOT EXISTS (SELECT 1 FROM mailbox_messages m WHERE m.id = record_id))
           OR (record_type = 'attachment'
               AND NOT EXISTS (SELECT 1 FROM mailbox_attachments a WHERE a.id = record_id));
      `);
    })();
  } catch (error) {
    warn("[DatabaseManager] Could not import the legacy mailbox search index:", error);
  }
}
