import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../schema";
import { TaskRepository } from "../repositories";
import {
  StaleWorkSessionTurnError,
  WorkSessionProtocolRepository,
} from "../WorkSessionProtocolRepository";

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

describeWithSqlite("WorkSessionProtocolRepository", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let repository: WorkSessionProtocolRepository;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-work-session-protocol-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    taskRepo = new TaskRepository(db);
    repository = new WorkSessionProtocolRepository(db);
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

  function createTask() {
    return taskRepo.create({
      title: "Protocol task",
      prompt: "Exercise the canonical protocol",
      status: "pending",
      workspaceId: "workspace-1",
      source: "manual",
    });
  }

  it("creates the session, root turn, and first item atomically and idempotently", () => {
    const task = createTask();
    const first = repository.createAggregate({
      id: "session-1",
      taskId: task.id,
      workspaceId: task.workspaceId,
      source: "test",
    });
    const second = repository.createAggregate({
      id: "session-1",
      taskId: task.id,
      workspaceId: task.workspaceId,
      source: "test-retry",
    });

    expect(first.session.id).toBe("session-1");
    expect(first.turns).toHaveLength(1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0].payload).toMatchObject({ event: "session.created" });
    expect(second.checksum).toBe(first.checksum);
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_sessions").get()).toMatchObject({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_session_turns").get()).toMatchObject({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_session_items").get()).toMatchObject({
      count: 1,
    });
  });

  it("serializes appends with contiguous sequences and idempotency", async () => {
    const task = createTask();
    const aggregate = repository.ensureForTask({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: "session-2",
    });
    const turn = aggregate.turns[0];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Promise.resolve(
          repository.appendItem({
            sessionId: aggregate.session.id,
            turnId: turn.id,
            kind: "legacy_event",
            actor: "agent",
            payload: { index },
            idempotencyKey: `item-${index}`,
          }),
        ),
      ),
    );
    const sequences = results.map((item) => item.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
    expect(repository.listItems(aggregate.session.id).map((item) => item.sequence)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
    expect(
      repository.appendItem({
        sessionId: aggregate.session.id,
        turnId: turn.id,
        kind: "legacy_event",
        payload: { index: 3, changed: true },
        idempotencyKey: "item-3",
      }),
    ).toEqual(results[3]);
  });

  it("guards stale steering and creates a fresh turn after completion", () => {
    const task = createTask();
    const aggregate = repository.ensureForTask({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: "session-3",
    });
    const firstTurn = aggregate.turns[0];
    const firstMessage = repository.appendUserMessage({
      sessionId: aggregate.session.id,
      taskId: task.id,
      message: "First prompt",
      idempotencyKey: "message-1",
    });
    expect(firstMessage.turn.id).toBe(firstTurn.id);
    repository.completeTurn({
      sessionId: aggregate.session.id,
      turnId: firstTurn.id,
      status: "completed",
      reason: "done",
    });

    const secondMessage = repository.appendUserMessage({
      sessionId: aggregate.session.id,
      taskId: task.id,
      message: "Second prompt",
      idempotencyKey: "message-2",
    });
    expect(secondMessage.turn.id).not.toBe(firstTurn.id);
    expect(secondMessage.turn.ordinal).toBe(2);
    expect(() => repository.assertExpectedTurn(aggregate.session.id, firstTurn.id)).toThrow(
      StaleWorkSessionTurnError,
    );
  });

  it("redacts sensitive payload keys and returns a stable replay checksum", () => {
    const task = createTask();
    const aggregate = repository.ensureForTask({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: "session-4",
    });
    const turn = aggregate.turns[0];
    repository.appendItem({
      sessionId: aggregate.session.id,
      turnId: turn.id,
      kind: "tool_result",
      payload: {
        result: "ok",
        apiKey: "do-not-store",
        nested: { authorization: "Bearer hidden" },
        message: "Generated with sk-live-secret-123456",
      },
      policySnapshot: { token: "also-hidden", mode: "default" },
    });
    const replay = repository.replay(aggregate.session.id)!;
    const item = repository.listItems(aggregate.session.id).at(-1)!;
    expect(item.payload).toMatchObject({
      apiKey: "[redacted]",
      nested: { authorization: "[redacted]" },
      message: "[redacted]",
    });
    expect(item.policySnapshot).toMatchObject({ token: "[redacted]", mode: "default" });
    expect(item.redactionClass).toBe("secret_redacted");
    expect(replay.checksum).toBe(repository.replay(aggregate.session.id)?.checksum);
  });

  it("rejects reusing a session across tasks or workspaces", () => {
    const firstTask = createTask();
    repository.ensureSessionForTask({
      taskId: firstTask.id,
      workspaceId: firstTask.workspaceId,
      sessionId: "session-isolated",
    });
    const secondTask = taskRepo.create({
      title: "Second protocol task",
      prompt: "Must not borrow another session",
      status: "pending",
      workspaceId: "workspace-1",
      source: "manual",
    });
    expect(() =>
      repository.ensureSessionForTask({
        taskId: secondTask.id,
        workspaceId: secondTask.workspaceId,
        sessionId: "session-isolated",
      }),
    ).toThrowError(/already bound to another task/i);

    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-2", "Other Workspace", path.join(tempDir, "workspace-2"), Date.now(), "{}");
    const crossWorkspaceTask = taskRepo.create({
      title: "Cross workspace task",
      prompt: "Must not borrow another workspace",
      status: "pending",
      workspaceId: "workspace-2",
      source: "manual",
    });
    expect(() =>
      repository.ensureSessionForTask({
        taskId: crossWorkspaceTask.id,
        workspaceId: crossWorkspaceTask.workspaceId,
        sessionId: "session-isolated",
      }),
    ).toThrowError(/another workspace/i);
  });
});
