import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

  async function fixture(teamName = "User configured team") {
    const repositories = await import("../../database/repositories");
    const { AgentRoleStore } = await import("../../agents/AgentRoleRepository");
    const { AgentTeamStore } = await import("../../agents/AgentTeamRepository");
    const { AgentTeamMemberStore } = await import("../../agents/AgentTeamMemberRepository");
    const db = manager.getDatabase();
    const workspace = new repositories.WorkspaceStore(db).create("Bot workspace", tempDir, {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: false,
    });
    const roleRepo = new AgentRoleStore(db);
    const roles = ["Coordinator", "Researcher", "Maker"].map((displayName) =>
      roleRepo.create({
        name: `custom-${randomUUID()}`,
        displayName,
        systemPrompt: `User instructions for ${displayName}`,
        capabilities: ["research"],
      }),
    );
    const team = new AgentTeamStore(db).create({
      workspaceId: workspace.id,
      name: teamName,
      leadAgentRoleId: roles[0].id,
      persistent: true,
    });
    const memberRepo = new AgentTeamMemberStore(db);
    roles.forEach((role) => memberRepo.add({ teamId: team.id, agentRoleId: role.id }));
    const taskRepo = new repositories.TaskStore(db);
    const daemon = {
      dbManager: manager,
      taskRepo,
      logEvent: vi.fn(),
      createTask: vi.fn(async (params: Any) =>
        taskRepo.create({
          title: params.title,
          prompt: params.prompt,
          status: "pending",
          workspaceId: params.workspaceId,
          assignedAgentRoleId: params.taskOverrides?.assignedAgentRoleId,
          branchFromTaskId: params.taskOverrides?.branchFromTaskId,
          branchLabel: params.taskOverrides?.branchLabel,
          agentConfig: params.agentConfig,
        }),
      ),
    } as Any;
    Object.setPrototypeOf(daemon, AgentDaemon.prototype);
    const conversation = (role = roles[0], overrides: Any = {}) =>
      taskRepo.create({
        title: role.displayName,
        prompt: "Original private transcript",
        status: "completed",
        workspaceId: workspace.id,
        assignedAgentRoleId: role.id,
        agentConfig: { botConversation: true, botTeamId: team.id },
        ...overrides,
      });
    return { db, workspace, roles, roleRepo, team, memberRepo, taskRepo, daemon, conversation };
  }

  it("reopens a standalone bot without creating a role or team or rewriting its prompt", async () => {
    const f = await fixture();
    const role = f.roles[1];
    const source = f.conversation(role, { agentConfig: { botConversation: true } });
    const before = f.db.prepare("SELECT COUNT(*) AS count FROM agent_roles").get();
    const teamsBefore = f.db.prepare("SELECT COUNT(*) AS count FROM agent_teams").get();
    const reopened = await f.daemon.reopenBotConversation({
      workspaceId: f.workspace.id,
      taskId: source.id,
    });
    expect(reopened.id).not.toBe(source.id);
    expect(reopened.assignedAgentRoleId).toBe(role.id);
    expect(reopened.agentConfig?.botTeamId).toBeUndefined();
    expect(reopened.branchFromTaskId).toBe(source.id);
    expect(reopened.prompt).not.toContain("Original private transcript");
    expect(f.daemon.createTask).toHaveBeenCalledWith(expect.objectContaining({ autoStart: false }));
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM agent_roles").get()).toEqual(before);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM agent_teams").get()).toEqual(teamsBefore);
    expect(f.roleRepo.findById(role.id)?.systemPrompt).toBe(role.systemPrompt);
    expect(f.taskRepo.findById(source.id)?.prompt).toBe(source.prompt);
  });

  it("creates a first conversation for a user bot that has never joined a team", async () => {
    const f = await fixture();
    const role = f.roleRepo.create({
      name: randomUUID(),
      displayName: "Independent",
      capabilities: [],
    });
    const reopened = await f.daemon.reopenBotConversation({
      workspaceId: f.workspace.id,
      agentRoleId: role.id,
    });
    expect(reopened.agentConfig?.botConversation).toBe(true);
    expect(reopened.agentConfig?.botTeamId).toBeUndefined();
    expect(reopened.branchFromTaskId).toBeUndefined();
    expect(await f.daemon.listBotTeamPeers(reopened.id)).toEqual([]);
    expect(f.daemon.getBotConversationMessagingContext(reopened.id)).toEqual({ authorized: false });
  });

  it("does not restore revoked membership during normalization or ordinary reopen, including legacy team names", async () => {
    const f = await fixture("CoWork Bot Team");
    const role = f.roles[1];
    f.memberRepo.removeByTeamAndRole(f.team.id, role.id);
    const source = f.conversation(role);
    const before = f.taskRepo.findById(source.id);
    f.daemon.ensureBotTaskTeam(source);
    expect(f.taskRepo.findById(source.id)).toEqual(before);
    expect(await f.daemon.listBotTeamPeers(source.id)).toEqual([]);
    await expect(
      f.daemon.reopenBotConversation({ workspaceId: f.workspace.id, taskId: source.id }),
    ).rejects.toThrow("BOT_MEMBERSHIP_REVOKED");
    expect(f.memberRepo.findByTeamAndRole(f.team.id, role.id)).toBeUndefined();
    const reopened = await f.daemon.reopenBotConversation({
      workspaceId: f.workspace.id,
      taskId: source.id,
      repairMembership: true,
    });
    expect(reopened.agentConfig?.botTeamId).toBe(f.team.id);
    expect(f.memberRepo.findByTeamAndRole(f.team.id, role.id)).toBeTruthy();
  });

  it("does not resurrect a deactivated bot through reopen or messaging", async () => {
    const f = await fixture();
    const source = f.conversation(f.roles[1]);
    f.roleRepo.delete(f.roles[1].id);
    await expect(
      f.daemon.reopenBotConversation({ workspaceId: f.workspace.id, taskId: source.id }),
    ).rejects.toThrow("BOT_NOT_FOUND");
    expect(f.daemon.getBotConversationMessagingContext(source.id)).toEqual({ authorized: false });
    expect(f.roleRepo.findById(f.roles[1].id)?.isActive).toBe(false);
    expect(f.taskRepo.findById(source.id)).toBeTruthy();
  });

  it("only lists active members of the selected team without global roster fallback", async () => {
    const f = await fixture();
    const outsider = f.roleRepo.create({
      name: randomUUID(),
      displayName: "Unrelated",
      capabilities: [],
    });
    f.roleRepo.delete(f.roles[2].id);
    const sender = f.conversation();
    const peers = await f.daemon.listBotTeamPeers(sender.id);
    expect(peers.map((peer: Any) => peer.roleId)).toEqual([f.roles[0].id, f.roles[1].id]);
    expect(peers.some((peer: Any) => peer.roleId === outsider.id)).toBe(false);
    expect(peers.find((peer: Any) => peer.roleId === f.roles[1].id)).toMatchObject({
      available: false,
      availability: "conversation_unavailable",
      recoveryAction: "reopen",
    });
  });

  it("preserves configured team IDs and resolves a renamed teammate by stable bot ID", async () => {
    const f = await fixture();
    const source = f.conversation();
    f.roleRepo.update({ id: f.roles[1].id, name: randomUUID(), displayName: "Renamed researcher" });
    const peer = await f.daemon.resolveBotTeamPeer(source.id, { botName: f.roles[1].id });
    expect(peer).toMatchObject({
      ok: true,
      role: { id: f.roles[1].id },
      task: { workspaceId: f.workspace.id, agentConfig: { botTeamId: f.team.id } },
    });
    expect(f.daemon.getBotTeamPromptContext(source.id)).toMatchObject({
      teamName: f.team.name,
      isLead: true,
      peers: expect.arrayContaining([
        expect.objectContaining({ id: f.roles[1].id, displayName: "Renamed researcher" }),
      ]),
    });
  });

  it("resolves duplicate display names within the selected team and rejects ambiguous members", async () => {
    const f = await fixture();
    const outsider = f.roleRepo.create({
      name: randomUUID(),
      displayName: "Shared name",
      capabilities: [],
    });
    f.roleRepo.update({ id: outsider.id, sortOrder: -100 });
    f.roleRepo.update({ id: f.roles[1].id, displayName: "Shared name" });
    const sender = f.conversation();
    const peer = await f.daemon.resolveBotTeamPeer(sender.id, { botName: "Shared name" });
    expect(peer).toMatchObject({ ok: true, role: { id: f.roles[1].id } });
    f.roleRepo.update({ id: f.roles[2].id, displayName: "Shared name" });
    f.daemon.createTask.mockClear();
    expect(await f.daemon.resolveBotTeamPeer(sender.id, { botName: "Shared name" })).toMatchObject({
      ok: false,
      error: "BOT_NOT_FOUND",
      message: expect.stringContaining("ambiguous"),
    });
    expect(f.daemon.createTask).not.toHaveBeenCalled();
    expect(await f.daemon.resolveBotTeamPeer(sender.id, { botName: f.roles[2].id })).toMatchObject({
      ok: true,
      role: { id: f.roles[2].id },
    });
  });

  it("requires explicit workspace branching and never inherits the source team or transcript", async () => {
    const f = await fixture();
    const repositories = await import("../../database/repositories");
    const target = new repositories.WorkspaceStore(f.db).create("Target", `${tempDir}/target`, {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: false,
    });
    const source = f.conversation();
    await expect(
      f.daemon.reopenBotConversation({ workspaceId: target.id, taskId: source.id }),
    ).rejects.toThrow("BOT_WORKSPACE_CONFLICT");
    const sourceBefore = f.taskRepo.findById(source.id);
    const branch = await f.daemon.reopenBotConversation({
      workspaceId: target.id,
      taskId: source.id,
      branchToWorkspace: true,
    });
    expect(branch.workspaceId).toBe(target.id);
    expect(branch.agentConfig?.botTeamId).toBeUndefined();
    expect(branch.prompt).not.toBe(source.prompt);
    expect(f.taskRepo.findById(source.id)).toEqual(sourceBefore);
    expect(f.daemon.getBotConversationMessagingContext(branch.id)).toEqual({ authorized: false });
    await expect(
      f.daemon.reopenBotConversation({
        workspaceId: target.id,
        taskId: source.id,
        branchToWorkspace: true,
        botTeamId: f.team.id,
        repairMembership: true,
      }),
    ).rejects.toThrow("BOT_TEAM_UNAVAILABLE");
  });

  it("does not reconcile a foreign team when its conversation was moved to another workspace", async () => {
    const f = await fixture("CoWork Bot Team");
    const source = f.conversation();
    const foreign = { ...source, workspaceId: "__temp_workspace__:different" };
    const normalized = f.daemon.ensureBotTaskTeam(foreign);
    expect(normalized.agentConfig?.botTeamId).toBe(f.team.id);
    expect(f.daemon.getBotTeamContext(normalized)).toBeUndefined();
  });

  it("rejects stale or inactive teams without creating a replacement", async () => {
    const f = await fixture();
    const { AgentTeamStore } = await import("../../agents/AgentTeamRepository");
    new AgentTeamStore(f.db).update({ id: f.team.id, isActive: false });
    const source = f.conversation();
    await expect(
      f.daemon.reopenBotConversation({
        workspaceId: f.workspace.id,
        taskId: source.id,
        repairMembership: true,
      }),
    ).rejects.toThrow("BOT_TEAM_UNAVAILABLE");
    const stale = f.conversation(f.roles[1], {
      agentConfig: { botConversation: true, botTeamId: "missing" },
    });
    await expect(
      f.daemon.reopenBotConversation({ workspaceId: f.workspace.id, taskId: stale.id }),
    ).rejects.toThrow("BOT_TEAM_UNAVAILABLE");
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM agent_teams").get()).toEqual({ count: 1 });
  });

  it("does not reopen work tasks or attribute another bot's history to a replacement identity", async () => {
    const f = await fixture();
    const work = f.conversation(f.roles[0], { agentConfig: {} });
    await expect(
      f.daemon.reopenBotConversation({ workspaceId: f.workspace.id, taskId: work.id }),
    ).rejects.toThrow("BOT_CONVERSATION_UNAVAILABLE");
    const source = f.conversation();
    await expect(
      f.daemon.reopenBotConversation({
        workspaceId: f.workspace.id,
        taskId: source.id,
        agentRoleId: f.roles[1].id,
      }),
    ).rejects.toThrow("BOT_ROLE_CONFLICT");
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
    expect(
      shouldRestartInterruptedTask({
        hasSnapshot: false,
        hasPlan: false,
        hasRecoveredBotHandoff: false,
        hasQueuedUserFollowUp: true,
      }),
    ).toBe(false);
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

  it.each(["failed", "quarantined"] as const)(
    "replays a handoff when its prior reply was %s",
    (deliveryStatus) => {
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
          id: "reply-attempt",
          type: "agent_message",
          timestamp: 3,
          payload: {
            message: "The reply could not be delivered.",
            deliveryMode: "message",
            deliveryStatus,
            inReplyToMessageId: "handoff-1",
            senderTaskId: "receiver-task",
          },
        },
      ];
      const daemonLike = { resolveLegacyEventType: (event: Any) => event.type } as Any;

      expect(
        (AgentDaemon.prototype as Any).findRecoverableBotHandoff.call(daemonLike, task, events),
      ).toMatchObject({
        messageId: "handoff-1",
        senderTaskId: "sender-task",
      });
    },
  );
});
