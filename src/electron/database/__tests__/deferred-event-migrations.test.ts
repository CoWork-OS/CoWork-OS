import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../schema";
import { TaskEventRepository, TaskStore, WorkspaceStore } from "../repositories";
import { setDeferredMigrationExecutor } from "../deferred-event-migrations";

const nativeSqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

// Legacy events converted on read are written back after the read, in chunks (DB4).
describeWithSqlite("deferred legacy event migrations", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let taskId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-deferred-migrations-"));
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
    taskId = new TaskStore(db).create({
      title: "Legacy",
      prompt: "p",
      status: "completed",
      workspaceId: workspace.id,
    }).id;
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const seedLegacy = (count: number) => {
    const insert = db.prepare(
      "INSERT INTO task_events (id, task_id, timestamp, type, payload, schema_version) VALUES (?, ?, ?, ?, ?, 1)",
    );
    db.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        insert.run(
          `legacy-${index}`,
          taskId,
          1_000 + index,
          index % 2 ? "tool_call" : "assistant_message",
          JSON.stringify(index % 2 ? { tool: "read_file" } : { message: `m${index}` }),
        );
      }
    })();
  };
  const legacyRows = () =>
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM task_events WHERE COALESCE(schema_version, 0) <> 2")
        .get() as { count: number }
    ).count;

  it("returns converted events at once and writes them back after the read", async () => {
    seedLegacy(20);
    const events = new TaskEventRepository(db);
    const first = events.findByTaskId(taskId);
    expect(first).toHaveLength(20);
    expect(first.every((event) => event.schemaVersion === 2)).toBe(true);
    expect(legacyRows()).toBe(20);

    // Another read before the write lands converts again, identically, without writing.
    expect(events.findByTaskId(taskId)).toEqual(first);
    expect(legacyRows()).toBe(20);

    await nextTick();
    expect(legacyRows()).toBe(0);
    expect(events.findByTaskId(taskId)).toEqual(first);
  });

  it("writes pending conversions before SQL that reads the converted columns", () => {
    seedLegacy(10);
    const events = new TaskEventRepository(db);
    events.findByTaskId(taskId);
    expect(legacyRows()).toBe(10);
    // Same tick: the seq column is only set by the conversion.
    expect(events.getLatestSeq(taskId)).toBe(10);
    expect(legacyRows()).toBe(0);
  });

  it("hands a whole task to the executor in one write", async () => {
    seedLegacy(1_200);
    const calls: Array<{ taskId: string; rows: number }> = [];
    setDeferredMigrationExecutor(db.name, async (id, rows) => {
      calls.push({ taskId: id, rows: rows.length });
    });
    try {
      new TaskEventRepository(db).findByTaskId(taskId);
      await nextTick();
      await nextTick();
      expect(calls).toEqual([{ taskId, rows: 1_200 }]);
      // The executor owns the write; the host connection did not write.
      expect(legacyRows()).toBe(1_200);
    } finally {
      setDeferredMigrationExecutor(db.name, null);
    }
  });

  /** Pages of 10 walk backwards in time; each page lists its events oldest first. */
  const pagesOf = (ascending: string[]) => {
    const pages: string[] = [];
    for (let end = ascending.length; end > 0; end -= 10) {
      pages.push(...ascending.slice(Math.max(0, end - 10), end));
    }
    return pages;
  };

  const pageThrough = async (
    events: TaskEventRepository,
    options: { beforePage?: (index: number) => Promise<void> | void } = {},
  ) => {
    const ids: string[] = [];
    let cursor = null as Parameters<TaskEventRepository["findTimelinePage"]>[0]["cursor"];
    for (let index = 0; index < 100; index += 1) {
      await options.beforePage?.(index);
      const page = events.findTimelinePage({ taskId, limit: 10, cursor });
      ids.push(...page.events.map((event) => event.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return ids;
  };

  it("pages a legacy task without duplicates or gaps while its conversion lands", async () => {
    seedLegacy(50);
    const events = new TaskEventRepository(db);
    const expected = pagesOf(Array.from({ length: 50 }, (_, index) => `legacy-${index}`));
    // A full read queues the deferred write-back; it lands after the second page.
    events.findByTaskId(taskId);
    const ids = await pageThrough(events, {
      beforePage: async (index) => {
        if (index === 2) {
          await nextTick();
          expect(legacyRows()).toBe(0);
        }
      },
    });
    expect(legacyRows()).toBe(0);
    expect(ids).toEqual(expected);
  });

  it("pages a v2 session exactly as before", async () => {
    const events = new TaskEventRepository(db);
    for (let index = 0; index < 35; index += 1) {
      events.create({ taskId, timestamp: 2_000 + index, type: "assistant_message", payload: {} });
    }
    const all = events.findByTaskId(taskId).map((event) => event.id);
    expect(await pageThrough(events)).toEqual(pagesOf(all));
  });

  it("keeps explicit task migration synchronous", () => {
    seedLegacy(5);
    expect(new TaskEventRepository(db).migrateLegacyEventsForTask(taskId)).toBe(5);
    expect(legacyRows()).toBe(0);
  });
});
