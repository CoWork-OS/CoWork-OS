import { afterEach, beforeEach, describe, expect, it } from "vitest";

const sqlite = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return module.default;
    } catch {
      return undefined;
    }
  })
  .catch(() => undefined);

const describeWithSqlite = sqlite ? describe : describe.skip;

describeWithSqlite("OrchestrationGraphRepository.isTeamWorkItemTask", () => {
  let db: import("better-sqlite3").Database;
  let repo: import("../OrchestrationGraphRepository").OrchestrationGraphStore;

  const insertNode = (id: string, kind: string, taskId: string, teamItemId: string | null) =>
    db
      .prepare(
        "INSERT INTO orchestration_graph_nodes (id, kind, task_id, team_item_id) VALUES (?, ?, ?, ?)",
      )
      .run(id, kind, taskId, teamItemId);

  beforeEach(async () => {
    const { OrchestrationGraphStore } = await import("../OrchestrationGraphRepository");
    db = new sqlite!(":memory:");
    db.exec(
      "CREATE TABLE orchestration_graph_nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, task_id TEXT, team_item_id TEXT)",
    );
    repo = new OrchestrationGraphStore(db);
  });

  afterEach(() => db.close());

  it("recognizes tasks dispatched from team work item nodes", () => {
    insertNode("n1", "team_work_item", "team-lane-task", "item-1");
    expect(repo.isTeamWorkItemTask("team-lane-task")).toBe(true);
  });

  it("does not treat delegated or unlinked child tasks as team lanes", () => {
    insertNode("n1", "child_task", "delegated-task", null);
    insertNode("n2", "team_work_item", "undispatched-lane", null);
    expect(repo.isTeamWorkItemTask("delegated-task")).toBe(false);
    expect(repo.isTeamWorkItemTask("undispatched-lane")).toBe(false);
    expect(repo.isTeamWorkItemTask("unknown-task")).toBe(false);
  });
});
