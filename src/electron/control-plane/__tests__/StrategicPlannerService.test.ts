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

describeWithSqlite("StrategicPlannerService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;
  let core: import("../ControlPlaneCoreService").ControlPlaneCoreService;
  let planner: import("../StrategicPlannerService").StrategicPlannerService;
  let taskRepo: import("../../database/repositories").TaskRepository;
  let agentRoleRepo: import("../../agents/AgentRoleRepository").AgentRoleRepository;

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-planner-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [
      { DatabaseManager },
      { ControlPlaneCoreService },
      { StrategicPlannerService },
      { TaskRepository },
      { AgentRoleRepository },
    ] = await Promise.all([
      import("../../database/schema"),
      import("../ControlPlaneCoreService"),
      import("../StrategicPlannerService"),
      import("../../database/repositories"),
      import("../../agents/AgentRoleRepository"),
    ]);

    manager = new DatabaseManager();
    db = manager.getDatabase();
    core = new ControlPlaneCoreService(db);
    taskRepo = new TaskRepository(db);
    agentRoleRepo = new AgentRoleRepository(db);
    planner = new StrategicPlannerService({ db });
  });

  afterEach(() => {
    planner?.stop();
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enables sqlite foreign key enforcement after schema initialization", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("creates planner-managed issues for uncovered goals and projects", async () => {
    const workspace = insertWorkspace();
    const company = core.getDefaultCompany();
    const goal = core.createGoal({
      companyId: company.id,
      title: "Launch autonomous venture pilot",
    });
    const project = core.createProject({
      companyId: company.id,
      goalId: goal.id,
      name: "Growth Engine",
    });
    core.linkProjectWorkspace({
      projectId: project.id,
      workspaceId: workspace.id,
      isPrimary: true,
    });

    planner.updateConfig(company.id, {
      enabled: true,
      maxIssuesPerRun: 5,
      autoDispatch: false,
    });

    const run = await planner.runNow({ companyId: company.id, trigger: "manual" });
    const issues = core.listIssues({ companyId: company.id, limit: 20 });

    expect(run.status).toBe("completed");
    expect(run.createdIssueCount).toBeGreaterThan(0);
    expect(
      issues.some((issue) => issue.title === "Define next deliverable for project: Growth Engine"),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.metadata?.plannerManaged === true && issue.metadata?.source === "strategic_planner"),
    ).toBe(true);
  });

  it("records an actionable outcome when an automated planner run creates work", async () => {
    const outcomes: Any[] = [];
    planner = new (await import("../StrategicPlannerService")).StrategicPlannerService({
      db,
      recordAutomationOutcome: async (outcome) => {
        outcomes.push(outcome);
      },
    });
    const company = core.getDefaultCompany();
    core.createProject({
      companyId: company.id,
      name: "Lifecycle Signals",
    });

    planner.updateConfig(company.id, {
      enabled: true,
      maxIssuesPerRun: 2,
      autoDispatch: false,
    });

    const run = await planner.runNow({ companyId: company.id, trigger: "schedule" });

    expect(run.status).toBe("completed");
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        usefulness: "actionable",
        notificationRecommended: true,
        title: `${company.name} planner found background work`,
      }),
    );
  });

  it("uses the company default workspace instead of creating workspace-link issues", async () => {
    const company = core.createCompany({
      name: "Planner Workspace Co",
      slug: "planner-workspace-co",
    });
    core.createProject({
      companyId: company.id,
      name: "Growth Engine",
    });

    planner.updateConfig(company.id, {
      enabled: true,
      maxIssuesPerRun: 5,
      autoDispatch: false,
    });

    const run = await planner.runNow({ companyId: company.id, trigger: "manual" });
    const issues = core.listIssues({ companyId: company.id, limit: 20 });

    expect(run.status).toBe("completed");
    expect(issues.some((issue) => issue.title === "Link a workspace for project: Growth Engine")).toBe(false);
    expect(
      issues.some(
        (issue) =>
          issue.title === "Define next deliverable for project: Growth Engine" &&
          issue.workspaceId === core.getCompany(company.id)?.defaultWorkspaceId,
      ),
    ).toBe(true);
    expect(core.listProjectWorkspaces(core.listProjects({ companyId: company.id })[0]!.id)).toHaveLength(1);
  });

  it("auto-dispatches planner-managed issues into task runs when enabled", async () => {
    const workspace = insertWorkspace();
    const company = core.getDefaultCompany();
    const project = core.createProject({
      companyId: company.id,
      name: "Customer Ops",
    });
    core.linkProjectWorkspace({
      projectId: project.id,
      workspaceId: workspace.id,
      isPrimary: true,
    });

    const plannerAgent =
      agentRoleRepo.findByName("project_manager") ||
      agentRoleRepo.create({
        name: "planner-agent",
        displayName: "Planner Agent",
        capabilities: ["plan", "manage"],
        heartbeatEnabled: true,
      });

    const createdTaskIds: string[] = [];
    planner = new (await import("../StrategicPlannerService")).StrategicPlannerService({
      db,
      agentDaemon: {
        createTask: async (params: { title: string; prompt: string; workspaceId: string; agentConfig?: Any }) => {
          const task = taskRepo.create({
            title: params.title,
            prompt: params.prompt,
            status: "pending",
            workspaceId: params.workspaceId,
            agentConfig: params.agentConfig,
            source: "api",
          });
          createdTaskIds.push(task.id);
          return task;
        },
      } as Any,
    });

    planner.updateConfig(company.id, {
      enabled: true,
      autoDispatch: true,
      maxIssuesPerRun: 2,
      plannerAgentRoleId: plannerAgent.id,
      planningWorkspaceId: workspace.id,
    });

    const run = await planner.runNow({ companyId: company.id });
    const tasks = createdTaskIds.map((id) => taskRepo.findById(id)).filter(Boolean);

    expect(run.status).toBe("completed");
    expect(run.dispatchedTaskCount).toBeGreaterThan(0);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.assignedAgentRoleId).toBe(plannerAgent.id);
    expect(tasks[0]?.issueId).toBeTruthy();
    expect(tasks[0]?.heartbeatRunId).toBeTruthy();
    expect(tasks[0]?.agentConfig?.autonomousMode).toBe(true);
  });

  it("uses the control-plane workspace link tool instructions for project workspace issues", async () => {
    const workspace = insertWorkspace();
    const company = core.getDefaultCompany();
    const project = core.createProject({
      companyId: company.id,
      name: "Docs Workspace Mapping",
    });
    for (const link of core.listProjectWorkspaces(project.id)) {
      core.unlinkProjectWorkspace(project.id, link.workspaceId);
    }
    // Exercise the legacy/migrated state where neither the project nor its
    // company has a workspace available for planner dispatch.
    db.prepare("UPDATE companies SET default_workspace_id = NULL WHERE id = ?").run(company.id);

    const plannerAgent =
      agentRoleRepo.findByName("project_manager") ||
      agentRoleRepo.create({
        name: "planner-agent",
        displayName: "Planner Agent",
        capabilities: ["plan", "manage"],
        heartbeatEnabled: true,
      });

    const prompts: string[] = [];
    planner = new (await import("../StrategicPlannerService")).StrategicPlannerService({
      db,
      agentDaemon: {
        createTask: async (params: { title: string; prompt: string; workspaceId: string; agentConfig?: Any }) => {
          prompts.push(params.prompt);
          return taskRepo.create({
            title: params.title,
            prompt: params.prompt,
            status: "pending",
            workspaceId: params.workspaceId,
            agentConfig: params.agentConfig,
            source: "api",
          });
        },
      } as Any,
    });

    planner.updateConfig(company.id, {
      enabled: true,
      autoDispatch: true,
      maxIssuesPerRun: 1,
      plannerAgentRoleId: plannerAgent.id,
      planningWorkspaceId: workspace.id,
    });

    const run = await planner.runNow({ companyId: company.id });

    expect(run.status).toBe("completed");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("link_project_workspace");
    expect(prompts[0]).toContain("Do not treat ad hoc files in .cowork/");
  });

  it("does not redispatch the same planner-managed issue on the next run when it already has a task", async () => {
    const workspace = insertWorkspace();
    const company = core.getDefaultCompany();
    const project = core.createProject({
      companyId: company.id,
      name: "Repeat Dispatch Guard",
    });
    core.linkProjectWorkspace({
      projectId: project.id,
      workspaceId: workspace.id,
      isPrimary: true,
    });

    const plannerAgent =
      agentRoleRepo.findByName("project_manager") ||
      agentRoleRepo.create({
        name: "planner-agent",
        displayName: "Planner Agent",
        capabilities: ["plan", "manage"],
        heartbeatEnabled: true,
      });

    const createdTaskIds: string[] = [];
    planner = new (await import("../StrategicPlannerService")).StrategicPlannerService({
      db,
      agentDaemon: {
        createTask: async (params: { title: string; prompt: string; workspaceId: string; agentConfig?: Any }) => {
          const task = taskRepo.create({
            title: params.title,
            prompt: params.prompt,
            status: "pending",
            workspaceId: params.workspaceId,
            agentConfig: params.agentConfig,
            source: "api",
          });
          createdTaskIds.push(task.id);
          return task;
        },
      } as Any,
    });

    planner.updateConfig(company.id, {
      enabled: true,
      autoDispatch: true,
      maxIssuesPerRun: 2,
      plannerAgentRoleId: plannerAgent.id,
      planningWorkspaceId: workspace.id,
    });

    const firstRun = await planner.runNow({ companyId: company.id });
    expect(firstRun.status).toBe("completed");
    expect(createdTaskIds).toHaveLength(1);

    const secondRun = await planner.runNow({ companyId: company.id });
    expect(secondRun.status).toBe("completed");
    expect(createdTaskIds).toHaveLength(1);
  });

  it("repairs stale planner role references instead of failing on config writes", async () => {
    const company = core.getDefaultCompany();
    const plannerAgent =
      agentRoleRepo.findByName("project_manager") ||
      agentRoleRepo.create({
        name: "planner-agent-stale-ref",
        displayName: "Planner Agent",
        capabilities: ["plan", "manage"],
        heartbeatEnabled: true,
      });

    planner.updateConfig(company.id, {
      enabled: true,
      plannerAgentRoleId: plannerAgent.id,
    });

    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM agent_roles WHERE id = ?").run(plannerAgent.id);
    db.exec("PRAGMA foreign_keys = ON");

    expect(() =>
      planner.updateConfig(company.id, {
        lastRunAt: Date.now(),
      }),
    ).not.toThrow();

    const repaired = planner.getConfig(company.id);
    expect(repaired.plannerAgentRoleId).toBeUndefined();
  });

  it("keeps successful planner runs completed when stale config role references are repaired", async () => {
    const company = core.getDefaultCompany();
    const plannerAgent =
      agentRoleRepo.findByName("project_manager") ||
      agentRoleRepo.create({
        name: "planner-agent-stale-run-ref",
        displayName: "Planner Agent",
        capabilities: ["plan", "manage"],
        heartbeatEnabled: true,
      });

    planner.updateConfig(company.id, {
      enabled: true,
      plannerAgentRoleId: plannerAgent.id,
    });

    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM agent_roles WHERE id = ?").run(plannerAgent.id);
    db.exec("PRAGMA foreign_keys = ON");

    const run = await planner.runNow({ companyId: company.id, trigger: "manual" });

    expect(run.status).toBe("completed");
    expect(run.error).toBeUndefined();
    expect(planner.getConfig(company.id).plannerAgentRoleId).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM strategic_planner_runs WHERE status = 'failed' AND error = 'FOREIGN KEY constraint failed'",
        )
        .get(),
    ).toMatchObject({ count: 0 });
  });

  it("does not create planner runs or configs for inactive companies", async () => {
    const company = core.createCompany({
      name: "Inactive Planner Company",
      status: "inactive",
    });

    await expect(planner.runNow({ companyId: company.id, trigger: "manual" })).rejects.toThrow(
      `Company is not active: ${company.id}`,
    );

    expect(planner.listRuns({ companyId: company.id })).toHaveLength(0);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM strategic_planner_configs WHERE company_id = ?")
        .get(company.id),
    ).toMatchObject({ count: 0 });
  });

  it("creates a linked planner follow-up for stale inbox-originated issues without taking ownership of the original", async () => {
    const workspace = insertWorkspace("handoff");
    const company = core.getDefaultCompany();
    const project = core.createProject({
      companyId: company.id,
      name: "Customer Escalations",
    });
    core.linkProjectWorkspace({
      projectId: project.id,
      workspaceId: workspace.id,
      isPrimary: true,
    });

    const operator =
      agentRoleRepo.findByCompanyId(company.id, false).find((role) =>
        /customer ops|founder office|growth|planner/i.test(role.displayName),
      ) || agentRoleRepo.findByCompanyId(company.id, false)[0];

    const inboxIssue = core.createIssue({
      companyId: company.id,
      projectId: project.id,
      workspaceId: workspace.id,
      title: "Client escalation from inbox",
      description: "Follow up on the client escalation thread.",
      status: "backlog",
      priority: 2,
      assigneeAgentRoleId: operator?.id,
      metadata: {
        source: "mailbox_handoff",
        plannerManaged: false,
      },
    });

    db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(
      Date.now() - 5 * 24 * 60 * 60 * 1000,
      inboxIssue.id,
    );

    planner.updateConfig(company.id, {
      enabled: true,
      maxIssuesPerRun: 5,
      autoDispatch: false,
      staleIssueDays: 3,
    });

    await planner.runNow({ companyId: company.id, trigger: "manual" });

    const issues = core.listIssues({ companyId: company.id, limit: 20 });
    const followUp = issues.find(
      (issue) =>
        issue.parentIssueId === inboxIssue.id &&
        issue.metadata?.plannerManaged === true &&
        issue.metadata?.source === "strategic_planner",
    );

    expect(followUp).toBeTruthy();
    expect(followUp?.title).toContain("Planner follow-up for inbox issue");

    const reloadedOriginal = core.getIssue(inboxIssue.id);
    expect(reloadedOriginal?.metadata?.source).toBe("mailbox_handoff");
    expect(reloadedOriginal?.metadata?.plannerManaged).toBe(false);
    expect(reloadedOriginal?.parentIssueId).toBeUndefined();
  });
});
