import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvalService } from "../EvalService";
import { TaskEventRepository, TaskRepository } from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { WorkSessionProtocolRepository } from "../../database/WorkSessionProtocolRepository";
import { WorkSessionProtocolService } from "../../sessions/WorkSessionProtocolService";

const nativeSqliteAvailable = (() => {
  try {
    const probe = new Database(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("EvalService isolated replay", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-eval-replay-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-1", "Workspace", path.join(tempDir, "workspace"), Date.now(), "{}");
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("grades the isolated canonical replay instead of result_summary", () => {
    const task = new TaskRepository(db).create({
      title: "Replay case",
      prompt: "Produce the replay output",
      status: "executing",
      workspaceId: "workspace-1",
      source: "test",
    });
    const protocol = new WorkSessionProtocolService(db);
    protocol.recordTaskEvent(task.id, {
      id: "replay-assistant",
      eventId: "replay-assistant",
      taskId: task.id,
      timestamp: 1_000,
      type: "assistant_message",
      schemaVersion: 2,
      payload: { message: "replay says 42" },
    });
    protocol.recordTaskEvent(task.id, {
      id: "replay-complete",
      eventId: "replay-complete",
      taskId: task.id,
      timestamp: 1_001,
      type: "task_completed",
      schemaVersion: 2,
      payload: { resultSummary: "replay says 42" },
    });
    new TaskRepository(db).update(task.id, {
      status: "completed",
      terminalStatus: "ok",
      resultSummary: "stale snapshot text",
    });

    const evalService = new EvalService(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO eval_cases
       (id, name, workspace_id, source_task_id, prompt, sanitized_prompt, assertions, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "case-replay",
      "Replay case",
      "workspace-1",
      task.id,
      task.prompt,
      task.prompt,
      JSON.stringify({ expectedTerminalStatus: "ok", mustContainAll: ["replay says 42"] }),
      "{}",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO eval_suites (id, name, description, case_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("suite-replay", "Replay suite", "", JSON.stringify(["case-replay"]), now, now);

    const run = evalService.runSuite("suite-replay");
    expect(run.status).toBe("completed");
    expect(run.passCount).toBe(1);
    expect(run.caseRuns[0]?.details).toContain("isolated replay passed");
    expect(run.caseRuns[0]?.details).not.toContain("stale snapshot text");
  });

  it("falls back to complete legacy evidence while canonical backfill is partial", () => {
    const task = new TaskRepository(db).create({
      title: "Partial backfill case",
      prompt: "Use the complete event evidence",
      status: "executing",
      workspaceId: "workspace-1",
      source: "test",
    });
    // Create only the canonical session/root item, then add legacy events as
    // if the process were interrupted before the backfill completed.
    const protocolRepository = new WorkSessionProtocolRepository(db);
    protocolRepository.ensureSessionForTask({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: task.id,
      status: "executing",
    });
    const events = new TaskEventRepository(db);
    events.create({
      id: "partial-assistant",
      eventId: "partial-assistant",
      taskId: task.id,
      timestamp: 2_000,
      type: "assistant_message",
      schemaVersion: 2,
      payload: { message: "complete evidence" },
    });
    events.create({
      id: "partial-complete",
      eventId: "partial-complete",
      taskId: task.id,
      timestamp: 2_001,
      type: "task_completed",
      schemaVersion: 2,
      payload: { resultSummary: "complete evidence" },
    });
    new TaskRepository(db).update(task.id, {
      status: "completed",
      terminalStatus: "ok",
      resultSummary: "stale snapshot",
    });

    const now = Date.now();
    db.prepare(
      `INSERT INTO eval_cases
       (id, name, workspace_id, source_task_id, prompt, sanitized_prompt, assertions, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "case-partial-backfill",
      "Partial backfill case",
      "workspace-1",
      task.id,
      task.prompt,
      task.prompt,
      JSON.stringify({ expectedTerminalStatus: "ok", mustContainAll: ["complete evidence"] }),
      "{}",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO eval_suites (id, name, description, case_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "suite-partial-backfill",
      "Partial backfill suite",
      "",
      JSON.stringify(["case-partial-backfill"]),
      now,
      now,
    );

    const run = new EvalService(db).runSuite("suite-partial-backfill");
    expect(run.status).toBe("completed");
    expect(run.passCount).toBe(1);
    expect(run.caseRuns[0]?.details).toContain("2 items");
  });

  it("does not grade a synthetic canonical root as replay evidence", () => {
    const task = new TaskRepository(db).create({
      title: "Empty replay case",
      prompt: "Must have durable evidence",
      status: "pending",
      workspaceId: "workspace-1",
      source: "test",
    });
    new WorkSessionProtocolRepository(db).ensureSessionForTask({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: task.id,
      status: "pending",
    });
    const now = Date.now();
    db.prepare(
      `INSERT INTO eval_cases
       (id, name, workspace_id, source_task_id, prompt, sanitized_prompt, assertions, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "case-empty-replay",
      "Empty replay case",
      "workspace-1",
      task.id,
      task.prompt,
      task.prompt,
      JSON.stringify({ expectedTerminalStatus: "ok" }),
      "{}",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO eval_suites (id, name, description, case_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "suite-empty-replay",
      "Empty replay suite",
      "",
      JSON.stringify(["case-empty-replay"]),
      now,
      now,
    );

    const run = new EvalService(db).runSuite("suite-empty-replay");
    expect(run.status).toBe("failed");
    expect(run.failCount).toBe(1);
    expect(run.caseRuns[0]?.details).toContain("missing_replay_items");
  });
});
