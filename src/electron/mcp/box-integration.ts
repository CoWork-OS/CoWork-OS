import type { BoxSettingsData } from "../../shared/types";
import { MCPClientManager } from "./client/MCPClientManager";
import { MCPSettingsManager } from "./settings";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

export const BOX_MCP_ENDPOINT = "https://mcp.box.com";
export const BOX_MCP_REGISTRY_ID = "box";
export const BOX_MCP_SERVER_NAME = "Box MCP";
const BOX_TOKEN_ENDPOINT = "https://api.box.com/oauth2/token";

function normalizeUrl(url?: string): string {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function isBoxMcpServer(server: MCPServerConfig): boolean {
  return (
    server.registryId === BOX_MCP_REGISTRY_ID ||
    normalizeUrl(server.url) === normalizeUrl(BOX_MCP_ENDPOINT) ||
    server.name.trim().toLowerCase() === BOX_MCP_SERVER_NAME.toLowerCase()
  );
}

export function getBoxMcpServer(): MCPServerConfig | undefined {
  return MCPSettingsManager.loadSettings().servers.find(isBoxMcpServer);
}

function buildBoxMcpAuth(settings: BoxSettingsData): MCPAuthConfig | undefined {
  if (!settings.accessToken) return undefined;

  return {
    type: "bearer",
    token: settings.accessToken,
    refreshToken: settings.refreshToken,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    tokenUrl: settings.refreshToken ? BOX_TOKEN_ENDPOINT : undefined,
    expiresAt: settings.tokenExpiresAt,
  };
}

/**
 * Keep the optional hosted Box MCP server aligned with Box integration settings.
 * The native Box REST tool remains independent and continues to work when MCP
 * is disabled.
 */
export function syncBoxMcpServerSettings(settings: BoxSettingsData): MCPServerConfig | null {
  if (settings.mcpEnabled === undefined) return null;

  const existing = getBoxMcpServer();
  if (settings.mcpEnabled === false) {
    if (!existing) return null;
    return MCPSettingsManager.updateServer(existing.id, { enabled: false });
  }

  const auth = buildBoxMcpAuth(settings);
  if (!auth) {
    if (!existing) return null;
    return MCPSettingsManager.updateServer(existing.id, {
      enabled: false,
      auth: undefined,
    });
  }

  const updates: Omit<MCPServerConfig, "id"> = {
    name: existing?.name || BOX_MCP_SERVER_NAME,
    description:
      "Box hosted MCP server for Box files, search, Box AI, Hubs, collaboration, and document workflows.",
    enabled: true,
    transport: "streamable-http",
    url: BOX_MCP_ENDPOINT,
    registryId: BOX_MCP_REGISTRY_ID,
    auth,
    connectionTimeout: settings.timeoutMs,
    requestTimeout: Math.max(settings.timeoutMs || 20000, 60000),
    version: existing?.version || "1.0.0",
    author: "Box",
    homepage: "https://developer.box.com/guides/box-mcp",
    repository: "https://github.com/box/box-for-ai",
    license: existing?.license,
  };

  if (existing) {
    return MCPSettingsManager.updateServer(existing.id, updates);
  }

  return MCPSettingsManager.addServer(updates);
}

export async function syncBoxMcpConnection(settings: BoxSettingsData): Promise<{
  serverId?: string;
  connected?: boolean;
  error?: string;
}> {
  const server = syncBoxMcpServerSettings(settings);
  if (!server) return {};

  const manager = MCPClientManager.getInstance();
  try {
    await manager.disconnectServer(server.id);
    if (server.enabled) {
      await manager.connectServer(server.id);
    }
    return { serverId: server.id, connected: server.enabled };
  } catch (error: Any) {
    return {
      serverId: server.id,
      connected: false,
      error: error?.message || "Failed to connect to the Box MCP server",
    };
  }
}
