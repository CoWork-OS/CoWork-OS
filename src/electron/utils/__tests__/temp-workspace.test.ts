import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { TEMP_WORKSPACE_ID_PREFIX, TEMP_WORKSPACE_NAME } from "../../../shared/types";
import { pruneTempWorkspaces } from "../temp-workspace";

type WorkspaceRow = {
  id: string;
  name: string;
  path: string;
  created_at: number;
  last_used_at: number;
  permissions: string;
};

type TaskRow = {
  id: string;
  workspace_id: string;
  status: string;
};

type SessionRow = {
  id: string;
  workspace_id: string | null;
  state: string;
  last_activity_at?: number;
};

class MockDb {
  workspaces: WorkspaceRow[] = [];
  tasks: TaskRow[] = [];
  sessions: SessionRow[] = [];

  prepare(sql: string): {
    all?: (...args: any[]) => any[];
    get?: (...args: any[]) => any;
    run?: (...args: any[]) => any;
  } {
    if (
      sql.includes("FROM workspaces") &&
      sql.includes("ORDER BY COALESCE(last_used_at, created_at) DESC")
    ) {
      return {
        all: (legacyId: string, _prefixLength: number, prefixValue: string) => {
          const prefix = String(prefixValue || "");
          return this.workspaces
            .filter((row) => row.id === legacyId || row.id.startsWith(prefix))
            .map((row) => ({
              id: row.id,
              path: row.path,
              created_at: row.created_at,
              last_used_at: row.last_used_at ?? row.created_at,
            }))
            .sort((a, b) => b.last_used_at - a.last_used_at);
        },
      };
    }

    if (
      sql.includes("FROM tasks") &&
      sql.includes("workspace_id = ? OR substr(workspace_id, 1, ?) = ?")
    ) {
      return {
        all: (
          legacyId: string,
          _prefixLength: number,
          prefixValue: string,
          ...statuses: string[]
        ) => {
          const prefix = String(prefixValue || "");
          const allowed = new Set(statuses.map((status) => String(status || "")));
          const seen = new Set<string>();
          const rows: Array<{ workspace_id: string }> = [];
          for (const task of this.tasks) {
            if (!(task.workspace_id === legacyId || task.workspace_id.startsWith(prefix))) continue;
            if (allowed.size > 0 && !allowed.has(task.status)) continue;
            if (!task.workspace_id || seen.has(task.workspace_id)) continue;
            seen.add(task.workspace_id);
            rows.push({ workspace_id: task.workspace_id });
          }
          return rows;
        },
      };
    }

    if (
      sql.includes("FROM channel_sessions") &&
      sql.includes("workspace_id = ? OR substr(workspace_id, 1, ?) = ?")
    ) {
      return {
        all: (legacyId: string, _prefixLength: number, prefixValue: string, cutoffMs: number) => {
          const prefix = String(prefixValue || "");
          const seen = new Set<string>();
          const rows: Array<{ workspace_id: string }> = [];
          for (const session of this.sessions) {
            if (!session.workspace_id) continue;
            if (!(session.workspace_id === legacyId || session.workspace_id.startsWith(prefix)))
              continue;
            const lastActivity = Number(session.last_activity_at ?? 0);
            if (session.state === "idle" && !(Number.isFinite(lastActivity) && lastActivity >= cutoffMs))
              continue;
            if (seen.has(session.workspace_id)) continue;
            seen.add(session.workspace_id);
            rows.push({ workspace_id: session.workspace_id });
          }
          return rows;
        },
      };
    }

    if (sql.includes("SELECT 1 FROM tasks WHERE workspace_id = ? AND status IN")) {
      return {
        get: (workspaceId: string, ...statuses: string[]) => {
          const allowed = new Set(statuses.map((status) => String(status || "")));
          return this.tasks.find(
            (task) => task.workspace_id === workspaceId && (allowed.size === 0 || allowed.has(task.status)),
          );
        },
      };
    }

    if (
      sql.includes("SELECT 1 FROM channel_sessions WHERE workspace_id = ?") &&
      sql.includes("COALESCE(last_activity_at, created_at)")
    ) {
      return {
        get: (workspaceId: string, cutoffMs: number) =>
          this.sessions.find((session) => {
            if (session.workspace_id !== workspaceId) return false;
            if (session.state !== "idle") return true;
            const lastActivity = Number(session.last_activity_at ?? 0);
            return Number.isFinite(lastActivity) && lastActivity >= cutoffMs;
          }),
      };
    }

    if (sql.includes("DELETE FROM workspaces WHERE id = ?")) {
      return {
        run: (workspaceId: string) => {
          this.workspaces = this.workspaces.filter((workspace) => workspace.id !== workspaceId);
        },
      };
    }

    throw new Error(`Unsupported SQL in MockDb.prepare: ${sql}`);
  }
}

describe("pruneTempWorkspaces", () => {
  const tempDirsToCleanup: string[] = [];

  afterEach(() => {
    for (const dir of tempDirsToCleanup) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
    tempDirsToCleanup.length = 0;
  });

  const createTempRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-temp-prune-test-"));
    tempDirsToCleanup.push(root);
    return root;
  };

  const insertTempWorkspace = (
    db: MockDb,
    root: string,
    idSuffix: string,
    lastUsedAt: number,
  ): { id: string; dir: string } => {
    const id = `${TEMP_WORKSPACE_ID_PREFIX}${idSuffix}`;
    const dir = path.join(root, idSuffix);
    fs.mkdirSync(dir, { recursive: true });

    db.workspaces.push({
      id,
      name: TEMP_WORKSPACE_NAME,
      path: dir,
      created_at: lastUsedAt - 500,
      last_used_at: lastUsedAt,
      permissions: JSON.stringify({
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: false,
        unrestrictedFileAccess: true,
      }),
    });

    return { id, dir };
  };

  it("removes old temp workspaces but keeps current and active ones", () => {
    const db = new MockDb();
    const root = createTempRoot();
    const nowMs = 2_000_000;

    const recent = insertTempWorkspace(db, root, "recent", nowMs - 100);
    const activeOld = insertTempWorkspace(db, root, "active-old", nowMs - 20_000);
    const old = insertTempWorkspace(db, root, "old", nowMs - 20_000);

    db.tasks.push({ id: "t1", workspace_id: activeOld.id, status: "executing" });

    const result = pruneTempWorkspaces({
      db: db as any,
      tempWorkspaceRoot: root,
      currentWorkspaceId: recent.id,
      nowMs,
      keepRecent: 1,
      maxAgeMs: 1_000,
      hardLimit: 10,
      targetAfterPrune: 8,
    });

    expect(result.removedDirs).toBe(1);
    expect(result.removedRows).toBe(1);
    expect(fs.existsSync(recent.dir)).toBe(true);
    expect(fs.existsSync(activeOld.dir)).toBe(true);
    expect(fs.existsSync(old.dir)).toBe(false);
    expect(db.workspaces.some((workspace) => workspace.id === old.id)).toBe(false);
  });

  it("enforces hard limit by deleting oldest temp workspaces when needed", () => {
    const db = new MockDb();
    const root = createTempRoot();
    const nowMs = 3_000_000;

    const workspaces = Array.from({ length: 6 }, (_, index) =>
      insertTempWorkspace(db, root, `w${index}`, nowMs - index * 100),
    );

    const result = pruneTempWorkspaces({
      db: db as any,
      tempWorkspaceRoot: root,
      nowMs,
      keepRecent: 0,
      maxAgeMs: 10_000_000,
      hardLimit: 4,
      targetAfterPrune: 3,
      minAgeForHardPruneMs: 0,
    });

    expect(result.removedDirs).toBe(3);
    expect(result.removedRows).toBe(3);

    const remainingIds = new Set(db.workspaces.map((workspace) => workspace.id));
    expect(remainingIds.size).toBe(3);
    expect(remainingIds.has(workspaces[0].id)).toBe(true);
    expect(remainingIds.has(workspaces[1].id)).toBe(true);
    expect(remainingIds.has(workspaces[2].id)).toBe(true);
  });

  it("keeps temp workspace referenced by idle session", () => {
    const db = new MockDb();
    const root = createTempRoot();
    const nowMs = 4_000_000;

    const idleReferenced = insertTempWorkspace(db, root, "idle-ref", nowMs - 50_000);
    db.sessions.push({
      id: "s1",
      workspace_id: idleReferenced.id,
      state: "idle",
      last_activity_at: nowMs - 100,
    });

    const result = pruneTempWorkspaces({
      db: db as any,
      tempWorkspaceRoot: root,
      nowMs,
      keepRecent: 0,
      maxAgeMs: 1_000,
      hardLimit: 2,
      targetAfterPrune: 1,
    });

    expect(result.removedDirs).toBe(0);
    expect(result.removedRows).toBe(0);
    expect(fs.existsSync(idleReferenced.dir)).toBe(true);
    expect(db.workspaces.some((workspace) => workspace.id === idleReferenced.id)).toBe(true);
  });

  it("prunes orphan temp directories that have no DB workspace rows", () => {
    const db = new MockDb();
    const root = createTempRoot();
    const nowMs = Date.now();

    const orphanDir = path.join(root, "orphan-old");
    fs.mkdirSync(orphanDir, { recursive: true });
    const oldDate = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(orphanDir, oldDate, oldDate);

    const freshOrphanDir = path.join(root, "orphan-fresh");
    fs.mkdirSync(freshOrphanDir, { recursive: true });

    const result = pruneTempWorkspaces({
      db: db as any,
      tempWorkspaceRoot: root,
      nowMs,
      keepRecent: 0,
      maxAgeMs: 14 * 24 * 60 * 60 * 1000,
      hardLimit: 50,
      targetAfterPrune: 40,
    });

    expect(result.removedRows).toBe(0);
    expect(result.removedDirs).toBe(1);
    expect(fs.existsSync(orphanDir)).toBe(false);
    expect(fs.existsSync(freshOrphanDir)).toBe(true);
  });

  it("does not treat wildcard-like IDs as temp workspace IDs", () => {
    const db = new MockDb();
    const root = createTempRoot();
    const nowMs = 5_000_000;

    const falsePositiveId = "abtempcworkspacede:looks-like-like-match";
    const falsePositiveDir = path.join(root, "false-positive");
    fs.mkdirSync(falsePositiveDir, { recursive: true });
    db.workspaces.push({
      id: falsePositiveId,
      name: "Not Temp",
      path: falsePositiveDir,
      created_at: nowMs - 100_000,
      last_used_at: nowMs - 100_000,
      permissions: "{}",
    });

    const oldTemp = insertTempWorkspace(db, root, "real-temp", nowMs - 100_000);

    const result = pruneTempWorkspaces({
      db: db as any,
      tempWorkspaceRoot: root,
      nowMs,
      keepRecent: 0,
      maxAgeMs: 1_000,
      hardLimit: 10,
      targetAfterPrune: 8,
    });

    expect(result.removedRows).toBe(1);
    expect(result.removedDirs).toBe(1);
    expect(db.workspaces.some((workspace) => workspace.id === falsePositiveId)).toBe(true);
    expect(fs.existsSync(falsePositiveDir)).toBe(true);
    expect(db.workspaces.some((workspace) => workspace.id === oldTemp.id)).toBe(false);
    expect(fs.existsSync(oldTemp.dir)).toBe(false);
  });

  it("prunes stale temp workspace DB rows even when temp root does not exist", () => {
    const db = new MockDb();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-temp-prune-missing-root-"));
    tempDirsToCleanup.push(base);
    const missingRoot = path.join(base, "missing-root");
    const nowMs = 6_000_000;

    db.workspaces.push({
      id: `${TEMP_WORKSPACE_ID_PREFIX}stale-no-root`,
      name: TEMP_WORKSPACE_NAME,
      path: path.join(missingRoot, "stale-no-root"),
      created_at: nowMs - 100_000,
      last_used_at: nowMs - 100_000,
      permissions: "{}",
    });

    const result = pruneTempWorkspaces({
      db: db as any,
      tempWorkspaceRoot: missingRoot,
      nowMs,
      keepRecent: 0,
      maxAgeMs: 1_000,
      hardLimit: 10,
      targetAfterPrune: 8,
    });

    expect(result.removedRows).toBe(1);
    expect(result.removedDirs).toBe(0);
    expect(db.workspaces.length).toBe(0);
  });
});
