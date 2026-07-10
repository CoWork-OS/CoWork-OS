import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task, TaskEvent, Workspace } from "../../../shared/types";
import { SessionRetentionService } from "../SessionRetentionService";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("SessionRetentionService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;
  let taskRepo: import("../../database/repositories").TaskRepository;
  let eventRepo: import("../../database/repositories").TaskEventRepository;
  let metadataRepo: import("../../database/repositories").TaskSessionMetadataRepository;
  let workspaceRepo: import("../../database/repositories").WorkspaceRepository;
  let service: import("../SessionRetentionService").SessionRetentionService;
  let workspaceId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-session-retention-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [{ DatabaseManager }, repositories, sessionRetention] = await Promise.all([
      import("../../database/schema"),
      import("../../database/repositories"),
      import("../SessionRetentionService"),
    ]);

    manager = new DatabaseManager();
    db = manager.getDatabase();
    taskRepo = new repositories.TaskRepository(db);
    eventRepo = new repositories.TaskEventRepository(db);
    metadataRepo = new repositories.TaskSessionMetadataRepository(db);
    workspaceRepo = new repositories.WorkspaceRepository(db);
    service = new sessionRetention.SessionRetentionService(
      taskRepo,
      eventRepo,
      metadataRepo,
      workspaceRepo,
    );
    workspaceId = insertWorkspace();
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("archives a session without deleting task data and hides it from sidebar queries", () => {
    const task = createTask("completed", "Archived task");

    const result = service.archiveSession(task.id);

    expect(result.taskCount).toBe(1);
    expect(taskRepo.findById(task.id)).toBeDefined();
    expect(
      taskRepo.findSidebarSummaries(10, 0, { includeArchivedSessions: false }),
    ).toEqual([]);
    expect(
      taskRepo.findSidebarSummaries(10, 0, { includeArchivedSessions: true }).map((row) => row.id),
    ).toEqual([task.id]);
  });

  it("prunes only terminal unpinned sessions matching the retention window", async () => {
    const oldCompleted = createTask("completed", "Old completed");
    const oldActive = createTask("executing", "Old active");
    const oldPinned = createTask("completed", "Old pinned");
    taskRepo.togglePin(oldPinned.id);
    const oldUpdatedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE tasks SET updated_at = ?").run(oldUpdatedAt);

    const result = await service.pruneSessions({ olderThanMs: 30 * 24 * 60 * 60 * 1000 });

    expect(result.deletedTaskIds).toEqual([oldCompleted.id]);
    expect(taskRepo.findById(oldCompleted.id)).toBeUndefined();
    expect(taskRepo.findById(oldActive.id)).toBeDefined();
    expect(taskRepo.findById(oldPinned.id)).toBeDefined();
  });

  it("supports provider and token filters in dry-run previews", async () => {
    const openaiTask = createTask("completed", "OpenAI task");
    const otherTask = createTask("completed", "Other task");
    seedLlmUsage(openaiTask.id, "openai", "gpt-5", 100, 25, 0.01);
    seedLlmUsage(otherTask.id, "anthropic", "claude", 10, 5, 0.02);

    const result = await service.pruneSessions(
      { all: true, provider: "openai", minTokens: 100 },
      { dryRun: true },
    );

    expect(result.sessions.map((session) => session.id)).toEqual([openaiTask.id]);
    expect(taskRepo.findById(openaiTask.id)).toBeDefined();
    expect(taskRepo.findById(otherTask.id)).toBeDefined();
  });

  function insertWorkspace(): string {
    const workspace = workspaceRepo.create("Workspace", path.join(tmpDir, "workspace"), {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: true,
    });
    return workspace.id;
  }

  function createTask(status: "completed" | "executing", title: string) {
    return taskRepo.create({
      title,
      prompt: title,
      status,
      workspaceId,
      ...(status === "completed" ? { completedAt: Date.now() } : {}),
    });
  }

  function seedLlmUsage(
    taskId: string,
    providerType: string,
    modelKey: string,
    inputTokens: number,
    outputTokens: number,
    cost: number,
  ): void {
    eventRepo.create({
      taskId,
      timestamp: Date.now(),
      type: "llm_usage",
      legacyType: "llm_usage",
      schemaVersion: 2,
      payload: {
        providerType,
        modelKey,
        usage: { inputTokens, outputTokens },
        cost,
      },
      id: randomUUID(),
    });
  }
});

describe("SessionRetentionService unit", () => {
  it("deletes only terminal unpinned sessions in the selected window", async () => {
    const now = Date.now();
    const tasks: Task[] = [
      makeTask({ id: "delete-me", status: "completed", updatedAt: now - 40 * 24 * 60 * 60 * 1000 }),
      makeTask({ id: "active", status: "executing", updatedAt: now - 40 * 24 * 60 * 60 * 1000 }),
      makeTask({ id: "pinned", status: "completed", pinned: true, updatedAt: now - 40 * 24 * 60 * 60 * 1000 }),
    ];
    const service = makeService(tasks);

    const result = await service.pruneSessions({ olderThanMs: 30 * 24 * 60 * 60 * 1000 });

    expect(result.deletedTaskIds).toEqual(["delete-me"]);
    expect(tasks.map((task) => task.id).sort()).toEqual(["active", "pinned"]);
  });

  it("uses usage filters for dry-run previews", async () => {
    const tasks: Task[] = [
      makeTask({ id: "openai-task", status: "completed" }),
      makeTask({ id: "other-task", status: "completed" }),
    ];
    const events: TaskEvent[] = [
      makeEvent("openai-task", {
        providerType: "openai",
        modelKey: "gpt-5",
        usage: { inputTokens: 120, outputTokens: 30 },
        cost: 0.01,
      }),
      makeEvent("other-task", {
        providerType: "anthropic",
        modelKey: "claude",
        usage: { inputTokens: 10, outputTokens: 20 },
        cost: 0.02,
      }),
    ];
    const service = makeService(tasks, events);

    const result = await service.pruneSessions(
      { all: true, provider: "openai", minTokens: 100 },
      { dryRun: true },
    );

    expect(result.sessions.map((session) => session.id)).toEqual(["openai-task"]);
    expect(tasks.map((task) => task.id).sort()).toEqual(["openai-task", "other-task"]);
  });
});

function makeService(tasks: Task[], events: TaskEvent[] = []): SessionRetentionService {
  const taskRepo = {
    findAll: () => [...tasks],
    findBySessionId: (sessionId: string) =>
      tasks.filter((task) => task.sessionId === sessionId),
    findById: (id: string) => tasks.find((task) => task.id === id),
    delete: (id: string) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index >= 0) tasks.splice(index, 1);
    },
  };
  const eventRepo = {
    findByTaskIds: (taskIds: string[], types?: string[]) =>
      events.filter((event) => {
        const effectiveType = event.legacyType || event.type;
        return taskIds.includes(event.taskId) && (!types?.length || types.includes(effectiveType));
      }),
  };
  const metadata = new Map<string, { sessionId: string; archivedAt?: number; createdAt: number; updatedAt: number }>();
  const metadataRepo = {
    findBySessionIds: (sessionIds: string[]) =>
      new Map(sessionIds.flatMap((id) => {
        const value = metadata.get(id);
        return value ? [[id, value] as const] : [];
      })),
    findBySessionId: (sessionId: string) => metadata.get(sessionId),
    archive: (sessionId: string) => {
      const value = { sessionId, archivedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
      metadata.set(sessionId, value);
      return value;
    },
    rename: (sessionId: string, name: string) => {
      const value = { sessionId, name, createdAt: Date.now(), updatedAt: Date.now() };
      metadata.set(sessionId, value);
      return value;
    },
    delete: (sessionId: string) => {
      metadata.delete(sessionId);
    },
  };
  const workspaceRepo = {
    findAll: (): Workspace[] => [],
  };
  return new SessionRetentionService(
    taskRepo as never,
    eventRepo as never,
    metadataRepo as never,
    workspaceRepo as never,
  );
}

function makeTask(overrides: Partial<Task>): Task {
  const now = Date.now();
  return {
    id: overrides.id || randomUUID(),
    title: overrides.title || overrides.id || "Task",
    prompt: overrides.prompt || "Task",
    status: overrides.status || "completed",
    workspaceId: overrides.workspaceId || "workspace-1",
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    completedAt: overrides.completedAt,
    pinned: overrides.pinned,
    sessionId: overrides.sessionId,
  };
}

function makeEvent(taskId: string, payload: Record<string, unknown>): TaskEvent {
  return {
    id: randomUUID(),
    taskId,
    timestamp: Date.now(),
    type: "llm_usage",
    legacyType: "llm_usage",
    schemaVersion: 2,
    payload,
  };
}
