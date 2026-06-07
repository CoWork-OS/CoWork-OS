import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Probe = module.default;
      const probe = new Probe(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("DatabaseManager activity_feed migration", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-schema-activity-feed-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const dbPath = path.join(tmpDir, "cowork-os.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE activity_feed (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        agent_role_id TEXT,
        actor_type TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        metadata TEXT,
        is_read INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    db.close();
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds pinned columns before creating pinned-dependent indexes", async () => {
    const { DatabaseManager } = await import("../schema");
    const manager = new DatabaseManager();
    const db = manager.getDatabase();

    const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
      name: string;
    }>;
    const activityColumns = db.prepare("PRAGMA table_info(activity_feed)").all() as Array<{
      name: string;
    }>;
    const taskIndexes = db.prepare("PRAGMA index_list(tasks)").all() as Array<{
      name: string;
    }>;

    expect(taskColumns.map((column) => column.name)).toContain("is_pinned");
    expect(activityColumns.map((column) => column.name)).toContain("is_pinned");
    expect(taskIndexes.map((index) => index.name)).toContain("idx_tasks_sidebar_order");

    manager.close();
  });
});
