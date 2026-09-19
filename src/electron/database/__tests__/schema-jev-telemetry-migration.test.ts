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

describeWithSqlite("DatabaseManager Jev telemetry migration", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-schema-jev-telemetry-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const db = new Database(path.join(tmpDir, "cowork-os.db"));
    db.exec(`
      CREATE TABLE llm_call_events (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        workspace_id TEXT,
        task_id TEXT,
        source_kind TEXT NOT NULL,
        source_id TEXT,
        provider_type TEXT,
        model_key TEXT,
        model_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
        error_message TEXT
      );
      INSERT INTO llm_call_events
        (id, timestamp, source_kind, source_id)
      VALUES
        ('llm-1', 1, 'task_event', 'duplicate-source'),
        ('llm-2', 2, 'task_event', 'duplicate-source');
    `);
    db.close();
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates Jev telemetry even when legacy LLM index repair fails", async () => {
    const { DatabaseManager } = await import("../schema");
    const manager = new DatabaseManager();
    const db = manager.getDatabase();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jev_call_events'")
      .all() as Array<{ name: string }>;
    const indexes = db.prepare("PRAGMA index_list(jev_call_events)").all() as Array<{
      name: string;
    }>;

    expect(tables).toHaveLength(1);
    expect(indexes.map((index) => index.name)).toContain("idx_jev_call_events_timestamp");
    expect(indexes.map((index) => index.name)).toContain("idx_jev_call_events_task");

    manager.close();
  });
});
