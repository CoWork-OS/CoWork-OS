import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../../agent/daemon";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import type { ControlPlaneServer } from "../server";
import { ErrorCodes, Methods } from "../protocol";
import { registerTaskAndWorkspaceMethods } from "../handlers";

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
});
