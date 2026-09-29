import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeMailboxSearchIndex } from "../mailbox-search-index-schema";
import { DatabaseManager } from "../schema";

// The keyed mailbox search index: a records table with an external-content FTS5 index
// kept in sync by triggers, and the import of the legacy standalone FTS table.

const LEGACY_FTS = `
  CREATE VIRTUAL TABLE mailbox_search_fts USING fts5(
    record_type UNINDEXED, record_id UNINDEXED, thread_id UNINDEXED, message_id UNINDEXED,
    attachment_id UNINDEXED, subject, sender, body, attachment_filename, attachment_text
  );
`;

function baseDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE mailbox_messages (id TEXT PRIMARY KEY);
    CREATE TABLE mailbox_attachments (id TEXT PRIMARY KEY);
  `);
  return db;
}

function init(db: Database.Database): string[] {
  const warnings: string[] = [];
  initializeMailboxSearchIndex(db, (message) => warnings.push(message));
  return warnings;
}

function upsertMessage(db: Database.Database, id: string, body: string): void {
  db.prepare(
    `INSERT INTO mailbox_search_records
       (record_type, record_id, thread_id, message_id, attachment_id, subject, sender, body, attachment_filename, attachment_text)
     VALUES ('message', ?, 't1', ?, NULL, 'Subject', 'sender', ?, '', '')
     ON CONFLICT (record_type, record_id) DO UPDATE SET body = excluded.body`,
  ).run(id, id, body);
}

function match(db: Database.Database, query: string): string[] {
  return (
    db
      .prepare(
        `SELECT record_id, snippet(mailbox_search_records_fts, 7, '[', ']', '…', 8) AS snippet
         FROM mailbox_search_records_fts WHERE mailbox_search_records_fts MATCH ? ORDER BY record_id`,
      )
      .all(query) as Array<{ record_id: string; snippet: string }>
  ).map((row) => `${row.record_id}:${row.snippet}`);
}

function assertIndexIntact(db: Database.Database): void {
  db.exec(
    "INSERT INTO mailbox_search_records_fts (mailbox_search_records_fts) VALUES ('integrity-check')",
  );
}

describe("mailbox search index", () => {
  const cleanups: Array<() => void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  it("keeps the index in sync through inserts, upserts and deletes", () => {
    const db = baseDb();
    expect(init(db)).toEqual([]);
    upsertMessage(db, "m1", "quarterly invoice attached");
    upsertMessage(db, "m2", "launch plan review");
    expect(match(db, "invoice")).toEqual(["m1:quarterly [invoice] attached"]);

    upsertMessage(db, "m1", "renewal contract attached");
    expect(match(db, "invoice")).toEqual([]);
    expect(match(db, "renewal")).toEqual(["m1:[renewal] contract attached"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mailbox_search_records").get()).toEqual({
      count: 2,
    });

    db.prepare(
      "DELETE FROM mailbox_search_records WHERE record_type = 'message' AND record_id = ?",
    ).run("m1");
    expect(match(db, "renewal")).toEqual([]);
    expect(match(db, "launch")).toEqual(["m2:[launch] plan review"]);
    assertIndexIntact(db);
  });

  it("finds a record by key through the table's index instead of scanning", () => {
    const db = baseDb();
    init(db);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN DELETE FROM mailbox_search_records WHERE record_type = 'message' AND record_id = ?",
      )
      .all("m1") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toMatch(/USING INDEX sqlite_autoindex/);
  });

  it("imports the legacy table once: later rows win, orphans go, the table is dropped", () => {
    const db = baseDb();
    db.exec(LEGACY_FTS);
    db.exec("INSERT INTO mailbox_messages (id) VALUES ('m1'), ('m2')");
    db.exec("INSERT INTO mailbox_attachments (id) VALUES ('a1')");
    const legacy = db.prepare(
      `INSERT INTO mailbox_search_fts (record_type, record_id, thread_id, message_id, attachment_id, subject, sender, body, attachment_filename, attachment_text)
       VALUES (?, ?, 't1', ?, ?, 'Subject', 'sender', ?, ?, ?)`,
    );
    legacy.run("message", "m1", "m1", null, "old invoice text", "", "");
    legacy.run("message", "m1", "m1", null, "newer renewal text", "", "");
    legacy.run("message", "m2", "m2", null, "launch plan", "", "");
    legacy.run("message", "gone", "gone", null, "deleted message", "", "");
    legacy.run("attachment", "a1", "m1", "a1", "", "statement.pdf", "card statement");

    expect(init(db)).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT record_type, record_id, body FROM mailbox_search_records ORDER BY record_id",
        )
        .all(),
    ).toEqual([
      { record_type: "attachment", record_id: "a1", body: "" },
      { record_type: "message", record_id: "m1", body: "newer renewal text" },
      { record_type: "message", record_id: "m2", body: "launch plan" },
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'mailbox_search_fts'").get(),
    ).toBeUndefined();
    expect(match(db, "invoice")).toEqual([]);
    expect(match(db, "renewal")).toEqual(["m1:newer [renewal] text"]);
    expect(match(db, "statement")).toEqual(["a1:"]);
    assertIndexIntact(db);

    // Idempotent: a second start changes nothing.
    expect(init(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mailbox_search_records").get()).toEqual({
      count: 3,
    });
    assertIndexIntact(db);
  });

  it("indexes records written while the FTS index was missing", () => {
    const db = baseDb();
    init(db);
    db.exec(`
      DROP TRIGGER mailbox_search_records_ai;
      DROP TRIGGER mailbox_search_records_ad;
      DROP TRIGGER mailbox_search_records_au;
      DROP TABLE mailbox_search_records_fts;
    `);
    upsertMessage(db, "m1", "written without fts");
    init(db);
    expect(match(db, "without")).toEqual(["m1:written [without] fts"]);
    assertIndexIntact(db);
  });

  it("recovers rows an older build wrote to its own table on the next start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-mailbox-search-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    process.env.COWORK_USER_DATA_DIR = dir;

    const first = new DatabaseManager();
    const dbPath = first.getDatabasePath();
    const db1 = first.getDatabase();
    db1.exec(`
      INSERT INTO mailbox_accounts (id, provider, address, status, capabilities_json, created_at, updated_at)
      VALUES ('acct', 'gmail', 'a@example.com', 'connected', '[]', 0, 0);
      INSERT INTO mailbox_threads (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
      VALUES ('t1', 'acct', 't1', 'gmail', 's', 's', '[]', '[]', 'updates', 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, '{}', 0, 0);
    `);
    const insertMessage = db1.prepare(
      `INSERT INTO mailbox_messages (id, thread_id, provider_message_id, direction, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, 't1', ?, 'incoming', 'x@example.com', '[]', '[]', '[]', 's', 's', '', 0, 0, '{}', 0, 0)`,
    );
    insertMessage.run("m-new", "m-new");
    insertMessage.run("m-kept", "m-kept");
    upsertMessage(db1, "m-kept", "indexed by this build");
    first.close();

    // An older build opens the profile: it creates its own table and indexes a message.
    const older = new Database(dbPath);
    older.exec(LEGACY_FTS);
    older
      .prepare(
        `INSERT INTO mailbox_search_fts (record_type, record_id, thread_id, message_id, attachment_id, subject, sender, body, attachment_filename, attachment_text)
         VALUES ('message', 'm-new', 't1', 'm-new', NULL, 's', 'x', 'synced by the older build', '', '')`,
      )
      .run();
    older.close();

    const second = new DatabaseManager();
    cleanups.push(() => second.close());
    const db2 = second.getDatabase();
    expect(match(db2, "older")).toEqual(["m-new:synced by the [older] build"]);
    expect(match(db2, "indexed")).toEqual(["m-kept:[indexed] by this build"]);
    assertIndexIntact(db2);
  });
});
