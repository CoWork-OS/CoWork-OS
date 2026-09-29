import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../../electron/database/schema";
import { SkillStore, TaskStore, WorkspaceStore } from "../../../electron/database/repositories";
import { WorkspaceRepository } from "../../../electron/database/repository-facades";
import type { CustomSkill, Workspace } from "../../../shared/types";
import { createBrowserCoreDefinitions } from "../browser-core-methods";

describe("browser core desktop methods", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: ReturnType<DatabaseManager["getDatabase"]>;
  let workspace: Workspace;
  let workspaceRepository: WorkspaceRepository;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-core-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    workspaceRepository = new WorkspaceRepository(db);
    workspace = new WorkspaceStore(db).create("Project", path.join(tempDir, "project"), {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
    });
  });

  afterEach(async () => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function definitions(options: { write?: boolean; skillLoader?: object } = {}) {
    return createBrowserCoreDefinitions({
      db,
      agentDaemon: {},
      skillLoader: options.skillLoader as never,
      resolveWorkspace: async (workspaceId) => {
        const found = await workspaceRepository.findById(workspaceId);
        if (!found) return null;
        return {
          ...found,
          permissions: { ...found.permissions, write: options.write !== false },
        };
      },
    });
  }

  async function invoke(name: string, args: unknown[]) {
    const definition = definitions()[name];
    const validated = definition.validate ? definition.validate(args) : args;
    return definition.handler(validated);
  }

  it("renames and pins only tasks in an effectively writable workspace", async () => {
    const task = new TaskStore(db).create({
      title: "Original",
      prompt: "private",
      status: "completed",
      workspaceId: workspace.id,
    });
    const defs = definitions();

    await defs.renameTask.handler(defs.renameTask.validate!([task.id, "Renamed"]));
    const renamed = await new (
      await import("../../../electron/database/repository-facades")
    ).TaskRepository(db).findById(task.id);
    expect(renamed?.title).toBe("Renamed");
    const pinned = await defs.toggleTaskPin.handler(defs.toggleTaskPin.validate!([task.id]));
    expect(pinned).toMatchObject({ id: task.id, pinned: true });
    expect(JSON.stringify(pinned)).not.toContain("private");

    const readOnly = definitions({ write: false });
    await expect(
      readOnly.renameTask.handler(readOnly.renameTask.validate!([task.id, "blocked"])),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(() => defs.renameTask.validate!([task.id, "\n"])).toThrow();
  });

  it("archives the shared session through the retention service after checking every workspace", async () => {
    const first = new TaskStore(db).create({
      title: "Session task",
      prompt: "private",
      status: "completed",
      workspaceId: workspace.id,
      sessionId: "session-1",
    });
    const taskStore = new TaskStore(db);
    taskStore.update(first.id, { sessionId: "session-1" });
    const second = taskStore.create({
      title: "Other task",
      prompt: "private",
      status: "completed",
      workspaceId: workspace.id,
      sessionId: "session-1",
    });
    taskStore.update(second.id, { sessionId: "session-1" });
    const result = await invoke("archiveTask", [first.id]);
    expect(result).toMatchObject({ taskCount: 2, metadata: { sessionId: "session-1" } });

    const otherWorkspace = new WorkspaceStore(db).create("Restricted", path.join(tempDir, "r"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const mixed = taskStore.create({
      title: "Mixed session task",
      prompt: "private",
      status: "completed",
      workspaceId: otherWorkspace.id,
      sessionId: "session-cross-workspace",
    });
    taskStore.update(mixed.id, { sessionId: "session-cross-workspace" });
    const crossingTask = taskStore.create({
      title: "Current workspace task",
      prompt: "private",
      status: "completed",
      workspaceId: workspace.id,
      sessionId: "session-cross-workspace",
    });
    taskStore.update(crossingTask.id, { sessionId: "session-cross-workspace" });
    const restricted = createBrowserCoreDefinitions({
      db,
      agentDaemon: {},
      resolveWorkspace: async (id) => {
        const found = await workspaceRepository.findById(id);
        if (!found || id === otherWorkspace.id) return null;
        return found;
      },
    });
    await expect(
      restricted.archiveTask.handler(restricted.archiveTask.validate!([crossingTask.id])),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(second.id).not.toBe(first.id);
  });

  it("creates a workspace only under the controlled browser root and hides the host path", async () => {
    const defs = definitions();
    const permissions = {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: false,
    };
    const params = defs.createWorkspace.validate!([{ name: "New Product", path: "", permissions }]);
    const created = (await defs.createWorkspace.handler(params)) as Workspace;

    expect(created).toMatchObject({ name: "New Product", path: "", permissions: { shell: false } });
    const saved = await workspaceRepository.findById(created.id);
    expect(saved?.path).toContain(path.join(tempDir, "browser-workspaces"));
    expect(saved?.permissions).toMatchObject({ delete: false, shell: false });
    const stat = await fs.stat(saved!.path);
    expect(stat.isDirectory()).toBe(true);
    expect(() =>
      defs.createWorkspace.validate!([{ name: "Bad", path: path.join(tempDir, "outside") }]),
    ).toThrow();
    expect(() =>
      defs.createWorkspace.validate!([
        { name: "Bad", path: "", permissions: { ...permissions, shell: true } },
      ]),
    ).toThrow();
  });

  it("limits bot conversations to the readable requested workspace", async () => {
    const inScope = new TaskStore(db).create({
      title: "Visible bot",
      prompt: "private prompt",
      status: "completed",
      workspaceId: workspace.id,
      agentConfig: { botConversation: true },
    });
    const outside = new WorkspaceStore(db).create("Outside", path.join(tempDir, "outside"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    new TaskStore(db).create({
      title: "Hidden bot",
      prompt: "other prompt",
      status: "completed",
      workspaceId: outside.id,
      agentConfig: { botConversation: true },
    });
    const defs = definitions();
    const args = defs.listBotConversations.validate!([
      { workspaceId: workspace.id, limit: 20, offset: 0 },
    ]);
    const rows = (await defs.listBotConversations.handler(args)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: inScope.id, agentConfig: { botConversation: true } });
    expect(JSON.stringify(rows)).not.toContain("other prompt");
    expect(() =>
      defs.listBotConversations.validate!([
        { workspaceId: workspace.id, includeAllWorkspaces: true },
      ]),
    ).toThrowError(/workspace-scoped/);
  });

  it("returns task picker prompts without paths and agent-hub skill summaries without content", async () => {
    const loadedSkill: CustomSkill = {
      id: "outline",
      name: "Outline",
      description: "Build a short outline",
      icon: "🧭",
      prompt: "Use {{topic}} to write an outline.",
      filePath: path.join(tempDir, "skills", "outline.json"),
      parameters: [{ name: "topic", type: "string", description: "The topic", required: true }],
    };
    const loader = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listTaskSkills: vi.fn().mockReturnValue([loadedSkill]),
    };
    const defs = definitions({ skillLoader: loader });
    const taskSkills = (await defs.listTaskSkills.handler([])) as Array<Record<string, unknown>>;
    expect(taskSkills[0]).toMatchObject({ id: "outline", prompt: loadedSkill.prompt });
    expect(JSON.stringify(taskSkills)).not.toContain("filePath");
    expect(JSON.stringify(taskSkills)).not.toContain("outline.json");

    const stored = new SkillStore(db).create({
      name: "Database skill",
      description: "For the Hub list",
      category: "custom",
      prompt: "private skill content",
      scriptPath: path.join(tempDir, "private-script.py"),
    });
    const summaries = (await defs.listSkills.handler([])) as Array<Record<string, unknown>>;
    expect(summaries).toContainEqual(
      expect.objectContaining({ id: stored.id, name: "Database skill" }),
    );
    expect(JSON.stringify(summaries)).not.toContain("private-script.py");
    expect(JSON.stringify(summaries)).not.toContain("private skill content");
    const detail = (await defs.getSkill.handler(defs.getSkill.validate!([stored.id]))) as Record<
      string,
      unknown
    >;
    expect(detail).toMatchObject({ id: stored.id, name: "Database skill" });
    expect(detail).not.toHaveProperty("prompt");
    expect(detail).not.toHaveProperty("scriptPath");
  });
});
