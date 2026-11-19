import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../registry";
import { MCPClientManager } from "../../../mcp/client/MCPClientManager";
import { MCPSettingsManager } from "../../../mcp/settings";
import { parseToolRestrictions } from "../../../../shared/tool-restrictions";

const owners: Record<string, string> = { sf_query: "server-sf", wiq_search: "server-wiq" };

function setup() {
  vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({ toolNamePrefix: "mcp_" } as Any);
  vi.spyOn(MCPClientManager, "getInstance").mockReturnValue({
    getServerIdForTool: (name: string) => owners[name] ?? null,
  } as Any);
  const registry = Object.create(ToolRegistry.prototype) as Any;
  Object.assign(registry, {
    toolRestrictionSet: parseToolRestrictions(),
    connectorsOff: new Set(),
    cachedToolDefinitionsKey: "warm",
    cachedToolDefinitions: [],
    toolDescriptionsCache: new Map(),
    isBlockedByBotWorksOn: () => false,
    isBlockedByBotContainment: () => false,
  });
  return registry;
}

describe("connectors turned off for one conversation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("denies only the turned-off connector's tools", () => {
    const registry = setup();
    registry.setConnectorsOff(["server-sf"]);

    expect(registry.isDeniedByTaskRestrictions("mcp_sf_query")).toBe(true);
    expect(registry.isDeniedByTaskRestrictions("mcp_wiq_search")).toBe(false);
    expect(registry.isDeniedByTaskRestrictions("read_file")).toBe(false);
  });

  it("drops the tool catalog cache when the set changes, and allows the tool again when on", () => {
    const registry = setup();
    registry.setConnectorsOff(["server-sf"]);
    expect(registry.cachedToolDefinitionsKey).toBeNull();

    registry.setConnectorsOff([]);
    expect(registry.isDeniedByTaskRestrictions("mcp_sf_query")).toBe(false);
  });

  it("refuses a connector tool whose owner cannot be looked up while any is off", () => {
    const registry = setup();
    registry.setConnectorsOff(["server-sf"]);
    vi.spyOn(MCPClientManager, "getInstance").mockImplementation(() => {
      throw new Error("not ready");
    });

    expect(registry.isDeniedByTaskRestrictions("mcp_wiq_search")).toBe(true);
    expect(registry.isDeniedByTaskRestrictions("read_file")).toBe(false);
  });

  it("refuses a direct call to a turned-off connector's tool before it reaches the server", async () => {
    const registry = setup();
    const callTool = vi.fn();
    vi.spyOn(MCPClientManager, "getInstance").mockReturnValue({
      hasTool: () => true,
      getServerIdForTool: (name: string) => owners[name] ?? null,
      getAllTools: () => [],
      callTool,
    } as Any);
    Object.assign(registry, { evaluateMcpEndpointNetworkPolicy: () => null });
    registry.setConnectorsOff(["server-sf"]);

    await expect(registry.tryExecuteMCPTool("mcp_sf_query", {})).rejects.toThrow(
      "turned off for this conversation",
    );
    expect(callTool).not.toHaveBeenCalled();
  });
});
