import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../../agent/daemon";
import { DatabaseManager } from "../../database/schema";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { BotWorkControlStore } from "../../automation/BotWorkControlStore";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import type { ControlPlaneServer } from "../server";
import { ErrorCodes, Methods } from "../protocol";
import { registerTaskAndWorkspaceMethods } from "../handlers";
import * as taskTitles from "../../agent/task-title-generator";

type RegisteredMethod = (
  client: { hasScope(scope: string): boolean },
  params?: unknown,
) => Promise<unknown>;

describe("Electron Control Plane durable task creation", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let methods: Map<string, RegisteredMethod>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-electron-admission-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager({ dbPath: path.join(tempDir, "test.db") });
    methods = new Map();
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createWorkspace() {
    const workspacePath = path.join(tempDir, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    return new WorkspaceStore(manager.getDatabase()).create("Workspace", workspacePath, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
  }

  function register(agentDaemon: Record<string, unknown>) {
    const server = {
      registerMethod: (method: string, handler: RegisteredMethod) => methods.set(method, handler),
    } as unknown as ControlPlaneServer;
    registerTaskAndWorkspaceMethods(server, {
      agentDaemon: {
        ...agentDaemon,
        getWorkSessionReliabilityService: () => ({}),
      } as unknown as AgentDaemon,
      dbManager: { getDatabase: () => manager.getDatabase() } as never,
    });
  }

  it("uses the idempotent daemon API for keyed requests and wakes only its receipt", async () => {
    const workspace = createWorkspace();
    const task = new TaskStore(manager.getDatabase()).create({
      title: "Browser task",
      prompt: "Routed prompt",
      status: "queued",
      workspaceId: workspace.id,
      source: "api",
      sessionId: "browser-task-session",
      resumeStrategy: "checkpoint",
    });
    const createTaskIdempotent = vi.fn().mockResolvedValue({ task, replayed: false });
    const startAdmittedTask = vi.fn().mockResolvedValue(undefined);
    register({ createTaskIdempotent, startAdmittedTask });

    await expect(
      methods.get(Methods.TASK_CREATE)!(
        { hasScope: (scope) => scope === "admin" },
        {
          title: " Browser task ",
          prompt: " Review this workspace ",
          workspaceId: workspace.id,
          operationKey: " browser-create-1 ",
          assignedAgentRoleId: " role-7 ",
          shellAccess: false,
        },
      ),
    ).resolves.toMatchObject({ taskId: task.id, task, replayed: false });

    expect(createTaskIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: "browser-create-1",
        title: "Browser task",
        prompt: "Review this workspace",
        workspaceId: workspace.id,
        source: "api",
        taskOverrides: { assignedAgentRoleId: "role-7" },
        boardColumn: "todo",
        autoStart: false,
        requestIdentity: expect.objectContaining({
          title: "Browser task",
          prompt: "Review this workspace",
          assignedAgentRoleId: "role-7",
          shellAccess: false,
        }),
      }),
    );
    expect(startAdmittedTask).toHaveBeenCalledWith("browser-create-1", task.id);
  });

  it("rejects malformed explicit keys but preserves the legacy unkeyed handler path", async () => {
    const workspace = createWorkspace();
    const createTaskIdempotent = vi.fn();
    const startTask = vi.fn().mockResolvedValue(undefined);
    register({ createTaskIdempotent, startTask });
    const handler = methods.get(Methods.TASK_CREATE)!;
    const admin = { hasScope: (scope: string) => scope === "admin" };

    await expect(
      handler(admin, {
        title: "Bad key",
        prompt: "Run this",
        workspaceId: workspace.id,
        operationKey: " ",
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    expect(createTaskIdempotent).not.toHaveBeenCalled();

    const legacy = (await handler(admin, {
      title: "Legacy task",
      prompt: "Review the workspace",
      workspaceId: workspace.id,
    })) as { taskId: string; task: { status: string }; replayed?: boolean };
    expect(legacy.task.status).toBe("pending");
    expect(legacy).not.toHaveProperty("replayed");
    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ id: legacy.taskId }));
    expect(createTaskIdempotent).not.toHaveBeenCalled();
  });

  it.each([
    { title: "what is 2+2?", generateTitle: undefined, generated: true },
    { title: "My arithmetic check", generateTitle: true, generated: true },
    { title: "what is 2+2?", generateTitle: false, generated: false },
    { title: "My arithmetic check", generateTitle: undefined, generated: false },
  ])("honors title generation for unkeyed requests: $title / $generateTitle", async (input) => {
    const workspace = createWorkspace();
    const generateTitle = vi.spyOn(taskTitles, "generateAndApplyTaskTitle").mockResolvedValue();
    const startTask = vi.fn().mockResolvedValue(undefined);
    const emitTaskTitleUpdated = vi.fn();
    register({ startTask, emitTaskTitleUpdated });
    const result = (await methods.get(Methods.TASK_CREATE)!(
      { hasScope: (scope) => scope === "admin" },
      {
        title: input.title,
        prompt: "what is 2+2?",
        workspaceId: workspace.id,
        ...(input.generateTitle !== undefined ? { generateTitle: input.generateTitle } : {}),
      },
    )) as { taskId: string };
    expect(startTask).toHaveBeenCalledOnce();
    expect(generateTitle).toHaveBeenCalledTimes(input.generated ? 1 : 0);
    if (input.generated) {
      const [task, prompt, , publish] = generateTitle.mock.calls[0];
      expect(task.id).toBe(result.taskId);
      expect(prompt).toBe("what is 2+2?");
      publish(task.id, "Add two numbers");
      expect(emitTaskTitleUpdated).toHaveBeenCalledWith(task.id, "Add two numbers");
    }
  });

  it.each([false, true])(
    "generates only on the first keyed admission, replayed=%s",
    async (replayed) => {
      const workspace = createWorkspace();
      const task = new TaskStore(manager.getDatabase()).create({
        title: "Placeholder",
        prompt: "what is 2+2?",
        status: "queued",
        workspaceId: workspace.id,
      });
      const generateTitle = vi.spyOn(taskTitles, "generateAndApplyTaskTitle").mockResolvedValue();
      const createTaskIdempotent = vi.fn().mockResolvedValue({ task, replayed });
      register({ createTaskIdempotent, startAdmittedTask: vi.fn().mockResolvedValue(undefined) });
      await methods.get(Methods.TASK_CREATE)!(
        { hasScope: (scope) => scope === "admin" },
        {
          title: task.title,
          prompt: "what is 2+2?",
          workspaceId: workspace.id,
          operationKey: "title-generation-1",
          generateTitle: true,
        },
      );
      expect(generateTitle).toHaveBeenCalledTimes(replayed ? 0 : 1);
      expect(createTaskIdempotent).toHaveBeenCalledWith(
        expect.objectContaining({
          requestIdentity: expect.objectContaining({ generateTitle: true }),
        }),
      );
    },
  );

  it("rejects a malformed title generation flag before creating a task", async () => {
    const workspace = createWorkspace();
    const startTask = vi.fn();
    register({ startTask });
    await expect(
      methods.get(Methods.TASK_CREATE)!(
        { hasScope: (scope) => scope === "admin" },
        {
          title: "Placeholder",
          prompt: "what is 2+2?",
          workspaceId: workspace.id,
          generateTitle: "true",
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    expect(startTask).not.toHaveBeenCalled();
  });
  it("checks a bot's future pause before unkeyed task insertion or native start", async () => {
    const workspace = createWorkspace();
    const db = manager.getDatabase();
    const bot = new AgentRoleStore(db).create({
      name: "private-fixture",
      displayName: "Fixture",
      description: "Fixture",
      capabilities: [],
    });
    new BotWorkControlStore(db).begin(
      {
        scope: { workspaceId: workspace.id, agentRoleId: bot.id },
        requestId: "pause",
        action: "pause_bot",
      },
      Date.now(),
    );
    const startTask = vi.fn();
    register({ startTask });
    await expect(
      methods.get(Methods.TASK_CREATE)!(
        { hasScope: () => true },
        {
          title: "Due",
          prompt: "Due",
          workspaceId: workspace.id,
          assignedAgentRoleId: bot.id,
          generateTitle: false,
        },
      ),
    ).rejects.toThrow("Bot future runs are paused");
    expect(startTask).not.toHaveBeenCalled();
    expect(new TaskStore(db).findAll()).toHaveLength(0);
  });
});
