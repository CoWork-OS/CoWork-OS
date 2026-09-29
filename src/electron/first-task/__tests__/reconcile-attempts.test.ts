import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { ensureFirstTaskTables } from "../attempt-schema";
import { reconcilePendingSampleAttempts } from "../reconcile-attempts";

describe("sample restart reconciliation", () => {
  it("fails an unstarted sample without relaunching or altering completed attempts", () => {
    const db = new Database(":memory:");
    try {
      ensureFirstTaskTables(db);
      const insert = db.prepare(
        "INSERT INTO first_task_attempts (attempt_id, mission_id, workspace_id, task_id, created_at) VALUES (?, 'release-brief-v1', 'workspace', ?, 1)",
      );
      insert.run("a", "pending-task");
      insert.run("b", "completed-task");
      const fail = vi.fn();
      const attemptTaskIds = (
        db.prepare("SELECT task_id FROM first_task_attempts").all() as Array<{ task_id: string }>
      ).map((row) => row.task_id);
      reconcilePendingSampleAttempts(
        attemptTaskIds,
        (id) => ({ source: "sample", status: id === "pending-task" ? "pending" : "completed" }),
        fail,
        42,
      );
      expect(fail).toHaveBeenCalledOnce();
      expect(fail).toHaveBeenCalledWith(
        "pending-task",
        expect.stringContaining("fresh sample"),
        42,
      );
    } finally {
      db.close();
    }
  });
});
