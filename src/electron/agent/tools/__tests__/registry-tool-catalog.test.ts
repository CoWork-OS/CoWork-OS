import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PermissionEngine } from "../../runtime/PermissionEngine";
import { resolveWorkerRoleAgentConfig } from "../../runtime/worker-role-registry";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "../../../security/access-profile-resolver";
import type { AccessProfileDefinition } from "../../../../shared/access-profiles";
import type { PermissionSettingsData } from "../../../../shared/types";
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
const mockMcpCallTool = vi.fn().mockResolvedValue({ content: [] });

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
      callTool: mockMcpCallTool,
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
import { ChannelTools } from "../channel-tools";
import * as montyPolicy from "../../../security/monty-tool-policy";

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

const broadResearcherProfile: AccessProfileDefinition = {
  id: "broad_researcher_profile",
  label: "Broad researcher profile",
  description: "A broad profile supplied by a caller.",
  sandbox: "danger-full-access",
  approval: "never",
  reviewer: "none",
  network: "enabled",
  shellAccess: true,
};

const researcherAccessSettings: PermissionSettingsData = {
  version: 1,
  defaultMode: "bypass_permissions",
  defaultShellEnabled: true,
  defaultPermissionAccess: "full",
  defaultAccessProfileId: broadResearcherProfile.id,
  accessProfiles: [broadResearcherProfile],
  rules: [],
};

async function assertResearcherDispatchBoundary(task: Any): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-researcher-authority-"));
  const rawWorkspace = { ...createWorkspace(), path: root };
  const inspectionPath = path.join(root, "inspection.md");
  await fs.writeFile(inspectionPath, "Local evidence remains readable.\n", "utf8");

  try {
    const profile = resolveEffectiveAccessProfile({
      task,
      workspace: rawWorkspace,
      settings: researcherAccessSettings,
    });
    const workspace = applyAccessProfileToWorkspace(rawWorkspace, profile);
    const attackToolNames = [
      "write_file",
      "run_command",
      "browser_click",
      "gmail_action",
      "mcp_research_mutate",
      "click",
      "write_clipboard",
      "git_commit",
    ];
    const permissiveSessionRules = attackToolNames.slice(0, 5).map((toolName) => ({
      source: "session",
      effect: "allow",
      scope: { kind: "tool", toolName },
    }));
    const daemon = {
      ...createDaemon(),
      getTaskById: vi.fn().mockResolvedValue(task),
      getEffectiveAccessProfile: vi.fn(() => profile),
      evaluateToolPermission: vi.fn((_taskId: string, request: Any) =>
        PermissionEngine.evaluate({
          workspace,
          toolName: request.toolName,
          toolInput: request.details?.params,
          approvalType: request.approvalType,
          mode: profile.permissionMode,
          rules: permissiveSessionRules as Any,
        }),
      ),
      requestApproval: vi.fn().mockResolvedValue(true),
    };
    const registry = new ToolRegistry(
      workspace,
      daemon as Any,
      task.id,
      undefined,
      task.agentConfig?.toolRestrictions,
    );
    const internals = registry as Any;

    const writeFile = vi
      .spyOn(internals.fileTools, "writeFile")
      .mockResolvedValue({ success: true } as Any);
    const runCommand = vi
      .spyOn(internals.shellTools, "runCommand")
      .mockResolvedValue({ success: true } as Any);
    const browserAction = vi
      .spyOn(internals.browserTools, "executeTool")
      .mockResolvedValue({ success: true } as Any);
    const connectorAction = vi
      .spyOn(internals.gmailTools, "executeAction")
      .mockResolvedValue({ success: true } as Any);
    const computerAction = vi
      .spyOn(internals.computerUseTools, "click")
      .mockResolvedValue({ success: true } as Any);
    const clipboardAction = vi
      .spyOn(internals.systemTools, "writeClipboard")
      .mockResolvedValue({ success: true } as Any);
    const gitAction = vi
      .spyOn(internals.gitTools, "gitCommit")
      .mockResolvedValue({ success: true } as Any);
    mockMcpCallTool.mockClear();
    mockMcpCallTool.mockResolvedValue({ content: [] });
    mockMcpState.tools = [
      {
        name: "research_mutate",
        description: "External mutation fixture",
        inputSchema: { type: "object", properties: {}, required: [] },
        serverId: "research-server",
      },
    ];

    const readResult = await registry.executeToolWithRuntime("read_file", {
      path: inspectionPath,
    });
    expect(readResult.result.content).toContain("Local evidence remains readable.");

    const mutationCalls = [
      ["write_file", { path: path.join(root, "would-write.md"), content: "mutation" }],
      ["run_command", { command: "touch would-run" }],
      ["browser_click", { x: 1, y: 1 }],
      ["gmail_action", { action: "send_email", to: "nobody@example.test" }],
      ["mcp_research_mutate", { value: "mutation" }],
      ["click", { x: 1, y: 1 }],
      ["write_clipboard", { text: "mutation" }],
      ["git_commit", { message: "mutation" }],
    ] as const;
    for (const [toolName, input] of mutationCalls) {
      await expect(registry.executeToolWithRuntime(toolName, input)).rejects.toThrow();
    }

    expect(writeFile).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(browserAction).not.toHaveBeenCalled();
    expect(connectorAction).not.toHaveBeenCalled();
    expect(mockMcpCallTool).not.toHaveBeenCalled();
    expect(computerAction).not.toHaveBeenCalled();
    expect(clipboardAction).not.toHaveBeenCalled();
    expect(gitAction).not.toHaveBeenCalled();
    expect(daemon.requestApproval).not.toHaveBeenCalled();
    expect(profile).toMatchObject({
      permissionMode: "plan",
      shellEnabled: false,
      networkEnabled: false,
      definition: {
        sandbox: "read-only",
        network: "disabled",
        shellAccess: false,
        approval: "never",
        reviewer: "none",
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("ToolRegistry tool catalog versioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockMcpState.version = 1;
    mockMcpState.tools = [];
    mockMcpSettings.toolNamePrefix = "mcp_";
    mockMcpSettings.servers = [];
    mockMcpCallTool.mockReset().mockResolvedValue({ content: [] });
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

  it("blocks dispatch from a fresh researcher config even when its caller requests broad access", async () => {
    const task = {
      id: "new-researcher-task",
      workerRole: "researcher",
      agentConfig: resolveWorkerRoleAgentConfig("researcher", {
        accessProfileId: broadResearcherProfile.id,
        permissionMode: "bypass_permissions",
        shellAccess: true,
        readOnlyExecution: false,
        toolRestrictions: [],
      }),
    };

    await assertResearcherDispatchBoundary(task);
    expect(task.agentConfig.readOnlyExecution).toBe(true);
    expect(task.agentConfig.permissionMode).toBe("plan");
    expect(task.agentConfig.shellAccess).toBe(false);
  });

  it("blocks dispatch from a saved researcher task without a read-only flag", async () => {
    const task = {
      id: "saved-researcher-task",
      workerRole: "researcher",
      agentConfig: {
        accessProfileId: broadResearcherProfile.id,
        permissionMode: "bypass_permissions",
        shellAccess: true,
        toolRestrictions: ["group:write", "delete_file"],
      },
    };

    await assertResearcherDispatchBoundary(task);
    expect(task.agentConfig.readOnlyExecution).toBeUndefined();
  });

  it("no longer registers security scan helpers as tools (migrated to codex-security plugin skills)", () => {
    mockBuiltinSettings.version = "security-scan-gating";
    const normalRegistry = new ToolRegistry(createWorkspace(), createDaemon(), "task-normal");
    expect(normalRegistry.getTools().some((tool) => tool.name === "security_scan_prepare")).toBe(
      false,
    );

    // Even Codex Security tasks no longer get built-in security_scan_* tools; the scan
    // capability now lives in the codex-security plugin pack (security-scan,
    // security-diff-scan, deep-security-scan skills).
    const securityRegistry = new ToolRegistry(
      createWorkspace(),
      createDaemon(),
      "task-security",
      undefined,
      undefined,
      true,
    );
    expect(securityRegistry.getTools().some((tool) => tool.name === "security_scan_prepare")).toBe(
      false,
    );
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
    const registry = new ToolRegistry(
      createWorkspace(),
      createDaemon(),
      "task-supermemory-default-off",
    );

    const toolNames = registry.getTools().map((tool) => tool.name);
    expect(toolNames).not.toContain("supermemory_profile");
    expect(toolNames).not.toContain("supermemory_search");
    expect(toolNames).not.toContain("supermemory_remember");
    expect(toolNames).not.toContain("supermemory_forget");
  });

  it("exposes x_search only when xAI credentials exist and the opt-in toggle is enabled", () => {
    vi.stubEnv("XAI_API_KEY", "xai-key");
    mockBuiltinSettings.toolOverrides = {
      x_search: { enabled: true },
    };

    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-x-search-enabled");

    expect(registry.getTools().map((tool) => tool.name)).toContain("x_search");
  });

  it("exposes Supermemory tools only when the integration is configured", () => {
    supermemoryIsConfiguredMock.mockReturnValue(true);
    const registry = new ToolRegistry(
      createWorkspace(),
      createDaemon(),
      "task-supermemory-enabled",
    );

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

  it.each([false, true])(
    "denies code before dispatch when shell is disabled (network=%s)",
    async (allowNetwork) => {
      const workspace = createWorkspace();
      workspace.permissions.shell = false;
      const executeCode = vi.fn();
      const daemon = {
        ...createDaemon(),
        evaluateToolPermission: vi.fn((_taskId: string, request: Any) =>
          PermissionEngine.evaluate({
            workspace,
            toolName: request.toolName,
            toolInput: request.details?.params,
            approvalType: request.approvalType,
            mode: "bypass_permissions",
            rules: [],
          }),
        ),
      };
      const registry = new ToolRegistry(workspace, daemon as Any, "code-shell-disabled");
      (registry as Any)._codeExecTools = { executeCode };
      await expect(
        registry.executeToolWithRuntime("execute_code", {
          language: "python",
          code: "print(1)",
          allow_network: allowNetwork,
        }),
      ).rejects.toThrow();
      expect(executeCode).not.toHaveBeenCalled();
    },
  );

  it("does not pre-classify local reads as external services and keeps safe network reads scoped", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-safe-read-approval");

    expect((registry as Any).getApprovalTypeForTool("read_file")).toBeNull();
    expect((registry as Any).getApprovalTypeForTool("glob")).toBeNull();
    expect((registry as Any).getApprovalTypeForTool("web_search")).toBe("network_access");
    expect((registry as Any).getApprovalTypeForTool("web_fetch")).toBe("network_access");
    expect((registry as Any).getApprovalTypeForTool("execute_code", { allow_network: true })).toBe(
      "network_access",
    );
    expect((registry as Any).getApprovalTypeForTool("execute_code", { allow_network: false })).toBe(
      "run_command",
    );
    expect((registry as Any).getApprovalTypeForTool("http_request", { method: "GET" })).toBe(
      "network_access",
    );
    expect(
      (registry as Any).getApprovalTypeForTool("http_request", { method: "POST", body: "x" }),
    ).toBe("data_export");
  });

  it("classifies local file mutations as workspace writes rather than external services", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-workspace-write");

    expect(
      (registry as Any).getApprovalTypeForTool("write_file", { path: "notes/checklist.md" }),
    ).toBe("workspace_write");
    expect((registry as Any).getApprovalTypeForTool("edit_file", { path: "src/app.ts" })).toBe(
      "workspace_write",
    );
  });

  it("keeps explicit approval classes for destructive, integration, and computer-use tools", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-explicit-approval");

    expect((registry as Any).getApprovalTypeForTool("run_command")).toBe("run_command");
    expect((registry as Any).getApprovalTypeForTool("delete_file")).toBe("delete_file");
    expect((registry as Any).getApprovalTypeForTool("batch_image_process")).toBe(
      "external_file_access",
    );
    expect((registry as Any).getApprovalTypeForTool("get_current_location")).toBe(
      "location_access",
    );
    expect((registry as Any).getApprovalTypeForTool("analyze_image")).toBe("data_export");
    expect((registry as Any).getApprovalTypeForTool("read_pdf_visual")).toBe("data_export");
    expect((registry as Any).getApprovalTypeForTool("mcp_fetch_issue")).toBe("external_service");
    expect((registry as Any).getApprovalTypeForTool("notion_action")).toBe("external_service");
    expect((registry as Any).getApprovalTypeForTool("supermemory_search")).toBe("external_service");
    expect((registry as Any).getApprovalTypeForTool("channel_fetch_discord_messages")).toBe(
      "external_service",
    );
    expect((registry as Any).getApprovalTypeForTool("email_imap_unread")).toBe("external_service");
    expect((registry as Any).getApprovalTypeForTool("open_application")).toBe("computer_use");
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

  it("lets create_spreadsheet cells carry numbers, booleans and nulls, not only strings", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-spreadsheet");
    const createSpreadsheet = registry
      .getTools()
      .find((tool) => tool.name === "create_spreadsheet");
    const sheet = createSpreadsheet!.input_schema.properties.sheets.items.properties;

    for (const cell of [sheet.data.items.items, sheet.rows.items.items]) {
      expect(cell.type).toBeUndefined();
      expect(cell.description).toMatch(/number/i);
      expect(cell.description).toContain("=");
    }
  });

  it("advertises the table, list and code blocks create_document renders", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-document-schema");
    const createDocument = registry.getTools().find((tool) => tool.name === "create_document");
    const block = createDocument!.input_schema.properties.content.items.properties;

    expect(block.type.enum).toEqual(["heading", "paragraph", "list", "table", "code"]);
    expect(block.items.items.type).toBe("string");
    expect(block.rows.items.items.type).toBe("string");
  });

  it("keeps canonical tool facts when prompt guidance is appended", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-prompting-facts");
    const tools = registry.getTools();
    const pick = (name: string) => tools.find((tool) => tool.name === name)!;
    const [spawnAgent, navigate] = registry.renderToolsForContext(
      [pick("spawn_agent"), pick("browser_navigate")],
      {
        executionMode: "execute",
        taskDomain: "code",
        webSearchMode: "live",
        shellEnabled: true,
        agentType: "main",
        workerRole: null,
        allowUserInput: true,
      },
    );

    expect(spawnAgent.description).toContain("Returns immediately");
    expect(spawnAgent.description).toContain("wait_for_agent");
    expect(spawnAgent.description).toContain("worker_role");
    expect(navigate.description).toMatch(/headless/i);
    expect(navigate.description).not.toContain("By default this opens and controls the visible");
  });

  it("tells the model that run_command runs non-interactively", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-noninteractive");
    const runCommand = registry.getTools().find((tool) => tool.name === "run_command")!;
    const renderContext = {
      executionMode: "execute" as const,
      taskDomain: "code" as const,
      webSearchMode: "live" as const,
      shellEnabled: true,
      agentType: "main" as const,
      workerRole: null,
      allowUserInput: true,
    };
    // The rendered description (base text, then appended guidance) is what the model sees.
    const rendered = registry.renderToolsForContext([runCommand], renderContext)[0];
    const compact = registry.getToolDescriptions(["run_command"], { renderContext });

    for (const description of [runCommand.description, rendered.description, compact]) {
      expect(description).toMatch(/non-interactive/i);
      expect(description).toContain("--yes");
    }
    expect(rendered.description).toContain("dev servers and watchers with background: true");
    expect(compact).toContain("background: true");
  });

  it("offers background process control exactly when run_command is offered", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-background");
    const tools = registry.getTools();
    const runCommand = tools.find((tool) => tool.name === "run_command")!;
    const processOutput = tools.find((tool) => tool.name === "process_output")!;
    const stopProcess = tools.find((tool) => tool.name === "stop_process")!;

    expect(runCommand.input_schema.properties.background.type).toBe("boolean");
    expect(runCommand.description).toMatch(/dev servers.*background: true/s);
    expect(processOutput.description).toMatch(/^Read new output/);
    expect(processOutput.description).toMatch(/Use it to wait for a dev server/);
    expect(processOutput.input_schema.required).toBeUndefined();
    expect(stopProcess.description).toMatch(/Use it when you no longer need/);
    expect(stopProcess.input_schema.required).toEqual(["process_id"]);

    const noShell = createWorkspace();
    noShell.permissions.shell = false;
    const names = new ToolRegistry(noShell, createDaemon(), "task-background-no-shell")
      .getTools()
      .map((tool) => tool.name);
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("process_output");
    expect(names).not.toContain("stop_process");
  });

  it("schedules process_output as a parallel read and stop_process exclusively, without approval", () => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-background-spec");

    expect(registry.getSchedulerSpec("process_output", { process_id: "bg-1" })).toMatchObject({
      concurrencyClass: "read_parallel",
      readOnly: true,
      idempotent: true,
    });
    expect(registry.getSchedulerSpec("stop_process", { process_id: "bg-1" })).toMatchObject({
      concurrencyClass: "exclusive",
      readOnly: false,
      idempotent: false,
    });
    expect((registry as Any).getApprovalTypeForTool("process_output")).toBeNull();
    expect((registry as Any).getApprovalTypeForTool("stop_process")).toBeNull();
    expect(
      (registry as Any).getApprovalTypeForTool("run_command", {
        command: "npm run dev",
        background: true,
      }),
    ).toBe("run_command");
  });

  it("routes background run_command calls and process tools to the shell tools", async () => {
    const daemon = { ...createDaemon(), requestApproval: vi.fn().mockResolvedValue(true) };
    const registry = new ToolRegistry(createWorkspace(), daemon as Any, "task-background-route");
    const internals = registry as Any;
    const startBackground = vi
      .spyOn(internals.shellTools, "startBackgroundCommand")
      .mockResolvedValue({ success: true, background: true, process_id: "bg-1" } as Any);
    const runCommand = vi
      .spyOn(internals.shellTools, "runCommand")
      .mockResolvedValue({ success: true } as Any);
    const output = vi
      .spyOn(internals.shellTools, "getBackgroundProcessOutput")
      .mockResolvedValue({ success: true } as Any);
    const stop = vi
      .spyOn(internals.shellTools, "stopBackgroundProcess")
      .mockResolvedValue({ success: true } as Any);

    await registry.executeTool("run_command", {
      command: "npm run dev",
      cwd: "web",
      background: true,
      startup_wait_ms: 8000,
    });
    await registry.executeTool("process_output", { process_id: "bg-1", tail_lines: 5 });
    await registry.executeTool("stop_process", { process_id: "bg-1" });

    expect(startBackground).toHaveBeenCalledWith("npm run dev", {
      cwd: "web",
      env: undefined,
      signal: undefined,
      startupWaitMs: 8000,
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith({ process_id: "bg-1", tail_lines: 5 }, undefined);
    expect(stop).toHaveBeenCalledWith({ process_id: "bg-1" });
    // The background start passes the same pre-dispatch shell approval as any
    // run_command; reading or stopping the task's own process does not ask.
    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
    expect(daemon.requestApproval.mock.calls[0][1]).toBe("run_command");
  });

  it("prioritizes local channel history for message summarization", () => {
    const definitions = ChannelTools.getToolDefinitions();
    const listChats = definitions.find((tool) => tool.name === "channel_list_chats");
    const history = definitions.find((tool) => tool.name === "channel_history");

    expect(listChats?.description).toContain("before browser automation");
    expect(history?.description).toContain(
      "prefer this local history over opening the channel's web app",
    );
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
    mockMcpState.version = 2;
    mockMcpState.tools = [
      {
        name: "search_docs",
        description: "Search project docs",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];
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
    const parseSpy = vi
      .spyOn(mermaid, "parse")
      .mockRejectedValue(new Error("Parse error on line 1"));

    const result = await registry.executeTool("create_diagram", {
      title: "Broken",
      diagram: "not mermaid",
    });

    expect(result.success).toBe(false);
    expect(String(result.error || "")).toContain("invalid Mermaid syntax: Parse error on line 1");

    parseSpy.mockRestore();
  });
});

describe("registered workspace operations without approval interruptions", () => {
  it("does not execute a legacy handler after required consent is cancelled", async () => {
    const daemon = {
      ...createDaemon(),
      requestApproval: vi.fn(async () => {
        throw new Error("Approval request cancelled because tool execution ended");
      }),
    };
    const registry = new ToolRegistry(createWorkspace(), daemon as Any, "task-cancelled-consent");
    const legacy = vi.spyOn((registry as Any).handlerRegistry, "has").mockReturnValue(false);
    const reader = vi.spyOn((registry as Any).fileTools, "readFile");
    const policy = vi.spyOn(montyPolicy, "evaluateMontyToolPolicy").mockResolvedValue({
      decision: "require_approval",
      reason: "Explicit workspace consent",
    } as Any);
    try {
      await expect(registry.executeTool("read_file", { path: "note.md" })).rejects.toThrow(
        "cancelled",
      );
      expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      legacy.mockRestore();
      reader.mockRestore();
      policy.mockRestore();
    }
  });

  it.each(["ask_for_approval", "approve_for_me", "full_access"])(
    "writes a real temporary-session note under %s without approval calls or events",
    async (accessProfileId) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-boundary-"));
      const session = path.join(root, "cowork-os-temp", "ui-session-test");
      await fs.mkdir(session, { recursive: true });
      try {
        const source = { ...createWorkspace(), path: session };
        const profile = resolveEffectiveAccessProfile({
          workspace: source,
          task: { agentConfig: { accessProfileId } },
        });
        const workspace = applyAccessProfileToWorkspace(source, profile);
        const daemon = {
          ...createDaemon(),
          requestApproval: vi.fn(() => {
            throw new Error("Unexpected approval interruption");
          }),
          updateTask: vi.fn(),
          evaluateToolPermission: vi.fn((_taskId, request) =>
            PermissionEngine.evaluate({
              workspace,
              toolName: request.toolName,
              toolInput: request.details?.params,
              approvalType: request.approvalType,
              mode: profile.permissionMode,
              rules: [],
            }),
          ),
        };
        const registry = new ToolRegistry(workspace, daemon as Any, "task-local-note");
        const notePath = path.join(session, "scribe-conversation.md");
        const result = await registry.executeTool("write_file", {
          path: notePath,
          content: "# Conversation\nA saved workspace note.\n",
        });
        expect(result.success).toBe(true);
        expect(await fs.readFile(notePath, "utf8")).toContain("A saved workspace note.");
        await registry.executeTool("write_file", { path: notePath, content: "Updated note\n" });
        expect(await fs.readFile(notePath, "utf8")).toBe("Updated note\n");
        expect(daemon.requestApproval).not.toHaveBeenCalled();
        expect(daemon.updateTask).not.toHaveBeenCalled();
        expect(
          daemon.logEvent.mock.calls.some((call: Any[]) =>
            ["approval_requested", "approval_granted", "approval_denied"].includes(call[1]),
          ),
        ).toBe(false);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("run_command kill timeout", () => {
  const runHandler = async (input: Record<string, unknown>, runtime?: Record<string, unknown>) => {
    const registry = new ToolRegistry(createWorkspace(), createDaemon(), "task-shell-timeout");
    const internals = registry as Any;
    const runCommand = vi
      .spyOn(internals.shellTools, "runCommand")
      .mockResolvedValue({ success: true } as Any);
    await internals.handlerRegistry.execute("run_command", {
      request: { name: "run_command", input, runtime },
    });
    return runCommand;
  };

  it("uses the executor budget minus a grace period when the call sets no timeout", async () => {
    const runCommand = await runHandler({ command: "npm run build" }, { timeoutMs: 300_000 });

    expect(runCommand).toHaveBeenCalledWith(
      "npm run build",
      expect.objectContaining({ timeout: 297_000 }),
    );
  });

  it("honors explicit timeout aliases from the tool input", async () => {
    const fromSeconds = await runHandler(
      { command: "npm test", timeout_seconds: 120 },
      { timeoutMs: 120_000 },
    );
    expect(fromSeconds).toHaveBeenCalledWith(
      "npm test",
      expect.objectContaining({ timeout: 120_000 }),
    );

    const fromMs = await runHandler({ command: "make", timeout_ms: 90_000 });
    expect(fromMs).toHaveBeenCalledWith("make", expect.objectContaining({ timeout: 90_000 }));
  });

  it("falls back to the documented 120s default and clamps to the 30-minute maximum", async () => {
    const withoutBudget = await runHandler({ command: "git status" });
    expect(withoutBudget).toHaveBeenCalledWith(
      "git status",
      expect.objectContaining({ timeout: 120_000 }),
    );

    const long = await runHandler({ command: "npm ci", timeout: 900_000 });
    expect(long).toHaveBeenCalledWith("npm ci", expect.objectContaining({ timeout: 900_000 }));

    const oversized = await runHandler({ command: "npm ci", timeout: 3_600_000 });
    expect(oversized).toHaveBeenCalledWith(
      "npm ci",
      expect.objectContaining({ timeout: 1_800_000 }),
    );
  });

  it("never sets a kill timer past the executor's budget for the call", async () => {
    // The executor clamps a 30-minute request to its 15-minute step budget; the
    // command must be killed within that budget so its partial output survives.
    const clamped = await runHandler(
      { command: "cargo build --release", timeout_seconds: 1_800 },
      { timeoutMs: 895_000 },
    );
    expect(clamped).toHaveBeenCalledWith(
      "cargo build --release",
      expect.objectContaining({ timeout: 895_000 }),
    );
  });
});
