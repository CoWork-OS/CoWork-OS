import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskEventRepository, TaskRepository } from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { StaleWorkSessionTurnError } from "../../database/WorkSessionProtocolRepository";
import { WorkSessionProtocolService, mapTaskEventKind } from "../WorkSessionProtocolService";
import type { TaskEvent } from "../../../shared/types";

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

  function addEvent(
    taskId: string,
    id: string,
    type: string,
    payload: Record<string, unknown>,
    options: Pick<TaskEvent, "status" | "legacyType"> = {},
  ) {
    return eventRepo.create({
      id,
      taskId,
      timestamp: Date.now(),
      type: type as never,
      payload,
      schemaVersion: 2,
      eventId: id,
      seq: Number(id.replace(/\D/g, "")) || undefined,
      ...options,
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

  it("keeps timeline step status separate from the enclosing turn status", () => {
    const task = createTask();
    const stepFinished = addEvent(
      task.id,
      "timeline-step-finished",
      "timeline_step_finished",
      { legacyType: "step_completed", stepId: "step-1" },
      { status: "completed", legacyType: "step_completed" },
    );
    const stepResult = service.recordTaskEvent(task.id, stepFinished)!;
    expect(stepResult.turn.status).toBe("executing");

    const stepFailed = addEvent(
      task.id,
      "timeline-step-failed",
      "timeline_error",
      { legacyType: "error", stepId: "step-2", message: "step failed" },
      { status: "failed", legacyType: "error" },
    );
    const failedStepResult = service.recordTaskEvent(task.id, stepFailed)!;
    expect(failedStepResult.turn.status).toBe("executing");

    const blocked = addEvent(
      task.id,
      "task-status-blocked",
      "task_status",
      { status: "blocked", terminalStatus: "awaiting_verification" },
      { status: "blocked", legacyType: "task_status" },
    );
    expect(service.recordTaskEvent(task.id, blocked)!.turn.status).toBe("waiting");

    const completed = addEvent(task.id, "task-completed-after-steps", "task_completed", {
      resultSummary: "Completed",
    });
    expect(service.recordTaskEvent(task.id, completed)!.turn.status).toBe("completed");
  });

  it("keeps cancellation authoritative when orchestration emits a late failure", () => {
    const task = createTask();
    const session = service.ensureForTask(task);
    const cancelled = addEvent(task.id, "task-cancelled", "task_cancelled", {
      message: "Task was stopped by user",
    });
    expect(service.recordTaskEvent(task.id, cancelled)!.turn.status).toBe("cancelled");

    const lateFailure = addEvent(task.id, "orchestration-failed", "orchestration_run_failed", {
      runId: "run-1",
      status: "failed",
    });
    let lateResult: ReturnType<WorkSessionProtocolService["recordTaskEvent"]> | undefined;
    expect(() => {
      lateResult = service.recordTaskEvent(task.id, lateFailure);
    }).not.toThrow();
    expect(lateResult?.turn.status).toBe("cancelled");
    expect(service.replay(session.session.id)?.status).toBe("cancelled");
    expect(
      service.getRepository().findItemBySourceEvent(session.session.id, "orchestration-failed"),
    ).toBeDefined();
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

  it("recovers a task into the current workspace without copying the foreign transcript", () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-2", "Foreign Workspace", path.join(tempDir, "workspace-2"), Date.now(), "{}");

    const task = createTask();
    const foreign = service.getRepository().createAggregate({
      id: "foreign-session",
      taskId: task.id,
      workspaceId: "workspace-2",
      source: "old-runtime",
    });
    service.getRepository().appendUserMessage({
      sessionId: foreign.session.id,
      taskId: task.id,
      message: "This belongs to the old workspace and must stay there.",
      idempotencyKey: "foreign-message",
    });

    const recovered = service.ensureForTask(task);
    expect(recovered.session.id).not.toBe(foreign.session.id);
    expect(recovered.session.workspaceId).toBe(task.workspaceId);
    expect(task.sessionId).toBe(recovered.session.id);
    expect(taskRepo.findById(task.id)?.sessionId).toBe(recovered.session.id);
    expect(
      service
        .getRepository()
        .findById(foreign.session.id)
        ?.items.some((item) => JSON.stringify(item.payload).includes("old workspace")),
    ).toBe(true);
    expect(
      recovered.items.some((item) => JSON.stringify(item.payload).includes("old workspace")),
    ).toBe(false);

    const recovery = db
      .prepare(
        `SELECT previous_session_id, replacement_session_id, previous_workspace_id,
                workspace_id, code, details_json
         FROM work_session_recovery_records WHERE task_id = ?`,
      )
      .get(task.id) as Record<string, unknown>;
    expect(recovery).toMatchObject({
      previous_session_id: "foreign-session",
      replacement_session_id: recovered.session.id,
      previous_workspace_id: "workspace-2",
      workspace_id: "workspace-1",
      code: "SESSION_WORKSPACE_CONFLICT",
    });
    expect(String(recovery.details_json)).not.toContain("old workspace");
    expect(
      eventRepo
        .findByTaskId(task.id)
        .some(
          (event) =>
            event.type === "workspace_boundary_recovery" ||
            event.legacyType === "workspace_boundary_recovery",
        ),
    ).toBe(true);
  });
});
