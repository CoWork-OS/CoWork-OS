import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalRepository,
  ArtifactRepository,
  InputRequestRepository,
  TaskEventRepository,
  TaskRepository,
} from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { SessionProgressService } from "../SessionProgressService";

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

describeWithSqlite("SessionProgressService", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let eventRepo: TaskEventRepository;
  let service: SessionProgressService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-session-progress-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    taskRepo = new TaskRepository(db);
    eventRepo = new TaskEventRepository(db);
    service = new SessionProgressService(db);
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

  function createTask(title: string, workspaceId = "workspace-1") {
    return taskRepo.create({
      title,
      prompt: `${title} prompt`,
      status: "executing",
      workspaceId,
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

  it("persists plan progress, waiting state, and the latest artifact", () => {
    const task = createTask("Prepare launch brief");
    addEvent(task.id, "event-1", "plan_created", {
      plan: {
        steps: [
          { id: "research", description: "Research the launch", status: "pending" },
          { id: "brief", description: "Write the brief", status: "pending" },
        ],
      },
    });
    addEvent(task.id, "event-2", "step_started", {
      step: { id: "research", description: "Research the launch" },
    });

    const artifactRepo = new ArtifactRepository(db);
    artifactRepo.create({
      taskId: task.id,
      path: path.join(tempDir, "launch-brief.md"),
      mimeType: "text/markdown",
      sha256: "a".repeat(64),
      size: 120,
      createdAt: Date.now(),
    });
    const approval = new ApprovalRepository(db).create({
      taskId: task.id,
      type: "network_access",
      description: "Allow the research request",
      details: { host: "example.test" },
      status: "pending",
      requestedAt: Date.now(),
    });

    const state = service.rebuild(task.id)!;
    expect(state).toMatchObject({
      taskId: task.id,
      phase: "waiting",
      headline: "Allow the research request",
      currentStep: { id: "research", status: "in_progress" },
      completedSteps: 0,
      totalSteps: 2,
      waiting: { kind: "approval", requestId: approval.id },
      latestArtifact: { path: path.join(tempDir, "launch-brief.md") },
      pendingApprovals: [{ id: approval.id, type: "network_access" }],
    });

    const restored = new SessionProgressService(db).get(task.id)!;
    expect(restored).toEqual(state);
  });

  it("restores pending structured input and searches only the requested workspace", () => {
    const task = createTask("Quarterly planning");
    new InputRequestRepository(db).create({
      taskId: task.id,
      questions: [
        {
          header: "Priority",
          id: "priority",
          question: "Which priority should lead?",
          options: [{ label: "Revenue", description: "Focus on revenue." }],
        },
      ],
      requestedAt: Date.now(),
    });

    const state = service.get(task.id)!;
    expect(state.waiting).toMatchObject({ kind: "input", reason: "Which priority should lead?" });
    expect(state.pendingInputRequests).toHaveLength(1);

    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-2", "Other", path.join(tempDir, "other"), Date.now(), "{}");
    createTask("Quarterly planning for another team", "workspace-2");

    const results = service.search("Quarterly planning", { workspaceId: "workspace-1" });
    expect(results).toHaveLength(1);
    expect(results[0].task.id).toBe(task.id);
    expect(results[0].progress.pendingInputRequests[0]?.id).toBe(state.pendingInputRequests[0]?.id);
  });

  it("marks interrupted sessions stale and exposes a safe resume checkpoint", () => {
    const task = createTask("Recover interrupted work");
    addEvent(task.id, "event-3", "conversation_snapshot", { summary: "checkpoint" });
    taskRepo.update(task.id, { status: "interrupted" });

    const state = service.rebuild(task.id)!;
    expect(state.phase).toBe("stale");
    expect(state.connectionState).toBe("stale");
    expect(state.waiting).toMatchObject({ kind: "reconnect" });
    expect(state.resumeFromEventId).toBe("event-3");
  });
});
