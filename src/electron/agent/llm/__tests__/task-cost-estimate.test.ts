import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../../database/schema", () => ({
  DatabaseManager: { getInstance: () => ({ getDatabase: () => state.db }) },
}));
vi.mock("../../../reports/UsageInsightsProjector", () => ({ UsageInsightsProjector: class {} }));

import Database from "better-sqlite3";
import { estimateTaskCost, estimateTaskDuration } from "../usage-telemetry";

function setup(rows: Array<[string, string, number]>) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE llm_call_events (
    id TEXT, timestamp INTEGER, task_id TEXT, model_key TEXT, model_id TEXT,
    cost REAL, success INTEGER DEFAULT 1
  )`);
  const insert = db.prepare(
    "INSERT INTO llm_call_events (id, timestamp, task_id, model_key, model_id, cost) VALUES (?, ?, ?, ?, ?, ?)",
  );
  rows.forEach(([taskId, modelId, cost], i) =>
    insert.run(
      `e${i}`,
      i,
      taskId,
      modelId.startsWith("claude") ? "sonnet-4-6" : modelId,
      modelId,
      cost,
    ),
  );
  state.db = db;
}

describe("estimateTaskCost", () => {
  it("summarizes per-task totals from local history", async () => {
    setup([
      ["t1", "claude-sonnet-4-6", 0.1],
      ["t1", "claude-sonnet-4-6", 0.1],
      ["t2", "claude-sonnet-4-6", 0.5],
      ["t3", "claude-sonnet-4-6", 1],
      ["t4", "gpt-6-sol", 9],
    ]);
    const estimate = await estimateTaskCost("claude-sonnet-4-6");
    expect(estimate).toMatchObject({ sampleSize: 3, medianCost: 0.5, p90Cost: 1 });
    // Matches on the CoWork model key as well as the API model id.
    expect((await estimateTaskCost("sonnet-4-6"))?.sampleSize).toBe(3);
  });

  it("returns null without enough history", async () => {
    setup([["t1", "claude-sonnet-4-6", 0.2]]);
    expect(await estimateTaskCost("claude-sonnet-4-6")).toBeNull();
  });
});

describe("estimateTaskDuration", () => {
  it("takes the wall-clock time of completed tasks that ran on the model", async () => {
    setup([
      ["t1", "claude-sonnet-4-6", 0.1],
      ["t2", "claude-sonnet-4-6", 0.5],
      ["t3", "claude-sonnet-4-6", 1],
      ["t4", "claude-sonnet-4-6", 1],
      ["t5", "gpt-6-sol", 9],
    ]);
    const db = state.db as Database.Database;
    db.exec(
      "CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, created_at INTEGER, completed_at INTEGER)",
    );
    const task = db.prepare(
      "INSERT INTO tasks (id, status, created_at, completed_at) VALUES (?, ?, ?, ?)",
    );
    task.run("t1", "completed", 0, 60_000);
    task.run("t2", "completed", 0, 120_000);
    task.run("t3", "completed", 0, 600_000);
    task.run("t4", "failed", 0, 5_000);
    task.run("t5", "completed", 0, 9_000_000);

    expect(await estimateTaskDuration("claude-sonnet-4-6")).toEqual({
      sampleSize: 3,
      medianMs: 120_000,
      p90Ms: 600_000,
    });
    expect(await estimateTaskDuration("gpt-6-sol")).toBeNull();
  });
});
