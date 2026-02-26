import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, TaskEvent, Workspace } from "../../../../shared/types";

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
      sendMessage: vi.fn().mockResolvedValue(undefined),
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
    });
    expect(ok.success).toBe(true);
    expect(daemon.sendMessage).toHaveBeenCalledWith("child-task", "hi");
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
});
