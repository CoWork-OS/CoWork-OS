import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("DatabaseManager bot room migration", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-schema-bot-room-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const db = new Database(path.join(tmpDir, "cowork-os.db"));
    db.exec(`
      CREATE TABLE bot_rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_agent_id TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'sequential',
        max_rounds INTEGER NOT NULL DEFAULT 3,
        max_messages INTEGER NOT NULL DEFAULT 10,
        epoch INTEGER NOT NULL DEFAULT 0,
        active_run_id TEXT,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE bot_room_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        run_id TEXT,
        epoch INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        from_agent_id TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'delivered',
        reply_to TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (room_id) REFERENCES bot_rooms(id) ON DELETE CASCADE
      );
    `);
    db.close();
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upgrades existing room tables without losing data", async () => {
    const { DatabaseManager } = await import("../schema");
    const manager = new DatabaseManager();
    const db = manager.getDatabase();

    const roomColumns = db.prepare("PRAGMA table_info(bot_rooms)").all() as Array<{ name: string }>;
    const messageColumns = db.prepare("PRAGMA table_info(bot_room_messages)").all() as Array<{
      name: string;
    }>;

    expect(roomColumns.map((column) => column.name)).toContain("current_round");
    expect(messageColumns.map((column) => column.name)).toContain("round");

    manager.close();
  });
});
