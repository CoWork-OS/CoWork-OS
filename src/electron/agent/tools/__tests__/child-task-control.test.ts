import Database from "better-sqlite3";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task, TaskEvent, Workspace } from "../../../../shared/types";
import { BuiltinToolsSettingsManager } from "../builtin-settings";
import { OrchestrationGraphEngine } from "../../orchestration/OrchestrationGraphEngine";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    const probe = new module.default(":memory:");
    probe.close();
    return true;
  })
  .catch(() => false);

function createGraphSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE orchestration_graph_runs (
      id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, max_parallel INTEGER NOT NULL,
      metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE TABLE orchestration_graph_nodes (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_key TEXT NOT NULL, title TEXT NOT NULL,
      prompt TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, dispatch_target TEXT NOT NULL,
      worker_role TEXT, parent_task_id TEXT, assigned_agent_role_id TEXT, capability_hint TEXT,
      acp_agent_id TEXT, agent_config TEXT, task_id TEXT, remote_task_id TEXT, public_handle TEXT,
      summary TEXT, output TEXT, error TEXT, team_run_id TEXT, team_item_id TEXT,
      workflow_phase_id TEXT, acp_task_id TEXT, metadata TEXT, verification_verdict TEXT,
      verification_report TEXT, semantic_summary TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
    );
    CREATE TABLE orchestration_graph_edges (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL
    );
    CREATE TABLE orchestration_graph_node_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, event_type TEXT NOT NULL,
      payload TEXT, created_at INTEGER NOT NULL
    );
  `);
}

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.mock("../../../mcp/client/MCPClientManager", () => ({
  MCPClientManager: {
    getInstance: vi.fn().mockImplementation(() => {
      throw new Error("MCP not initialized");
    }),
  },
}));

vi.mock("../../../mcp/settings", () => ({
  MCPSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockReturnValue({ toolNamePrefix: "mcp_" }),
    updateServer: vi.fn().mockReturnValue({}),
  },
}));

vi.mock("../../../mcp/registry/MCPRegistryManager", () => ({
  MCPRegistryManager: {
    installServer: vi.fn(),
  },
}));

vi.mock("../../../hooks/settings", () => ({
  HooksSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockReturnValue({
      enabled: false,
      token: "",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    }),
    enableHooks: vi.fn().mockReturnValue({
      enabled: true,
      token: "token",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    }),
    updateConfig: vi.fn().mockImplementation((cfg: Any) => cfg),
  },
}));

vi.mock("../../../settings/personality-manager", () => ({
  PersonalityManager: {
    loadSettings: vi.fn().mockReturnValue({}),
    saveSettings: vi.fn(),
    setUserName: vi.fn(),
    getUserName: vi.fn(),
    getAgentName: vi.fn().mockReturnValue("CoWork"),
    setActivePersona: vi.fn(),
    setResponseStyle: vi.fn(),
    setQuirks: vi.fn(),
    clearCache: vi.fn(),
  },
}));

vi.mock("../../custom-skill-loader", () => ({
  getCustomSkillLoader: vi.fn().mockReturnValue({
    getSkill: vi.fn(),
    listModelInvocableSkills: vi.fn().mockReturnValue([]),
    expandPrompt: vi.fn().mockReturnValue(""),
    getSkillDescriptionsForModel: vi.fn().mockReturnValue(""),
  }),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue("{}"),
    readdirSync: vi.fn().mockReturnValue([]),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue("{}"),
  readdirSync: vi.fn().mockReturnValue([]),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    writeFile: vi.fn(),
  },
  writeFile: vi.fn(),
}));

// Mock MentionTools to avoid DatabaseManager dependency
vi.mock("../mention-tools", () => {
  return {
    MentionTools: class MockMentionTools {
      getTools() {
        return [];
      }
      static getToolDefinitions() {
        return [];
      }
    },
  };
});

import { ToolRegistry } from "../registry";

describe("ToolRegistry child task control tools", () => {
  let workspace: Workspace;

  beforeEach(() => {
    workspace = {
      id: "ws-1",
      name: "Test Workspace",
      path: "/tmp",
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: true, shell: false },
    };
  });

  it("wait_for_agent rejects non-descendant tasks", async () => {
    const tasks = new Map<string, Task>([
      [
        "other-task",
        {
          id: "other-task",
          title: "Other",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);

    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("wait_for_agent", {
      task_id: "other-task",
      timeout_seconds: 1,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("forbidden");
    expect(result.error).toBe("FORBIDDEN");
  });

  it("send_agent_message only allows descendant tasks", async () => {
    const tasks = new Map<string, Task>([
      [
        "child-task",
        {
          id: "child-task",
          title: "Child",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        },
      ],
      [
        "other-task",
        {
          id: "other-task",
          title: "Other",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);

    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      sendMessage: vi.fn().mockResolvedValue({ queued: true, deliveryMode: "message" }),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");

    const forbidden = await registry.executeTool("send_agent_message", {
      task_id: "other-task",
      message: "hi",
    });
    expect(forbidden.success).toBe(false);
    expect(forbidden.error).toBe("FORBIDDEN");

    const ok = await registry.executeTool("send_agent_message", {
      task_id: "child-task",
      message: "hi",
      message_id: "retry-message-1",
    });
    expect(ok.success).toBe(true);
    expect(daemon.sendMessage).toHaveBeenCalledWith(
      "child-task",
      "hi",
      undefined,
      undefined,
      expect.objectContaining({
        messageSource: "agent",
        senderTaskId: "parent-task",
        messageId: "retry-message-1",
        deliveryMode: "message",
      }),
    );
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "parent-task",
      "agent_message",
      expect.objectContaining({ status: "queued", targetTaskId: "child-task" }),
    );
  });

  it("send_agent_message can address a verified bot teammate by handle", async () => {
    const recipient: Task = {
      id: "forge-task",
      title: "Forge — Product Engineer",
      prompt: "Start chatting with Forge.",
      status: "pending",
      workspaceId: workspace.id,
      assignedAgentRoleId: "forge-role",
      agentConfig: { botConversation: true, botTeamId: "bot-team-1" },
      createdAt: 1,
      updatedAt: 1,
    };
    const daemon = {
      getTaskById: vi.fn().mockResolvedValue(recipient),
      resolveBotTeamPeer: vi.fn().mockResolvedValue({
        ok: true,
        task: recipient,
        role: { id: "forge-role", name: "forge", displayName: recipient.title },
      }),
      sendMessage: vi.fn().mockResolvedValue({
        queued: true,
        deliveryMode: "message",
        deliveryStatus: "queued",
        acceptedAt: 100,
        queuedAt: 100,
      }),
      getTaskEvents: vi.fn(),
      reconcileAgentMessageSenderProjection: vi.fn(),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "atlas-task");
    const result = await registry.executeTool("send_agent_message", {
      bot: "forge",
      message: "Please check the failing build and report the first actionable error.",
      message_id: "bot-message-1",
    });

    expect(result.success).toBe(true);
    expect(result).toMatchObject({
      queued: true,
      message_id: "bot-message-1",
      deliveryStatus: "queued",
      deliveryMode: "message",
      acceptedAt: 100,
      queuedAt: 100,
      sender_task_id: "atlas-task",
      target_task_id: "forge-task",
      message: "Message queued for the agent's next turn",
    });
    expect(result).not.toHaveProperty("teammate_reply");
    expect(daemon.getTaskEvents).toHaveBeenCalledWith("atlas-task", { limit: 200 });
    expect(daemon.resolveBotTeamPeer).toHaveBeenCalledWith("atlas-task", {
      botName: "forge",
      taskId: undefined,
    });
    expect(daemon.sendMessage).toHaveBeenNthCalledWith(
      1,
      "forge-task",
      "Please check the failing build and report the first actionable error.",
      undefined,
      undefined,
      expect.objectContaining({
        messageSource: "agent",
        senderTaskId: "atlas-task",
        messageId: "bot-message-1",
        deliveryMode: "message",
        startAfterAccepted: true,
      }),
    );
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "atlas-task",
      "agent_message",
      expect.objectContaining({
        message: "Please check the failing build and report the first actionable error.",
        messageId: "bot-message-1",
        status: "queued",
        deliveryStatus: "queued",
        deliveryMode: "message",
        replyStatus: "pending",
      }),
    );
    expect(daemon.logEvent).toHaveBeenCalledTimes(1);
    expect(daemon.reconcileAgentMessageSenderProjection).toHaveBeenCalledWith(
      "forge-task",
      "bot-message-1",
    );
  });

  it("correlates a bot reply with the latest durable inbound receipt", async () => {
    const recipient: Task = {
      id: "scribe-task",
      title: "Scribe — Author and Publisher",
      prompt: "Start chatting with Scribe.",
      status: "executing",
      workspaceId: workspace.id,
      assignedAgentRoleId: "scribe-role",
      agentConfig: { botConversation: true, botTeamId: "bot-team-1" },
      createdAt: 1,
      updatedAt: 1,
    };
    const inbound = {
      id: "inbound-event",
      taskId: "atlas-task",
      type: "timeline_step_updated",
      legacyType: "user_message",
      timestamp: 100,
      payload: {
        messageId: "inbound-1",
        messageSource: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        senderTaskId: "scribe-task",
        senderLabel: "Scribe — Author and Publisher",
        message: "Please verify the source mechanics.",
      },
      schemaVersion: 2,
    };
    const markBotHandoffReplied = vi.fn();
    const daemon = {
      getTaskById: vi.fn().mockResolvedValue(recipient),
      resolveBotTeamPeer: vi.fn().mockResolvedValue({
        ok: true,
        task: recipient,
        role: { id: "scribe-role", name: "scribe", displayName: recipient.title },
      }),
      // A canonical work-session read may return the projection with a
      // timeline_step_updated type and legacyType user_message. The reply
      // correlation path must not pass a type filter that drops that event.
      getTaskEvents: vi
        .fn()
        .mockImplementation((_taskId: string, options?: Any) => (options?.types ? [] : [inbound])),
      sendMessage: vi.fn().mockResolvedValue({
        queued: true,
        deliveryMode: "message",
        deliveryStatus: "queued",
        acceptedAt: 101,
        queuedAt: 101,
      }),
      markBotHandoffReplied,
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "atlas-task");
    const result = await registry.executeTool("send_agent_message", {
      bot: "scribe",
      message: "The mechanics check is complete.",
      message_id: "reply-1",
    });

    expect(result.success).toBe(true);
    expect(daemon.getTaskEvents).toHaveBeenCalledWith("atlas-task", { limit: 200 });
    expect(daemon.sendMessage).toHaveBeenCalledWith(
      "scribe-task",
      "The mechanics check is complete.",
      undefined,
      undefined,
      expect.objectContaining({
        inReplyToMessageId: "inbound-1",
        inReplyToTaskId: "scribe-task",
      }),
    );
    const replyActivity = daemon.logEvent.mock.calls.find(
      (call: Any[]) => call[1] === "agent_message",
    )?.[2];
    expect(replyActivity).toMatchObject({
      inReplyToMessageId: "inbound-1",
      inReplyToTaskId: "scribe-task",
    });
    expect(replyActivity).not.toHaveProperty("replyStatus");
    expect(markBotHandoffReplied).not.toHaveBeenCalled();
  });

  it("uses the durable delivered receipt when the canonical event is still queued", async () => {
    const recipient: Task = {
      id: "atlas-task",
      title: "Atlas",
      prompt: "Start chatting with Atlas.",
      status: "completed",
      workspaceId: workspace.id,
      assignedAgentRoleId: "atlas-role",
      agentConfig: { botConversation: true, botTeamId: "bot-team-1" },
      createdAt: 1,
      updatedAt: 1,
    };
    const delivered = {
      id: "inbound-event",
      taskId: "scribe-task",
      type: "user_message",
      timestamp: 100,
      payload: {
        messageId: "inbound-1",
        messageSource: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        senderTaskId: "atlas-task",
        message: "Check this calculation.",
      },
    };
    const daemon = {
      getTaskById: vi.fn().mockResolvedValue(recipient),
      resolveBotTeamPeer: vi.fn().mockResolvedValue({
        ok: true,
        task: recipient,
        role: { id: "atlas-role", name: "atlas", displayName: recipient.title },
      }),
      getTaskEvents: vi
        .fn()
        .mockReturnValue([
          { ...delivered, payload: { ...delivered.payload, deliveryStatus: "queued" } },
        ]),
      getDurableTaskEvents: vi.fn((_taskId: string, type: string) =>
        type === "user_message" ? [delivered] : [],
      ),
      sendMessage: vi.fn().mockResolvedValue({
        queued: true,
        deliveryMode: "message",
        deliveryStatus: "queued",
      }),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "scribe-task");
    const result = await registry.executeTool("send_agent_message", {
      task_id: "atlas-task",
      message: "The answer is 59.5.",
      message_id: "reply-1",
    });

    expect(result.success).toBe(true);
    expect(daemon.getTaskEvents).not.toHaveBeenCalled();
    expect(daemon.sendMessage).toHaveBeenCalledWith(
      "atlas-task",
      "The answer is 59.5.",
      undefined,
      undefined,
      expect.objectContaining({
        inReplyToMessageId: "inbound-1",
        inReplyToTaskId: "atlas-task",
      }),
    );
  });

  it.each(["queued", "started"] as const)(
    "does not correlate a %s inbound receipt before the receiver consumes it",
    async (deliveryStatus) => {
      const recipient: Task = {
        id: "scribe-task",
        title: "Scribe — Author and Publisher",
        prompt: "Start chatting with Scribe.",
        status: "executing",
        workspaceId: workspace.id,
        assignedAgentRoleId: "scribe-role",
        agentConfig: { botConversation: true, botTeamId: "bot-team-1" },
        createdAt: 1,
        updatedAt: 1,
      };
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue(recipient),
        resolveBotTeamPeer: vi.fn().mockResolvedValue({
          ok: true,
          task: recipient,
          role: { id: "scribe-role", name: "scribe", displayName: recipient.title },
        }),
        getTaskEvents: vi.fn().mockReturnValue([
          {
            id: "inbound-event",
            taskId: "atlas-task",
            type: "user_message",
            timestamp: 100,
            payload: {
              messageId: "inbound-1",
              messageSource: "agent",
              deliveryMode: "message",
              deliveryStatus,
              senderTaskId: "scribe-task",
              senderLabel: "Scribe — Author and Publisher",
              message: "Please verify the source mechanics.",
            },
            schemaVersion: 2,
          },
        ]),
        sendMessage: vi.fn().mockResolvedValue({
          queued: true,
          deliveryMode: "message",
          deliveryStatus: "queued",
          acceptedAt: 101,
          queuedAt: 101,
        }),
        reconcileAgentMessageSenderProjection: vi.fn(),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "atlas-task");
      const result = await registry.executeTool("send_agent_message", {
        bot: "scribe",
        message: "Start a new, independent check.",
        message_id: `independent-${deliveryStatus}`,
      });

      expect(result.success).toBe(true);
      const sendOptions = daemon.sendMessage.mock.calls[0]?.[4];
      expect(sendOptions).not.toHaveProperty("inReplyToMessageId");
      expect(sendOptions).not.toHaveProperty("inReplyToTaskId");
    },
  );

  it("suppresses a follow-up when the latest teammate message is a correlated reply receipt", async () => {
    const recipient: Task = {
      id: "scribe-task",
      title: "Scribe — Author and Publisher",
      prompt: "Start chatting with Scribe.",
      status: "executing",
      workspaceId: workspace.id,
      assignedAgentRoleId: "scribe-role",
      agentConfig: { botConversation: true, botTeamId: "bot-team-1" },
      createdAt: 1,
      updatedAt: 1,
    };
    const sender: Task = {
      id: "atlas-task",
      title: "Atlas — Chief Community Officer",
      prompt: "Start chatting with Atlas.",
      status: "executing",
      workspaceId: workspace.id,
      assignedAgentRoleId: "atlas-role",
      agentConfig: { botConversation: true, botTeamId: "bot-team-1" },
      createdAt: 1,
      updatedAt: 1,
    };
    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (taskId: string) => {
        if (taskId === recipient.id) return recipient;
        if (taskId === sender.id) return sender;
        return undefined;
      }),
      resolveBotTeamPeer: vi.fn().mockResolvedValue({
        ok: true,
        task: recipient,
        role: { id: "scribe-role", name: "scribe", displayName: recipient.title },
      }),
      getTaskEvents: vi.fn().mockReturnValue([
        {
          id: "handoff-event",
          taskId: "atlas-task",
          type: "agent_message",
          timestamp: 100,
          payload: {
            messageId: "handoff-1",
            senderType: "agent",
            deliveryMode: "message",
            deliveryStatus: "delivered",
            senderTaskId: "atlas-task",
            targetTaskId: "scribe-task",
          },
        },
        {
          id: "reply-event",
          taskId: "atlas-task",
          type: "timeline_step_updated",
          legacyType: "user_message",
          timestamp: 101,
          payload: {
            messageId: "reply-1",
            messageSource: "agent",
            deliveryMode: "message",
            deliveryStatus: "delivered",
            senderTaskId: "scribe-task",
            inReplyToMessageId: "handoff-1",
            inReplyToTaskId: "atlas-task",
          },
        },
      ]),
      sendMessage: vi.fn(),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "atlas-task");
    const result = await registry.executeTool("send_agent_message", {
      bot: "scribe",
      message: "Thanks, I will record the result.",
      message_id: "follow-up-1",
    });

    expect(result).toMatchObject({
      success: true,
      duplicate: true,
      deliveryStatus: "delivered",
      message:
        "No message sent: the latest teammate message is a correlated reply receipt. Record it and finish this turn.",
    });
    expect(daemon.sendMessage).not.toHaveBeenCalled();
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "atlas-task",
      "log",
      expect.objectContaining({
        metric: "bot_correlated_reply_suppressed",
        inboundMessageId: "reply-1",
        inReplyToMessageId: "handoff-1",
        inReplyToTaskId: "atlas-task",
      }),
    );
  });

  it.each(["queued", "started"] as const)(
    "does not suppress a follow-up for a %s correlated reply receipt",
    async (deliveryStatus) => {
      const recipient: Task = {
        id: "scribe-task",
        title: "Scribe — Author and Publisher",
        prompt: "Start chatting with Scribe.",
        status: "executing",
        workspaceId: workspace.id,
        assignedAgentRoleId: "scribe-role",
        agentConfig: { botConversation: true, botTeamId: "bot-team-1" },
        createdAt: 1,
        updatedAt: 1,
      };
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue(recipient),
        resolveBotTeamPeer: vi.fn().mockResolvedValue({
          ok: true,
          task: recipient,
          role: { id: "scribe-role", name: "scribe", displayName: recipient.title },
        }),
        getTaskEvents: vi.fn().mockReturnValue([
          {
            id: "handoff-event",
            taskId: "atlas-task",
            type: "agent_message",
            timestamp: 100,
            payload: {
              messageId: "handoff-1",
              messageSource: "agent",
              deliveryMode: "message",
              deliveryStatus: "delivered",
              senderTaskId: "atlas-task",
              targetTaskId: "scribe-task",
            },
          },
          {
            id: "reply-event",
            taskId: "atlas-task",
            type: "user_message",
            timestamp: 101,
            payload: {
              messageId: "reply-1",
              messageSource: "agent",
              deliveryMode: "message",
              deliveryStatus,
              senderTaskId: "scribe-task",
              inReplyToMessageId: "handoff-1",
              inReplyToTaskId: "atlas-task",
            },
          },
        ]),
        sendMessage: vi.fn().mockResolvedValue({
          queued: true,
          deliveryMode: "message",
          deliveryStatus: "queued",
          acceptedAt: 102,
          queuedAt: 102,
        }),
        reconcileAgentMessageSenderProjection: vi.fn(),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "atlas-task");
      const result = await registry.executeTool("send_agent_message", {
        bot: "scribe",
        message: "Continue with the next check.",
        message_id: `follow-up-${deliveryStatus}`,
      });

      expect(result.success).toBe(true);
      expect(daemon.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("starts a fresh handoff after a new human request follows a correlated reply", async () => {
    const recipient: Task = {
      id: "scribe-task",
      title: "Scribe — Author and Publisher",
      prompt: "Start chatting with Scribe.",
      status: "executing",
      workspaceId: workspace.id,
      assignedAgentRoleId: "scribe-role",
      agentConfig: { botConversation: true, botTeamId: "bot-team-1" },
      createdAt: 1,
      updatedAt: 1,
    };
    const daemon = {
      getTaskById: vi.fn().mockResolvedValue(recipient),
      resolveBotTeamPeer: vi.fn().mockResolvedValue({
        ok: true,
        task: recipient,
        role: { id: "scribe-role", name: "scribe", displayName: recipient.title },
      }),
      getTaskEvents: vi.fn().mockReturnValue([
        {
          id: "handoff-event",
          taskId: "atlas-task",
          type: "agent_message",
          timestamp: 100,
          payload: {
            messageId: "handoff-1",
            messageSource: "agent",
            deliveryMode: "message",
            deliveryStatus: "delivered",
            senderTaskId: "atlas-task",
            targetTaskId: "scribe-task",
          },
        },
        {
          id: "reply-event",
          taskId: "atlas-task",
          type: "user_message",
          timestamp: 101,
          payload: {
            messageId: "reply-1",
            messageSource: "agent",
            deliveryMode: "message",
            deliveryStatus: "delivered",
            senderTaskId: "scribe-task",
            inReplyToMessageId: "handoff-1",
            inReplyToTaskId: "atlas-task",
          },
        },
        {
          id: "human-follow-up",
          taskId: "atlas-task",
          type: "user_message",
          timestamp: 102,
          payload: {
            message: "Now ask Scribe to verify the second source.",
          },
        },
      ]),
      sendMessage: vi.fn().mockResolvedValue({
        queued: true,
        deliveryMode: "message",
        deliveryStatus: "queued",
        acceptedAt: 103,
        queuedAt: 103,
      }),
      reconcileAgentMessageSenderProjection: vi.fn(),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "atlas-task");
    const result = await registry.executeTool("send_agent_message", {
      bot: "scribe",
      message: "Verify the second source.",
      message_id: "handoff-2",
    });

    expect(result.success).toBe(true);
    expect(daemon.sendMessage).toHaveBeenCalledTimes(1);
    expect(daemon.sendMessage.mock.calls[0]?.[4]).not.toHaveProperty("inReplyToMessageId");
    expect(daemon.sendMessage.mock.calls[0]?.[4]).not.toHaveProperty("inReplyToTaskId");
  });

  it("capture_agent_events returns summarized events", async () => {
    const tasks = new Map<string, Task>([
      [
        "child-task",
        {
          id: "child-task",
          title: "Child",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        },
      ],
    ]);

    const childEvents: TaskEvent[] = [
      {
        id: "e1",
        taskId: "child-task",
        timestamp: 1,
        type: "assistant_message",
        payload: { content: "hello" },
      },
      {
        id: "e2",
        taskId: "child-task",
        timestamp: 2,
        type: "file_created",
        payload: { path: "out.txt" },
      },
    ];

    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      getTaskEvents: vi.fn().mockReturnValue(childEvents),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("capture_agent_events", {
      task_id: "child-task",
      limit: 10,
    });

    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toEqual({ timestamp: 1, type: "assistant_message", summary: "hello" });
    expect(result.events[1].type).toBe("file_created");
  });

  it("cancel_agent cancels a descendant task", async () => {
    const tasks = new Map<string, Task>([
      [
        "child-task",
        {
          id: "child-task",
          title: "Child",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        },
      ],
    ]);

    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      cancelTask: vi.fn().mockResolvedValue(undefined),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("cancel_agent", { task_id: "child-task" });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Task cancelled");
    expect(daemon.cancelTask).toHaveBeenCalledWith("child-task");
  });

  it("cancel_agent rejects already-finished tasks", async () => {
    const tasks = new Map<string, Task>([
      [
        "child-task",
        {
          id: "child-task",
          title: "Child",
          prompt: "x",
          status: "completed",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        },
      ],
    ]);

    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("cancel_agent", { task_id: "child-task" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("TASK_ALREADY_FINISHED");
  });

  it("pause_agent pauses an executing descendant task", async () => {
    const tasks = new Map<string, Task>([
      [
        "child-task",
        {
          id: "child-task",
          title: "Child",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        },
      ],
    ]);

    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      pauseTask: vi.fn().mockResolvedValue(undefined),
      updateTaskStatus: vi.fn(),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("pause_agent", { task_id: "child-task" });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Task paused");
    expect(daemon.pauseTask).toHaveBeenCalledWith("child-task");
    expect(daemon.updateTaskStatus).toHaveBeenCalledWith("child-task", "paused");
  });

  it("pause_agent rejects tasks not in a running state", async () => {
    const tasks = new Map<string, Task>([
      [
        "child-task",
        {
          id: "child-task",
          title: "Child",
          prompt: "x",
          status: "paused",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        },
      ],
    ]);

    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("pause_agent", { task_id: "child-task" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("TASK_NOT_RUNNING");
  });

  it("resume_agent resumes a paused descendant task", async () => {
    const tasks = new Map<string, Task>([
      [
        "child-task",
        {
          id: "child-task",
          title: "Child",
          prompt: "x",
          status: "paused",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        },
      ],
    ]);

    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      resumeTask: vi.fn().mockResolvedValue(true),
      updateTaskStatus: vi.fn(),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("resume_agent", { task_id: "child-task" });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Task resumed");
    expect(daemon.resumeTask).toHaveBeenCalledWith("child-task");
  });

  it("resume_agent fails when task has no in-memory executor", async () => {
    const tasks = new Map<string, Task>([
      [
        "child-task",
        {
          id: "child-task",
          title: "Child",
          prompt: "x",
          status: "paused",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        },
      ],
    ]);

    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      resumeTask: vi.fn().mockResolvedValue(false),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("resume_agent", { task_id: "child-task" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("NO_EXECUTOR");
  });

  it("resume_agent rejects tasks not in paused state", async () => {
    const tasks = new Map<string, Task>([
      [
        "child-task",
        {
          id: "child-task",
          title: "Child",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        },
      ],
    ]);

    const daemon = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("resume_agent", { task_id: "child-task" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("TASK_NOT_PAUSED");
  });

  it("spawn_agent enforces active child fanout limit", async () => {
    const prevLimit = process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT;
    const prevPhaseC = process.env.COWORK_GUARDRAIL_PHASE_C;
    process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = "1";
    process.env.COWORK_GUARDRAIL_PHASE_C = "true";

    try {
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue({
          id: "parent-task",
          title: "Parent",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          depth: 0,
        }),
        getChildTasks: vi.fn().mockResolvedValue([
          {
            id: "child-1",
            title: "Child",
            prompt: "x",
            status: "executing",
            workspaceId: workspace.id,
            createdAt: 1,
            updatedAt: 1,
            parentTaskId: "parent-task",
            agentType: "sub",
            depth: 1,
          },
        ]),
        createChildTask: vi.fn(),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("spawn_agent", {
        prompt: "Analyze this file",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("FANOUT_LIMIT_REACHED");
      expect(daemon.createChildTask).not.toHaveBeenCalled();
    } finally {
      process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = prevLimit;
      process.env.COWORK_GUARDRAIL_PHASE_C = prevPhaseC;
    }
  });

  it("spawn_agent ignores paused children when enforcing fanout limit", async () => {
    const prevLimit = process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT;
    const prevPhaseC = process.env.COWORK_GUARDRAIL_PHASE_C;
    process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = "1";
    process.env.COWORK_GUARDRAIL_PHASE_C = "true";

    try {
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue({
          id: "parent-task",
          title: "Parent",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          depth: 0,
        }),
        getChildTasks: vi.fn().mockResolvedValue([
          {
            id: "child-paused",
            title: "Paused child",
            prompt: "x",
            status: "paused",
            workspaceId: workspace.id,
            createdAt: 1,
            updatedAt: 1,
            parentTaskId: "parent-task",
            agentType: "sub",
            depth: 1,
          },
        ]),
        createChildTask: vi.fn().mockResolvedValue({
          id: "child-1",
          title: "Spawned Child",
          prompt: "x",
          status: "pending",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        }),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("spawn_agent", {
        prompt: "Analyze this file",
      });

      expect(result.success).toBe(true);
      expect(daemon.createChildTask).toHaveBeenCalledTimes(1);
    } finally {
      process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = prevLimit;
      process.env.COWORK_GUARDRAIL_PHASE_C = prevPhaseC;
    }
  });

  it("spawn_agent applies extraction contract and scoped allowed tools for HTML extraction tasks", async () => {
    const prevLimit = process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT;
    const prevPhaseC = process.env.COWORK_GUARDRAIL_PHASE_C;
    process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = "3";
    process.env.COWORK_GUARDRAIL_PHASE_C = "true";

    try {
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue({
          id: "parent-task",
          title: "Parent",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          depth: 0,
        }),
        getChildTasks: vi.fn().mockResolvedValue([]),
        createChildTask: vi.fn().mockResolvedValue({
          id: "child-1",
          title: "Extract HTML",
          prompt: "x",
          status: "pending",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        }),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("spawn_agent", {
        prompt:
          'Read "temp-writing-rules.html" in the workspace and extract meaningful content to markdown.',
      });

      expect(result.success).toBe(true);
      expect(daemon.createChildTask).toHaveBeenCalledTimes(1);
      const call = daemon.createChildTask.mock.calls[0][0];
      expect(call.prompt).toContain("[EXTRACTION_OUTPUT_CONTRACT_V1]");
      expect(Array.isArray(call.agentConfig?.allowedTools)).toBe(true);
      expect(call.agentConfig.allowedTools).toContain("read_file");
      expect(call.agentConfig.toolRestrictions).toContain("spawn_agent");
    } finally {
      process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = prevLimit;
      process.env.COWORK_GUARDRAIL_PHASE_C = prevPhaseC;
    }
  });

  it("spawn_agent applies extraction contract for page-source prompts without explicit .html", async () => {
    const prevLimit = process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT;
    const prevPhaseC = process.env.COWORK_GUARDRAIL_PHASE_C;
    process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = "3";
    process.env.COWORK_GUARDRAIL_PHASE_C = "true";

    try {
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue({
          id: "parent-task",
          title: "Parent",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          depth: 0,
        }),
        getChildTasks: vi.fn().mockResolvedValue([]),
        createChildTask: vi.fn().mockResolvedValue({
          id: "child-2",
          title: "Extract Page Source",
          prompt: "x",
          status: "pending",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        }),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("spawn_agent", {
        prompt:
          "Read the saved page source from the workspace and extract meaningful content into markdown sections.",
      });

      expect(result.success).toBe(true);
      const call = daemon.createChildTask.mock.calls[0][0];
      expect(call.prompt).toContain("[EXTRACTION_OUTPUT_CONTRACT_V1]");
      expect(Array.isArray(call.agentConfig?.allowedTools)).toBe(true);
      expect(call.agentConfig.toolRestrictions).toContain("spawn_agent");
    } finally {
      process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = prevLimit;
      process.env.COWORK_GUARDRAIL_PHASE_C = prevPhaseC;
    }
  });

  it("spawn_agent keeps full tools and a free-form answer for ordinary research prompts", async () => {
    const prevLimit = process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT;
    const prevPhaseC = process.env.COWORK_GUARDRAIL_PHASE_C;
    process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = "3";
    process.env.COWORK_GUARDRAIL_PHASE_C = "true";

    try {
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue({
          id: "parent-task",
          title: "Parent",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          depth: 0,
        }),
        getChildTasks: vi.fn().mockResolvedValue([]),
        createChildTask: vi.fn().mockResolvedValue({
          id: "child-3",
          title: "Competitor pricing",
          prompt: "x",
          status: "pending",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        }),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("spawn_agent", {
        prompt: "Research the top 5 competitors in the ed-tech domain and summarize their pricing",
      });

      expect(result.success).toBe(true);
      const call = daemon.createChildTask.mock.calls[0][0];
      expect(call.prompt).not.toContain("[EXTRACTION_OUTPUT_CONTRACT_V1]");
      expect(call.prompt).not.toContain("strict JSON");
      expect(call.agentConfig?.allowedTools).toBeUndefined();
      expect(call.agentConfig.toolRestrictions).toContain("spawn_agent");
    } finally {
      process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = prevLimit;
      process.env.COWORK_GUARDRAIL_PHASE_C = prevPhaseC;
    }
  });

  it("spawn_agent persists explicit acpx runtime requests into agentConfig", async () => {
    const daemon = {
      getTaskById: vi.fn().mockResolvedValue({
        id: "parent-task",
        title: "Parent",
        prompt: "x",
        status: "executing",
        workspaceId: workspace.id,
        createdAt: 1,
        updatedAt: 1,
        depth: 0,
      }),
      getChildTasks: vi.fn().mockResolvedValue([]),
      createChildTask: vi.fn().mockResolvedValue({
        id: "child-acpx",
        title: "Codex child",
        prompt: "x",
        status: "pending",
        workspaceId: workspace.id,
        createdAt: 1,
        updatedAt: 1,
        parentTaskId: "parent-task",
        agentType: "sub",
        depth: 1,
      }),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("spawn_agent", {
      title: "Codex review",
      prompt: "Review the patch",
      runtime: "acpx",
      runtime_agent: "codex",
    });

    expect(result.success).toBe(true);
    const call = daemon.createChildTask.mock.calls[0][0];
    expect(call.agentConfig.externalRuntime).toEqual({
      kind: "acpx",
      agent: "codex",
      sessionMode: "persistent",
      outputMode: "json",
      permissionMode: "approve-reads",
    });
  });

  it("spawn_agent persists explicit Claude acpx runtime requests into agentConfig", async () => {
    const daemon = {
      getTaskById: vi.fn().mockResolvedValue({
        id: "parent-task",
        title: "Parent",
        prompt: "x",
        status: "executing",
        workspaceId: workspace.id,
        createdAt: 1,
        updatedAt: 1,
        depth: 0,
      }),
      getChildTasks: vi.fn().mockResolvedValue([]),
      createChildTask: vi.fn().mockResolvedValue({
        id: "child-acpx",
        title: "Claude child",
        prompt: "x",
        status: "pending",
        workspaceId: workspace.id,
        createdAt: 1,
        updatedAt: 1,
        parentTaskId: "parent-task",
        agentType: "sub",
        depth: 1,
      }),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const result = await registry.executeTool("spawn_agent", {
      title: "Claude review",
      prompt: "Review the patch",
      runtime: "acpx",
      runtime_agent: "claude",
    });

    expect(result.success).toBe(true);
    const call = daemon.createChildTask.mock.calls[0][0];
    expect(call.agentConfig.externalRuntime).toEqual({
      kind: "acpx",
      agent: "claude",
      sessionMode: "persistent",
      outputMode: "json",
      permissionMode: "approve-reads",
    });
  });

  it("spawn_agent uses the Codex runtime default only for explicit Codex flows", async () => {
    const runtimeSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getCodexRuntimeMode")
      .mockReturnValue("acpx");
    const daemon = {
      getTaskById: vi.fn().mockResolvedValue({
        id: "parent-task",
        title: "Parent",
        prompt: "x",
        status: "executing",
        workspaceId: workspace.id,
        createdAt: 1,
        updatedAt: 1,
        depth: 0,
      }),
      getChildTasks: vi.fn().mockResolvedValue([]),
      createChildTask: vi.fn().mockResolvedValue({
        id: "child-default-runtime",
        title: "Codex child",
        prompt: "x",
        status: "pending",
        workspaceId: workspace.id,
        createdAt: 1,
        updatedAt: 1,
        parentTaskId: "parent-task",
        agentType: "sub",
        depth: 1,
      }),
      logEvent: vi.fn(),
    } as Any;

    try {
      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      await registry.executeTool("spawn_agent", {
        title: "Codex CLI Agent",
        prompt: "Review the patch",
      });

      const firstCall = daemon.createChildTask.mock.calls[0][0];
      expect(firstCall.agentConfig.externalRuntime?.kind).toBe("acpx");

      await registry.executeTool("spawn_agent", {
        title: "Generic analysis",
        prompt: "Analyze the codebase",
      });

      const secondCall = daemon.createChildTask.mock.calls[1][0];
      expect(secondCall.agentConfig.externalRuntime).toBeUndefined();
    } finally {
      runtimeSpy.mockRestore();
    }
  });

  it("spawn_agent resolves worker_role and sends a structured delegation brief", async () => {
    const daemon = {
      getTaskById: vi.fn().mockResolvedValue({
        id: "parent-task",
        title: "Parent task",
        prompt: "Ship the feature safely",
        status: "executing",
        workspaceId: workspace.id,
        createdAt: 1,
        updatedAt: 1,
        depth: 0,
      }),
      getTaskEvents: vi.fn().mockReturnValue([
        {
          type: "step_started",
          payload: { step: { description: "Validate the patch before shipping" } },
        },
        {
          type: "assistant_message",
          payload: { message: "Latest findings from the parent task." },
        },
      ]),
      getChildTasks: vi.fn().mockResolvedValue([]),
      createChildTask: vi.fn().mockResolvedValue({
        id: "child-verifier",
        title: "Verify patch",
        prompt: "x",
        status: "pending",
        workspaceId: workspace.id,
        createdAt: 1,
        updatedAt: 1,
        parentTaskId: "parent-task",
        agentType: "sub",
        depth: 1,
      }),
      logEvent: vi.fn(),
    } as Any;

    const registry = new ToolRegistry(workspace, daemon, "parent-task");
    const explicit = await registry.executeTool("spawn_agent", {
      title: "Verify patch",
      prompt: "Validate the patch and give a second opinion.",
      worker_role: "verifier",
    });
    const inferred = await registry.executeTool("spawn_agent", {
      title: "Research bug",
      prompt: "Investigate the failing test and summarize the findings.",
      worker_role: "auto",
    });

    expect(explicit.success).toBe(true);
    expect(inferred.success).toBe(true);

    const explicitCall = daemon.createChildTask.mock.calls[0][0];
    const inferredCall = daemon.createChildTask.mock.calls[1][0];

    expect(explicitCall.workerRole).toBe("verifier");
    expect(explicitCall.prompt).toContain("STRUCTURED DELEGATION BRIEF");
    expect(explicitCall.prompt).toContain("Resolved worker role: Verifier");
    expect(explicitCall.prompt).toContain("Current step: Validate the patch before shipping");
    expect(explicitCall.prompt).toContain("Latest findings from the parent task.");

    expect(inferredCall.workerRole).toBe("researcher");
    expect(inferredCall.prompt).toContain("Resolved worker role: Researcher");
  });

  describe("spawn_agent model and turn defaults", () => {
    // Sub-agents used to default to Haiku with 20 turns. A pinned modelKey also
    // drops the provider failover chain (resolveProviderFailoverChain returns
    // only the primary route when the task has a modelKey), so the default now
    // inherits the parent's route and only extraction helpers or explicit
    // requests ask for Haiku.
    let prevLimit: string | undefined;
    let prevPhaseC: string | undefined;
    beforeEach(() => {
      prevLimit = process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT;
      prevPhaseC = process.env.COWORK_GUARDRAIL_PHASE_C;
      process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = "3";
      process.env.COWORK_GUARDRAIL_PHASE_C = "true";
    });
    afterEach(() => {
      process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = prevLimit;
      process.env.COWORK_GUARDRAIL_PHASE_C = prevPhaseC;
    });

    async function spawnChild(
      input: Record<string, unknown>,
      parentAgentConfig?: Task["agentConfig"],
    ): Promise<Any> {
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue({
          id: "parent-task",
          title: "Parent",
          prompt: "x",
          status: "executing",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          depth: 0,
          ...(parentAgentConfig ? { agentConfig: parentAgentConfig } : {}),
        }),
        getChildTasks: vi.fn().mockResolvedValue([]),
        createChildTask: vi.fn().mockResolvedValue({
          id: "child-1",
          title: "Child",
          prompt: "x",
          status: "pending",
          workspaceId: workspace.id,
          createdAt: 1,
          updatedAt: 1,
          parentTaskId: "parent-task",
          agentType: "sub",
          depth: 1,
        }),
        logEvent: vi.fn(),
      } as Any;
      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("spawn_agent", input);
      expect(result.success).toBe(true);
      return daemon.createChildTask.mock.calls[0][0].agentConfig;
    }

    it("inherits the parent's model route when no preference is given", async () => {
      const agentConfig = await spawnChild({ prompt: "Fix the failing date parser in src/utils" });
      expect(agentConfig.modelKey).toBeUndefined();
      expect(agentConfig.providerType).toBeUndefined();
    });

    it("copies an explicit parent provider and model", async () => {
      const agentConfig = await spawnChild(
        { prompt: "Fix the failing date parser in src/utils" },
        { providerType: "openai", modelKey: "gpt-5.2" },
      );
      expect(agentConfig.providerType).toBe("openai");
      expect(agentConfig.modelKey).toBe("gpt-5.2");
    });

    it('treats "same" and unknown preferences as inheritance', async () => {
      expect(
        (await spawnChild({ prompt: "Fix the parser", model_preference: "same" })).modelKey,
      ).toBeUndefined();
      expect(
        (await spawnChild({ prompt: "Fix the parser", model_preference: "gpt-9" })).modelKey,
      ).toBeUndefined();
    });

    it("keeps Haiku for explicit cheaper/haiku requests and extraction helpers", async () => {
      expect(
        (await spawnChild({ prompt: "Fix the parser", model_preference: "cheaper" })).modelKey,
      ).toBe("haiku-4-5");
      expect(
        (await spawnChild({ prompt: "Fix the parser", model_preference: "haiku" })).modelKey,
      ).toBe("haiku-4-5");
      const extraction = await spawnChild(
        {
          prompt:
            'Read "temp-writing-rules.html" in the workspace and extract meaningful content to markdown.',
        },
        { providerType: "openai", modelKey: "gpt-5.2" },
      );
      expect(extraction.modelKey).toBe("haiku-4-5");
      expect(extraction.providerType).toBeUndefined();
    });

    it("gives implementer children 40 turns and other roles 20", async () => {
      expect((await spawnChild({ prompt: "Fix the failing date parser" })).maxTurns).toBe(40);
      expect(
        (await spawnChild({ prompt: "Fix the parser", worker_role: "researcher" })).maxTurns,
      ).toBe(20);
      expect(
        (await spawnChild({ prompt: "Fix the parser", worker_role: "verifier" })).maxTurns,
      ).toBe(20);
      expect((await spawnChild({ prompt: "Fix the parser", max_turns: 12 })).maxTurns).toBe(12);
    });
  });

  describe("orchestrate_agents", () => {
    const parentTask = {
      id: "parent-task",
      title: "Parent",
      prompt: "x",
      status: "executing",
      workspaceId: "ws-1",
      createdAt: 1,
      updatedAt: 1,
      depth: 0,
    };
    const tasks = [1, 2, 3, 4].map((index) => ({
      prompt: `Review vendor ${index} pricing notes`,
      title: `Vendor ${index}`,
    }));
    const node = (index: number, overrides: Record<string, unknown> = {}) => ({
      id: `node-${index}`,
      runId: "run-1",
      key: `batch-${index}`,
      title: `Vendor ${index}`,
      status: "running",
      publicHandle: `child-${index}`,
      ...overrides,
    });

    let prevLimit: string | undefined;
    let prevPhaseC: string | undefined;
    beforeEach(() => {
      prevLimit = process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT;
      prevPhaseC = process.env.COWORK_GUARDRAIL_PHASE_C;
      process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = "3";
      process.env.COWORK_GUARDRAIL_PHASE_C = "true";
    });
    afterEach(() => {
      process.env.COWORK_SUBAGENT_MAX_ACTIVE_PER_PARENT = prevLimit;
      process.env.COWORK_GUARDRAIL_PHASE_C = prevPhaseC;
    });

    it("queues tasks beyond the active child limit instead of rejecting them", async () => {
      const queued = node(4, { status: "ready", publicHandle: undefined });
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue(parentTask),
        getChildTasks: vi.fn().mockResolvedValue([]),
        createOrchestrationGraphRun: vi.fn().mockResolvedValue({
          run: { id: "run-1", maxParallel: 3 },
          nodes: [node(1), node(2), node(3), queued],
        }),
        getOrchestrationGraphSnapshot: vi.fn().mockResolvedValue({
          run: { id: "run-1", maxParallel: 3 },
          nodes: [node(1), node(2), node(3), node(4)],
        }),
        waitForDelegatedNode: vi.fn(async (_root: string, handle: string) => ({
          success: true,
          status: "completed",
          message: "Delegated work completed successfully",
          resultSummary: `summary for ${handle}`,
        })),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("orchestrate_agents", { tasks });

      expect(result.success).toBe(true);
      expect(daemon.createOrchestrationGraphRun).toHaveBeenCalledWith(
        expect.objectContaining({ maxParallel: 3 }),
      );
      expect(daemon.createOrchestrationGraphRun.mock.calls[0][0].nodes).toHaveLength(4);
      expect(result.completed).toBe(4);
      expect(result.results.map((entry: Any) => entry.task_id)).toEqual([
        "child-1",
        "child-2",
        "child-3",
        "child-4",
      ]);
      expect(daemon.waitForDelegatedNode).toHaveBeenCalledWith(
        "parent-task",
        "child-4",
        expect.any(Number),
      );
    });

    it("reports tasks that never started before the timeout as queued", async () => {
      const queued = node(4, { status: "ready", publicHandle: undefined });
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue(parentTask),
        getChildTasks: vi.fn().mockResolvedValue([]),
        createOrchestrationGraphRun: vi.fn().mockResolvedValue({
          run: { id: "run-1", maxParallel: 3 },
          nodes: [node(1), node(2), node(3), queued],
        }),
        getOrchestrationGraphSnapshot: vi.fn().mockResolvedValue({
          run: { id: "run-1", maxParallel: 3 },
          nodes: [node(1), node(2), node(3), queued],
        }),
        waitForDelegatedNode: vi.fn().mockResolvedValue({
          success: true,
          status: "completed",
          message: "Delegated work completed successfully",
        }),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("orchestrate_agents", {
        tasks,
        timeout_seconds: 1,
      });

      expect(result.results[3]).toMatchObject({ title: "Vendor 4", status: "queued" });
      expect(daemon.waitForDelegatedNode).toHaveBeenCalledTimes(3);
      expect(result.run_id).toBe("run-1");
      expect(result.message).toContain("get_orchestration_status");
    });

    it("leaves the slots a running run holds for its queued tasks", async () => {
      const activeChild = {
        ...parentTask,
        id: "child-active",
        parentTaskId: "parent-task",
        agentType: "sub",
        depth: 1,
      };
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue(parentTask),
        getChildTasks: vi.fn().mockResolvedValue([activeChild]),
        // An earlier run: one child running, two tasks queued behind it (2 parallel).
        listOrchestrationGraphsByRootTask: vi.fn().mockResolvedValue([
          {
            run: { id: "run-0", status: "running", maxParallel: 2 },
            nodes: [
              node(1, { runId: "run-0", taskId: "child-active" }),
              node(2, { runId: "run-0", status: "pending", publicHandle: undefined }),
              node(3, { runId: "run-0", status: "ready", publicHandle: undefined }),
            ],
          },
        ]),
        createOrchestrationGraphRun: vi.fn().mockResolvedValue({
          run: { id: "run-1", maxParallel: 1 },
          nodes: [node(1), node(2), node(3), node(4)],
        }),
        getOrchestrationGraphSnapshot: vi.fn(),
        waitForDelegatedNode: vi.fn().mockResolvedValue({ status: "completed" }),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("orchestrate_agents", { tasks });

      // 3 slots: one running child, one more the earlier run will start for its queue.
      expect(daemon.createOrchestrationGraphRun).toHaveBeenCalledWith(
        expect.objectContaining({ maxParallel: 1 }),
      );
      expect(result.max_parallel).toBe(1);
    });

    it.runIf(nativeSqliteAvailable)(
      "keeps a run's queued tasks and later spawn_agent calls within the limit together",
      async () => {
        const db = new Database(":memory:");
        createGraphSchema(db);
        const childTasks = new Map<string, Task>();
        const isActive = (task: Task) =>
          ["pending", "queued", "planning", "executing"].includes(task.status);
        const activeChildren = () => [...childTasks.values()].filter(isActive).length;
        let mostActiveChildren = 0;
        const engine = new OrchestrationGraphEngine(db, {
          createChildTask: async (params) => {
            const child = {
              ...parentTask,
              id: `child-${childTasks.size + 1}`,
              title: params.title,
              status: "executing",
              parentTaskId: params.parentTaskId,
              agentType: "sub",
              depth: 1,
            } as Task;
            childTasks.set(child.id, child);
            mostActiveChildren = Math.max(mostActiveChildren, activeChildren());
            return child;
          },
          createRootTask: async () => {
            throw new Error("unexpected root task");
          },
          getTaskById: async (taskId) => childTasks.get(taskId),
          cancelTask: async () => undefined,
          getActiveAgentRoles: () => [],
        });
        const repo = engine.getRepository();
        const daemon = {
          getTaskById: vi.fn(async (taskId: string) =>
            taskId === parentTask.id ? parentTask : childTasks.get(taskId),
          ),
          getChildTasks: vi.fn(async () => [...childTasks.values()]),
          createOrchestrationGraphRun: (params: Any) => engine.createRun(params),
          getOrchestrationGraphSnapshot: (runId: string) => repo.findSnapshotByRunId(runId),
          listOrchestrationGraphsByRootTask: (rootTaskId: string) =>
            repo.listSnapshotsByRootTaskId(rootTaskId),
          logEvent: vi.fn(),
        } as Any;
        const finish = (taskId: string) =>
          childTasks.set(taskId, { ...childTasks.get(taskId)!, status: "completed" });
        const registry = new ToolRegistry(workspace, daemon, "parent-task");
        const spawn = () => registry.executeTool("spawn_agent", { prompt: "Review vendor 5" });

        // What orchestrate_agents creates for four tasks with all three slots free.
        const run = await engine.createRun({
          rootTaskId: "parent-task",
          workspaceId: "ws-1",
          kind: "delegation",
          maxParallel: 3,
          metadata: { createdBy: "orchestrate_agents" },
          nodes: tasks.map((task, index) => ({
            key: `batch-${index + 1}`,
            title: task.title,
            prompt: task.prompt,
            kind: "child_task" as const,
            dispatchTarget: "native_child_task" as const,
            parentTaskId: "parent-task",
          })),
        });
        expect(activeChildren()).toBe(3);

        // A child finishes; its slot belongs to the queued fourth task, before and after the
        // run notices.
        finish("child-1");
        expect((await spawn()).error).toBe("FANOUT_LIMIT_REACHED");
        await engine.tickRun(run.run.id);
        expect(activeChildren()).toBe(3);
        expect((await spawn()).error).toBe("FANOUT_LIMIT_REACHED");

        // Once the queue is drained, finished children free their slots for spawn_agent.
        finish("child-2");
        await engine.tickRun(run.run.id);
        const spawned = await spawn();
        expect(spawned.success).toBe(true);
        expect((await spawn()).error).toBe("FANOUT_LIMIT_REACHED");
        expect(mostActiveChildren).toBe(3);
        db.close();
      },
    );

    it("does not count a paused child that holds a slot in its run", async () => {
      const pausedChild = {
        ...parentTask,
        id: "child-paused",
        status: "paused",
        parentTaskId: "parent-task",
        agentType: "sub",
        depth: 1,
      };
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue(parentTask),
        getChildTasks: vi.fn().mockResolvedValue([pausedChild]),
        // The paused child keeps its run's only slot, so the queued task cannot start either.
        listOrchestrationGraphsByRootTask: vi.fn().mockResolvedValue([
          {
            run: { id: "run-0", status: "running", maxParallel: 1 },
            nodes: [
              node(1, { runId: "run-0", taskId: "child-paused" }),
              node(2, { runId: "run-0", status: "pending", publicHandle: undefined }),
            ],
          },
        ]),
        createOrchestrationGraphRun: vi.fn().mockResolvedValue({
          run: { id: "run-1", maxParallel: 3 },
          nodes: [node(1), node(2), node(3), node(4)],
        }),
        getOrchestrationGraphSnapshot: vi.fn(),
        waitForDelegatedNode: vi.fn().mockResolvedValue({ status: "completed" }),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("orchestrate_agents", { tasks });

      expect(result.max_parallel).toBe(3);
    });

    it("returns a coded error when no child-agent slot is free", async () => {
      const activeChild = {
        ...parentTask,
        id: "child-active",
        parentTaskId: "parent-task",
        agentType: "sub",
        depth: 1,
      };
      const daemon = {
        getTaskById: vi.fn().mockResolvedValue(parentTask),
        getChildTasks: vi.fn().mockResolvedValue([activeChild, activeChild, activeChild]),
        createOrchestrationGraphRun: vi.fn(),
        logEvent: vi.fn(),
      } as Any;

      const registry = new ToolRegistry(workspace, daemon, "parent-task");
      const result = await registry.executeTool("orchestrate_agents", { tasks });

      expect(result.success).toBe(false);
      expect(result.error).toBe("FANOUT_LIMIT_REACHED");
      expect(result.message).toContain("3/3");
      expect(daemon.createOrchestrationGraphRun).not.toHaveBeenCalled();
    });
  });
});
