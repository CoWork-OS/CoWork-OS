import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describeWithSqlite("SymphonyService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;
  let core: import("../ControlPlaneCoreService").ControlPlaneCoreService;
  let taskRepo: import("../../database/repositories").TaskRepository;

  const insertWorkspace = (name = "main") => {
    const workspace = {
      id: randomUUID(),
      name,
      path: path.join(tmpDir, name),
      createdAt: Date.now(),
      permissions: JSON.stringify({
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      }),
    };
    fs.mkdirSync(workspace.path, { recursive: true });
    db.prepare(
      `
        INSERT INTO workspaces (id, name, path, created_at, permissions)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(workspace.id, workspace.name, workspace.path, workspace.createdAt, workspace.permissions);
    return workspace;
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-symphony-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [
      { DatabaseManager },
      { ControlPlaneCoreService },
      { TaskRepository },
    ] = await Promise.all([
      import("../../database/schema"),
      import("../ControlPlaneCoreService"),
      import("../../database/repositories"),
    ]);

    manager = new DatabaseManager();
    db = manager.getDatabase();
    core = new ControlPlaneCoreService(db);
    taskRepo = new TaskRepository(db);
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

  it("loads workflow front matter and falls back when workflow is missing", async () => {
    const { loadSymphonyWorkflow } = await import("../SymphonyService");
    const workspace = insertWorkspace();
    fs.writeFileSync(
      path.join(workspace.path, "WORKFLOW.md"),
      "---\nruntime: native\nagent:\n  max_turns: 12\n---\nShip {{issue.title}}",
    );

    const loaded = loadSymphonyWorkflow({ workspacePath: workspace.path });
    const missing = loadSymphonyWorkflow({
      workspacePath: workspace.path,
      workflowPath: "MISSING.md",
    });

    expect(loaded.error).toBeUndefined();
    expect(loaded.config.runtime).toBe("native");
    expect(loaded.promptTemplate).toContain("{{issue.title}}");
    expect(missing.error).toContain("no such file");
    expect(missing.promptTemplate).toContain("CoWork OS issue");
  });

  it("dispatches one eligible issue with native worktree-required config", async () => {
    const { SymphonyService } = await import("../SymphonyService");
    const workspace = insertWorkspace();
    fs.writeFileSync(path.join(workspace.path, "WORKFLOW.md"), "Implement {{issue.title}}");
    const company = core.getDefaultCompany();
    const issue = core.createIssue({
      companyId: company.id,
      workspaceId: workspace.id,
      title: "Add orchestration telemetry",
      status: "todo",
      priority: 3,
    });
    const createdTaskIds: string[] = [];
    const service = new SymphonyService({
      db,
      agentDaemon: {
        createTask: async (params: Any) => {
          const task = taskRepo.create({
            title: params.title,
            prompt: params.prompt,
            status: "pending",
            workspaceId: params.workspaceId,
            agentConfig: params.agentConfig,
            source: params.source,
            ...params.taskOverrides,
          });
          createdTaskIds.push(task.id);
          return task;
        },
      } as Any,
    });
    service.updateConfig({
      enabled: true,
      workspaceId: workspace.id,
      maxConcurrentIssueRuns: 1,
    });

    await service.runOnce("manual");
    await service.runOnce("manual");

    const task = taskRepo.findById(createdTaskIds[0]!);
    const updatedIssue = core.getIssue(issue.id);
    expect(createdTaskIds).toHaveLength(1);
    expect(task?.source).toBe("symphony");
    expect(task?.issueId).toBe(issue.id);
    expect(task?.heartbeatRunId).toBeTruthy();
    expect(task?.agentConfig?.requireWorktree).toBe(true);
    expect(task?.agentConfig?.autonomousMode).toBe(true);
    expect(task?.agentConfig?.externalRuntime).toBeUndefined();
    expect(updatedIssue?.activeRunId).toBeTruthy();
  });

  it("uses acpx runtime only when workflow front matter opts in", async () => {
    const { SymphonyService } = await import("../SymphonyService");
    const workspace = insertWorkspace();
    fs.writeFileSync(
      path.join(workspace.path, "WORKFLOW.md"),
      "---\nruntime:\n  mode: acpx\n  agent: claude\n---\nImplement {{issue.title}}",
    );
    const issue = core.createIssue({
      companyId: core.getDefaultCompany().id,
      workspaceId: workspace.id,
      title: "Route through Codex",
      status: "todo",
      priority: 1,
    });
    const service = new SymphonyService({
      db,
      agentDaemon: {
        createTask: async (params: Any) =>
          taskRepo.create({
            title: params.title,
            prompt: params.prompt,
            status: "pending",
            workspaceId: params.workspaceId,
            agentConfig: params.agentConfig,
            source: params.source,
            ...params.taskOverrides,
          }),
      } as Any,
    });
    service.updateConfig({
      enabled: true,
      workspaceId: workspace.id,
      runtimeMode: "native",
    });

    await service.runOnce("manual");

    const updatedIssue = core.getIssue(issue.id);
    const task = updatedIssue?.taskId ? taskRepo.findById(updatedIssue.taskId) : undefined;
    expect(task?.agentConfig?.externalRuntime?.kind).toBe("acpx");
    expect(task?.agentConfig?.externalRuntime?.agent).toBe("claude");
  });
});
