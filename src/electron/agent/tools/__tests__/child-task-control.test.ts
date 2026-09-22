import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, TaskEvent, Workspace } from "../../../../shared/types";
import { BuiltinToolsSettingsManager } from "../builtin-settings";

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
    expect(markBotHandoffReplied).not.toHaveBeenCalled();
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
});
