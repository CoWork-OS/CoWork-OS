import { buildSync } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TaskAdmissionService,
  TaskAdmissionConflictError,
} from "../../control-plane/task-admission-service";
import { TaskQueueManager } from "../../agent/queue-manager";
import { DatabaseClient } from "../async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../async/commands";
import { TaskAdmissionRepository } from "../repository-facades";
import { TaskStore, WorkspaceStore } from "../repositories";
import { DatabaseManager } from "../schema";
import { setStatementClient } from "../statements/statement-route";

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => false,
  },
}));

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-task-admission-${process.pid}.js`);
  buildSync({
    entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: workerPath,
    external: ["better-sqlite3", "electron"],
    logLevel: "silent",
  });
});

afterAll(() => {
  fs.rmSync(workerPath, { force: true });
});

describe("durable task admission", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let workspaceId: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-task-admission-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
    const workspacePath = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspacePath);
    workspaceId = new WorkspaceStore(manager.getDatabase()).create("Admission", workspacePath, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    }).id;
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function taskInput(prompt = "summarize the workspace") {
    return {
      title: "Workspace summary",
      prompt,
      workspaceId,
      source: "api" as const,
      agentConfig: { model: "test-model", personality: "careful" },
      resumeStrategy: "snapshot" as const,
    };
  }

  it("creates one queued task and replays the same receipt; a changed payload conflicts", async () => {
    const service = new TaskAdmissionService(manager.getDatabase());
    const input = taskInput();
    const [created, replay] = await Promise.all([
      service.admit("browser-op-1", input),
      service.admit("browser-op-1", {
        agentConfig: { personality: "careful", model: "test-model" },
        workspaceId,
        prompt: "summarize the workspace",
        title: "Workspace summary",
        source: "api",
        resumeStrategy: "snapshot",
      }),
    ]);

    expect(created.task.id).toBe(replay.task.id);
    expect(created.task.status).toBe("queued");
    expect(created.task.sessionId).toBe(created.task.id);
    expect(created.task.resumeStrategy).toBe("snapshot");
    expect([created.replayed, replay.replayed].sort()).toEqual([false, true]);
    expect(manager.getDatabase().prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({
      count: 1,
    });
    expect(
      manager.getDatabase().prepare("SELECT COUNT(*) AS count FROM task_admission_receipts").get(),
    ).toEqual({ count: 1 });

    await expect(
      service.admit("browser-op-1", taskInput("different prompt")),
    ).rejects.toBeInstanceOf(TaskAdmissionConflictError);
    expect(manager.getDatabase().prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({
      count: 1,
    });
    await expect(service.getByOperationKey("browser-op-1")).resolves.toMatchObject({
      found: true,
      taskId: created.task.id,
      task: { id: created.task.id, status: "queued" },
    });
  });

  it("replays across changed prepared context when the validated request identity is unchanged", async () => {
    const service = new TaskAdmissionService(manager.getDatabase());
    const requestIdentity = {
      title: "Workspace summary",
      prompt: "summarize the workspace",
      workspaceId,
      agentConfig: { model: "test-model" },
    };
    const first = await service.admit(
      "browser-stable-request-1",
      taskInput("summarize the workspace\n\nPrior memory: projects A and B"),
      requestIdentity,
    );
    const replay = await service.admit(
      "browser-stable-request-1",
      taskInput("summarize the workspace\n\nPrior memory: projects C and D"),
      {
        agentConfig: { model: "test-model" },
        workspaceId,
        prompt: "summarize the workspace",
        title: "Workspace summary",
      },
    );

    expect(replay.replayed).toBe(true);
    expect(replay.task.id).toBe(first.task.id);
    expect(replay.task.prompt).toBe(first.task.prompt);
    await expect(
      service.findReplayByRequestIdentity("browser-stable-request-1", {
        ...requestIdentity,
        prompt: "different caller request",
      }),
    ).rejects.toBeInstanceOf(TaskAdmissionConflictError);
    await expect(
      service.findReplayByRequestIdentity("browser-stable-request-1", {
        agentConfig: { model: "test-model" },
        workspaceId,
        prompt: "summarize the workspace",
        title: "Workspace summary",
      }),
    ).resolves.toEqual({ task: first.task, replayed: true });
    await expect(
      service.admit("browser-stable-request-1", taskInput("another prepared prompt"), {
        ...requestIdentity,
        prompt: "different caller request",
      }),
    ).rejects.toBeInstanceOf(TaskAdmissionConflictError);
    expect(manager.getDatabase().prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({
      count: 1,
    });
  });

  it("reconciles a lost post-commit reply by reading the same operation key", async () => {
    const db = manager.getDatabase();
    const actual = new TaskAdmissionRepository(db);
    let loseFirstReply = true;
    const admit = vi.fn(async (...args: Parameters<typeof actual.admit>) => {
      const result = await actual.admit(...args);
      if (loseFirstReply) {
        loseFirstReply = false;
        throw new Error("simulated worker exit after commit");
      }
      return result;
    });
    const service = new TaskAdmissionService(db, {
      admit,
      findByOperationKey: actual.findByOperationKey,
    });

    const result = await service.admit("browser-op-after-commit", taskInput());
    expect(result.replayed).toBe(true);
    expect(result.task.status).toBe("queued");
    expect(admit).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_admission_receipts").get()).toEqual({
      count: 1,
    });
  });

  it("persists prepared session and branch lineage inside the admission transaction", async () => {
    const db = manager.getDatabase();
    const parent = new TaskStore(db).create({
      title: "Parent",
      prompt: "original task",
      status: "completed",
      workspaceId,
    });
    const service = new TaskAdmissionService(db);

    const result = await service.admit("browser-op-branch", {
      ...taskInput(),
      sessionId: "shared-session",
      resumeStrategy: "checkpoint",
      branchFromTaskId: parent.id,
      branchFromEventId: "parent-event-1",
      branchLabel: "Follow-up investigation",
      boardColumn: "todo",
    });

    expect(result.task).toMatchObject({
      sessionId: "shared-session",
      resumeStrategy: "checkpoint",
      branchFromTaskId: parent.id,
      branchFromEventId: "parent-event-1",
      branchLabel: "Follow-up investigation",
      boardColumn: "todo",
    });
  });

  it("rolls the task back when its receipt cannot be written", async () => {
    const db = manager.getDatabase();
    db.exec(`
      CREATE TRIGGER reject_admission_receipt
      BEFORE INSERT ON task_admission_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt write rejected'); END;
    `);
    const service = new TaskAdmissionService(db);

    await expect(service.admit("browser-op-rollback", taskInput())).rejects.toThrow(
      "receipt write rejected",
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_admission_receipts").get()).toEqual({
      count: 0,
    });
  });

  it("retries an unavailable admission only with the caller's original operation key", async () => {
    const db = manager.getDatabase();
    const actual = new TaskAdmissionRepository(db);
    const attemptedKeys: string[] = [];
    let failBeforeCommit = true;
    const service = new TaskAdmissionService(db, {
      admit: async (operationKey, payloadHash, input) => {
        attemptedKeys.push(operationKey);
        if (failBeforeCommit) {
          failBeforeCommit = false;
          throw new Error("simulated unavailable worker before commit");
        }
        return actual.admit(operationKey, payloadHash, input);
      },
      findByOperationKey: async () => {
        throw new Error("worker unavailable for receipt lookup");
      },
    });

    const result = await service.admit("browser-op-retry", taskInput());

    expect(result.replayed).toBe(false);
    expect(attemptedKeys).toEqual(["browser-op-retry", "browser-op-retry"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 1 });
  });

  it("uses the worker transaction and reconciles its lost reply from the same-key receipt", async () => {
    const db = manager.getDatabase();
    const client = await DatabaseClient.start({
      dbPath: manager.getDatabasePath(),
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
    });
    const execute = client.execute.bind(client);
    const executedCommands: string[] = [];
    vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
      executedCommands.push(name);
      return execute(name as Parameters<typeof execute>[0], args as never);
    }) as typeof client.execute);
    setStatementClient("storage", manager.getDatabasePath(), client);
    cleanups.push(() => client.close(2_000));

    const actual = new TaskAdmissionRepository(db);
    let loseFirstReply = true;
    const service = new TaskAdmissionService(db, {
      admit: async (...args) => {
        const result = await actual.admit(...args);
        if (loseFirstReply) {
          loseFirstReply = false;
          throw new Error("simulated worker exit after commit");
        }
        return result;
      },
      findByOperationKey: actual.findByOperationKey,
    });
    const result = await service.admit("worker-admission-1", taskInput());
    await expect(service.getByOperationKey("worker-admission-1")).resolves.toMatchObject({
      found: true,
      taskId: result.task.id,
    });

    expect(result.task.status).toBe("queued");
    expect(result.replayed).toBe(true);
    expect(executedCommands).toContain("statements.unit");
    expect(executedCommands).toContain("statements.readUnit");
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_admission_receipts").get()).toEqual({
      count: 1,
    });
  });

  it("recreates the additive receipt table when opening a pre-admission profile", () => {
    const db = manager.getDatabase();
    db.exec("DROP TABLE task_admission_receipts");
    manager.close();

    manager = new DatabaseManager();
    const exists = manager
      .getDatabase()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_admission_receipts'",
      )
      .get();
    expect(exists).toEqual({ name: "task_admission_receipts" });
  });

  it("recovers an admitted queued task through the startup queue after reopening the database", async () => {
    const admitted = await new TaskAdmissionService(manager.getDatabase()).admit(
      "browser-op-restart",
      taskInput(),
    );
    manager.close();
    manager = new DatabaseManager();
    const taskStore = new TaskStore(manager.getDatabase());
    const queuedAtStartup = taskStore.findByStatus("queued");
    const started: string[] = [];
    const queue = new TaskQueueManager({
      startTaskImmediate: async (task) => {
        started.push(task.id);
      },
      emitQueueUpdate: () => undefined,
      getTaskById: (taskId) => taskStore.findById(taskId) ?? undefined,
      updateTaskStatus: (taskId, status) => {
        taskStore.update(taskId, { status });
      },
      onTaskTimeout: async () => undefined,
    });
    cleanups.push(() => queue.destroy());

    await queue.initialize(queuedAtStartup, []);

    expect(queuedAtStartup.map((task) => task.id)).toContain(admitted.task.id);
    expect(queuedAtStartup).toContainEqual(
      expect.objectContaining({
        id: admitted.task.id,
        sessionId: admitted.task.id,
        resumeStrategy: "snapshot",
      }),
    );
    expect(started).toEqual([admitted.task.id]);
  });
});
