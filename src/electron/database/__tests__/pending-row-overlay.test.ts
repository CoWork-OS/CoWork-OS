import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../schema";
import {
  TASK_EVENT_COLUMN_NAMES,
  TaskEventRepository,
  TaskStore,
  WorkspaceStore,
} from "../repositories";
import { registerPendingTimelineWrites } from "../timeline-write-registry";
import { ActivityRepository } from "../../activity/activity-repository-facades";
import type { Activity, TaskEvent } from "../../../shared/types";

const nativeSqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

// Reads merge accepted-but-uncommitted timeline rows instead of committing them on the
// host (async SQLite plan, DB6), so a read never writes and never waits on a lock.
describeWithSqlite("reads over pending timeline rows", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let taskId: string;
  let workspaceId: string;
  const pendingEvents: Array<Record<string, unknown>> = [];
  const pendingActivities: Activity[] = [];
  let unregister: () => void;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-pending-overlay-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    workspaceId = new WorkspaceStore(db).create("W", path.join(tempDir, "w"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    }).id;
    taskId = new TaskStore(db).create({
      title: "T",
      prompt: "p",
      status: "executing",
      workspaceId,
    }).id;
    pendingEvents.length = 0;
    pendingActivities.length = 0;
    unregister = registerPendingTimelineWrites(db, {
      pendingTaskEventRows: (id) => pendingEvents.filter((row) => row.task_id === id),
      pendingActivities: () => [...pendingActivities],
      flushTask: () => {
        throw new Error("a read must not commit pending rows");
      },
      flushEvent: () => undefined,
      flushActivities: () => {
        throw new Error("a read must not commit pending activity rows");
      },
      flushAll: () => undefined,
    });
  });

  afterEach(() => {
    unregister();
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const event = (seq: number, legacyType: string): Omit<TaskEvent, "id"> & { id: string } => ({
    id: `e-${seq}`,
    taskId,
    timestamp: 1_000 + seq,
    type: "timeline_step_updated",
    legacyType,
    seq,
    payload: { n: seq },
  });
  const commit = (seq: number, legacyType = "assistant_message") => {
    unregister();
    new TaskEventRepository(db).create(event(seq, legacyType));
    unregister = registerPendingTimelineWrites(db, {
      pendingTaskEventRows: (id) => pendingEvents.filter((row) => row.task_id === id),
      pendingActivities: () => [...pendingActivities],
      flushTask: () => {
        throw new Error("a read must not commit pending rows");
      },
      flushEvent: () => undefined,
      flushActivities: () => {
        throw new Error("a read must not commit pending activity rows");
      },
      flushAll: () => undefined,
    });
  };
  const accept = (seq: number, legacyType = "assistant_message") => {
    const { params } = TaskEventRepository.prepareForInsert(event(seq, legacyType));
    const row: Record<string, unknown> = {};
    TASK_EVENT_COLUMN_NAMES.forEach((column, index) => {
      row[column] = params[index];
    });
    pendingEvents.push(row);
  };
  const ids = (events: TaskEvent[]) => events.map((item) => item.id);
  const committedCount = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM task_events").get() as { n: number }).n;

  it("merges pending rows into full, typed, limited and replay reads without writing", () => {
    for (const seq of [1, 2, 3]) commit(seq);
    accept(4);
    accept(5, "tool_call");
    const events = new TaskEventRepository(db);
    const before = committedCount();

    expect(ids(events.findByTaskId(taskId))).toEqual(["e-1", "e-2", "e-3", "e-4", "e-5"]);
    expect(ids(events.findByTaskIdAndTypes(taskId, ["assistant_message"], 2))).toEqual([
      "e-3",
      "e-4",
    ]);
    expect(ids(events.findByTaskIdAndTypes(taskId, ["tool_call"]))).toEqual(["e-5"]);
    expect(
      ids(
        events.findReplayTailAfterCursor(taskId, { order: 3, timestamp: 1_003, id: "e-3" }, [
          "assistant_message",
          "tool_call",
        ]),
      ),
    ).toEqual(["e-4", "e-5"]);
    expect(events.findEventCursorById(taskId, "e-5")).toEqual({
      order: 5,
      timestamp: 1_005,
      id: "e-5",
    });
    expect(committedCount()).toBe(before);
  });

  it("includes pending rows in the latest timeline page and pages on from the database", () => {
    for (const seq of [1, 2, 3, 4]) commit(seq);
    accept(5);
    accept(6);
    const events = new TaskEventRepository(db);
    const first = events.findTimelinePage({ taskId, limit: 3 });
    expect(ids(first.events)).toEqual(["e-4", "e-5", "e-6"]);
    const second = events.findTimelinePage({ taskId, limit: 3, cursor: first.nextCursor });
    expect(ids(second.events)).toEqual(["e-1", "e-2", "e-3"]);
    expect(second.nextCursor).toBeNull();
  });

  it("returns a committed row once when its pending copy is still queued", () => {
    commit(1);
    accept(1);
    expect(ids(new TaskEventRepository(db).findByTaskId(taskId))).toEqual(["e-1"]);
  });

  it("merges pending activity rows into lists and unread counts", async () => {
    const activities = new ActivityRepository(db);
    unregister();
    const committed = await activities.create({
      workspaceId,
      taskId,
      actorType: "agent",
      activityType: "tool_used",
      title: "committed",
    });
    unregister = registerPendingTimelineWrites(db, {
      pendingActivities: () => [...pendingActivities],
      flushTask: () => undefined,
      flushEvent: () => undefined,
      flushActivities: () => {
        throw new Error("a read must not commit pending activity rows");
      },
      flushAll: () => undefined,
    });
    const pending = {
      ...ActivityRepository.prepareForInsert({
        workspaceId,
        taskId,
        actorType: "agent",
        activityType: "tool_used",
        title: "pending",
      }),
      createdAt: committed.createdAt + 10,
    };
    pendingActivities.push(pending);
    expect((await activities.list({ workspaceId })).map((item) => item.title)).toEqual([
      "pending",
      "committed",
    ]);
    expect(
      (await activities.list({ workspaceId, limit: 1, offset: 1 })).map((item) => item.title),
    ).toEqual(["committed"]);
    expect(await activities.getUnreadCount(workspaceId)).toBe(2);
    expect((await activities.findById(pending.id))?.title).toBe("pending");
  });
});
