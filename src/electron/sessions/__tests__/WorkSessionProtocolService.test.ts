import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskEventRepository, TaskRepository } from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { StaleWorkSessionTurnError } from "../../database/WorkSessionProtocolRepository";
import { WorkSessionProtocolService, mapTaskEventKind } from "../WorkSessionProtocolService";

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

describeWithSqlite("WorkSessionProtocolService", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let eventRepo: TaskEventRepository;
  let service: WorkSessionProtocolService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-work-session-service-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    taskRepo = new TaskRepository(db);
    eventRepo = new TaskEventRepository(db);
    service = new WorkSessionProtocolService(db);
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
      title: "Dual-write task",
      prompt: "Record legacy events in the canonical stream",
      status: "executing",
      workspaceId: "workspace-1",
      source: "manual",
    });
  }

  function addEvent(taskId: string, id: string, type: string, payload: Record<string, unknown>) {
    return eventRepo.create({
      id,
      taskId,
      timestamp: Date.now(),
      type: type as never,
      payload,
      schemaVersion: 2,
      eventId: id,
      seq: Number(id.replace(/\D/g, "")) || undefined,
    });
  }

  it("maps legacy events into immutable item kinds", () => {
    expect(mapTaskEventKind("assistant_message")).toBe("message");
    expect(mapTaskEventKind("tool_call")).toBe("tool_call");
    expect(mapTaskEventKind("approval_requested")).toBe("approval");
    expect(mapTaskEventKind("context_compaction_completed")).toBe("compaction");
    expect(mapTaskEventKind("timeline_evidence_attached")).toBe("evidence");
    expect(mapTaskEventKind("unknown_legacy_event")).toBe("legacy_event");
  });

  it("backfills legacy task events when a protocol session is first requested", () => {
    const task = createTask();
    addEvent(task.id, "legacy-1", "user_message", { message: "Existing prompt" });
    addEvent(task.id, "legacy-2", "tool_result", { result: "Existing result" });

    const aggregate = service.getSessionForTask(task.id)!;
    expect(aggregate.items.map((item) => item.sourceEventId)).toEqual(
      expect.arrayContaining(["legacy-1", "legacy-2"]),
    );
    expect(service.replay(aggregate.session.id)?.itemCount).toBeGreaterThanOrEqual(3);
  });

  it("dual-writes user, tool, and terminal events with a replayable projection", () => {
    const task = createTask();
    const session = service.ensureForTask(task);
    const user = addEvent(task.id, "event-1", "user_message", { message: "Start the work" });
    const tool = addEvent(task.id, "event-2", "tool_call", { tool: "shell", command: "pwd" });
    const completed = addEvent(task.id, "event-3", "task_completed", {
      resultSummary: "Completed",
    });

    const userResult = service.recordTaskEvent(task.id, user)!;
    const toolResult = service.recordTaskEvent(task.id, tool)!;
    const completedResult = service.recordTaskEvent(task.id, completed)!;
    // A retry of the same event is an idempotent no-op.
    const duplicate = service.recordTaskEvent(task.id, completed)!;

    expect(userResult.item?.kind).toBe("message");
    expect(toolResult.item?.kind).toBe("tool_call");
    expect(completedResult.turn.status).toBe("completed");
    expect(duplicate.item?.id).toBe(completedResult.item?.id);
    const replay = service.replay(session.session.id)!;
    expect(replay.status).toBe("completed");
    expect(replay.itemCount).toBeGreaterThanOrEqual(4);
    expect(replay.checksum).toBe(service.replay(session.session.id)?.checksum);

    // A late non-user event must not resurrect a terminal session.
    const late = addEvent(task.id, "event-4", "assistant_message", { message: "late" });
    service.recordTaskEvent(task.id, late);
    expect(service.replay(session.session.id)?.status).toBe("completed");
    expect(service.getReliabilityService().leases.listActive(session.session.id)).toHaveLength(0);
  });

  it("rejects a stale expected turn before accepting a steering message", () => {
    const task = createTask();
    const session = service.ensureForTask(task);
    const firstTurn = session.turns[0];
    service.beginUserMessage(task.id, "First", { idempotencyKey: "message-1" });
    service.getRepository().completeTurn({
      sessionId: session.session.id,
      turnId: firstTurn.id,
      status: "completed",
    });

    service.beginUserMessage(task.id, "Second", { idempotencyKey: "message-2" });
    expect(() =>
      service.beginUserMessage(task.id, "Stale", { expectedTurnId: firstTurn.id }),
    ).toThrow(StaleWorkSessionTurnError);
  });

  it("persists pipeline failure events as terminal failures", () => {
    const task = createTask();
    const event = addEvent(task.id, "pipeline-failed", "pipeline_failed", {
      reason: "A workflow phase failed",
    });
    const result = service.recordTaskEvent(task.id, event)!;
    expect(result.turn.status).toBe("failed");
    expect(service.replay(result.session.id)?.status).toBe("failed");
  });

  it("switches TaskEvent reads by cohort and falls back immediately on rollback", () => {
    const task = createTask();
    const event = addEvent(task.id, "canary-1", "assistant_message", {
      message: "canonical read",
    });
    service.recordTaskEvent(task.id, event);
    service
      .getReliabilityService()
      .rollout.updateConfig({ enabled: true, cohortPercent: 100, salt: "canary-test" });

    const legacyRead = () => eventRepo.findByTaskId(task.id);
    const canaryEvents = service.readTaskEvents(task.id, undefined, legacyRead);
    expect(canaryEvents.some((candidate) => candidate.eventId === "canary-1")).toBe(true);
    expect(canaryEvents.every((candidate) => candidate.schemaVersion === 2)).toBe(true);

    service.getReliabilityService().rollout.setLegacyReadRollback(true);
    expect(service.readTaskEvents(task.id, undefined, legacyRead)).toEqual(legacyRead());
  });
});
