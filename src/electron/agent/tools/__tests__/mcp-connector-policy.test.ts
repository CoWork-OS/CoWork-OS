import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const policyState = vi.hoisted(() => ({ blocked: [] as string[] }));

vi.mock("../../../admin/policies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../admin/policies")>()),
  loadPolicies: vi.fn(() => ({ connectors: { blocked: [...policyState.blocked] } })),
}));

import { ToolRegistry } from "../registry";
import { MCPClientManager } from "../../../mcp/client/MCPClientManager";
import { MCPSettingsManager } from "../../../mcp/settings";
import { CONNECTOR_BLOCKED_ERROR_CODE, ConnectorBlockedError } from "../../../mcp/connector-policy";

const server = {
  id: "server-jira",
  name: "Jira",
  enabled: true,
  transport: "stdio",
  registryId: "jira",
};

function setup() {
  vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({
    toolNamePrefix: "mcp_",
    servers: [server],
  } as Any);
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "issue list" }] }));
  const manager = {
    hasTool: (name: string) => name === "search_issues",
    getServerIdForTool: () => server.id,
    getAllTools: () => [{ name: "search_issues", inputSchema: { type: "object" } }],
    callTool,
  };
  vi.spyOn(MCPClientManager, "getInstance").mockReturnValue(manager as Any);
  const registry = Object.create(ToolRegistry.prototype) as Any;
  Object.assign(registry, {
    taskId: "task-1",
    daemon: {},
    workspace: {
      id: "fixture-workspace",
      path: "/tmp/fixture-workspace",
      permissions: { read: true, write: false, delete: false, network: true, shell: false },
    },
    evaluateMcpEndpointNetworkPolicy: () => null,
    getMcpServerName: () => server.name,
    assertResponsibilityPolicy: async () => undefined,
  });
  return { registry, callTool };
}

describe("MCP tool dispatch under admin connector policy", () => {
  beforeEach(() => {
    policyState.blocked = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it("denies a blocked connector's tool with a clear policy reason and never calls it", async () => {
    const { registry, callTool } = setup();
    policyState.blocked = ["jira"];

    const result = await registry.tryExecuteMCPTool("mcp_search_issues", { q: "bug" });

    expect(result).toMatchObject({
      success: false,
      policyDenied: true,
      code: CONNECTOR_BLOCKED_ERROR_CODE,
      source: "mcp",
      tool: "search_issues",
    });
    expect(result.error).toContain('Connector "Jira" is blocked by your administrator');
    expect(result.error).toContain("was not run");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("returns the same denial when the block lands while the call is in flight", async () => {
    const { registry, callTool } = setup();
    callTool.mockRejectedValueOnce(
      new ConnectorBlockedError(
        server.id,
        "jira",
        'Connector "Jira" is blocked by your administrator.',
      ),
    );

    const result = await registry.tryExecuteMCPTool("mcp_search_issues", {});

    expect(result).toMatchObject({ success: false, policyDenied: true });
    expect(result.error).toContain("blocked by your administrator");
  });

  it("reports the block when it surfaces as an authority change mid-call", async () => {
    const { registry, callTool } = setup();
    callTool.mockImplementationOnce(async () => {
      policyState.blocked = ["jira"];
      throw new Error("MCP authority changed before send; request approval again");
    });

    const result = await registry.tryExecuteMCPTool("mcp_search_issues", {});

    expect(result).toMatchObject({ success: false, policyDenied: true });
    expect(result.error).toContain("blocked by your administrator");
  });

  it("runs the tool again once the connector is unblocked", async () => {
    const { registry, callTool } = setup();
    policyState.blocked = ["jira"];
    expect((await registry.tryExecuteMCPTool("mcp_search_issues", {})).policyDenied).toBe(true);

    policyState.blocked = [];
    const result = await registry.tryExecuteMCPTool("mcp_search_issues", {});

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.policyDenied).toBeUndefined();
  });

  it("hides a blocked connector's tools from the model's catalog", () => {
    const { registry } = setup();
    expect(registry.getMCPToolDefinitions().map((tool: Any) => tool.name)).toEqual([
      "mcp_search_issues",
    ]);

    policyState.blocked = ["JIRA"];
    expect(registry.getMCPToolDefinitions()).toEqual([]);
  });

  it("refuses to configure a blocked provider through integration_setup", async () => {
    const { registry } = setup();
    vi.spyOn(MCPSettingsManager, "initialize").mockImplementation(() => undefined);
    vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({
      toolNamePrefix: "mcp_",
      servers: [],
    } as Any);
    vi.spyOn(MCPSettingsManager, "addServer");
    policyState.blocked = ["jira"];

    const result = await registry.integrationSetup({
      action: "configure",
      provider: "jira",
      dry_run: false,
    });

    expect(result).toMatchObject({
      success: false,
      provider: "jira",
      policyDenied: true,
      code: CONNECTOR_BLOCKED_ERROR_CODE,
    });
    expect(result.message).toContain("blocked by your administrator");
    expect(MCPSettingsManager.addServer).not.toHaveBeenCalled();
  });
});
