import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureFirstTaskTables } from "../attempt-schema";

describe("first-task local state migration", () => {
  it("adds revision state without losing an older attempt", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE first_task_attempts (
        attempt_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, checked_at INTEGER,
        check_json TEXT, inspected_at INTEGER
      )`);
      db.prepare(
        "INSERT INTO first_task_attempts (attempt_id, mission_id, workspace_id, task_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("attempt", "release-brief-v1", "workspace", "task", 1);
      ensureFirstTaskTables(db);
      ensureFirstTaskTables(db);
      const row = db
        .prepare(
          "SELECT attempt_id, revision_requested_at FROM first_task_attempts WHERE task_id = ?",
        )
        .get("task") as { attempt_id: string; revision_requested_at: number | null };
      expect(row).toEqual({ attempt_id: "attempt", revision_requested_at: null });
      expect(db.prepare("SELECT COUNT(*) AS n FROM first_task_real_work").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM first_task_setup").get()).toEqual({ n: 0 });
      db.prepare(
        "INSERT INTO first_task_setup (id, schema_version, choice, updated_at) VALUES (1, 1, 'skipped', 10)",
      ).run();
      ensureFirstTaskTables(db);
      expect(db.prepare("SELECT choice FROM first_task_setup WHERE id = 1").get()).toEqual({
        choice: "skipped",
      });
    } finally {
      db.close();
    }
  });
});
