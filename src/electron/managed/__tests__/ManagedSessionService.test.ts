import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentRoleRepository } from "../../agents/AgentRoleRepository";
import { ChannelRepository, TaskEventRepository, TaskRepository } from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { MCPSettingsManager } from "../../mcp/settings";
import { ManagedSessionService } from "../ManagedSessionService";

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

describeWithSqlite("ManagedSessionService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: ReturnType<DatabaseManager["getDatabase"]>;
  let taskRepo: TaskRepository;
  let taskEventRepo: TaskEventRepository;
  let channelRepo: ChannelRepository;
  let roleRepo: AgentRoleRepository;
  let service: ManagedSessionService;
  let daemon: Any;

  const insertWorkspace = (name = "managed-test") => {
    const workspace = {
      id: `ws-${Math.random().toString(36).slice(2, 10)}`,
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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-managed-session-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    manager = new DatabaseManager();
    db = manager.getDatabase();
    taskRepo = new TaskRepository(db);
    taskEventRepo = new TaskEventRepository(db);
    channelRepo = new ChannelRepository(db);
    roleRepo = new AgentRoleRepository(db);

    daemon = {
      startTask: vi.fn(async (task: Any) => {
        taskRepo.update(task.id, { status: "executing" });
        task.status = "executing";
      }),
      cancelTask: vi.fn(async (taskId: string) => {
        taskRepo.update(taskId, {
          status: "cancelled",
          terminalStatus: "cancelled",
          completedAt: Date.now(),
        });
      }),
      resumeTask: vi.fn(async (taskId: string) => {
        taskRepo.update(taskId, { status: "executing" });
        return true;
      }),
      sendMessage: vi.fn(async () => {}),
      respondToInputRequest: vi.fn(async () => {}),
      failTask: vi.fn((taskId: string, message: string) => {
        taskRepo.update(taskId, { status: "failed", error: message, completedAt: Date.now() });
      }),
      teamOrchestrator: {
        tickRun: vi.fn(async () => {}),
        cancelRun: vi.fn(async () => {}),
      },
    };

    service = new ManagedSessionService(db, daemon);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pins managed sessions to the agent version used at creation time", async () => {
    const workspace = insertWorkspace();
    const environment = service.createEnvironment({
      name: "Local env",
      config: {
        workspaceId: workspace.id,
        enableShell: true,
      },
    });
    const created = service.createAgent({
      name: "Pinned agent",
      systemPrompt: "You are version one.",
      executionMode: "solo",
    });

    const firstSession = await service.createSession({
      agentId: created.agent.id,
      environmentId: environment.id,
      title: "First run",
      initialEvent: {
        type: "user.message",
        content: [{ type: "text", text: "First request" }],
      },
    });

    const updated = service.updateAgent(created.agent.id, {
      name: "Pinned agent v2",
      systemPrompt: "You are version two.",
      executionMode: "solo",
    });

    const secondSession = await service.createSession({
      agentId: created.agent.id,
      environmentId: environment.id,
      title: "Second run",
      initialEvent: {
        type: "user.message",
        content: [{ type: "text", text: "Second request" }],
      },
    });

    expect(daemon.startTask).toHaveBeenCalledTimes(2);
    expect(firstSession.agentVersion).toBe(1);
    expect(service.getSession(firstSession.id)?.agentVersion).toBe(1);
    expect(updated.agent.currentVersion).toBe(2);
    expect(secondSession.agentVersion).toBe(2);
  });

  it("applies managed shell access to the task without persisting workspace permissions", async () => {
    const workspace = insertWorkspace("shell-session");
    db.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?").run(
      JSON.stringify({
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: false,
      }),
      workspace.id,
    );

    const environment = service.createEnvironment({
      name: "Scoped shell env",
      config: {
        workspaceId: workspace.id,
        enableShell: true,
      },
    });
    const created = service.createAgent({
      name: "Scoped shell agent",
      systemPrompt: "Use shell only for this session.",
      executionMode: "solo",
    });

    const session = await service.createSession({
      agentId: created.agent.id,
      environmentId: environment.id,
      title: "Scoped shell run",
    });

    const backingTask = taskRepo.findById(session.backingTaskId!);
    const storedWorkspace = db
      .prepare("SELECT permissions FROM workspaces WHERE id = ?")
      .get(workspace.id) as { permissions: string };

    expect(backingTask?.agentConfig?.shellAccess).toBe(true);
    expect(JSON.parse(storedWorkspace.permissions).shell).toBe(false);
  });

  it("supports partial managed agent updates by carrying forward unspecified version fields", () => {
    const created = service.createAgent({
      name: "Partial update agent",
      systemPrompt: "Version one system prompt.",
      executionMode: "solo",
      runtimeDefaults: {
        allowUserInput: false,
        maxTurns: 5,
      },
    });

    const updated = service.updateAgent(created.agent.id, {
      name: "Renamed partial agent",
    });

    expect(updated.agent.name).toBe("Renamed partial agent");
    expect(updated.version.systemPrompt).toBe("Version one system prompt.");
    expect(updated.version.executionMode).toBe("solo");
    expect(updated.version.runtimeDefaults).toMatchObject({
      allowUserInput: false,
      maxTurns: 5,
    });
  });

  it("reuses the managed agent mirror when saved metadata omits the mirror link", () => {
    const workspace = insertWorkspace("mirror-link-save");
    const environment = service.createEnvironment({
      name: "Mirror link env",
      config: { workspaceId: workspace.id },
    });
    const created = service.createAgent({
      name: "Mirror Link Agent",
      systemPrompt: "Version one.",
      executionMode: "solo",
      metadata: {
        studio: {
          defaultEnvironmentId: environment.id,
          workflowBrief: "Handle mirrored work.",
        },
      },
    });
    const originalStudio = created.version.metadata?.studio as Any;
    const { legacyMirror: _legacyMirror, ...studioWithoutLegacyMirror } = originalStudio;

    const updated = service.updateAgent(created.agent.id, {
      systemPrompt: "Version two.",
      metadata: {
        studio: {
          ...studioWithoutLegacyMirror,
          workflowBrief: "Handle updated mirrored work.",
        },
      },
    });
    const updatedStudio = updated.version.metadata?.studio as Any;
    const mirroredRoles = roleRepo.findAll(true).filter((role) => {
      const soul = JSON.parse(role.soul || "{}");
      return soul.managedAgentId === created.agent.id;
    });

    expect(updatedStudio?.legacyMirror?.agentRoleId).toBe(originalStudio?.legacyMirror?.agentRoleId);
    expect(mirroredRoles).toHaveLength(1);
    expect(mirroredRoles[0]?.systemPrompt).toBe("Version two.");
  });

  it("sanitizes bridged task event payloads before persisting managed session events", async () => {
    const workspace = insertWorkspace();
    const environment = service.createEnvironment({
      name: "Local env",
      config: { workspaceId: workspace.id },
    });
    const created = service.createAgent({
      name: "Sanitizer",
      systemPrompt: "Keep things safe.",
      executionMode: "solo",
    });
    const session = await service.createSession({
      agentId: created.agent.id,
      environmentId: environment.id,
      title: "Sanitized run",
    });

    taskEventRepo.create({
      taskId: session.backingTaskId!,
      timestamp: Date.now(),
      type: "tool_call",
      payload: {
        prompt: "raw prompt should not leave storage",
        apiKey: "super-secret",
        nested: {
          authorization: "Bearer hidden",
        },
        message: "x".repeat(13_000),
      },
    });

    const events = service.listSessionEvents(session.id);
    const bridged = events.find((event) => event.type === "tool.call");

    expect(bridged?.payload.prompt).toBe("[REDACTED]");
    expect(bridged?.payload.apiKey).toBe("[REDACTED]");
    expect((bridged?.payload.nested as Any)?.authorization).toBe("[REDACTED]");
    expect(typeof bridged?.payload.message).toBe("string");
    expect(String(bridged?.payload.message)).toContain("[... truncated");
  });

  it("fails closed when an environment MCP allowlist cannot resolve tool metadata", async () => {
    const workspace = insertWorkspace();
    const loadSettingsSpy = vi
      .spyOn(MCPSettingsManager, "loadSettings")
      .mockReturnValue({ toolNamePrefix: "mcp_" } as Any);
    const getServerSpy = vi.spyOn(MCPSettingsManager, "getServer").mockReturnValue({
      id: "server-1",
      name: "Broken server",
      tools: [],
    } as Any);

    const environment = service.createEnvironment({
      name: "Locked env",
      config: {
        workspaceId: workspace.id,
        allowedMcpServerIds: ["server-1"],
      },
    });
    const created = service.createAgent({
      name: "Fail closed agent",
      systemPrompt: "Only use approved tools.",
      executionMode: "solo",
    });

    await expect(
      service.createSession({
        agentId: created.agent.id,
        environmentId: environment.id,
        title: "Should fail",
      }),
    ).rejects.toThrow(/tool metadata/i);

    expect(loadSettingsSpy).toHaveBeenCalled();
    expect(getServerSpy).toHaveBeenCalledWith("server-1");
    expect(daemon.startTask).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(1) AS count FROM tasks").get() as Any).toMatchObject({ count: 0 });
  });

  it("starts team-mode sessions through the daemon path and blocks direct follow-up user messages", async () => {
    const workspace = insertWorkspace();
    const roleRepo = new AgentRoleRepository(db);
    const lead = roleRepo.create({
      name: "managed-team-lead",
      displayName: "Managed Team Lead",
      capabilities: [],
    });
    const environment = service.createEnvironment({
      name: "Team env",
      config: { workspaceId: workspace.id },
    });
    const created = service.createAgent({
      name: "Team agent",
      systemPrompt: "Coordinate the team.",
      executionMode: "team",
      teamTemplate: {
        leadAgentRoleId: lead.id,
        memberAgentRoleIds: [lead.id],
        maxParallelAgents: 1,
        collaborativeMode: true,
      },
    });

    const session = await service.createSession({
      agentId: created.agent.id,
      environmentId: environment.id,
      title: "Team run",
      initialEvent: {
        type: "user.message",
        content: [{ type: "text", text: "Investigate the repo." }],
      },
    });

    expect(daemon.startTask).toHaveBeenCalledTimes(1);
    expect(session.backingTaskId).toBeTruthy();
    expect(session.backingTeamRunId).toBeTruthy();
    expect(service.getSession(session.id)?.status).toBe("running");

    await expect(
      service.sendEvent(session.id, {
        type: "user.message",
        content: [{ type: "text", text: "One more thing" }],
      }),
    ).rejects.toThrow(/team-mode managed sessions/i);
    expect(daemon.sendMessage).not.toHaveBeenCalled();
  });

  it("enforces managed approval policy on direct sessions and mirrored agent roles", async () => {
    const workspace = insertWorkspace("approval-session");
    const environment = service.createEnvironment({
      name: "Approval env",
      config: { workspaceId: workspace.id },
    });
    const created = service.createAgent({
      name: "Approval agent",
      systemPrompt: "Handle approvals carefully.",
      executionMode: "solo",
      metadata: {
        studio: {
          approvalPolicy: {
            autoApproveReadOnly: true,
            requireApprovalFor: ["send email", "edit spreadsheet"],
            escalationChannel: "#ops-approvals",
          },
        },
      },
    });

    const session = await service.createSession({
      agentId: created.agent.id,
      environmentId: environment.id,
      title: "Approval run",
      initialEvent: {
        type: "user.message",
        content: [{ type: "text", text: "Run the workflow." }],
      },
    });

    const backingTask = taskRepo.findById(session.backingTaskId!);
    expect(backingTask?.agentConfig?.allowUserInput).toBe(true);
    expect(backingTask?.agentConfig?.pauseForRequiredDecision).toBe(true);
    expect(backingTask?.agentConfig?.autoApproveTypes).toEqual(["network_access"]);

    const roleRepo = new AgentRoleRepository(db);
    const mirroredRole = roleRepo.findAll(false).find((role) => role.displayName === "Approval agent");
    expect(mirroredRole).toBeTruthy();
    const soul = JSON.parse(mirroredRole!.soul || "{}");
    expect(soul.autonomyPolicy).toMatchObject({
      preset: "manual",
      allowUserInput: true,
      pauseForRequiredDecision: true,
      autoApproveTypes: ["network_access"],
    });
  });

  it("does not mint admin access for arbitrary principals when reading workspace permissions", () => {
    const workspace = insertWorkspace("rbac");

    const snapshot = service.getMyWorkspacePermissions(workspace.id, "attacker-user");
    const attackerMembership = db
      .prepare(
        `SELECT role
         FROM agent_workspace_memberships
         WHERE workspace_id = ? AND principal_id = ?`,
      )
      .get(workspace.id, "attacker-user") as { role?: string } | undefined;

    expect(snapshot.principalId).toBe("local-user");
    expect(snapshot.role).toBe("admin");
    expect(snapshot.canManageMemberships).toBe(true);
    expect(attackerMembership).toBeUndefined();
  });

  it("preserves authored Slack targets when suspending an agent while removing live routing", () => {
    const workspace = insertWorkspace("suspend-slack");
    const environment = service.createEnvironment({
      name: "Slack env",
      config: { workspaceId: workspace.id },
    });
    const channel = channelRepo.create({
      type: "slack",
      name: "Support Slack",
      enabled: true,
      status: "connected",
      config: {},
      securityConfig: { mode: "pairing" },
    });
    const created = service.createAgent({
      name: "Slacky",
      systemPrompt: "Handle Slack work.",
      executionMode: "solo",
      metadata: {
        studio: {
          deployment: { surfaces: ["slack"] },
          defaultEnvironmentId: environment.id,
          channelTargets: [
            {
              channelType: "slack",
              channelId: channel.id,
              channelName: channel.name,
              enabled: true,
              progressRelayMode: "curated",
              securityMode: "allowlist",
            },
          ],
        },
      },
    });

    service.publishAgent(created.agent.id);
    service.suspendAgent(created.agent.id);

    const suspended = service.getAgent(created.agent.id);
    const studio = suspended?.currentVersion?.metadata?.studio as Any;
    const updatedChannel = channelRepo.findById(channel.id);

    expect(studio?.channelTargets).toHaveLength(1);
    expect(studio?.channelTargets?.[0]?.channelId).toBe(channel.id);
    expect(updatedChannel?.config?.defaultAgentRoleId).toBeUndefined();
    expect(updatedChannel?.config?.allowedAgentRoleIds || []).not.toContain(
      studio?.legacyMirror?.agentRoleId,
    );
  });

  it("returns workpapers to viewers without requiring audit permission", async () => {
    const workspace = insertWorkspace("viewer-workpaper");
    const environment = service.createEnvironment({
      name: "Viewer env",
      config: { workspaceId: workspace.id },
    });
    const created = service.createAgent({
      name: "Viewer agent",
      systemPrompt: "Generate a workpaper.",
      executionMode: "solo",
      metadata: {
        studio: {
          defaultEnvironmentId: environment.id,
        },
      },
    });
    const session = await service.createSession({
      agentId: created.agent.id,
      environmentId: environment.id,
      title: "Viewer session",
    });

    service.updateWorkspaceMembership({
      workspaceId: workspace.id,
      principalId: "local-user",
      role: "viewer",
    });

    const workpaper = service.getSessionWorkpaper(session.id);

    expect(workpaper.sessionId).toBe(session.id);
    expect(workpaper.auditTrail).toEqual([]);
  });

  it("reuses the source agent role when converting personas into managed agents", () => {
    const workspace = insertWorkspace("convert-role");
    const role = roleRepo.create({
      name: "support-pilot",
      displayName: "Support Pilot",
      description: "Answer support questions.",
      roleKind: "custom",
      capabilities: ["research", "communicate"],
      systemPrompt: "Help customers.",
    });

    const converted = service.convertAgentRoleToManagedAgent({
      agentRoleId: role.id,
      workspaceId: workspace.id,
    });
    const detail = service.getAgent(converted.agent.id);
    const studio = detail?.currentVersion?.metadata?.studio as Any;
    const managedRoles = roleRepo.findAll(true).filter((candidate) => {
      const soul = JSON.parse(candidate.soul || "{}");
      return soul.managedAgentId === converted.agent.id;
    });

    expect(studio?.legacyMirror?.agentRoleId).toBe(role.id);
    expect(managedRoles).toHaveLength(1);
    expect(managedRoles[0]?.id).toBe(role.id);
  });

  it("only reports Slack deployment run health from Slack-backed routine runs", async () => {
    const workspace = insertWorkspace("slack-health");
    const environment = service.createEnvironment({
      name: "Slack health env",
      config: { workspaceId: workspace.id },
    });
    const channel = channelRepo.create({
      type: "slack",
      name: "Ops Slack",
      enabled: true,
      status: "connected",
      config: {},
      securityConfig: { mode: "pairing" },
    });
    const created = service.createAgent({
      name: "Health agent",
      systemPrompt: "Do health checks.",
      executionMode: "solo",
      metadata: {
        studio: {
          deployment: { surfaces: ["slack"] },
          defaultEnvironmentId: environment.id,
          channelTargets: [
            {
              channelType: "slack",
              channelId: channel.id,
              channelName: channel.name,
              enabled: true,
            },
          ],
        },
      },
    });
    service.publishAgent(created.agent.id);

    const manualSession = await service.createSession({
      agentId: created.agent.id,
      environmentId: environment.id,
      title: "Manual run",
    });
    db.prepare("UPDATE managed_sessions SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(
      "completed",
      Date.now(),
      Date.now(),
      manualSession.id,
    );

    const health = service.getSlackDeploymentHealth(created.agent.id);

    expect(health.lastSuccessfulRoutedRunId).toBeUndefined();
    expect(health.lastSuccessfulRoutedRunAt).toBeUndefined();
    expect(health.lastDeploymentError).toBeUndefined();
  });

  it("derives unique agent users from recorded requester identities instead of hard-coding one", async () => {
    const workspace = insertWorkspace("agent-insights");
    const environment = service.createEnvironment({
      name: "Insights env",
      config: { workspaceId: workspace.id },
    });
    const created = service.createAgent({
      name: "Insights agent",
      systemPrompt: "Track usage.",
      executionMode: "solo",
      metadata: {
        studio: {
          defaultEnvironmentId: environment.id,
        },
      },
    });

    const first = await service.createSession({
      agentId: created.agent.id,
      environmentId: environment.id,
      title: "First run",
    });
    taskEventRepo.create({
      taskId: first.backingTaskId!,
      timestamp: Date.now(),
      type: "task_status",
      payload: { requestingUserId: "alice" },
    });

    const second = await service.createSession({
      agentId: created.agent.id,
      environmentId: environment.id,
      title: "Second run",
    });
    taskEventRepo.create({
      taskId: second.backingTaskId!,
      timestamp: Date.now(),
      type: "task_status",
      payload: { requestingUserId: "bob" },
    });

    const insights = service.getAgentInsights(created.agent.id);

    expect(insights.uniqueUsers).toBe(2);
  });
});
