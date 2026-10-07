import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MentionStore } from "../MentionRepository";

describe("MentionStore pending mentions (SQLite)", () => {
  let db: DatabaseSync;
  let store: MentionStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE agent_mentions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        from_agent_role_id TEXT,
        to_agent_role_id TEXT NOT NULL,
        mention_type TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        completed_at INTEGER
      );
    `);
    store = new MentionStore(db as unknown as ConstructorParameters<typeof MentionStore>[0]);
  });

  afterEach(() => {
    db.close();
  });

  const mentionOn = (taskId: string, taskStatus?: string) => {
    if (taskStatus)
      db.prepare("INSERT INTO tasks (id, status) VALUES (?, ?)").run(taskId, taskStatus);
    return store.create({
      workspaceId: "ws-1",
      taskId,
      toAgentRoleId: "role-pm",
      mentionType: "request",
      context: `mention on ${taskId}`,
    });
  };

  it("keeps fresh requests on completed, failed and cancelled source tasks", () => {
    const open = mentionOn("task-open", "executing");
    const done = mentionOn("task-done", "completed");
    const failed = mentionOn("task-failed", "failed");
    const cancelled = mentionOn("task-cancelled", "cancelled");
    const review = store.create({
      workspaceId: "ws-1",
      taskId: "task-done",
      toAgentRoleId: "role-pm",
      mentionType: "review",
      context: "Review the finished work",
    });
    expect(new Set(store.getPendingForAgent("role-pm").map((m) => m.id))).toEqual(
      new Set([open.id, done.id, failed.id, cancelled.id, review.id]),
    );
    expect(store.getPendingCount("role-pm", "ws-1")).toBe(5);
    store.acknowledge(review.id);
    store.complete(done.id);
    store.dismiss(cancelled.id);
    expect(new Set(store.getPendingForAgent("role-pm").map((m) => m.id))).toEqual(
      new Set([open.id, failed.id]),
    );
    expect(store.getPendingCount("role-pm", "ws-1")).toBe(2);
  });

  it("keeps requests made mid-run pending when the source task finishes", () => {
    const mention = mentionOn("mid-run", "executing");
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run("mid-run");
    expect(store.getPendingForAgent("role-pm").map((m) => m.id)).toEqual([mention.id]);
    expect(store.getPendingCount("role-pm")).toBe(1);
  });

  it("keeps pending mentions whose task row is missing", () => {
    const orphan = mentionOn("task-missing");

    expect(store.getPendingForAgent("role-pm").map((m) => m.id)).toEqual([orphan.id]);
    expect(store.getPendingCount("role-pm", "ws-1")).toBe(1);
  });
});
