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

describeWithSqlite("DatabaseManager automation outcome migration", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-schema-automation-outcome-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const db = new Database(path.join(tmpDir, "cowork-os.db"));
    db.exec(`
      CREATE TABLE automation_run_outcomes (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_run_id TEXT,
        task_id TEXT,
        workspace_id TEXT,
        company_id TEXT,
        agent_role_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        usefulness TEXT NOT NULL,
        trigger TEXT NOT NULL,
        notification_recommended INTEGER NOT NULL DEFAULT 0,
        notification_reason TEXT,
        notification_delivered_at INTEGER,
        next_action TEXT,
        metrics_json TEXT,
        evidence_refs_json TEXT,
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

  it("adds outcome columns before creating the notification-key index", async () => {
    const { DatabaseManager } = await import("../schema");
    const manager = new DatabaseManager();
    const db = manager.getDatabase();

    const columns = db.prepare("PRAGMA table_info(automation_run_outcomes)").all() as Array<{
      name: string;
    }>;
    const indexes = db.prepare("PRAGMA index_list(automation_run_outcomes)").all() as Array<{
      name: string;
    }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "change_hash",
        "notification_key",
        "notification_skipped_at",
        "notification_skip_reason",
      ]),
    );
    expect(indexes.map((index) => index.name)).toContain(
      "idx_automation_outcomes_notification_key",
    );

    manager.close();
  });
});
