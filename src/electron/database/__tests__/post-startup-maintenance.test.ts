import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { deleteOrphanTaskEventsChunk } from "../post-startup-maintenance";

describe("bounded orphan event cleanup", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  function seed(rows: Array<{ rowid: number; taskId: string }>) {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE task_events (id TEXT PRIMARY KEY, task_id TEXT, payload TEXT);
      INSERT INTO tasks VALUES ('existing');
    `);
    const insert = db.prepare(
      "INSERT INTO task_events (rowid, id, task_id, payload) VALUES (?, ?, ?, ?)",
    );
    for (const row of rows) insert.run(row.rowid, `event-${row.rowid}`, row.taskId, "TEST DATA");
  }

  it("advances through valid events without searching later chunks for an orphan", () => {
    seed(
      Array.from({ length: 8 }, (_, index) => ({
        rowid: index + 1,
        taskId: index === 7 ? "missing" : "existing",
      })),
    );
    expect(deleteOrphanTaskEventsChunk(db, 0, 3)).toEqual({
      deleted: 0,
      nextRowid: 3,
      done: false,
    });
    expect(db.prepare("SELECT 1 FROM task_events WHERE rowid = 8").get()).toBeDefined();
    expect(deleteOrphanTaskEventsChunk(db, 3, 3)).toEqual({
      deleted: 0,
      nextRowid: 6,
      done: false,
    });
    expect(deleteOrphanTaskEventsChunk(db, 6, 3)).toEqual({ deleted: 1, nextRowid: 8, done: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_events").get()).toEqual({ count: 7 });
    expect(deleteOrphanTaskEventsChunk(db, 8, 3)).toEqual({ deleted: 0, nextRowid: 8, done: true });
  });

  it("handles rowid gaps, deleted boundary rows, and an exact final chunk", () => {
    seed([
      { rowid: 2, taskId: "missing" },
      { rowid: 100, taskId: "missing" },
      { rowid: 1000, taskId: "existing" },
      { rowid: 10000, taskId: "missing" },
    ]);
    expect(deleteOrphanTaskEventsChunk(db, 0, 2)).toEqual({
      deleted: 2,
      nextRowid: 100,
      done: false,
    });
    expect(deleteOrphanTaskEventsChunk(db, 100, 2)).toEqual({
      deleted: 1,
      nextRowid: 10000,
      done: false,
    });
    expect(deleteOrphanTaskEventsChunk(db, 10000, 2)).toEqual({
      deleted: 0,
      nextRowid: 10000,
      done: true,
    });
    expect(db.prepare("SELECT rowid FROM task_events").all()).toEqual([{ rowid: 1000 }]);
  });
});
