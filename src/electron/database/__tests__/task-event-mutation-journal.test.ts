import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TASK_EVENT_COLUMN_NAMES,
  TaskEventRepository,
  TaskStore,
  WorkspaceStore,
} from "../repositories";
import { DatabaseManager } from "../schema";
import { registerPendingTimelineWrites } from "../timeline-write-registry";
import { TASK_EVENT_MUTATION_JOURNAL_MAX_ROWS_PER_TASK } from "../../../shared/task-event-mutation-journal-limits";

const nativeSqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("TaskEventRepository committed mutation journal", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let taskId: string;
  let workspaceId: string;
  let repo: TaskEventRepository;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-event-mutation-journal-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("W", path.join(tempDir, "w"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    workspaceId = workspace.id;
    taskId = new TaskStore(db).create({
      title: "Event journal",
      prompt: "Track committed event mutations",
      status: "executing",
      workspaceId: workspace.id,
    }).id;
    repo = new TaskEventRepository(db);
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const cursor = (position = 0) => ({ taskId, position });
  const createEvent = (id: string, payload: Record<string, unknown> = { id }) =>
    repo.create({
      id,
      taskId,
      timestamp: 1_000 + Number(id.replace(/\D/g, "") || 0),
      type: "assistant_message",
      payload,
    });

  it("installs the journal when upgrading an existing database without copying event payloads", () => {
    manager.close();
    fs.rmSync(path.join(tempDir, "cowork-os.db"), { force: true });
    const oldDb = new Database(path.join(tempDir, "cowork-os.db"));
    oldDb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    oldDb
      .prepare(
        `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-task", "Legacy task", "legacy prompt", "completed", "legacy-workspace", 1, 1);
    oldDb
      .prepare(
        "INSERT INTO task_events (id, task_id, timestamp, type, payload) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "legacy-event",
        "legacy-task",
        2,
        "assistant_message",
        JSON.stringify({ message: "kept" }),
      );
    oldDb.close();
    manager = new DatabaseManager();
    db = manager.getDatabase();

    const columns = db.prepare("PRAGMA table_info(task_event_mutation_journal)").all() as Array<{
      name: string;
    }>;
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all() as Array<{
      name: string;
    }>;

    expect(columns.map((column) => column.name)).toEqual([
      "task_id",
      "cursor",
      "event_id",
      "operation",
    ]);
    expect(triggers.map((trigger) => trigger.name)).toEqual(
      expect.arrayContaining([
        "task_events_mutation_journal_insert",
        "task_events_mutation_journal_update",
        "task_events_mutation_journal_rekey",
        "task_events_mutation_journal_delete",
        "task_event_mutation_journal_prune",
      ]),
    );

    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-workspace",
      "Legacy workspace",
      path.join(tempDir, "legacy-workspace"),
      1,
      1,
      JSON.stringify({ read: true, write: false, delete: false, network: false, shell: false }),
    );

    const legacyEvents = new TaskEventRepository(db);
    expect(legacyEvents.getCommittedMutationCursor("legacy-task")).toEqual({
      taskId: "legacy-task",
      position: 0,
    });
    expect(
      legacyEvents.findTimelinePage({ taskId: "legacy-task", limit: 10 }).events,
    ).toMatchObject([{ id: "legacy-event", payload: { message: "kept" } }]);
    expect(
      legacyEvents.findScopedTimelineSnapshot({
        taskId: "legacy-task",
        workspaceId: "legacy-workspace",
        limit: 10,
      }),
    ).toMatchObject({
      outcome: "available",
      cursor: { taskId: "legacy-task", position: 0 },
      page: { events: [{ id: "legacy-event", payload: { message: "kept" } }] },
    });
    expect(
      legacyEvents.findScopedMutationPage({
        taskId: "legacy-task",
        workspaceId: "other-workspace",
        afterCursor: { taskId: "legacy-task", position: 0 },
      }),
    ).toEqual({ outcome: "unavailable" });
  });

  it("bounds retained mutations per task and advances the cursor floor for resnapshot", () => {
    const mutationCount = TASK_EVENT_MUTATION_JOURNAL_MAX_ROWS_PER_TASK + 25;
    const insert = db.prepare(
      `INSERT INTO task_events (id, task_id, timestamp, type, payload)
       VALUES (?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < mutationCount; index += 1) {
        insert.run(`bulk-event-${index}`, taskId, 2_000 + index, "assistant_message", "{}");
      }
    })();

    const state = db
      .prepare(
        `SELECT high_water_cursor, earliest_available_cursor
         FROM task_event_mutation_journal_state WHERE task_id = ?`,
      )
      .get(taskId) as { high_water_cursor: number; earliest_available_cursor: number };
    const retained = db
      .prepare("SELECT COUNT(*) AS count FROM task_event_mutation_journal WHERE task_id = ?")
      .get(taskId) as { count: number };

    expect(state).toEqual({
      high_water_cursor: mutationCount,
      earliest_available_cursor: 26,
    });
    expect(retained.count).toBe(TASK_EVENT_MUTATION_JOURNAL_MAX_ROWS_PER_TASK);
    expect(
      repo.findCommittedMutationPage({ taskId, afterCursor: cursor(0), limit: 10 }),
    ).toMatchObject({
      outcome: "cursor_expired",
      earliestAvailableCursor: 26,
      resyncCursor: cursor(mutationCount),
    });
    expect(
      repo.findCommittedMutationPage({ taskId, afterCursor: cursor(25), limit: 1 }),
    ).toMatchObject({
      outcome: "page_with_more",
      changes: [{ cursor: 26, operation: "upsert" }],
      hasMore: true,
    });
  });

  it("removes retained journal metadata when a task is deleted", () => {
    createEvent("event-to-delete");
    expect(repo.getCommittedMutationCursor(taskId)).toEqual({ taskId, position: 1 });

    new TaskStore(db).delete(taskId);

    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM task_event_mutation_journal WHERE task_id = ?")
        .get(taskId),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          "SELECT high_water_cursor FROM task_event_mutation_journal_state WHERE task_id = ?",
        )
        .get(taskId),
    ).toBeUndefined();
  });

  it("pages scoped history strictly before each returned anchor and rejects another workspace", () => {
    repo.create({
      id: "older-event",
      taskId,
      timestamp: 100,
      type: "assistant_message",
      payload: { message: "older" },
    });
    repo.create({
      id: "middle-event",
      taskId,
      timestamp: 200,
      type: "assistant_message",
      payload: { message: "middle" },
    });
    repo.create({
      id: "newest-event",
      taskId,
      timestamp: 300,
      type: "assistant_message",
      payload: { message: "newest" },
    });

    const newest = repo.findScopedTimelineSnapshot({ taskId, workspaceId, limit: 1 });
    expect(newest).toMatchObject({
      outcome: "available",
      page: { events: [{ id: "newest-event" }], hasMoreHistory: true },
    });
    if (newest.outcome !== "available" || !newest.page.nextCursor) return;

    const middle = repo.findScopedTimelineHistoryPage({
      taskId,
      workspaceId,
      beforeCursor: newest.page.nextCursor as { order: number; timestamp: number; id: string },
      limit: 1,
    });
    expect(middle).toMatchObject({
      outcome: "available",
      page: { events: [{ id: "middle-event" }], hasMoreHistory: true },
    });
    if (middle.outcome !== "available" || !middle.page.nextCursor) return;

    expect(
      repo.findScopedTimelineHistoryPage({
        taskId,
        workspaceId,
        beforeCursor: middle.page.nextCursor as { order: number; timestamp: number; id: string },
        limit: 1,
      }),
    ).toMatchObject({
      outcome: "available",
      page: {
        events: [{ id: "older-event" }],
        hasMoreHistory: false,
        nextCursor: null,
      },
    });
    expect(
      repo.findScopedTimelineHistoryPage({
        taskId,
        workspaceId: "other-workspace",
        beforeCursor: newest.page.nextCursor as { order: number; timestamp: number; id: string },
        limit: 1,
      }),
    ).toEqual({ outcome: "unavailable" });
  });

  it("journals committed inserts, payload updates, and deletes as ordered upserts or tombstones", () => {
    createEvent("event-1", { text: "before" });
    const inserted = repo.findCommittedMutationPage({ taskId, afterCursor: cursor(), limit: 10 });
    expect(inserted.outcome).toBe("page");
    if (inserted.outcome !== "page") return;
    expect(inserted.changes).toEqual([
      {
        cursor: 1,
        operation: "upsert",
        event: expect.objectContaining({
          id: "event-1",
          payload: expect.objectContaining({ text: "before" }),
        }),
      },
    ]);

    repo.updatePayloadById("event-1", { text: "after" });
    const updated = repo.findCommittedMutationPage({
      taskId,
      afterCursor: inserted.nextCursor,
      limit: 10,
    });
    expect(updated.outcome).toBe("page");
    if (updated.outcome !== "page") return;
    expect(updated.changes).toEqual([
      {
        cursor: 2,
        operation: "upsert",
        event: expect.objectContaining({
          id: "event-1",
          payload: expect.objectContaining({ text: "after" }),
        }),
      },
    ]);

    db.prepare("DELETE FROM task_events WHERE task_id = ? AND id = ?").run(taskId, "event-1");
    const deleted = repo.findCommittedMutationPage({
      taskId,
      afterCursor: updated.nextCursor,
      limit: 10,
    });
    expect(deleted.outcome).toBe("page");
    if (deleted.outcome !== "page") return;
    expect(deleted.changes).toEqual([{ cursor: 3, operation: "delete", eventId: "event-1" }]);
  });

  it("does not journal ignored duplicate inserts or writes rolled back with their transaction", () => {
    const prepared = TaskEventRepository.prepareForInsert({
      id: "event-1",
      taskId,
      timestamp: 1_001,
      type: "assistant_message",
      payload: { text: "once" },
    });
    expect(repo.insertPreparedIfAbsent(prepared)).toBe(true);
    expect(repo.insertPreparedIfAbsent(prepared)).toBe(false);

    expect(() =>
      db.transaction(() => {
        createEvent("event-2");
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");

    const result = repo.findCommittedMutationPage({ taskId, afterCursor: cursor(), limit: 10 });
    expect(result.outcome).toBe("page");
    if (result.outcome !== "page") return;
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      cursor: 1,
      operation: "upsert",
      event: { id: "event-1" },
    });
  });

  it("pages with a hard row bound and returns explicit empty, invalid, and expired outcomes", () => {
    createEvent("event-1");
    createEvent("event-2");
    createEvent("event-3");

    const first = repo.findCommittedMutationPage({ taskId, afterCursor: cursor(), limit: 2 });
    expect(first.outcome).toBe("page_with_more");
    if (first.outcome !== "page_with_more") return;
    expect(first.changes.map((change) => change.cursor)).toEqual([1, 2]);
    expect(first.nextCursor).toEqual(cursor(2));

    const second = repo.findCommittedMutationPage({
      taskId,
      afterCursor: first.nextCursor,
      limit: 2,
    });
    expect(second.outcome).toBe("page");
    if (second.outcome !== "page") return;
    expect(second.changes.map((change) => change.cursor)).toEqual([3]);

    expect(
      repo.findCommittedMutationPage({ taskId, afterCursor: second.nextCursor, limit: 2 }),
    ).toMatchObject({ outcome: "no_changes", changes: [], hasMore: false });
    expect(
      repo.findCommittedMutationPage({ taskId, afterCursor: cursor(0), limit: 501 }),
    ).toMatchObject({ outcome: "invalid_request", reason: "limit_invalid" });
    expect(
      repo.findCommittedMutationPage({ taskId, afterCursor: cursor(4), limit: 2 }),
    ).toMatchObject({ outcome: "invalid_request", reason: "cursor_ahead" });
    expect(
      repo.findCommittedMutationPage({
        taskId: "other-task",
        afterCursor: cursor(0),
        limit: 2,
      }),
    ).toMatchObject({ outcome: "invalid_request", reason: "cursor_task_mismatch" });

    db.prepare(
      `UPDATE task_event_mutation_journal_state
       SET earliest_available_cursor = 3 WHERE task_id = ?`,
    ).run(taskId);
    db.prepare(`DELETE FROM task_event_mutation_journal WHERE task_id = ? AND cursor < 3`).run(
      taskId,
    );
    expect(
      repo.findCommittedMutationPage({ taskId, afterCursor: cursor(1), limit: 2 }),
    ).toMatchObject({
      outcome: "cursor_expired",
      earliestAvailableCursor: 3,
      resyncCursor: cursor(3),
    });

    db.prepare(
      `UPDATE task_event_mutation_journal_state
       SET earliest_available_cursor = 4 WHERE task_id = ?`,
    ).run(taskId);
    db.prepare("DELETE FROM task_event_mutation_journal WHERE task_id = ?").run(taskId);
    expect(
      repo.findCommittedMutationPage({ taskId, afterCursor: cursor(2), limit: 2 }),
    ).toMatchObject({
      outcome: "cursor_expired",
      earliestAvailableCursor: 4,
      resyncCursor: cursor(3),
    });
    expect(
      repo.findCommittedMutationPage({ taskId, afterCursor: cursor(3), limit: 2 }),
    ).toMatchObject({ outcome: "no_changes", changes: [], nextCursor: cursor(3) });
  });

  it("hydrates journal rows inside one SQLite read transaction and ignores pending rows", () => {
    createEvent("event-1");
    createEvent("event-0");
    const transactionStates: boolean[] = [];
    const readRepo = new TaskEventRepository({
      prepare: (sql: string) => {
        if (
          sql.includes("task_event_mutation_journal_state") ||
          sql.includes("FROM task_event_mutation_journal") ||
          sql.includes("FROM tasks AS task") ||
          sql.includes("timeline_order") ||
          (sql.includes("FROM task_events") && sql.includes("id IN ("))
        ) {
          transactionStates.push(db.inTransaction);
        }
        return db.prepare(sql);
      },
      transaction: db.transaction.bind(db),
    } as unknown as Database.Database);

    const result = readRepo.findCommittedMutationPage({ taskId, afterCursor: cursor(), limit: 10 });
    expect(result.outcome).toBe("page");
    expect(transactionStates.length).toBeGreaterThanOrEqual(3);
    expect(transactionStates.every(Boolean)).toBe(true);

    const pending = TaskEventRepository.prepareForInsert({
      id: "event-pending",
      taskId,
      timestamp: 2_000,
      type: "assistant_message",
      payload: { text: "accepted but not committed" },
    });
    const pendingRow: Record<string, unknown> = {};
    TASK_EVENT_COLUMN_NAMES.forEach((column, index) => {
      pendingRow[column] = pending.params[index];
    });
    const unregister = registerPendingTimelineWrites(db, {
      pendingTaskEventRows: (id) => (id === taskId ? [pendingRow] : []),
      flushTask: () => {
        throw new Error("committed replay must not flush pending rows");
      },
      flushEvent: () => undefined,
      flushActivities: () => undefined,
      flushAll: () => undefined,
    });
    try {
      const currentCursor = repo.getCommittedMutationCursor(taskId)!;
      expect(
        readRepo.findCommittedMutationPage({ taskId, afterCursor: currentCursor, limit: 10 }),
      ).toMatchObject({ outcome: "no_changes", changes: [] });
      const committedSnapshot = readRepo.findScopedTimelineSnapshot({
        taskId,
        workspaceId,
        limit: 1,
      });
      expect(committedSnapshot).toMatchObject({
        outcome: "available",
        page: { events: [{ id: "event-1" }] },
      });
      if (committedSnapshot.outcome === "available") {
        expect(committedSnapshot.page.events.map((event) => event.id)).not.toContain(
          "event-pending",
        );
        expect(committedSnapshot.page.nextCursor).toMatchObject({ id: "event-1" });
        const beforeCursor = committedSnapshot.page.nextCursor;
        if (!beforeCursor?.id) throw new Error("Expected a complete timeline cursor");
        const olderPage = readRepo.findScopedTimelineHistoryPage({
          taskId,
          workspaceId,
          beforeCursor: { ...beforeCursor, id: beforeCursor.id },
          limit: 1,
        });
        expect(olderPage).toMatchObject({
          outcome: "available",
          page: { events: [{ id: "event-0" }], hasMoreHistory: false },
        });
        if (olderPage.outcome === "available") {
          expect(olderPage.page.events.map((event) => event.id)).not.toContain("event-pending");
        }
      }
      expect(transactionStates.every(Boolean)).toBe(true);
    } finally {
      unregister();
    }
  });
});
