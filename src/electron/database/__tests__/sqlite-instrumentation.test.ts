import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureSqliteInstrumentation,
  fingerprintSql,
  getSqliteInstrumentationSnapshot,
  instrumentDatabase,
  recordHostOperation,
  resetSqliteInstrumentation,
  type SlowSqliteOperation,
} from "../sqlite-instrumentation";

const BetterSqlite3 = await import("better-sqlite3")
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

const describeWithSqlite = BetterSqlite3 ? describe : describe.skip;

describe("fingerprintSql", () => {
  it("removes literals and comments and collapses parameter lists", () => {
    expect(
      fingerprintSql(`
        -- recent events
        SELECT * FROM task_events /* hint */
        WHERE task_id = 'task-123' AND seq > 42 AND id IN (?, ?, ?)
      `),
    ).toBe("SELECT * FROM task_events WHERE task_id = ? AND seq > ? AND id IN (?, ...)");
  });

  it("keeps identifiers that contain digits", () => {
    expect(fingerprintSql("SELECT bm25(memories_fts) FROM t1 LIMIT 10")).toBe(
      "SELECT bm25(memories_fts) FROM t1 LIMIT ?",
    );
  });

  it("caps long statements", () => {
    const label = fingerprintSql(`SELECT ${"column_name, ".repeat(40)} x FROM t`);
    expect(label.length).toBeLessThanOrEqual(163);
    expect(label.endsWith("...")).toBe(true);
  });
});

describeWithSqlite("instrumentDatabase", () => {
  let db: InstanceType<NonNullable<typeof BetterSqlite3>>;
  let slowOperations: SlowSqliteOperation[];

  beforeEach(() => {
    resetSqliteInstrumentation();
    slowOperations = [];
    configureSqliteInstrumentation({
      slowOperationMs: Number.POSITIVE_INFINITY,
      onSlowOperation: (operation) => slowOperations.push(operation),
    });
    db = instrumentDatabase(new BetterSqlite3!(":memory:"));
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  });

  afterEach(() => {
    db.close();
    configureSqliteInstrumentation({ slowOperationMs: 100, onSlowOperation: null });
    resetSqliteInstrumentation();
  });

  const label = (text: string) =>
    getSqliteInstrumentationSnapshot({ topLabels: 100 }).labels.find(
      (entry) => entry.label === text,
    );

  it("records reads and writes with row counts and parameter sizes but no values", () => {
    const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
    insert.run("alpha");
    insert.run("beta");
    expect(db.prepare("SELECT name FROM items ORDER BY id").all()).toHaveLength(2);
    expect(db.prepare("SELECT name FROM items WHERE id = ?").get(1)).toEqual({ name: "alpha" });

    const write = label("INSERT INTO items (name) VALUES (?)");
    expect(write).toMatchObject({ kind: "write", count: 2, rows: 2, paramSize: 9 });
    expect(label("SELECT name FROM items ORDER BY id")).toMatchObject({ kind: "read", rows: 2 });
    expect(label("SELECT name FROM items WHERE id = ?")).toMatchObject({ kind: "read", rows: 1 });

    const snapshot = getSqliteInstrumentationSnapshot({ topLabels: 100 });
    expect(snapshot.byKind.write.count).toBe(2);
    expect(snapshot.byKind.read.count).toBe(2);
    expect(JSON.stringify(snapshot)).not.toContain("alpha");
  });

  it("keeps statement chaining and pragma results intact", () => {
    db.prepare("INSERT INTO items (name) VALUES (?)").run("gamma");
    expect(db.prepare("SELECT name FROM items").pluck().get()).toBe("gamma");
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(db.exec("SELECT 1")).toBe(db);
    expect(label("PRAGMA user_version")).toMatchObject({ kind: "pragma", count: 1 });
  });

  it("times each transaction mode without double-counting nested statements", () => {
    const insertMany = db.transaction((names: string[]) => {
      const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
      for (const name of names) insert.run(name);
      return names.length;
    });
    resetSqliteInstrumentation();

    expect(insertMany(["a", "b"])).toBe(2);
    expect(insertMany.immediate(["c"])).toBe(1);
    expect(insertMany.deferred.exclusive(["d"])).toBe(1);
    expect(typeof insertMany.database.prepare).toBe("function");

    const snapshot = getSqliteInstrumentationSnapshot({ topLabels: 100 });
    expect(label("TRANSACTION default")?.count).toBe(1);
    expect(label("TRANSACTION immediate")?.count).toBe(1);
    expect(label("TRANSACTION exclusive")?.count).toBe(1);
    expect(snapshot.byKind.write.count).toBe(4);
    // Only the three transactions are top-level; their inserts are nested.
    expect(snapshot.topLevelOperations).toBe(3);
    expect(snapshot.hostMs).toBeLessThanOrEqual(snapshot.byKind.transaction.totalMs + 0.01);
  });

  it("labels nested transactions as savepoints and preserves rollback", () => {
    const inner = db.transaction(() => {
      db.prepare("INSERT INTO items (name) VALUES (?)").run("inner");
      throw new Error("inner failed");
    });
    const outer = db.transaction(() => {
      db.prepare("INSERT INTO items (name) VALUES (?)").run("outer");
      expect(() => inner()).toThrow("inner failed");
    });
    outer();

    expect(db.prepare("SELECT name FROM items").pluck().all()).toEqual(["outer"]);
    expect(label("SAVEPOINT")).toMatchObject({ kind: "transaction", count: 1, errors: 1 });
  });

  it("counts errors and rethrows them unchanged", () => {
    const insert = db.prepare("INSERT INTO items (id, name) VALUES (?, ?)");
    insert.run(1, "first");
    expect(() => insert.run(1, "duplicate")).toThrow(/UNIQUE constraint failed/);

    expect(label("INSERT INTO items (id, name) VALUES (?, ...)")).toMatchObject({
      count: 2,
      errors: 1,
    });
    expect(getSqliteInstrumentationSnapshot().errors).toBe(1);
  });

  it("reports slow operations with an application call site", () => {
    configureSqliteInstrumentation({ slowOperationMs: 0 });
    db.prepare("SELECT count(*) AS total FROM items").get();

    const slow = slowOperations.find((entry) => entry.label.startsWith("SELECT count(*)"));
    expect(slow).toMatchObject({ kind: "read", rows: 1, failed: false });
    expect(slow?.callSite.some((frame) => frame.includes("sqlite-instrumentation.test"))).toBe(
      true,
    );
    expect(slow?.callSite.join("\n")).not.toMatch(/\/Users\/|\/home\//);
  });

  it("is idempotent", () => {
    instrumentDatabase(db);
    db.prepare("SELECT 1").get();
    expect(label("SELECT ?")?.count).toBe(1);
  });

  it("summarizes host operations and resets the window", () => {
    recordHostOperation("timeline.persist", 4);
    recordHostOperation("timeline.persist", 12);
    const persist = getSqliteInstrumentationSnapshot({ reset: true }).hostOperations[
      "timeline.persist"
    ];
    expect(persist).toMatchObject({ count: 2, totalMs: 16, maxMs: 12 });
    expect(persist.p99Ms).toBeGreaterThanOrEqual(11.9);

    const after = getSqliteInstrumentationSnapshot();
    expect(after.hostOperations["timeline.persist"]).toBeUndefined();
    expect(after.topLevelOperations).toBe(0);
  });
});
