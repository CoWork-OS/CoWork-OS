import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMP_WORKSPACE_ID_PREFIX, TEMP_WORKSPACE_NAME } from "../../../shared/types";
import { pruneTempWorkspaces } from "../temp-workspace";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

describeWithSqlite("pruneTempWorkspaces foreign-key cleanup", () => {
  let tmpDir: string;
  let tempRoot: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;
  const nowMs = Date.now();
  const oldMs = nowMs - 30 * DAY_MS;

  const insertWorkspace = (id: string, workspacePath: string, lastUsedAt: number) => {
    fs.mkdirSync(workspacePath, { recursive: true });
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      id.startsWith(TEMP_WORKSPACE_ID_PREFIX) ? TEMP_WORKSPACE_NAME : id,
      workspacePath,
      lastUsedAt,
      lastUsedAt,
      JSON.stringify({ read: true, write: true, delete: true, network: true, shell: false }),
    );
  };

  const insertTempWorkspace = (slug: string): { id: string; dir: string } => {
    const id = `${TEMP_WORKSPACE_ID_PREFIX}${slug}`;
    const dir = path.join(tempRoot, slug);
    insertWorkspace(id, dir, oldMs);
    return { id, dir };
  };

  const insertTask = (id: string, workspaceId: string, branchFromTaskId: string | null = null) => {
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, branch_from_task_id)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)`,
    ).run(id, id, id, workspaceId, oldMs, oldMs, branchFromTaskId);
  };

  const insertTeamRun = (runId: string, teamId: string, rootTaskId: string) => {
    db.prepare(
      `INSERT INTO agent_team_runs (id, team_id, root_task_id, status, started_at)
       VALUES (?, ?, ?, 'completed', ?)`,
    ).run(runId, teamId, rootTaskId, oldMs);
  };

  const insertTeamItem = (
    itemId: string,
    runId: string,
    sourceTaskId: string,
    parentItemId: string | null = null,
  ) => {
    db.prepare(
      `INSERT INTO agent_team_items (id, team_run_id, parent_item_id, title, source_task_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'done', ?, ?)`,
    ).run(itemId, runId, parentItemId, itemId, sourceTaskId, oldMs, oldMs);
  };

  const count = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  const prune = () =>
    pruneTempWorkspaces({
      db,
      tempWorkspaceRoot: tempRoot,
      nowMs,
      keepRecent: 0,
      maxAgeMs: DAY_MS,
    });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-temp-fk-cleanup-"));
    tempRoot = path.join(tmpDir, "temp-workspaces");
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const { DatabaseManager } = await import("../../database/schema");
    manager = new DatabaseManager();
    db = manager.getDatabase();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    insertWorkspace("main-workspace", path.join(tmpDir, "main"), nowMs);
    db.prepare(
      `INSERT INTO agent_roles (id, name, display_name, capabilities, created_at, updated_at)
       VALUES ('role-1', 'role-1', 'Role 1', '[]', ?, ?)`,
    ).run(oldMs, oldMs);
    db.prepare(
      `INSERT INTO agent_teams (id, workspace_id, name, lead_agent_role_id, created_at, updated_at)
       VALUES ('team-main', 'main-workspace', 'Main team', 'role-1', ?, ?)`,
    ).run(oldMs, oldMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes a temp workspace whose tasks are referenced by team rows and a branched task", async () => {
    const warn = vi.spyOn(console, "warn");
    const temp = insertTempWorkspace("session-a");
    insertTask("temp-root", temp.id);
    insertTask("temp-branch", temp.id, "temp-root");
    db.prepare("UPDATE tasks SET parent_task_id = 'temp-root' WHERE id = 'temp-branch'").run();
    db.prepare(
      `INSERT INTO agent_teams (id, workspace_id, name, lead_agent_role_id, created_at, updated_at)
       VALUES ('team-temp', ?, 'Temp team', 'role-1', ?, ?)`,
    ).run(temp.id, oldMs, oldMs);
    insertTeamRun("run-temp", "team-main", "temp-root");
    insertTeamRun("run-temp-team", "team-temp", "temp-branch");
    insertTeamItem("item-temp", "run-temp", "temp-branch");
    insertTeamItem("item-temp-child", "run-temp", "temp-root", "item-temp");
    db.prepare(
      `INSERT INTO agent_team_thoughts (id, team_run_id, team_item_id, agent_role_id, agent_display_name, phase, content, source_task_id, created_at, updated_at)
       VALUES ('thought-temp', 'run-temp', 'item-temp', 'role-1', 'Role 1', 'analysis', 'x', 'temp-branch', ?, ?)`,
    ).run(oldMs, oldMs);

    const result = await prune();

    expect(result.candidateWorkspaceIds).toEqual([temp.id]);
    expect(result.removedRows).toBe(1);
    expect(fs.existsSync(temp.dir)).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM workspaces WHERE id = ?", temp.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?", temp.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM agent_teams WHERE id = 'team-temp'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM agent_team_runs")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM agent_team_items")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM agent_team_thoughts")).toBe(0);
    // Rows outside the temp workspace are untouched.
    expect(count("SELECT COUNT(*) AS n FROM agent_teams WHERE id = 'team-main'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM agent_roles WHERE id = 'role-1'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM workspaces WHERE id = 'main-workspace'")).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("temp workspace");
  });

  it("nulls optional references from surviving rows and deletes rows that require the temp task", async () => {
    const temp = insertTempWorkspace("session-b");
    insertTask("temp-root", temp.id);
    insertTask("main-branch", "main-workspace", "temp-root");
    db.prepare("UPDATE tasks SET parent_task_id = 'temp-root' WHERE id = 'main-branch'").run();
    // A team run owned by the main workspace whose item was sourced from the temp task.
    insertTeamRun("run-main", "team-main", "main-branch");
    insertTeamItem("item-main", "run-main", "temp-root");
    // Tables unknown to the cleanup code are covered through PRAGMA foreign_key_list.
    db.exec(`
      CREATE TABLE future_planner_configs (
        id TEXT PRIMARY KEY,
        planning_workspace_id TEXT REFERENCES workspaces(id)
      );
      CREATE TABLE future_task_receipts (
        id TEXT PRIMARY KEY,
        owner_task_id TEXT NOT NULL REFERENCES tasks(id)
      );
    `);
    db.prepare(
      "INSERT INTO future_planner_configs (id, planning_workspace_id) VALUES ('cfg', ?)",
    ).run(temp.id);
    db.prepare(
      "INSERT INTO future_task_receipts (id, owner_task_id) VALUES ('receipt-temp', 'temp-root'), ('receipt-main', 'main-branch')",
    ).run();

    const result = await prune();

    expect(result.removedRows).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM workspaces WHERE id = ?", temp.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM tasks WHERE id = 'temp-root'")).toBe(0);
    expect(
      db
        .prepare("SELECT branch_from_task_id, parent_task_id FROM tasks WHERE id = 'main-branch'")
        .get(),
    ).toEqual({ branch_from_task_id: null, parent_task_id: null });
    expect(count("SELECT COUNT(*) AS n FROM agent_team_runs WHERE id = 'run-main'")).toBe(1);
    expect(
      db.prepare("SELECT source_task_id FROM agent_team_items WHERE id = 'item-main'").get(),
    ).toEqual({ source_task_id: null });
    expect(
      db.prepare("SELECT planning_workspace_id FROM future_planner_configs WHERE id = 'cfg'").get(),
    ).toEqual({ planning_workspace_id: null });
    expect(
      db
        .prepare("SELECT id FROM future_task_receipts ORDER BY id")
        .all()
        .map((row) => (row as { id: string }).id),
    ).toEqual(["receipt-main"]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("logs a warning naming the workspace and keeps the fallback when cleanup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const temp = insertTempWorkspace("session-c");
    insertTask("temp-root", temp.id);
    db.exec(`
      CREATE TABLE future_locks (
        id TEXT PRIMARY KEY,
        task_id_ref TEXT REFERENCES tasks(id) ON DELETE RESTRICT
      );
      CREATE TRIGGER future_locks_block_update BEFORE UPDATE ON future_locks
      BEGIN SELECT RAISE(ABORT, 'future_locks is append-only'); END;
    `);
    db.prepare("INSERT INTO future_locks (id, task_id_ref) VALUES ('lock', 'temp-root')").run();

    const result = await prune();

    expect(result.removedRows).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM workspaces WHERE id = ?", temp.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM tasks WHERE id = 'temp-root'")).toBe(1);
    const logged = warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(logged).toContain(temp.id);
    expect(logged).toContain("future_locks is append-only");
  });
});
