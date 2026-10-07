import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerSurfaceStateStore } from "../AnswerSurfaceStateStore";
import { deleteAnswerSurfaceStateForTask } from "../answer-surface-state-sql";

const require = createRequire(import.meta.url);
const BetterSqlite3 = (() => {
  try {
    const module = require("better-sqlite3") as typeof import("better-sqlite3");
    new module(":memory:").close();
    return module;
  } catch {
    return null;
  }
})();

const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;
const databases: Array<import("better-sqlite3").Database> = [];

function useDb(): void {
  if (!BetterSqlite3) throw new Error("better-sqlite3 unavailable");
  const db = new BetterSqlite3(":memory:");
  databases.push(db);
  AnswerSurfaceStateStore.setDatabaseForTests(db);
}

afterEach(() => {
  AnswerSurfaceStateStore.setDatabaseForTests(null);
  for (const db of databases.splice(0)) db.close();
});

describeWithNativeDb("AnswerSurfaceStateStore", () => {
  it("saves and reads state per task and surface", async () => {
    useDb();
    await AnswerSurfaceStateStore.save("task-1", "s1-abc-0", { people: 8 }, "People: 8");
    await AnswerSurfaceStateStore.save("task-2", "s1-abc-0", { people: 3 }, "People: 3");
    await AnswerSurfaceStateStore.save("task-1", "s1-abc-0", { people: 9 }, "People: 9");

    expect(await AnswerSurfaceStateStore.get("task-1", ["s1-abc-0", "s1-missing-0"])).toMatchObject(
      [{ key: "s1-abc-0", state: { people: 9 } }],
    );
    expect(await AnswerSurfaceStateStore.get("task-2", ["s1-abc-0"])).toMatchObject([
      { state: { people: 3 } },
    ]);
  });

  it("reports each change to the model once", async () => {
    useDb();
    await AnswerSurfaceStateStore.save("task-1", "s1-a-0", { people: 8 }, "People: 8");
    await AnswerSurfaceStateStore.save("task-1", "s1-b-0", { done: [] }, "");

    const first = await AnswerSurfaceStateStore.listUnreported("task-1");
    expect(first).toEqual([{ key: "s1-a-0", summary: "People: 8", updatedAt: expect.any(Number) }]);
    await AnswerSurfaceStateStore.markReported("task-1", ["s1-a-0"]);
    expect(await AnswerSurfaceStateStore.listUnreported("task-1")).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 2));
    await AnswerSurfaceStateStore.save("task-1", "s1-a-0", { people: 10 }, "People: 10");
    expect(await AnswerSurfaceStateStore.listUnreported("task-1")).toMatchObject([
      { key: "s1-a-0", summary: "People: 10" },
    ]);
  });

  it("deletes a task's state", async () => {
    useDb();
    await AnswerSurfaceStateStore.save("task-1", "s1-a-0", { people: 8 }, "People: 8");
    await AnswerSurfaceStateStore.deleteForTask("task-1");
    expect(await AnswerSurfaceStateStore.get("task-1", ["s1-a-0"])).toEqual([]);
  });

  it("deletes inside the task-delete transaction, even before the table exists", async () => {
    if (!BetterSqlite3) throw new Error("better-sqlite3 unavailable");
    const fresh = new BetterSqlite3(":memory:");
    databases.push(fresh);
    expect(() => deleteAnswerSurfaceStateForTask(fresh, "task-1")).not.toThrow();
    AnswerSurfaceStateStore.setDatabaseForTests(fresh);
    await AnswerSurfaceStateStore.save("task-1", "s1-a-0", { people: 8 }, "People: 8");
    await AnswerSurfaceStateStore.save("task-2", "s1-a-0", { people: 2 }, "People: 2");
    fresh.transaction(() => deleteAnswerSurfaceStateForTask(fresh, "task-1"))();
    expect(await AnswerSurfaceStateStore.get("task-1", ["s1-a-0"])).toEqual([]);
    expect(await AnswerSurfaceStateStore.get("task-2", ["s1-a-0"])).toHaveLength(1);
  });

  it("refuses oversized state", async () => {
    useDb();
    await expect(
      AnswerSurfaceStateStore.save("task-1", "s1-a-0", { blob: "x".repeat(40_000) }, ""),
    ).rejects.toThrow();
  });

  it("reads nothing and skips writes without a database", async () => {
    AnswerSurfaceStateStore.setDatabaseForTests(null);
    await AnswerSurfaceStateStore.save("task-1", "s1-a-0", { people: 8 }, "People: 8");
    expect(await AnswerSurfaceStateStore.get("task-1", ["s1-a-0"])).toEqual([]);
  });
});
