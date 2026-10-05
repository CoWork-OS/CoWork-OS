/**
 * Term search over tables without a full-text index (Mission Control recall, RECALL-4):
 * every row of the workspace is searched in SQL, ranked by how many query terms match,
 * so old matches are not lost behind a recent window.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityStore } from "../../activity/ActivityRepository";
import { likeTermHitsSql } from "../fts-query";
import { TaskStore } from "../repositories";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describe("likeTermHitsSql", () => {
  it("counts term matches across columns with escaped patterns", () => {
    const hits = likeTermHitsSql(["title", "prompt"], ["100%", "a_b", ""]);
    expect(hits.sql).toBe(
      "(CASE WHEN (title LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\') THEN 1 ELSE 0 END) + " +
        "(CASE WHEN (title LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\') THEN 1 ELSE 0 END)",
    );
    expect(hits.params).toEqual(["%100\\%%", "%100\\%%", "%a\\_b%", "%a\\_b%"]);
    expect(likeTermHitsSql(["title"], [])).toEqual({ sql: "0", params: [] });
  });
});

describeWithSqlite("term search", () => {
  let db: Database.Database;
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();

  beforeEach(async () => {
    const { default: SqliteDatabase } = await import("better-sqlite3");
    db = new SqliteDatabase(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, prompt TEXT, result_summary TEXT,
        status TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE activity_feed (
        id TEXT PRIMARY KEY, workspace_id TEXT, task_id TEXT, agent_role_id TEXT,
        actor_type TEXT, activity_type TEXT, title TEXT, description TEXT, metadata TEXT,
        is_read INTEGER DEFAULT 0, is_pinned INTEGER DEFAULT 0, created_at INTEGER
      );
    `);
    const task = db.prepare(
      "INSERT INTO tasks (id, workspace_id, title, prompt, result_summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)",
    );
    // An old full match, many recent partial matches, another workspace's full match.
    task.run(
      "old",
      "ws-1",
      "Postgres 16 migration",
      "plan it",
      null,
      now - 400 * DAY,
      now - 400 * DAY,
    );
    for (let index = 0; index < 30; index += 1) {
      const at = now - index * 1000;
      task.run(`recent-${index}`, "ws-1", `Migration step ${index}`, "", null, at, at);
    }
    task.run("other", "ws-2", "Postgres migration", "", null, now, now);
    task.run(
      "result",
      "ws-1",
      "Upgrade",
      "db",
      "Postgres migrated",
      now - 500 * DAY,
      now - 500 * DAY,
    );

    const activity = db.prepare(
      "INSERT INTO activity_feed (id, workspace_id, actor_type, activity_type, title, description, created_at) VALUES (?, ?, 'system', 'info', ?, ?, ?)",
    );
    activity.run("a-old", "ws-1", "Postgres migration done", "", now - 300 * DAY);
    activity.run("a-new", "ws-1", "Deploy finished", "migration notes", now);
    activity.run("a-other", "ws-2", "Postgres migration done", "", now);
  });

  afterEach(() => db.close());

  it("finds old tasks first when they match more terms", () => {
    const store = new TaskStore(db);
    const tasks = store.searchByTerms({
      workspaceId: "ws-1",
      terms: ["postgres", "migration"],
      minMatched: 1,
      limit: 5,
    });
    expect(tasks[0]?.id).toBe("old");
    expect(tasks.map((entry) => entry.id)).not.toContain("other");
    expect(tasks).toHaveLength(5);

    const full = store.searchByTerms({
      workspaceId: "ws-1",
      terms: ["postgres", "migration"],
      minMatched: 2,
    });
    expect(full.map((entry) => entry.id)).toEqual(["old"]);
    // The result summary counts too.
    expect(
      store.searchByTerms({ workspaceId: "ws-1", terms: ["migrated"], minMatched: 1 })[0]?.id,
    ).toBe("result");
    expect(store.searchByTerms({ workspaceId: "", terms: ["postgres"] })).toEqual([]);
    expect(store.searchByTerms({ workspaceId: "ws-1", terms: [] })).toEqual([]);
  });

  it("searches the whole activity feed of the workspace, pending rows included", () => {
    const pending = {
      id: "a-pending",
      workspaceId: "ws-1",
      actorType: "system",
      activityType: "info",
      title: "Postgres migration rolled back",
      isRead: false,
      isPinned: false,
      createdAt: now + 1,
    } as never;
    const store = new ActivityStore(db, [pending]);
    const rows = store.search({
      workspaceId: "ws-1",
      terms: ["postgres", "migration"],
      minMatched: 2,
    });
    expect(rows.map((row) => row.id)).toEqual(["a-pending", "a-old"]);
    expect(
      store.search({ workspaceId: "ws-1", terms: ["postgres", "migration"] }).map((row) => row.id),
    ).toEqual(["a-pending", "a-old", "a-new"]);
  });
});
