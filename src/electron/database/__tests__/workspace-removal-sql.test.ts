import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

describeWithSqlite("removing a workspace (WORKSPACE_REMOVE)", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../schema").DatabaseManager;
  let db: ReturnType<import("../schema").DatabaseManager["getDatabase"]>;
  let removal: typeof import("../workspace-removal-sql");
  let workspaceId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-workspace-removal-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    const { DatabaseManager } = await import("../schema");
    removal = await import("../workspace-removal-sql");
    manager = new DatabaseManager();
    db = manager.getDatabase();
    workspaceId = randomUUID();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, "Old project", path.join(tmpDir, "folder"), Date.now(), "{}");
    // History that references the workspace without ON DELETE.
    db.prepare("INSERT INTO memory_settings (workspace_id) VALUES (?)").run(workspaceId);
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const count = (sql: string) => (db.prepare(sql).get(workspaceId) as { n: number }).n;

  it("deletes the workspace with its history rows, which a bare delete cannot", () => {
    expect(() => db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId)).toThrow(
      /FOREIGN KEY/,
    );
    expect(removal.removeWorkspaceWithHistory(db, workspaceId)).toEqual({
      removed: true,
      blockers: [],
    });
    expect(count("SELECT COUNT(*) AS n FROM workspaces WHERE id = ?")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM memory_settings WHERE workspace_id = ?")).toBe(0);
  });

  it("refuses while sessions still use the workspace, and changes nothing", () => {
    db.prepare(
      "INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), "Session", "hi", "completed", workspaceId, Date.now(), Date.now());
    expect(removal.removeWorkspaceWithHistory(db, workspaceId)).toEqual({
      removed: false,
      blockers: ["sessions"],
    });
    expect(count("SELECT COUNT(*) AS n FROM workspaces WHERE id = ?")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM memory_settings WHERE workspace_id = ?")).toBe(1);
  });
});
