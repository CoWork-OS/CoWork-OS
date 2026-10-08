import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../../electron/database/schema";
import { TaskStore, WorkspaceStore } from "../../../electron/database/repositories";
import { WorkspaceRepository } from "../../../electron/database/repository-facades";
import {
  AgentRoleRepository,
  AgentTeamRepository,
} from "../../../electron/agents/agent-repository-facades";
import type { Workspace } from "../../../shared/types";
import type { ChannelGateway } from "../../../electron/gateway";
import type { ManagedSessionService } from "../../../electron/managed/ManagedSessionService";
import type { CronService } from "../../../electron/cron/service";
import type { RoutineService } from "../../../electron/routines/service";
import type { PluginPackToggleService } from "../../../electron/extensions/plugin-pack-toggle-service";
import { BrowserDesktopRpcService } from "../browser-desktop-rpc";
import {
  createBrowserNavigationDefinitions,
  type BrowserDiscoverySources,
} from "../browser-navigation-methods";

describe("browser navigation desktop methods", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: ReturnType<DatabaseManager["getDatabase"]>;
  let workspace: Workspace;
  let workspaceRepository: WorkspaceRepository;
  let managed: ManagedSessionService;
  let routineService: RoutineService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-navigation-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    workspaceRepository = new WorkspaceRepository(db);
    workspace = new WorkspaceStore(db).create("Readable", path.join(tempDir, "readable"), {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
    });
    managed = {
      getMyWorkspacePermissions: vi.fn(async () => ({
        canViewAgents: true,
        canRunAgents: true,
        canResumeSessions: true,
        canAnswerApprovals: true,
        canEditDrafts: true,
        canManageEnvironments: true,
        canPublishAgents: true,
        canManageRoutines: true,
        canManageMemberships: true,
        canAuditAgents: true,
      })),
    } as unknown as ManagedSessionService;
    routineService = {
      getWorkflowCapabilities: () => ({ operations: [] }),
    } as unknown as RoutineService;
  });

  afterEach(async () => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function definitions(
    resolveWorkspace?: (id: string) => Promise<Workspace | null>,
    discovery?: Partial<BrowserDiscoverySources>,
    pluginPackToggleService?: Pick<PluginPackToggleService, "setPackEnabled" | "setSkillEnabled">,
    channelGateway?: Pick<
      ChannelGateway,
      "getChannels" | "getChannel" | "getDistinctChatIds" | "sendMessage"
    >,
    agentDaemon: object = {},
    cronService: CronService | null = null,
  ) {
    return createBrowserNavigationDefinitions({
      db,
      agentDaemon: agentDaemon as never,
      channelGateway,
      managedSessionService: managed,
      getRoutineService: () => routineService,
      getCronService: () => cronService,
      resolveWorkspace: resolveWorkspace || (async (id) => workspaceRepository.findById(id)),
      discovery,
      pluginPackToggleService,
    }).definitions;
  }

  async function invoke(defs: ReturnType<typeof definitions>, name: string, args: unknown[] = []) {
    const method = defs[name];
    const validated = method.validate ? method.validate(args) : args;
    return method.handler(validated, {} as never);
  }

  it("registers only exact browser-safe method names and leaves host-only sources gated", () => {
    const defs = definitions();

    expect(defs.generateManagedAgentPlan).toBeDefined();
    expect(defs.createManagedAgentFromPlan).toBeDefined();
    expect(defs.getSkillStatus).toBeDefined();
    expect(defs.listPluginPacks).toBeDefined();
    expect(defs.togglePluginPack).toBeDefined();
    expect(defs.togglePluginPackSkill).toBeDefined();
    expect(defs.listQuarantinedImports).toBeDefined();
    expect(defs.searchSkillRegistry).toBeDefined();
    expect(defs.searchClawHubSkills).toBeDefined();
    expect(defs.searchPackRegistry).toBeDefined();
    expect(defs.getMCPStatus).toBeDefined();
    expect(defs.fetchMCPRegistry).toBeDefined();
    expect(defs.searchMCPRegistry).toBeDefined();
    expect(defs.listRoutineWorkflowRunSteps).toBe(defs.listRoutineWorkflowSteps);
    expect(defs.listRoutineWorkflowEventSamples).toBeUndefined();
    expect(defs.getAllHeartbeatStatus).toBeUndefined();
    expect(Object.keys(defs).some((name) => name.toLowerCase().includes("ipc"))).toBe(false);
  });

  it("forks only writable readable tasks and returns a prompt-free task summary", async () => {
    const sourceTask = new TaskStore(db).create({
      title: "Source task",
      prompt: "private source prompt",
      status: "completed",
      workspaceId: workspace.id,
    });
    const forkedTask = new TaskStore(db).create({
      title: "Source task (side-chat)",
      prompt: "private fork prompt",
      status: "pending",
      workspaceId: workspace.id,
    });
    const forkTaskSession = vi.fn().mockResolvedValue(forkedTask);
    const defs = definitions(undefined, undefined, undefined, undefined, { forkTaskSession });
    const forkDefinition = defs.forkTaskSession;
    expect(forkDefinition).toMatchObject({ capability: "tasks.create", mutation: true });

    const request = {
      taskId: sourceTask.id,
      branchLabel: "side-chat",
      sideChat: true,
      initialMessage: "private initial message",
    };
    const returned = await invoke(defs, "forkTaskSession", [request]);
    expect(forkTaskSession).toHaveBeenCalledWith(request);
    expect(returned).toMatchObject({
      id: forkedTask.id,
      title: forkedTask.title,
      workspaceId: workspace.id,
      prompt: "",
    });
    expect(JSON.stringify(returned)).not.toContain("private fork prompt");
    expect(JSON.stringify(returned)).not.toContain(workspace.path);
    expect(() => forkDefinition.validate!([{ ...request, extra: true }])).toThrow();

    const readOnly = definitions(
      async (id) => {
        const found = await workspaceRepository.findById(id);
        return found ? { ...found, permissions: { ...found.permissions, write: false } } : null;
      },
      undefined,
      undefined,
      undefined,
      { forkTaskSession },
    );
    await expect(
      readOnly.forkTaskSession.handler(readOnly.forkTaskSession.validate!([request])),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(forkTaskSession).toHaveBeenCalledTimes(1);
  });

  it("supports browser bot details, notification policy, and workspace-scoped team reads", async () => {
    const role = await new AgentRoleRepository(db).create({
      name: "browser-reviewer",
      displayName: "Browser Reviewer",
      description: "Reviews approved work.",
      systemPrompt: "Review the current task.",
      capabilities: ["review"],
    });
    const team = await new AgentTeamRepository(db).create({
      workspaceId: workspace.id,
      name: "Review team",
      leadAgentRoleId: role.id,
    });
    const defs = definitions();

    expect(defs.getAgentRole).toMatchObject({ capability: "agents.manage", minArgs: 1 });
    await expect(invoke(defs, "getAgentRole", [role.id])).resolves.toMatchObject({
      id: role.id,
      displayName: role.displayName,
      systemPrompt: role.systemPrompt,
    });
    await expect(invoke(defs, "getBotNotificationPolicy", [role.id])).resolves.toMatchObject({
      agentRoleId: role.id,
      onFinish: true,
      onInputRequired: true,
    });
    expect(defs.updateBotNotificationPolicy).toMatchObject({
      capability: "agents.manage",
      mutation: true,
    });
    await expect(
      invoke(defs, "updateBotNotificationPolicy", [
        { agentRoleId: role.id, onFinish: false, onInputRequired: true },
      ]),
    ).resolves.toMatchObject({
      agentRoleId: role.id,
      onFinish: false,
      onInputRequired: true,
    });
    await expect(invoke(defs, "listTeams", [workspace.id])).resolves.toMatchObject([
      { id: team.id, workspaceId: workspace.id, name: team.name },
    ]);

    expect(() =>
      defs.updateBotNotificationPolicy.validate?.([{ agentRoleId: role.id, onFinish: 1 }]),
    ).toThrow();
    expect(() => defs.listTeams.validate?.([workspace.id, "true"])).toThrow();
    const unreadable = definitions(async () => ({
      ...workspace,
      permissions: { ...workspace.permissions, read: false },
    }));
    await expect(invoke(unreadable, "listTeams", [workspace.id])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("reopens bot conversations only inside a writable browser workspace", async () => {
    const sourceTask = new TaskStore(db).create({
      title: "Earlier bot session",
      prompt: "private source prompt",
      status: "completed",
      workspaceId: workspace.id,
    });
    const reopenedTask = new TaskStore(db).create({
      title: "Earlier bot session",
      prompt: "private reopened prompt",
      status: "pending",
      workspaceId: workspace.id,
    });
    const reopenBotConversation = vi.fn().mockResolvedValue(reopenedTask);
    const defs = definitions(undefined, undefined, undefined, undefined, {
      reopenBotConversation,
    });
    const reopen = defs.reopenBotConversation;
    expect(reopen).toMatchObject({ capability: "tasks.create", mutation: true });
    const request = { workspaceId: workspace.id, taskId: sourceTask.id };
    await expect(invoke(defs, "reopenBotConversation", [request])).resolves.toMatchObject({
      id: reopenedTask.id,
      workspaceId: workspace.id,
      prompt: "private reopened prompt",
    });
    expect(reopenBotConversation).toHaveBeenCalledWith(request);

    const readOnly = definitions(
      async (id) => {
        const found = await workspaceRepository.findById(id);
        return found ? { ...found, permissions: { ...found.permissions, write: false } } : null;
      },
      undefined,
      undefined,
      undefined,
      { reopenBotConversation },
    );
    await expect(invoke(readOnly, "reopenBotConversation", [request])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(reopenBotConversation).toHaveBeenCalledTimes(1);
  });

  it("authorizes desired-state pack toggles as agents.manage mutations and returns bounded results", async () => {
    const pluginPackToggleService = {
      setPackEnabled: vi.fn(async (name: string, enabled: boolean) => ({
        success: true as const,
        name,
        enabled,
        hostPath: "/Users/private/secret",
      })),
      setSkillEnabled: vi.fn(async (packName: string, skillId: string, enabled: boolean) => ({
        success: true as const,
        packName,
        skillId,
        enabled,
        secret: "should not escape",
      })),
    } as unknown as Pick<PluginPackToggleService, "setPackEnabled" | "setSkillEnabled">;
    const defs = definitions(undefined, undefined, pluginPackToggleService);
    const pack = defs.togglePluginPack;
    const skill = defs.togglePluginPackSkill;

    expect(pack.capability).toBe("agents.manage");
    expect(pack.mutation).toBe(true);
    expect(pack.minArgs).toBe(2);
    expect(pack.maxArgs).toBe(2);
    expect(skill.capability).toBe("agents.manage");
    expect(skill.mutation).toBe(true);
    expect(skill.minArgs).toBe(3);
    expect(skill.maxArgs).toBe(3);

    await expect(invoke(defs, "togglePluginPack", ["pack-one", true])).resolves.toEqual({
      success: true,
      name: "pack-one",
      enabled: true,
    });
    await expect(
      invoke(defs, "togglePluginPackSkill", ["pack-one", "skill-one", false]),
    ).resolves.toEqual({
      success: true,
      packName: "pack-one",
      skillId: "skill-one",
      enabled: false,
    });
    expect(pluginPackToggleService.setPackEnabled).toHaveBeenCalledWith("pack-one", true);
    expect(pluginPackToggleService.setSkillEnabled).toHaveBeenCalledWith(
      "pack-one",
      "skill-one",
      false,
    );
  });

  it("rejects malformed pack-toggle identifiers, desired states, and argument counts", () => {
    const defs = definitions();
    const rpcMethods = new BrowserDesktopRpcService(defs).methods();
    for (const [name, args] of [
      ["togglePluginPack", ["/Users/private/pack", true]],
      ["togglePluginPack", ["pack-one", "true"]],
      ["togglePluginPack", ["pack-one", true, "extra"]],
      ["togglePluginPackSkill", ["pack-one", "../skill", false]],
      ["togglePluginPackSkill", ["pack-one", "skill-one", 1]],
    ] as const) {
      expect(() => rpcMethods[`desktop.${name}`].validateParams?.({ args })).toThrow();
    }
  });

  it("returns bounded chat choices only for enabled channels", async () => {
    const gateway = {
      getChannel: vi.fn(async (id: string) =>
        id === "enabled-channel" ? { id, type: "telegram", enabled: true } : undefined,
      ),
      getDistinctChatIds: vi.fn(async () => [
        { chatId: "chat-one", lastTimestamp: 123 },
        { chatId: "chat-two", lastTimestamp: -1 },
      ]),
    } as unknown as ChannelGateway;
    const defs = definitions(undefined, undefined, undefined, gateway);

    expect(defs.getGatewayChats?.capability).toBe("automation.manage");
    await expect(invoke(defs, "getGatewayChats", ["enabled-channel"])).resolves.toEqual([
      { chatId: "chat-one", lastTimestamp: 123 },
      { chatId: "chat-two", lastTimestamp: 0 },
    ]);
    expect(gateway.getDistinctChatIds).toHaveBeenCalledWith("enabled-channel", 200);
    await expect(invoke(defs, "getGatewayChats", ["missing-channel"])).resolves.toEqual([]);
    expect(gateway.getDistinctChatIds).toHaveBeenCalledTimes(1);
  });

  it("accepts scheduled-task access profiles while rejecting browser shell-access escalation", () => {
    const cronService = {} as CronService;
    const defs = definitions(undefined, undefined, undefined, undefined, undefined, cronService);
    const job = {
      name: "Disposable report",
      enabled: false,
      accessProfileId: "ask_for_approval",
      workspaceId: workspace.id,
      taskPrompt: "Summarize local changes.",
      schedule: { kind: "every", everyMs: 60 * 60 * 1000, anchorMs: Date.now() },
      delivery: { enabled: false },
    };

    expect(defs.addCronJob?.validate?.([job])).toEqual([job]);
    expect(() =>
      defs.addCronJob?.validate?.([{ ...job, accessProfileId: "../full-access" }]),
    ).toThrow();
    expect(() => defs.addCronJob?.validate?.([{ ...job, shellAccess: true }])).toThrow();
    expect(() => defs.updateCronJob?.validate?.(["cron-job-1", { shellAccess: true }])).toThrow();
    expect(defs.updateCronJob?.validate?.(["cron-job-1", { shellAccess: false }])).toEqual([
      "cron-job-1",
      { shellAccess: false },
    ]);
  });

  it("lets a scheduled follow-up target only a task in its own workspace", async () => {
    const other = new WorkspaceStore(db).create("Other", path.join(tempDir, "other"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const tasks = new TaskStore(db);
    const own = tasks.create({
      title: "Own thread",
      prompt: "Own",
      status: "completed",
      workspaceId: workspace.id,
    } as never);
    const foreign = tasks.create({
      title: "Other thread",
      prompt: "Other",
      status: "completed",
      workspaceId: other.id,
    } as never);
    const add = vi.fn(async (job: Record<string, unknown>) => ({
      ok: true,
      job: { ...job, id: "cron-1", state: { runHistory: [] } },
    }));
    const cronService = { add } as unknown as CronService;
    const defs = definitions(undefined, undefined, undefined, undefined, undefined, cronService);
    const job = (targetTaskId: string) => ({
      name: "Morning nudge",
      enabled: true,
      accessProfileId: "ask_for_approval",
      workspaceId: workspace.id,
      taskPrompt: "Continue.",
      runMode: "thread_follow_up",
      targetTaskId,
      schedule: { kind: "every", everyMs: 60 * 60 * 1000, anchorMs: Date.now() },
      delivery: { enabled: false },
    });

    await expect(invoke(defs, "addCronJob", [job(own.id)])).resolves.toMatchObject({ ok: true });
    await expect(invoke(defs, "addCronJob", [job(foreign.id)])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(invoke(defs, "addCronJob", [job("missing-task")])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("sends only the fixed scheduled-task test message through an enabled host channel", async () => {
    const gateway = {
      getChannel: vi.fn(async (id: string) => ({
        id,
        type: "slack",
        enabled: id === "enabled-channel",
      })),
      sendMessage: vi.fn(async () => "message-id"),
    } as unknown as ChannelGateway;
    const defs = definitions(undefined, undefined, undefined, gateway);
    const definition = defs.sendGatewayTestMessage;

    expect(definition?.capability).toBe("automation.manage");
    expect(definition?.mutation).toBe(true);
    await expect(
      invoke(defs, "sendGatewayTestMessage", [
        { channelType: "telegram", channelDbId: "enabled-channel", chatId: "chat-123" },
      ]),
    ).resolves.toEqual({ ok: true });
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      "slack",
      "chat-123",
      "Test delivery from CoWork OS",
      { channelDbId: "enabled-channel", parseMode: "text" },
    );

    await expect(
      invoke(defs, "sendGatewayTestMessage", [
        { channelType: "telegram", channelDbId: "disabled-channel", chatId: "chat-123" },
      ]),
    ).rejects.toThrow("Choose an enabled channel");
    expect(gateway.sendMessage).toHaveBeenCalledTimes(1);
    expect(() =>
      definition?.validate?.([
        { channelType: "telegram", chatId: "chat-123", message: "arbitrary" },
      ]),
    ).toThrow();
  });

  it("returns bounded pack metadata required by CustomizePanel without prompts, paths, or secrets", async () => {
    const listPluginPacks = vi.fn(async () => [
      {
        manifest: {
          name: "safe-pack",
          displayName: "Safe Pack",
          version: "1.2.3",
          description: "A review pack backed by /Users/alice/private-workspace",
          category: "Operations",
          scope: "personal",
          personaTemplateId: "operator",
          recommendedConnectors: ["jira", "C:\\Users\\alice\\secret"],
          tryAsking: ["Private prompt: disclose customer credentials"],
          bestFitWorkflows: ["it_ops", "unsupported"],
          outcomeExamples: ["Review a queue", "/Users/alice/private-workspace/output.csv"],
          skills: [
            {
              id: "review-queue",
              name: "Review Queue",
              description: "Review a support queue",
              icon: "📋",
              enabled: false,
              prompt: "Private skill instructions",
              filePath: "/Users/alice/private-workspace/SKILL.md",
              config: { API_TOKEN: "private-value" },
            },
          ],
          skillDirectories: [
            {
              id: "directory-skill",
              path: "/Users/alice/private-workspace/skills/directory-skill",
              systemPrompt: "Another private prompt",
            },
          ],
          slashCommands: [
            {
              name: "review-queue",
              description: "Review the queue",
              skillId: "review-queue",
              prompt: "Do not return this prompt",
            },
          ],
          agentRoles: [
            {
              name: "queue-reviewer",
              displayName: "Queue Reviewer",
              description: "A bounded role description",
              icon: "🤖",
              color: "#112233",
              systemPrompt: "Private role prompt",
              capabilities: ["secret-capability"],
            },
          ],
          configSchema: { properties: { token: { default: "private-value", secret: true } } },
          dependencies: { "private-package": "private-version" },
        },
        state: "registered",
        securityReport: {
          verdict: "warning",
          summary: "Found /Users/alice/private-workspace/SKILL.md",
          findings: [{ path: "/Users/alice/private-workspace/SKILL.md" }],
        },
      },
      {
        manifest: {
          name: "Users/alice/private-pack.json",
          displayName: "Path-like pack must be rejected",
        },
      },
    ]);
    const defs = definitions(undefined, { listPluginPacks });

    const packs = (await invoke(defs, "listPluginPacks")) as Array<Record<string, unknown>>;

    expect(listPluginPacks).toHaveBeenCalledOnce();
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      name: "safe-pack",
      displayName: "Safe Pack",
      version: "1.2.3",
      description: "A review pack backed by [host path]",
      scope: "personal",
      recommendedConnectors: ["jira"],
      bestFitWorkflows: ["it_ops"],
      skills: [
        {
          id: "review-queue",
          name: "Review Queue",
          description: "Review a support queue",
          icon: "📋",
          enabled: false,
        },
        {
          id: "directory-skill",
          name: "Directory Skill",
          description: "Directory-backed skill",
          enabled: true,
        },
      ],
      slashCommands: [
        { name: "review-queue", description: "Review the queue", skillId: "review-queue" },
      ],
      agentRoles: [
        {
          name: "queue-reviewer",
          displayName: "Queue Reviewer",
          description: "A bounded role description",
          icon: "🤖",
          color: "#112233",
        },
      ],
      state: "registered",
      enabled: true,
      policyBlocked: false,
      policyRequired: false,
      securityReport: {
        verdict: "warning",
        summary: "Security findings require review.",
      },
    });
    expect(packs[0]).not.toHaveProperty("tryAsking");
    const serialized = JSON.stringify(packs);
    for (const privateValue of [
      "Private prompt",
      "systemPrompt",
      "private-value",
      "private-capability",
      "private-version",
      "configSchema",
      "dependencies",
      "/Users/alice",
      "C:\\Users\\alice",
      "filePath",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }

    const manyChildren = {
      manifest: {
        name: "bounded-pack",
        skills: Array.from({ length: 125 }, (_, index) => ({
          id: `skill-${index}`,
          name: `Skill ${index}`,
        })),
        slashCommands: Array.from({ length: 125 }, (_, index) => ({
          name: `command-${index}`,
          skillId: `skill-${index}`,
        })),
        agentRoles: Array.from({ length: 125 }, (_, index) => ({
          name: `role-${index}`,
          displayName: `Role ${index}`,
        })),
      },
      state: "registered",
    };
    const boundedDefs = definitions(undefined, {
      listPluginPacks: async () => [manyChildren],
    });
    const boundedPacks = (await invoke(boundedDefs, "listPluginPacks")) as Array<{
      skills: unknown[];
      slashCommands: unknown[];
      agentRoles: unknown[];
    }>;
    expect(boundedPacks[0]?.skills).toHaveLength(100);
    expect(boundedPacks[0]?.slashCommands).toHaveLength(100);
    expect(boundedPacks[0]?.agentRoles).toHaveLength(100);
  });

  it("reports error-state packs as disabled rather than claiming runtime registration", async () => {
    const defs = definitions(undefined, {
      listPluginPacks: async () => [
        {
          manifest: { name: "error-pack", displayName: "Error Pack" },
          state: "error",
        },
      ],
    });
    const packs = (await invoke(defs, "listPluginPacks")) as Array<Record<string, unknown>>;
    expect(packs[0]).toMatchObject({ state: "error", enabled: false });
  });

  it("returns skill readiness without prompts, configuration values, security paths, or host directories", async () => {
    const defs = definitions(undefined, {
      getSkillStatus: vi.fn(async () => ({
        workspaceDir: "/Users/alice/private-workspace",
        managedSkillsDir: "/Users/alice/.config/cowork/skills",
        bundledSkillsDir: "/opt/cowork/skills",
        externalSkillDirs: ["/Users/alice/third-party-skills"],
        skills: [
          {
            id: "outline",
            name: "Outline",
            description: "Make a concise outline",
            icon: "🧭",
            prompt: "private instructions and access token",
            filePath: "/Users/alice/.config/cowork/skills/outline.json",
            source: "managed",
            category: "ClawHub",
            metadata: {
              version: "1.2.0",
              homepage: "https://clawhub.ai/owner/outline?token=private-token",
              repository: "https://example.test/private-repository",
            },
            eligible: false,
            disabled: false,
            blockedByAllowlist: true,
            missing: {
              bins: ["python"],
              anyBins: [],
              env: ["PRIVATE_API_TOKEN"],
              config: [],
              os: [],
            },
            requirements: { env: ["PRIVATE_API_TOKEN"] },
            securityReport: {
              verdict: "warning",
              summary: "Review /Users/alice/private-workspace/source.py",
              bundleDigest: "private-digest",
              findings: [{ path: "/Users/alice/private-workspace/source.py" }],
            },
          },
        ],
        summary: { total: 1, eligible: 0, disabled: 0, missingRequirements: 1 },
      })),
    });

    const report = (await invoke(defs, "getSkillStatus")) as Record<string, unknown>;
    const skills = report.skills as Array<Record<string, unknown>>;
    expect(skills[0]).toMatchObject({
      id: "outline",
      name: "Outline",
      source: "managed",
      category: "ClawHub",
      eligible: false,
      blockedByAllowlist: true,
      missing: { bins: ["python"], env: ["PRIVATE_API_TOKEN"] },
      metadata: { version: "1.2.0", homepage: "https://clawhub.ai/owner/outline" },
      securityReport: { verdict: "warning" },
    });
    expect(report).toMatchObject({
      workspaceDir: "",
      managedSkillsDir: "",
      bundledSkillsDir: "",
      externalSkillDirs: [],
      summary: { total: 1, missingRequirements: 1 },
    });
    expect(JSON.stringify(report)).not.toContain("private instructions");
    expect(JSON.stringify(report)).not.toContain("private-repository");
    expect(JSON.stringify(report)).not.toContain("private-token");
    expect(JSON.stringify(report)).not.toContain("private-digest");
    expect(JSON.stringify(report)).not.toContain("/Users/alice");
    expect(JSON.stringify(report)).not.toContain("filePath");
    expect(JSON.stringify(report)).not.toContain("requirements");
  });

  it("lists only sanitized skill quarantine metadata and findings", async () => {
    const defs = definitions(undefined, {
      listQuarantinedImports: () => [
        {
          id: "quarantine-1",
          bundleKind: "skill",
          bundleId: "dangerous-skill",
          displayName: "Dangerous Skill",
          quarantinedAt: "2026-09-29T12:00:00Z",
          summary:
            "Blocked file /Users/alice/private-workspace/skill.md and C:\\Users\\alice\\private-workspace\\skill.md",
          filePath: "/Users/alice/.config/cowork/quarantine/record.json",
          report: {
            verdict: "quarantined",
            summary: "Review /Users/alice/private-workspace/skill.md",
            bundleDigest: "private-digest",
            findings: [
              {
                code: "script-execution",
                severity: "critical",
                message: "Found /Users/alice/private-workspace/skill.md",
                path: "/Users/alice/private-workspace/skill.md",
                detail: "private details",
              },
            ],
          },
        },
        {
          id: "quarantine-pack",
          bundleKind: "plugin-pack",
          bundleId: "untrusted-pack",
          report: { findings: [] },
        },
      ],
    });

    const records = (await invoke(defs, "listQuarantinedImports")) as Array<
      Record<string, unknown>
    >;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "quarantine-1",
      bundleKind: "skill",
      bundleId: "dangerous-skill",
      report: {
        verdict: "quarantined",
        findings: [{ code: "script-execution", severity: "critical" }],
      },
    });
    expect(JSON.stringify(records)).not.toContain("/Users/alice");
    expect(JSON.stringify(records)).not.toContain("C:\\Users\\alice");
    expect(JSON.stringify(records)).not.toContain("private-digest");
    expect(JSON.stringify(records)).not.toContain("private details");
    expect(JSON.stringify(records)).not.toContain("quarantine-pack");
    expect(JSON.stringify(records)).not.toContain("filePath");
  });

  it("bounds catalog queries and strips install links and package content from discovery results", async () => {
    const searchSkillRegistry = vi.fn(async (query: string) => ({
      query,
      total: 1,
      page: 1,
      pageSize: 20,
      results: [
        {
          id: "safe-skill",
          name: "Safe Skill",
          description: "Public catalog entry",
          version: "1.0.0",
          source: "cowork",
          author: "CoWork",
          tags: ["review"],
          homepage: "https://example.test/hidden-homepage",
          prompt: "private catalog payload",
        },
        {
          id: "Users/alice/private-skill.json",
          name: "Path-like identifier",
          description: "Must not cross the host boundary",
          version: "1.0.0",
        },
      ],
    }));
    const searchPackRegistry = vi.fn(async (query: string) => ({
      query,
      total: 1,
      page: 1,
      pageSize: 24,
      results: [
        {
          id: "safe-pack",
          name: "safe-pack",
          displayName: "Safe Pack",
          description: "Public pack metadata",
          skillCount: 2,
          downloadUrl: "https://example.test/untrusted-download",
          gitUrl: "https://example.test/untrusted-git",
        },
      ],
    }));
    const defs = definitions(undefined, {
      searchSkillRegistry,
      searchClawHubSkills: vi.fn(async () => ({ results: [] })),
      searchPackRegistry,
    });

    const skills = (await invoke(defs, "searchSkillRegistry", [
      "outline",
      { page: 1, pageSize: 10 },
    ])) as Record<string, unknown>;
    expect(searchSkillRegistry).toHaveBeenCalledWith("outline", { page: 1, pageSize: 10 });
    expect(skills.results).toEqual([
      expect.objectContaining({ id: "safe-skill", name: "Safe Skill", tags: ["review"] }),
    ]);
    expect(JSON.stringify(skills)).not.toContain("hidden-homepage");
    expect(JSON.stringify(skills)).not.toContain("private catalog payload");
    expect(JSON.stringify(skills)).not.toContain("Users/alice");

    const packs = (await invoke(defs, "searchPackRegistry", [
      "pack",
      { page: 1, pageSize: 24 },
    ])) as Record<string, unknown>;
    expect(searchPackRegistry).toHaveBeenCalledWith("pack", { page: 1, pageSize: 24 });
    expect(packs.results).toEqual([
      expect.objectContaining({ id: "safe-pack", displayName: "Safe Pack", skillCount: 2 }),
    ]);
    expect(JSON.stringify(packs)).not.toContain("untrusted-download");
    expect(JSON.stringify(packs)).not.toContain("untrusted-git");

    await expect(
      invoke(defs, "searchSkillRegistry", ["outline", { pageSize: 51 }]),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(invoke(defs, "searchSkillRegistry", ["x".repeat(257)])).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(searchSkillRegistry).toHaveBeenCalledTimes(1);
  });

  it("returns MCP catalog and connection summaries without commands, URLs, env values, or server data", async () => {
    const mcpEntry = {
      id: "postgres",
      name: "PostgreSQL",
      description: "Read-only database connector",
      version: "1.0.0",
      author: "CoWork",
      homepage: "https://example.test/homepage",
      repository: "https://example.test/repository",
      license: "MIT",
      installMethod: "npm",
      installCommand: "npx",
      packageName: "@example/server",
      transport: "stdio",
      defaultCommand: "npx",
      defaultUrl: "https://example.test/endpoint",
      defaultArgs: ["--token", "secret-token"],
      defaultEnv: { API_TOKEN: "secret-value" },
      tools: [{ name: "query", description: "Run query" }],
      tags: ["database"],
      category: "data",
      verified: true,
    };
    const defs = definitions(undefined, {
      fetchMCPRegistry: vi.fn(async () => ({
        version: "1",
        lastUpdated: "2026-09-29",
        servers: [mcpEntry],
      })),
      searchMCPRegistry: vi.fn(async () => [mcpEntry]),
      getMCPStatus: () => [
        {
          id: "server-1",
          name: "PostgreSQL",
          status: "error",
          error: "secret-token /Users/alice/private.txt",
          tools: [{ name: "query", description: "private data" }],
          resources: [{ uri: "file:///Users/alice/private.txt" }],
          serverInfo: { name: "private server info" },
          uptime: 50,
        },
      ],
    });

    const registry = (await invoke(defs, "fetchMCPRegistry")) as Record<string, unknown>;
    expect(registry.servers).toEqual([
      expect.objectContaining({
        id: "postgres",
        installMethod: "npm",
        tools: [{ name: "query", description: "Run query" }],
      }),
    ]);
    expect(JSON.stringify(registry)).not.toContain("secret-value");
    expect(JSON.stringify(registry)).not.toContain("secret-token");
    expect(JSON.stringify(registry)).not.toContain("defaultEnv");
    expect(JSON.stringify(registry)).not.toContain("defaultUrl");
    expect(JSON.stringify(registry)).not.toContain("installCommand");
    expect(JSON.stringify(registry)).not.toContain("repository");

    const search = (await invoke(defs, "searchMCPRegistry", ["postgres", ["database"]])) as Array<
      Record<string, unknown>
    >;
    expect(search).toHaveLength(1);
    expect(JSON.stringify(search)).not.toContain("secret-value");

    const statuses = (await invoke(defs, "getMCPStatus")) as Array<Record<string, unknown>>;
    expect(statuses).toEqual([
      expect.objectContaining({ id: "server-1", name: "PostgreSQL", status: "error", uptime: 50 }),
    ]);
    expect(JSON.stringify(statuses)).not.toContain("secret-token");
    expect(JSON.stringify(statuses)).not.toContain("private.txt");
    expect(JSON.stringify(statuses)).not.toContain("private data");

    await expect(
      invoke(defs, "searchMCPRegistry", ["postgres", Array.from({ length: 21 }, () => "x")]),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("rejects malformed mutation arguments before dispatching a handler", () => {
    const defs = definitions();
    const createRoutine = defs.createManagedAgentRoutine;
    const handler = vi.spyOn(createRoutine, "handler");

    expect(() =>
      createRoutine.validate!([
        { agentId: "agent-1", name: "Daily", trigger: { type: "schedule", cadenceMinutes: "bad" } },
      ]),
    ).toThrow();
    expect(() =>
      defs.updateManagedAgentRoutine.validate!([{ agentId: "agent-1", name: "Renamed" }]),
    ).toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires a saved routine for live workflow tests", async () => {
    const testWorkflow = vi.fn(async () => ({ run: {}, steps: [] }));
    routineService = {
      getWorkflowCapabilities: () => ({ operations: [] }),
      validateWorkflow: () => ({ issues: [] }),
      testWorkflow,
    } as unknown as RoutineService;

    await expect(
      invoke(definitions(), "testRoutineWorkflow", [
        {
          workflow: {
            version: 1,
            starterNodeId: "manual",
            nodes: [
              {
                id: "manual",
                kind: "starter",
                operation: "starter.manual",
                name: "Manual",
                config: {},
              },
            ],
            edges: [],
          },
          dryRun: false,
        },
      ]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(testWorkflow).not.toHaveBeenCalled();
  });

  it("requires a writable, agent-enabled workspace for live workflow tests", async () => {
    const readOnly = new WorkspaceStore(db).create("Read only", path.join(tempDir, "read-only"), {
      read: true,
      write: false,
      delete: false,
      network: false,
      shell: false,
    });
    const routine = { id: "routine-read-only", workspaceId: readOnly.id };
    const testWorkflow = vi.fn(async () => ({ run: {}, steps: [] }));
    routineService = {
      getWorkflowCapabilities: () => ({ operations: [] }),
      get: vi.fn(async (id: string) => (id === routine.id ? routine : null)),
      validateWorkflow: () => ({ issues: [] }),
      testWorkflow,
    } as unknown as RoutineService;
    const defs = definitions();
    const request = {
      routineId: routine.id,
      workflow: {
        version: 1,
        starterNodeId: "manual",
        nodes: [
          {
            id: "manual",
            kind: "starter",
            operation: "starter.manual",
            name: "Manual",
            config: {},
          },
        ],
        edges: [],
      },
      dryRun: false,
    };

    await expect(invoke(defs, "testRoutineWorkflow", [request])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(testWorkflow).not.toHaveBeenCalled();

    const writableRoutine = { id: "routine-writable", workspaceId: workspace.id };
    const agentDenied = vi.fn(async () => ({
      canViewAgents: true,
      canRunAgents: false,
      canResumeSessions: true,
      canAnswerApprovals: true,
      canEditDrafts: true,
      canManageEnvironments: true,
      canPublishAgents: true,
      canManageRoutines: true,
      canManageMemberships: true,
      canAuditAgents: true,
    }));
    vi.spyOn(managed, "getMyWorkspacePermissions").mockImplementation(agentDenied);
    routineService = {
      getWorkflowCapabilities: () => ({ operations: [] }),
      get: vi.fn(async (id: string) => (id === writableRoutine.id ? writableRoutine : null)),
      validateWorkflow: () => ({ issues: [] }),
      testWorkflow,
    } as unknown as RoutineService;

    await expect(
      invoke(definitions(), "testRoutineWorkflow", [{ ...request, routineId: writableRoutine.id }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(agentDenied).toHaveBeenCalledWith(workspace.id);
    expect(testWorkflow).not.toHaveBeenCalled();
  });

  it("allows a live workflow test through a saved routine in a writable agent-enabled workspace", async () => {
    const routine = { id: "routine-live", workspaceId: workspace.id };
    const testWorkflow = vi.fn(async () => ({ run: { id: "run-1" }, steps: [] }));
    routineService = {
      getWorkflowCapabilities: () => ({ operations: [] }),
      get: vi.fn(async (id: string) => (id === routine.id ? routine : null)),
      validateWorkflow: () => ({ issues: [] }),
      testWorkflow,
    } as unknown as RoutineService;
    const workflow = {
      version: 1,
      starterNodeId: "manual",
      nodes: [
        { id: "manual", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
      ],
      edges: [],
    };

    await expect(
      invoke(definitions(), "testRoutineWorkflow", [
        { routineId: routine.id, workflow, dryRun: false },
      ]),
    ).resolves.toEqual({ run: { id: "run-1" }, steps: [] });
    expect(testWorkflow).toHaveBeenCalledWith({ routineId: routine.id, workflow, dryRun: false });
  });

  it("returns workspaces only inside the effective readable scope", async () => {
    const hidden = new WorkspaceStore(db).create("Hidden", path.join(tempDir, "hidden"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const defs = definitions(async (id) =>
      id === hidden.id ? null : workspaceRepository.findById(id),
    );

    await expect(invoke(defs, "listWorkspaces")).resolves.toEqual([
      expect.objectContaining({ id: workspace.id }),
    ]);
  });
});
