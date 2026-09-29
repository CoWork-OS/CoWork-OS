import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../../agent/daemon";
import { DatabaseManager } from "../schema";
import { TaskEventRepository, TaskStore, WorkspaceStore } from "../repositories";

vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/tmp") } }));

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

describeWithSqlite("TaskEventRepository.pruneOldEvents", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-task-event-prune-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let workspaceCount = 0;
  const seed = (status: "completed" | "executing", createdAt: number, events: number) => {
    const db = manager.getDatabase();
    workspaceCount += 1;
    const workspace = new WorkspaceStore(db).create(
      "prune",
      path.join(tmpDir, `ws-${workspaceCount}`),
      {
        read: true,
        write: true,
        delete: false,
        network: false,
        shell: false,
      },
    );
    const task = new TaskStore(db).create({
      title: "prune",
      prompt: "prune",
      status,
      workspaceId: workspace.id,
    });
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(createdAt, task.id);
    const eventRepo = new TaskEventRepository(db);
    for (let i = 0; i < events; i += 1) {
      eventRepo.create({ taskId: task.id, timestamp: createdAt + i, type: "log", payload: { i } });
    }
    return task.id;
  };

  const countEvents = (taskId: string) =>
    (
      manager
        .getDatabase()
        .prepare("SELECT COUNT(*) AS total FROM task_events WHERE task_id = ?")
        .get(taskId) as { total: number }
    ).total;

  it("deletes old terminal-task events in batches and yields between them", async () => {
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
    const oldCompleted = seed("completed", old, 25);
    const oldRunning = seed("executing", old, 5);
    const recentCompleted = seed("completed", Date.now(), 5);

    let yields = 0;
    const setImmediateSpy = vi.spyOn(global, "setImmediate").mockImplementation(((
      callback: () => void,
    ) => {
      yields += 1;
      callback();
      return undefined as unknown as NodeJS.Immediate;
    }) as typeof setImmediate);

    try {
      const deleted = await new TaskEventRepository(manager.getDatabase()).pruneOldEvents(90, {
        batchSize: 10,
      });
      expect(deleted).toBe(25);
    } finally {
      setImmediateSpy.mockRestore();
    }

    // 25 rows at 10 per batch: two full batches, each followed by a yield, then a partial one.
    expect(yields).toBe(2);
    expect(countEvents(oldCompleted)).toBe(0);
    expect(countEvents(oldRunning)).toBe(5);
    expect(countEvents(recentCompleted)).toBe(5);
  });
});

describe("AgentDaemon.vacuumWhenIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const createDaemon = (status: { runningCount: number; queuedCount: number }) =>
    Object.assign(Object.create(AgentDaemon.prototype), {
      shutdownRequested: false,
      queueManager: { getStatus: vi.fn(() => status) },
      dbManager: { getDatabase: () => ({}) },
    }) as Any;

  it("vacuums immediately when no tasks are running or queued", () => {
    const vacuum = vi.spyOn(TaskEventRepository.prototype, "vacuumIfNeeded").mockReturnValue(true);
    createDaemon({ runningCount: 0, queuedCount: 0 }).vacuumWhenIdle(500);
    expect(vacuum).toHaveBeenCalledWith(500);
  });

  it("defers while tasks are active and retries with the lowest requested threshold", () => {
    vi.useFakeTimers();
    const vacuum = vi.spyOn(TaskEventRepository.prototype, "vacuumIfNeeded").mockReturnValue(true);
    const status = { runningCount: 2, queuedCount: 0 };
    const daemon = createDaemon(status);

    daemon.vacuumWhenIdle(500);
    daemon.vacuumWhenIdle(0);
    expect(vacuum).not.toHaveBeenCalled();

    status.runningCount = 0;
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(vacuum).toHaveBeenCalledTimes(1);
    expect(vacuum).toHaveBeenCalledWith(0);
  });

  it("does nothing once shutdown was requested", () => {
    const vacuum = vi.spyOn(TaskEventRepository.prototype, "vacuumIfNeeded");
    const daemon = createDaemon({ runningCount: 0, queuedCount: 0 });
    daemon.shutdownRequested = true;
    daemon.vacuumWhenIdle(500);
    expect(vacuum).not.toHaveBeenCalled();
  });
});
