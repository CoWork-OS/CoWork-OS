import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadSubscriptionStore } from "../thread-subscriptions-sql";
import { ThreadSubscriptionRepository } from "../repository-facades";
import { THREAD_SUBSCRIPTIONS_SCHEMA_SQL } from "../thread-subscriptions-schema";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("ThreadSubscriptionStore", () => {
  let db: import("better-sqlite3").Database;

  beforeEach(async () => {
    const Database = (await import("better-sqlite3")).default;
    db = new Database(":memory:");
    db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    db.exec(THREAD_SUBSCRIPTIONS_SCHEMA_SQL);
    const insert = db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)");
    insert.run("running", "executing");
    insert.run("paused", "paused");
    insert.run("done", "completed");
    insert.run("failed", "failed");
  });

  afterEach(() => db.close());

  it("subscribes once per task and thread", () => {
    const store = new ThreadSubscriptionStore(db);
    expect(store.subscribe("github:acme/app:pr:1", "running", 10)).toBe(true);
    expect(store.subscribe("github:acme/app:pr:1", "running", 20)).toBe(false);
    expect(store.listForThread("github:acme/app:pr:1")).toEqual([
      { threadKey: "github:acme/app:pr:1", taskId: "running", createdAt: 10 },
    ]);
  });

  it("returns only subscribers that can still take a follow-up, oldest first", () => {
    const store = new ThreadSubscriptionStore(db);
    store.subscribe("mail:t1", "paused", 30);
    store.subscribe("mail:t1", "done", 5);
    store.subscribe("mail:t1", "failed", 6);
    store.subscribe("mail:t1", "running", 20);
    store.subscribe("mail:t1", "deleted-task", 1);
    expect(store.findActiveSubscribers("mail:t1")).toEqual(["running", "paused"]);
    expect(store.findActiveSubscribers("mail:other")).toEqual([]);
  });

  it("unsubscribes one thread or every thread of a task", () => {
    const store = new ThreadSubscriptionStore(db);
    store.subscribe("mail:t1", "running", 1);
    store.subscribe("mail:t2", "running", 2);
    store.subscribe("mail:t1", "paused", 3);
    expect(store.unsubscribe("mail:t1", "running")).toBe(1);
    expect(store.unsubscribe("mail:t1", "running")).toBe(0);
    expect(store.listForTask("running").map((row) => row.threadKey)).toEqual(["mail:t2"]);
    expect(store.unsubscribeTask("running")).toBe(1);
    expect(store.listForTask("running")).toEqual([]);
    expect(store.listForThread("mail:t1").map((row) => row.taskId)).toEqual(["paused"]);
  });

  it("runs behind the async repository facade", async () => {
    const repository = new ThreadSubscriptionRepository(db);
    expect(await repository.subscribe("slack:c:C1:1.1", "running", 1)).toBe(true);
    expect(await repository.findActiveSubscribers("slack:c:C1:1.1")).toEqual(["running"]);
    expect(await repository.unsubscribeTask("running")).toBe(1);
  });
});
