import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMcpState = {
  version: 1,
  tools: [] as Any[],
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
      toolNamePrefix: "mcp_",
      servers: [],
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
    mockBuiltinSettings.toolOverrides = {};
    mockBuiltinSettings.version = "1.0.0";
    isToolEnabledMock.mockImplementation((toolName: string) => {
      const override = mockBuiltinSettings.toolOverrides[toolName];
      return override ? override.enabled : true;
    });
    getToolPriorityMock.mockReturnValue("normal");
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

    expect(readFile?.runtime).toBeDefined();
    expect(readFile?.runtime?.concurrencyClass).toBe("read_parallel");
    expect(readFile?.runtime?.readOnly).toBe(true);
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
});
