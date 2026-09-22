import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentDaemon, shouldRestartInterruptedTask } from "../daemon";

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
type Any = Record<string, any>;

describeWithSqlite("AgentDaemon bot recovery", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-daemon-bot-recovery-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    const { DatabaseManager } = await import("../../database/schema");
    manager = new DatabaseManager();
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("repairs revoked membership only after explicit reopen approval", async () => {
    const [repositories, botTeam] = await Promise.all([
      import("../../database/repositories"),
      import("../../agents/bot-team"),
    ]);
    const workspace = new repositories.WorkspaceRepository(manager.getDatabase()).create(
      "Bot recovery workspace",
      tempDir,
      { read: true, write: true, delete: true, network: true, shell: false },
    );
    const seeded = botTeam.ensureDefaultBotTeam(manager.getDatabase(), workspace.id);
    expect(seeded).toBeTruthy();
    const role = seeded!.roles.find((candidate) => candidate.name === "scribe")!;
    const memberRepo = new (
      await import("../../agents/AgentTeamMemberRepository")
    ).AgentTeamMemberRepository(manager.getDatabase());
    expect(memberRepo.removeByTeamAndRole(seeded!.team.id, role.id)).toBe(true);

    const taskRepo = new repositories.TaskRepository(manager.getDatabase());
    const oldTask = taskRepo.create({
      title: role.displayName,
      prompt: "Old bot conversation",
      status: "failed",
      workspaceId: workspace.id,
      assignedAgentRoleId: role.id,
      agentConfig: {
        botConversation: true,
        botTeamId: seeded!.team.id,
        conversationMode: "hybrid",
        executionMode: "execute",
        executionModeSource: "strategy",
      },
    });

    const createTask = async (params: Any): Promise<Any> =>
      taskRepo.create({
        title: params.title,
        prompt: params.prompt,
        status: "pending",
        workspaceId: params.workspaceId,
        assignedAgentRoleId: params.taskOverrides?.assignedAgentRoleId,
        agentConfig: params.agentConfig,
      });
    const daemonLike = {
      dbManager: manager,
      taskRepo,
      createTask,
      logEvent: vi.fn(),
    } as Any;

    await expect(
      AgentDaemon.prototype.reopenBotConversation.call(daemonLike, {
        workspaceId: workspace.id,
        taskId: oldTask.id,
      }),
    ).rejects.toThrow("BOT_MEMBERSHIP_REVOKED");
    expect(memberRepo.findByTeamAndRole(seeded!.team.id, role.id)).toBeUndefined();

    const reopened = await AgentDaemon.prototype.reopenBotConversation.call(daemonLike, {
      workspaceId: workspace.id,
      taskId: oldTask.id,
      repairMembership: true,
    });

    expect(reopened.id).not.toBe(oldTask.id);
    expect(reopened.workspaceId).toBe(workspace.id);
    expect(reopened.assignedAgentRoleId).toBe(role.id);
    expect(reopened.agentConfig).toMatchObject({
      botConversation: true,
      botTeamId: seeded!.team.id,
    });
    expect(taskRepo.findById(oldTask.id)?.status).toBe("failed");
    expect(memberRepo.findByTeamAndRole(seeded!.team.id, role.id)).toBeTruthy();
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      reopened.id,
      "task_created",
      expect.objectContaining({ recoveryAction: "repair_membership" }),
    );
  });

  it("reports a missing reusable conversation without making the peer look available", async () => {
    const [repositories, botTeam] = await Promise.all([
      import("../../database/repositories"),
      import("../../agents/bot-team"),
    ]);
    const workspace = new repositories.WorkspaceRepository(manager.getDatabase()).create(
      "Bot peer workspace",
      tempDir,
      { read: true, write: true, delete: true, network: true, shell: false },
    );
    const seeded = botTeam.ensureDefaultBotTeam(manager.getDatabase(), workspace.id)!;
    const atlas = seeded.roles.find((candidate) => candidate.name === "atlas-your-chief-of-staff")!;
    const forge = seeded.roles.find((candidate) => candidate.name === "forge")!;
    const taskRepo = new repositories.TaskRepository(manager.getDatabase());
    const sender = taskRepo.create({
      title: atlas.displayName,
      prompt: "Atlas",
      status: "pending",
      workspaceId: workspace.id,
      assignedAgentRoleId: atlas.id,
      agentConfig: {
        botConversation: true,
        botTeamId: seeded.team.id,
        conversationMode: "hybrid",
        executionMode: "execute",
        executionModeSource: "strategy",
      },
    });
    const daemonLike = { dbManager: manager, taskRepo } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const peers = await AgentDaemon.prototype.listBotTeamPeers.call(daemonLike, sender.id);
    const forgePeer = peers.find((peer) => peer.roleId === forge.id);
    expect(forgePeer).toMatchObject({
      roleId: forge.id,
      available: false,
      availability: "conversation_unavailable",
      recoveryAction: "reopen",
    });
  });

  it("repairs a missing member on the reserved default team during routing", async () => {
    const [repositories, botTeam, memberModule] = await Promise.all([
      import("../../database/repositories"),
      import("../../agents/bot-team"),
      import("../../agents/AgentTeamMemberRepository"),
    ]);
    const workspace = new repositories.WorkspaceRepository(manager.getDatabase()).create(
      "Bot roster repair workspace",
      tempDir,
      { read: true, write: true, delete: true, network: true, shell: false },
    );
    const seeded = botTeam.ensureDefaultBotTeam(manager.getDatabase(), workspace.id)!;
    const cco = seeded.roles.find((candidate) => candidate.name === "chief-community-officer")!;
    const memberRepo = new memberModule.AgentTeamMemberRepository(manager.getDatabase());
    expect(memberRepo.removeByTeamAndRole(seeded.team.id, cco.id)).toBe(true);

    const taskRepo = new repositories.TaskRepository(manager.getDatabase());
    const task = taskRepo.create({
      title: cco.displayName,
      prompt: "Find community opportunities",
      status: "pending",
      workspaceId: workspace.id,
      assignedAgentRoleId: cco.id,
      agentConfig: {
        botConversation: true,
        botTeamId: seeded.team.id,
        conversationMode: "hybrid",
        executionMode: "execute",
        executionModeSource: "strategy",
      },
    });
    const daemonLike = { dbManager: manager, taskRepo } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const normalized = (AgentDaemon.prototype as Any).ensureBotTaskTeam.call(daemonLike, task);

    expect(normalized.agentConfig?.botTeamId).toBe(seeded.team.id);
    expect(memberRepo.findByTeamAndRole(seeded.team.id, cco.id)).toBeTruthy();
  });

  it("reconciles the reserved team when a bot conversation crosses temporary workspaces", async () => {
    const [repositories, botTeam] = await Promise.all([
      import("../../database/repositories"),
      import("../../agents/bot-team"),
    ]);
    const previousWorkspaceId = "__temp_workspace__:previous-ui-session";
    const currentWorkspaceId = "__temp_workspace__:current-ui-session";
    const insertWorkspace = (id: string, name: string, workspacePath: string) => {
      const now = Date.now();
      manager
        .getDatabase()
        .prepare(
          "INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          name,
          workspacePath,
          now,
          now,
          JSON.stringify({ read: true, write: true, delete: true, network: true, shell: false }),
        );
    };
    insertWorkspace(previousWorkspaceId, "Previous Temporary Workspace", `${tempDir}/previous`);
    insertWorkspace(currentWorkspaceId, "Current Temporary Workspace", `${tempDir}/current`);
    const previousTeam = botTeam.ensureDefaultBotTeam(manager.getDatabase(), previousWorkspaceId)!;
    const atlas = previousTeam.roles.find(
      (candidate) => candidate.name === "atlas-your-chief-of-staff",
    )!;
    const taskRepo = new repositories.TaskRepository(manager.getDatabase());
    const sender = taskRepo.create({
      title: atlas.displayName,
      prompt: "Coordinate the current workspace",
      status: "pending",
      workspaceId: currentWorkspaceId,
      assignedAgentRoleId: atlas.id,
      agentConfig: {
        botConversation: true,
        botTeamId: previousTeam.team.id,
        conversationMode: "hybrid",
        executionMode: "execute",
        executionModeSource: "strategy",
      },
    });
    const createTask = async (params: Any): Promise<Any> =>
      taskRepo.create({
        title: params.title,
        prompt: params.prompt,
        status: "pending",
        workspaceId: params.workspaceId,
        assignedAgentRoleId: params.taskOverrides?.assignedAgentRoleId,
        agentConfig: params.agentConfig,
      });
    const daemonLike = {
      dbManager: manager,
      taskRepo,
      createTask,
      logEvent: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const resolved = await AgentDaemon.prototype.resolveBotTeamPeer.call(daemonLike, sender.id, {
      botName: "scribe",
    });

    expect(resolved).toMatchObject({ ok: true });
    const updatedSender = taskRepo.findById(sender.id)!;
    const currentTeam = new (await import("../../agents/AgentTeamRepository")).AgentTeamRepository(
      manager.getDatabase(),
    ).findByName(currentWorkspaceId, botTeam.DEFAULT_BOT_TEAM_NAME);
    expect(currentTeam).toBeTruthy();
    expect(updatedSender.agentConfig?.botTeamId).toBe(currentTeam?.id);
    expect(updatedSender.agentConfig?.botTeamId).not.toBe(previousTeam.team.id);
    expect((resolved as Any).task.workspaceId).toBe(currentWorkspaceId);
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      sender.id,
      "log",
      expect.objectContaining({
        previousBotTeamId: previousTeam.team.id,
        botTeamId: currentTeam?.id,
        workspaceId: currentWorkspaceId,
      }),
    );
  });

  it("replays a delivered teammate handoff after a restart when no plan was persisted", () => {
    const task = {
      id: "receiver-task",
      agentConfig: { botConversation: true },
    } as Any;
    const events = [
      {
        id: "inbound",
        type: "user_message",
        timestamp: 2,
        payload: {
          message: "PROMO_RESEARCH\nFind five opportunities.",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          messageId: "handoff-1",
          senderTaskId: "sender-task",
          senderLabel: "Product Engineer",
        },
      },
    ];
    const daemonLike = { resolveLegacyEventType: (event: Any) => event.type } as Any;

    expect(
      (AgentDaemon.prototype as Any).findRecoverableBotHandoff.call(daemonLike, task, events),
    ).toMatchObject({
      message: "PROMO_RESEARCH\nFind five opportunities.",
      messageSource: "agent",
      messageId: "handoff-1",
      senderTaskId: "sender-task",
      senderLabel: "Product Engineer",
    });
  });

  it("treats a delivered teammate handoff as resumable state without a snapshot or plan", () => {
    expect(
      shouldRestartInterruptedTask({
        hasSnapshot: false,
        hasPlan: false,
        hasRecoveredBotHandoff: true,
      }),
    ).toBe(false);
    expect(
      shouldRestartInterruptedTask({
        hasSnapshot: false,
        hasPlan: false,
        hasRecoveredBotHandoff: false,
      }),
    ).toBe(true);
  });

  it("does not replay an already-replied handoff from the legacy durable shape", () => {
    const task = {
      id: "receiver-task",
      agentConfig: { botConversation: true },
    } as Any;
    const events = [
      {
        id: "inbound",
        type: "user_message",
        timestamp: 2,
        payload: {
          message: "PROMO_RESEARCH\nFind five opportunities.",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          messageId: "handoff-1",
          senderTaskId: "sender-task",
        },
      },
      {
        id: "reply",
        type: "agent_message",
        timestamp: 3,
        payload: {
          message: "DONE\nResearch complete.",
          inReplyToMessageId: "handoff-1",
        },
      },
    ];
    const daemonLike = { resolveLegacyEventType: (event: Any) => event.type } as Any;

    expect(
      (AgentDaemon.prototype as Any).findRecoverableBotHandoff.call(daemonLike, task, events),
    ).toBeUndefined();
  });
});
