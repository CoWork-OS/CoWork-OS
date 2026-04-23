import { beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";

const mockMcpState = {
  version: 1,
  tools: [] as Any[],
};

const mockMcpSettings = {
  toolNamePrefix: "mcp_",
  servers: [] as Array<{ id: string; name: string }>,
};

const mockBuiltinSettings = {
  categories: {
    code: { enabled: true, priority: "high" },
    webfetch: { enabled: true, priority: "high" },
    browser: { enabled: true, priority: "normal" },
    search: { enabled: true, priority: "normal" },
    system: { enabled: true, priority: "normal" },
    file: { enabled: true, priority: "normal" },
    skill: { enabled: true, priority: "normal" },
    shell: { enabled: true, priority: "normal" },
    image: { enabled: true, priority: "normal" },
  },
  toolOverrides: {} as Record<string, { enabled: boolean; priority?: "high" | "normal" | "low" }>,
  toolTimeouts: {},
  toolAutoApprove: {},
  runCommandApprovalMode: "per_command" as const,
  version: "1.0.0",
};

const supermemoryIsConfiguredMock = vi.fn(() => false);

const isToolEnabledMock = vi.fn((toolName: string) => {
  const override = mockBuiltinSettings.toolOverrides[toolName];
  return override ? override.enabled : true;
});

const getToolPriorityMock = vi.fn(() => "normal" as const);

vi.mock("../mention-tools", () => ({
  MentionTools: class MockMentionTools {
    static getToolDefinitions() {
      return [];
    }
  },
}));

vi.mock("../builtin-settings", () => ({
  BuiltinToolsSettingsManager: {
    loadSettings: vi.fn(() => ({
      ...mockBuiltinSettings,
      categories: { ...mockBuiltinSettings.categories },
      toolOverrides: { ...mockBuiltinSettings.toolOverrides },
      toolTimeouts: { ...mockBuiltinSettings.toolTimeouts },
      toolAutoApprove: { ...mockBuiltinSettings.toolAutoApprove },
    })),
    isToolEnabled: vi.fn((toolName: string) => isToolEnabledMock(toolName)),
    getToolPriority: vi.fn((toolName: string) => getToolPriorityMock(toolName)),
  },
}));

vi.mock("../../../mcp/client/MCPClientManager", () => ({
  MCPClientManager: {
    getInstance: vi.fn(() => ({
      getAllTools: vi.fn(() => mockMcpState.tools),
      getToolCatalogVersion: vi.fn(() => mockMcpState.version),
      getServerIdForTool: vi.fn((toolName: string) => {
        const tool = mockMcpState.tools.find((entry) => entry.name === toolName);
        return tool?.serverId ?? null;
      }),
      hasTool: vi.fn((toolName: string) =>
        mockMcpState.tools.some((tool) => tool.name === toolName),
      ),
      callTool: vi.fn(),
    })),
  },
}));

vi.mock("../../../mcp/settings", () => ({
  MCPSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn(() => ({
      toolNamePrefix: mockMcpSettings.toolNamePrefix,
      servers: [...mockMcpSettings.servers],
    })),
    updateServer: vi.fn(),
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
    loadSettings: vi.fn(() => ({
      enabled: false,
      token: "",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    })),
    enableHooks: vi.fn(),
    updateConfig: vi.fn(),
  },
}));

vi.mock("../../../infra/infra-settings", () => ({
  InfraSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn(() => ({
      enabled: false,
      enabledCategories: {},
    })),
  },
}));

vi.mock("../../../memory/SupermemoryService", () => ({
  SupermemoryService: {
    isConfigured: vi.fn(() => supermemoryIsConfiguredMock()),
  },
}));

import { ToolRegistry } from "../registry";

function createWorkspace(): Any {
  return {
    id: "workspace-1",
    name: "Workspace",
    path: "/mock/workspace",
    permissions: {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: true,
    },
    createdAt: Date.now(),
  };
}

function createDaemon(): Any {
  return {
    logEvent: vi.fn(),
    registerArtifact: vi.fn(),
  };
}

describe("ToolRegistry tool catalog versioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMcpState.version = 1;
    mockMcpState.tools = [];
    mockMcpSettings.toolNamePrefix = "mcp_";
    mockMcpSettings.servers = [];
    mockBuiltinSettings.toolOverrides = {};
    mockBuiltinSettings.version = "1.0.0";
    isToolEnabledMock.mockImplementation((toolName: string) => {
      const override = mockBuiltinSettings.toolOverrides[toolName];
      return override ? override.enabled : true;
    });
    getToolPriorityMock.mockReturnValue("normal");
    supermemoryIsConfiguredMock.mockReturnValue(false);
  });

  it("invalidates cached tool definitions when the MCP catalog changes", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-1");

    const firstTools = registry.getTools();
    expect(firstTools.some((tool) => tool.name === "mcp_alpha")).toBe(false);

    mockMcpState.version = 2;
    mockMcpState.tools = [
      {
        name: "alpha",
        description: "Alpha",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];

    const secondTools = registry.getTools();
    expect(secondTools.some((tool) => tool.name === "mcp_alpha")).toBe(true);
  });

  it("annotates MCP tool descriptions with the source server name", () => {
    mockMcpSettings.servers = [{ id: "server-shuttle", name: "Shuttle" }];
    mockMcpState.version = 2;
    mockMcpState.tools = [
      {
        name: "search_docs",
        description: "Search project docs",
        inputSchema: { type: "object", properties: {}, required: [] },
        serverId: "server-shuttle",
      },
    ];

    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-mcp-server-name");
    const tool = registry.getTools().find((entry) => entry.name === "mcp_search_docs");

    expect(tool?.description).toContain('Provided by MCP server "Shuttle".');
  });

  it("invalidates cached tool definitions when built-in tool settings change", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-2");

    const firstTools = registry.getTools();
    expect(firstTools.some((tool) => tool.name === "web_search")).toBe(true);

    mockBuiltinSettings.version = "1.0.1";
    mockBuiltinSettings.toolOverrides = {
      web_search: { enabled: false },
    };

    const secondTools = registry.getTools();
    expect(secondTools.some((tool) => tool.name === "web_search")).toBe(false);
  });

  it("runs tool semantics invariants inside getTools", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-3");
    const invariantSpy = vi.spyOn(registry as Any, "validateToolSemanticsInvariant");

    registry.getTools();

    expect(invariantSpy).toHaveBeenCalled();
  });

  it("attaches runtime metadata to tool definitions", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-runtime");
    const readFile = registry.getTools().find((tool) => tool.name === "read_file");
    const skill = registry.getTools().find((tool) => tool.name === "Skill");

    expect(readFile?.runtime).toBeDefined();
    expect(readFile?.runtime?.concurrencyClass).toBe("read_parallel");
    expect(readFile?.runtime?.readOnly).toBe(true);
    expect(skill?.runtime?.approvalKind).toBe("none");
  });

  it("keeps Supermemory tools hidden by default", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-supermemory-default-off");

    const toolNames = registry.getTools().map((tool) => tool.name);
    expect(toolNames).not.toContain("supermemory_profile");
    expect(toolNames).not.toContain("supermemory_search");
    expect(toolNames).not.toContain("supermemory_remember");
    expect(toolNames).not.toContain("supermemory_forget");
  });

  it("exposes Supermemory tools only when the integration is configured", () => {
    supermemoryIsConfiguredMock.mockReturnValue(true);
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-supermemory-enabled");

    const toolNames = registry.getTools().map((tool) => tool.name);
    expect(toolNames).toContain("supermemory_profile");
    expect(toolNames).toContain("supermemory_search");
    expect(toolNames).toContain("supermemory_remember");
    expect(toolNames).toContain("supermemory_forget");
  });

  it("does not classify Skill as an external-service approval type", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-skill-approval");
    expect((registry as Any).getApprovalTypeForTool("Skill")).toBeNull();
  });

  it("does not pre-classify local reads as external services and keeps safe network reads scoped", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-safe-read-approval");

    expect((registry as Any).getApprovalTypeForTool("read_file")).toBeNull();
    expect((registry as Any).getApprovalTypeForTool("glob")).toBeNull();
    expect((registry as Any).getApprovalTypeForTool("web_search")).toBeNull();
    expect((registry as Any).getApprovalTypeForTool("web_fetch")).toBe("network_access");
    expect((registry as Any).getApprovalTypeForTool("http_request", { method: "GET" })).toBe("network_access");
    expect((registry as Any).getApprovalTypeForTool("http_request", { method: "POST", body: "x" })).toBe("data_export");
  });

  it("keeps explicit approval classes for destructive, integration, and computer-use tools", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-explicit-approval");

    expect((registry as Any).getApprovalTypeForTool("run_command")).toBe("run_command");
    expect((registry as Any).getApprovalTypeForTool("delete_file")).toBe("delete_file");
    expect((registry as Any).getApprovalTypeForTool("analyze_image")).toBe("data_export");
    expect((registry as Any).getApprovalTypeForTool("read_pdf_visual")).toBe("data_export");
    expect((registry as Any).getApprovalTypeForTool("mcp_fetch_issue")).toBe("external_service");
    expect((registry as Any).getApprovalTypeForTool("notion_action")).toBe("external_service");
    expect((registry as Any).getApprovalTypeForTool("click")).toBe("computer_use");
  });

  it("renders rollout tool descriptions from the shared tool-prompt metadata", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-prompting");
    const runCommand = registry.getTools().find((tool) => tool.name === "run_command");
    const rendered = registry.renderToolsForContext([runCommand!], {
      executionMode: "execute",
      taskDomain: "code",
      webSearchMode: "live",
      shellEnabled: true,
      agentType: "main",
      workerRole: null,
      allowUserInput: true,
    })[0];
    const compact = registry.getToolDescriptions(["web_search", "web_fetch"], {
      renderContext: {
        executionMode: "execute",
        taskDomain: "research",
        webSearchMode: "cached",
        shellEnabled: true,
        agentType: "main",
        workerRole: null,
        allowUserInput: true,
      },
    });

    expect(rendered.description).toContain("shell");
    expect(rendered.description).toContain("test");
    expect(compact).toContain("cached mode");
    expect(compact).toContain("web_fetch");
  });

  it("resolves scheduler specs independently from runtime metadata", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-scheduler");
    const spec = registry.getSchedulerSpec("browser_get_content", { session_id: "browser-1" });

    expect(spec.concurrencyClass).toBe("serial_only");
    expect(spec.idempotent).toBe(false);
  });

  it("uses the expected scheduler specs for session checklist tools", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-checklist");

    const createSpec = registry.getSchedulerSpec("task_list_create", {
      items: [{ title: "Implement", status: "pending" }],
    });
    const listSpec = registry.getSchedulerSpec("task_list_list", {});

    expect(createSpec.concurrencyClass).toBe("serial_only");
    expect(createSpec.readOnly).toBe(false);
    expect(createSpec.idempotent).toBe(false);

    expect(listSpec.concurrencyClass).toBe("read_parallel");
    expect(listSpec.readOnly).toBe(true);
    expect(listSpec.idempotent).toBe(true);
  });

  it("includes the tool_search meta tool and returns deferred matches", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-tool-search");
    const deferredTools = registry.getDeferredTools();
    const target = deferredTools[0];

    expect(registry.getTools().some((tool) => tool.name === "tool_search")).toBe(true);
    expect(target).toBeDefined();

    const result = registry.searchDeferredTools(`${target?.name} ${target?.description}`, 5);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.some((match) => match.name === target?.name)).toBe(true);
  });

  it("fails loudly in test when duplicate artifact tool semantics drift is detected", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-4");

    expect(() =>
      (registry as Any).validateToolSemanticsInvariant([
        {
          name: "create_document",
          description: "Create a document",
          input_schema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "create_document",
          description: "Duplicate create a document",
          input_schema: {
            type: "object",
            properties: {},
          },
        },
      ]),
    ).toThrow(/duplicate tool names detected/i);
  });

  it("accepts create_diagram when Mermaid validation is unavailable in the current runtime", async () => {
    const daemon = createDaemon();
    const registry = new ToolRegistry(createWorkspace(), daemon, "diagram-task");
    const parseSpy = vi
      .spyOn(mermaid, "parse")
      .mockRejectedValue(new Error("DOMPurify.addHook is not a function"));

    const result = await registry.executeTool("create_diagram", {
      title: "Timeline",
      diagram: "graph TD\nA[Start] --> B[Today]",
    });

    expect(result.success).toBe(true);
    expect(result.warning).toContain("pre-validation is unavailable");
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "diagram-task",
      "diagram_created",
      expect.objectContaining({ title: "Timeline" }),
    );

    parseSpy.mockRestore();
  });

  it("still rejects invalid Mermaid syntax when parser validation runs normally", async () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "diagram-task-2");
    const parseSpy = vi.spyOn(mermaid, "parse").mockRejectedValue(new Error("Parse error on line 1"));

    const result = await registry.executeTool("create_diagram", {
      title: "Broken",
      diagram: "not mermaid",
    });

    expect(result.success).toBe(false);
    expect(String(result.error || "")).toContain("invalid Mermaid syntax: Parse error on line 1");

    parseSpy.mockRestore();
  });
});
