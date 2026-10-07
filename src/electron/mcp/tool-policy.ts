import { MCPClientManager } from "./client/MCPClientManager";
import { MCPSettingsManager } from "./settings";
import { connectorBlockedMessage, findBlockedConnectorId } from "./connector-policy";
import type { MCPServerConfig, MCPTool, MCPToolApprovalMode } from "./types";

export interface MCPToolPolicy {
  serverName: string;
  approvalMode: MCPToolApprovalMode;
  readOnly: boolean;
  enabled: boolean;
  endpoint?: string;
  /** Set when admin policy `connectors.blocked` blocks the server; a hard deny. */
  blockedReason?: string;
}

export function resolveMcpToolPolicy(tool: MCPTool, server: MCPServerConfig): MCPToolPolicy {
  const mode = server.toolApprovals?.[tool.name] ?? server.defaultToolsApprovalMode;
  return {
    serverName: server.name,
    approvalMode: mode === "prompt" || mode === "writes" || mode === "approve" ? mode : "auto",
    // Tool names are not evidence of read-only behavior. MCP annotations are
    // hints from a user-configured server; explicit rules and hard policy win.
    readOnly: tool.annotations?.readOnlyHint === true,
    enabled: server.enabled !== false,
    ...(server.url ? { endpoint: server.url } : {}),
  };
}

/** Resolve authority from the connected catalog and saved settings, never tool arguments. */
export function getConfiguredMcpToolPolicy(toolName: string): MCPToolPolicy | undefined {
  try {
    const settings = MCPSettingsManager.loadSettings();
    const prefix = settings.toolNamePrefix || "mcp_";
    if (!toolName.startsWith(prefix)) return undefined;
    const rawName = toolName.slice(prefix.length);
    const manager = MCPClientManager.getInstance();
    const serverId = manager.getServerIdForTool(rawName);
    const server = settings.servers.find((entry) => entry.id === serverId);
    const tool = manager.getAllTools().find((entry) => entry.name === rawName);
    if (!server || !tool) return undefined;
    const policy = resolveMcpToolPolicy(tool, server);
    const blockedId = findBlockedConnectorId(server);
    return blockedId
      ? { ...policy, blockedReason: connectorBlockedMessage(server, blockedId) }
      : policy;
  } catch {
    return undefined;
  }
}
