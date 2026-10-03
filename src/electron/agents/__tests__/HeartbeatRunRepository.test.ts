import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeartbeatRunStore, pruneHeartbeatRunHistory } from "../HeartbeatRunRepository";

const nativeSqlite = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return module.default;
    } catch {
      return null;
    }
  })
  .catch(() => null);

const describeWithSqlite = nativeSqlite ? describe : describe.skip;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describeWithSqlite("HeartbeatRunStore (SQLite)", () => {
  let db: import("better-sqlite3").Database;
  let store: HeartbeatRunStore;

  beforeEach(() => {
    db = new nativeSqlite!(":memory:");
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE issues (id TEXT PRIMARY KEY, active_run_id TEXT, updated_at INTEGER);
      CREATE TABLE heartbeat_runs (
        id TEXT PRIMARY KEY, issue_id TEXT, task_id TEXT, agent_role_id TEXT, workspace_id TEXT,
        run_type TEXT DEFAULT 'dispatch', dispatch_kind TEXT, reason TEXT, status TEXT NOT NULL,
        summary TEXT, error TEXT, cost_stats TEXT, evidence_refs TEXT, resumed_from_run_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER,
        completed_at INTEGER
      );
      CREATE TABLE heartbeat_run_events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    store = new HeartbeatRunStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertRun(input: {
    id: string;
    agentRoleId?: string | null;
    issueId?: string | null;
    taskId?: string | null;
    runType?: "pulse" | "dispatch";
    status: string;
    createdAt: number;
  }): void {
    db.prepare(
      `INSERT INTO heartbeat_runs (id, issue_id, task_id, agent_role_id, run_type, status,
         created_at, updated_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.issueId ?? null,
      input.taskId ?? null,
      input.agentRoleId === undefined ? "agent-1" : input.agentRoleId,
      input.runType ?? "dispatch",
      input.status,
      input.createdAt,
      input.createdAt,
      input.createdAt,
    );
  }

  function statusOf(id: string): string | undefined {
    return (db.prepare("SELECT status FROM heartbeat_runs WHERE id = ?").get(id) as Any)?.status;
  }

  it("settles dispatch runs whose task is terminal, missing, or stale and releases issues", () => {
    const now = Date.now();
    db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("t-done", "completed");
    db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("t-failed", "failed");
    db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run("t-live", "executing");
    db.prepare("INSERT INTO issues (id, active_run_id) VALUES (?, ?)").run("issue-1", "r-issue");
    insertRun({ id: "r-done", taskId: "t-done", status: "running", createdAt: now });
    insertRun({
      id: "r-issue",
      issueId: "issue-1",
      taskId: "t-failed",
      status: "running",
      createdAt: now - 14 * DAY,
    });
    insertRun({ id: "r-missing", taskId: "t-gone", status: "running", createdAt: now });
    insertRun({ id: "r-live", taskId: "t-live", status: "running", createdAt: now - HOUR });
    insertRun({ id: "r-old-live", taskId: "t-live", status: "running", createdAt: now - DAY });

    const settled = store.reconcileStaleDispatchRuns({
      maxAgeMs: 12 * HOUR,
      message: "stale",
      now,
    });

    expect(settled).toBe(4);
    expect(statusOf("r-done")).toBe("completed");
    expect(statusOf("r-issue")).toBe("failed");
    expect(statusOf("r-missing")).toBe("failed");
    expect(statusOf("r-live")).toBe("running");
    expect(statusOf("r-old-live")).toBe("failed");
    expect(
      (db.prepare("SELECT active_run_id FROM issues WHERE id = 'issue-1'").get() as Any)
        .active_run_id,
    ).toBeNull();
  });

  it("does not fail task-tracking dispatch runs on restart reconciliation", () => {
    const now = Date.now();
    insertRun({ id: "r-task", taskId: "t-1", status: "running", createdAt: now });
    insertRun({ id: "r-plain", status: "running", createdAt: now });
    insertRun({ id: "r-pulse", runType: "pulse", status: "running", createdAt: now });

    expect(store.reconcileInterruptedAgentRuns()).toBe(2);
    expect(statusOf("r-task")).toBe("running");
    expect(statusOf("r-plain")).toBe("failed");
    expect(statusOf("r-pulse")).toBe("failed");
  });

  it("prunes old finished runs and their events but keeps the newest per agent", () => {
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) {
      insertRun({
        id: `old-${index}`,
        runType: "pulse",
        status: "completed",
        createdAt: now - 40 * DAY - index,
      });
      db.prepare(
        "INSERT INTO heartbeat_run_events (id, run_id, timestamp, type, payload) VALUES (?, ?, ?, ?, ?)",
      ).run(`e-${index}`, `old-${index}`, now, "x", "{}");
    }
    insertRun({ id: "old-running", status: "running", createdAt: now - 50 * DAY });
    insertRun({ id: "old-issue", issueId: "i", status: "completed", createdAt: now - 50 * DAY });
    insertRun({ id: "recent", runType: "pulse", status: "completed", createdAt: now - DAY });
    db.prepare(
      "INSERT INTO heartbeat_run_events (id, run_id, timestamp, type, payload) VALUES (?, ?, ?, ?, ?)",
    ).run("orphan", "no-such-run", now, "x", "{}");

    const result = pruneHeartbeatRunHistory(db, { retentionMs: 30 * DAY, keepPerAgent: 3, now });

    // Newest three per agent (recent, old-0, old-1) are kept regardless of age.
    expect(statusOf("recent")).toBe("completed");
    expect(statusOf("old-0")).toBe("completed");
    expect(statusOf("old-1")).toBe("completed");
    expect(statusOf("old-2")).toBeUndefined();
    expect(statusOf("old-4")).toBeUndefined();
    expect(statusOf("old-running")).toBe("running");
    expect(statusOf("old-issue")).toBe("completed");
    expect(result.runsDeleted).toBe(3);
    // Events of the three deleted runs plus the orphan.
    expect(result.eventsDeleted).toBe(4);
  });

  it("prunes runs that tasks point to when the task link has no ON DELETE action", () => {
    // Older databases declare tasks.heartbeat_run_id without ON DELETE SET NULL.
    db.pragma("foreign_keys = ON");
    db.exec("ALTER TABLE tasks ADD COLUMN heartbeat_run_id TEXT REFERENCES heartbeat_runs(id)");
    const now = Date.now();
    for (let index = 0; index < 4; index += 1) {
      insertRun({
        id: `old-${index}`,
        runType: "dispatch",
        status: "completed",
        createdAt: now - 40 * DAY - index,
      });
    }
    db.prepare("INSERT INTO tasks (id, status, heartbeat_run_id) VALUES (?, ?, ?)").run(
      "task-kept-run",
      "completed",
      "old-0",
    );
    db.prepare("INSERT INTO tasks (id, status, heartbeat_run_id) VALUES (?, ?, ?)").run(
      "task-pruned-run",
      "completed",
      "old-3",
    );

    const result = pruneHeartbeatRunHistory(db, { retentionMs: 30 * DAY, keepPerAgent: 1, now });

    expect(result.runsDeleted).toBe(3);
    expect(statusOf("old-0")).toBe("completed");
    expect(statusOf("old-3")).toBeUndefined();
    const linkOf = (taskId: string) =>
      (db.prepare("SELECT heartbeat_run_id FROM tasks WHERE id = ?").get(taskId) as Any)
        .heartbeat_run_id;
    expect(linkOf("task-kept-run")).toBe("old-0");
    expect(linkOf("task-pruned-run")).toBeNull();
  });

  it("lists only agent dispatch runs that are still running", () => {
    const now = Date.now();
    insertRun({ id: "a", status: "running", taskId: "t", createdAt: now });
    insertRun({ id: "b", status: "completed", createdAt: now });
    insertRun({ id: "c", status: "running", issueId: "i", createdAt: now });
    insertRun({ id: "d", status: "running", agentRoleId: "agent-2", createdAt: now });
    expect(store.listRunningDispatches("agent-1").map((run) => run.id)).toEqual(["a"]);
  });
});
