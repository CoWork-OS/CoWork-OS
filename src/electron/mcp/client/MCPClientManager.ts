/**
 * MCPClientManager - Manages all MCP server connections
 *
 * This is the main interface for the MCP client functionality.
 * It manages multiple server connections, aggregates tools,
 * and routes tool calls to the appropriate server.
 */

import { EventEmitter } from "events";
import {
  MCPServerConfig,
  MCPServerStatus,
  MCPTool,
  MCPCallResult,
  MCPClientEvent,
  MCPSettings as _MCPSettings,
} from "../types";
import { MCPSettingsManager } from "../settings";
import { MCPServerConnection } from "./MCPServerConnection";
import { IPC_CHANNELS } from "../../../shared/types";

const CONNECTOR_SCRIPT_PATH_REGEX =
  /(?:^|[\\/])connectors[\\/]([^\\/]+)-mcp[\\/]dist[\\/]index\.js$/i;
const KNOWN_CONNECTORS = new Set([
  "salesforce",
  "jira",
  "hubspot",
  "zendesk",
  "servicenow",
  "linear",
  "asana",
  "okta",
  "resend",
]);

function getAllElectronWindows(): Any[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const BrowserWindow = electron?.BrowserWindow;
    if (BrowserWindow?.getAllWindows) return BrowserWindow.getAllWindows();
  } catch {
    // Not running under Electron.
  }
  return [];
}

export class MCPClientManager extends EventEmitter {
  private static instance: MCPClientManager | null = null;
  private connections: Map<string, MCPServerConnection> = new Map();
  private toolServerMap: Map<string, string> = new Map(); // tool name -> server id
  private initialized = false;
  private isInitializing = false; // Flag to batch operations during startup
  private rebuildToolMapDebounceTimer: NodeJS.Timeout | null = null;

  private constructor() {
    super();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): MCPClientManager {
    if (!MCPClientManager.instance) {
      MCPClientManager.instance = new MCPClientManager();
    }
    return MCPClientManager.instance;
  }

  /**
   * Initialize the client manager and connect to enabled servers
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log("[MCPClientManager] Initializing...");
    this.isInitializing = true;

    // Initialize settings manager
    MCPSettingsManager.initialize();

    // Enter batch mode to defer all settings saves until initialization completes
    MCPSettingsManager.beginBatch();

    // Load settings
    const settings = MCPSettingsManager.loadSettings();

    // Auto-connect if enabled - connect in PARALLEL for faster startup
    if (settings.autoConnect) {
      const enabledServers = settings.servers.filter((s) => s.enabled);
      const autoConnectServers: MCPServerConfig[] = [];
      for (const server of enabledServers) {
        if (this.shouldAutoConnect(server)) {
          autoConnectServers.push(server);
          continue;
        }

        const connectorId = this.detectConnectorId(server);
        if (connectorId) {
          // Keep persisted state aligned with behavior: unconfigured connectors stay disabled
          // until credentials are provided and users explicitly enable/connect them.
          MCPSettingsManager.updateServer(server.id, { enabled: false });
        }
      }
      console.log(
        `[MCPClientManager] Auto-connecting to ${autoConnectServers.length} enabled server(s) in parallel`,
      );

      const connectionPromises = autoConnectServers.map((server) =>
        this.connectServer(server.id).catch((error) => {
          console.error(`[MCPClientManager] Failed to auto-connect to ${server.name}:`, error);
          return null; // Don't throw, allow other connections to continue
        }),
      );

      await Promise.allSettled(connectionPromises);
    }

    this.isInitializing = false;
    this.initialized = true;

    // Rebuild tool map once after all connections are established
    this.rebuildToolMapImmediate();

    // End batch mode - this will save settings once if any changes were made
    MCPSettingsManager.endBatch();

    console.log("[MCPClientManager] Initialized");
  }

  /**
   * Shutdown and disconnect all servers
   */
  async shutdown(): Promise<void> {
    console.log("[MCPClientManager] Shutting down...");

    // Clear debounce timer to prevent memory leaks
    if (this.rebuildToolMapDebounceTimer) {
      clearTimeout(this.rebuildToolMapDebounceTimer);
      this.rebuildToolMapDebounceTimer = null;
    }

    const disconnectPromises = Array.from(this.connections.keys()).map((id) =>
      this.disconnectServer(id).catch((error) =>
        console.error(`[MCPClientManager] Error disconnecting ${id}:`, error),
      ),
    );

    await Promise.all(disconnectPromises);
    this.connections.clear();
    this.toolServerMap.clear();
    this.initialized = false;

    console.log("[MCPClientManager] Shutdown complete");
  }

  /**
   * Connect to a specific server
   */
  async connectServer(serverId: string): Promise<void> {
    // Check if already connected
    if (this.connections.has(serverId)) {
      const existing = this.connections.get(serverId)!;
      if (existing.getStatus().status === "connected") {
        console.log(`[MCPClientManager] Server ${serverId} already connected`);
        return;
      }
    }

    // Get server config
    const config = MCPSettingsManager.getServer(serverId);
    if (!config) {
      throw new Error(`Server ${serverId} not found`);
    }

    console.log(`[MCPClientManager] Connecting to server: ${config.name}`);

    // Get settings for reconnection config
    const settings = MCPSettingsManager.loadSettings();

    // Create connection
    const connection = new MCPServerConnection(config, {
      maxReconnectAttempts: settings.maxReconnectAttempts,
      reconnectDelayMs: settings.reconnectDelayMs,
    });

    // Set up event handlers
    this.setupConnectionHandlers(serverId, connection);

    // Store connection
    this.connections.set(serverId, connection);

    // Connect
    await connection.connect();

    // Rebuild tool map (debounced during initialization)
    this.rebuildToolMap();
  }

  /**
   * Disconnect from a specific server
   */
  async disconnectServer(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      console.log(`[MCPClientManager] Server ${serverId} not connected`);
      return;
    }

    console.log(`[MCPClientManager] Disconnecting from server: ${serverId}`);
    await connection.disconnect();
    this.connections.delete(serverId);

    // Rebuild tool map
    this.rebuildToolMap();
  }

  /**
   * Get all available tools from all connected servers
   */
  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = [];

    for (const connection of this.connections.values()) {
      if (connection.getStatus().status === "connected") {
        tools.push(...connection.getTools());
      }
    }

    return tools;
  }

  /**
   * Get tools from a specific server
   */
  getServerTools(serverId: string): MCPTool[] {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return [];
    }
    return connection.getTools();
  }

  /**
   * Check if a tool exists (by name)
   */
  hasTool(toolName: string): boolean {
    return this.toolServerMap.has(toolName);
  }

  /**
   * Call a tool by name
   */
  async callTool(toolName: string, args: Record<string, Any> = {}): Promise<MCPCallResult> {
    const serverId = this.toolServerMap.get(toolName);
    if (!serverId) {
      throw new Error(`Tool ${toolName} not found`);
    }

    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Server ${serverId} not connected`);
    }

    return connection.callTool(toolName, args);
  }

  /**
   * Get status of all servers
   */
  getStatus(): MCPServerStatus[] {
    const statuses: MCPServerStatus[] = [];
    const settings = MCPSettingsManager.loadSettings();

    for (const config of settings.servers) {
      const connection = this.connections.get(config.id);
      if (connection) {
        statuses.push(connection.getStatus());
      } else {
        // Server not connected
        statuses.push({
          id: config.id,
          name: config.name,
          status: "disconnected",
          error: config.lastError,
          tools: config.tools || [],
          lastPing: config.lastConnectedAt,
        });
      }
    }

    return statuses;
  }

  /**
   * Get status of a specific server
   */
  getServerStatus(serverId: string): MCPServerStatus | null {
    const connection = this.connections.get(serverId);
    if (connection) {
      return connection.getStatus();
    }

    // Check if server exists in settings
    const config = MCPSettingsManager.getServer(serverId);
    if (config) {
      return {
        id: config.id,
        name: config.name,
        status: "disconnected",
        error: config.lastError,
        tools: config.tools || [],
        lastPing: config.lastConnectedAt,
      };
    }

    return null;
  }

  /**
   * Test connection to a server (connect and disconnect)
   */
  async testServer(
    serverId: string,
  ): Promise<{ success: boolean; error?: string; tools?: number }> {
    try {
      await this.connectServer(serverId);
      const status = this.getServerStatus(serverId);
      const toolCount = status?.tools.length || 0;
      await this.disconnectServer(serverId);

      return { success: true, tools: toolCount };
    } catch (error: Any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Set up event handlers for a connection
   */
  private setupConnectionHandlers(serverId: string, connection: MCPServerConnection): void {
    connection.on("status_changed", (status, error) => {
      console.log(`[MCPClientManager] Server ${serverId} status: ${status}`, error || "");

      // Update settings with last error
      if (error) {
        MCPSettingsManager.updateServerError(serverId, error);
      } else if (status === "connected") {
        MCPSettingsManager.updateServerError(serverId, undefined);
      }

      // Emit event
      const event: MCPClientEvent = error
        ? { type: "server_error", serverId, error }
        : status === "connected"
          ? { type: "server_connected", serverId, serverInfo: connection.getStatus().serverInfo! }
          : status === "disconnected"
            ? { type: "server_disconnected", serverId }
            : status === "reconnecting"
              ? { type: "server_reconnecting", serverId, attempt: 0 }
              : { type: "server_disconnected", serverId };

      this.emit("event", event);

      // Broadcast to renderer
      this.broadcastStatusChange();
    });

    connection.on("tools_changed", (tools) => {
      console.log(`[MCPClientManager] Server ${serverId} tools changed: ${tools.length} tools`);

      // Update settings with tools
      MCPSettingsManager.updateServerTools(serverId, tools);

      // Rebuild tool map
      this.rebuildToolMap();

      // Emit event
      const event: MCPClientEvent = { type: "tools_changed", serverId, tools };
      this.emit("event", event);

      // Broadcast to renderer
      this.broadcastStatusChange();
    });

    connection.on("error", (error) => {
      console.error(`[MCPClientManager] Server ${serverId} error:`, error);
    });
  }

  /**
   * Rebuild the tool -> server mapping (debounced to avoid redundant rebuilds)
   */
  private rebuildToolMap(): void {
    // During initialization, skip individual rebuilds - we'll do one at the end
    if (this.isInitializing) {
      return;
    }

    // Debounce rebuilds to batch rapid changes
    if (this.rebuildToolMapDebounceTimer) {
      clearTimeout(this.rebuildToolMapDebounceTimer);
    }

    this.rebuildToolMapDebounceTimer = setTimeout(() => {
      this.rebuildToolMapImmediate();
      this.rebuildToolMapDebounceTimer = null;
    }, 100);
  }

  /**
   * Immediately rebuild the tool -> server mapping (no debounce)
   */
  private rebuildToolMapImmediate(): void {
    this.toolServerMap.clear();

    for (const [serverId, connection] of this.connections) {
      if (connection.getStatus().status === "connected") {
        for (const tool of connection.getTools()) {
          if (this.toolServerMap.has(tool.name)) {
            console.warn(
              `[MCPClientManager] Tool name collision: ${tool.name} from ${serverId} conflicts with ${this.toolServerMap.get(tool.name)}`,
            );
          } else {
            this.toolServerMap.set(tool.name, serverId);
          }
        }
      }
    }

    console.log(`[MCPClientManager] Tool map rebuilt: ${this.toolServerMap.size} tools`);
  }

  /**
   * Broadcast status change to all renderer windows
   */
  private broadcastStatusChange(): void {
    const status = this.getStatus();
    const windows = getAllElectronWindows();

    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGE, status);
      }
    }
  }

  private shouldAutoConnect(server: MCPServerConfig): boolean {
    const connectorId = this.detectConnectorId(server);
    if (!connectorId) {
      return true;
    }

    if (this.isConnectorConfigured(connectorId, server.env)) {
      return true;
    }

    console.log(
      `[MCPClientManager] Skipping auto-connect for unconfigured connector: ${server.name} (${connectorId})`,
    );
    return false;
  }

  private detectConnectorId(server: MCPServerConfig): string | null {
    const args = server.args || [];
    for (const arg of args) {
      const match = arg.match(CONNECTOR_SCRIPT_PATH_REGEX);
      if (!match) continue;
      const connector = match[1].toLowerCase();
      if (KNOWN_CONNECTORS.has(connector)) return connector;
    }

    const lowerName = server.name.toLowerCase();
    for (const connector of KNOWN_CONNECTORS) {
      if (lowerName.includes(connector)) {
        return connector;
      }
    }

    return null;
  }

  private hasEnvValue(env: Record<string, string> | undefined, key: string): boolean {
    return Boolean(env?.[key]?.trim());
  }

  private hasAllEnvValues(env: Record<string, string> | undefined, keys: string[]): boolean {
    return keys.every((key) => this.hasEnvValue(env, key));
  }

  private isConnectorConfigured(
    connectorId: string,
    env: Record<string, string> | undefined,
  ): boolean {
    switch (connectorId) {
      case "salesforce":
        return (
          this.hasEnvValue(env, "SALESFORCE_INSTANCE_URL") &&
          (this.hasEnvValue(env, "SALESFORCE_ACCESS_TOKEN") ||
            this.hasAllEnvValues(env, [
              "SALESFORCE_CLIENT_ID",
              "SALESFORCE_CLIENT_SECRET",
              "SALESFORCE_REFRESH_TOKEN",
            ]))
        );
      case "jira":
        return (
          this.hasEnvValue(env, "JIRA_BASE_URL") &&
          (this.hasEnvValue(env, "JIRA_ACCESS_TOKEN") ||
            this.hasAllEnvValues(env, ["JIRA_EMAIL", "JIRA_API_TOKEN"]))
        );
      case "hubspot":
        return this.hasEnvValue(env, "HUBSPOT_ACCESS_TOKEN");
      case "zendesk":
        return (
          (this.hasEnvValue(env, "ZENDESK_BASE_URL") ||
            this.hasEnvValue(env, "ZENDESK_SUBDOMAIN")) &&
          (this.hasEnvValue(env, "ZENDESK_ACCESS_TOKEN") ||
            this.hasAllEnvValues(env, ["ZENDESK_EMAIL", "ZENDESK_API_TOKEN"]))
        );
      case "servicenow":
        return (
          (this.hasEnvValue(env, "SERVICENOW_INSTANCE_URL") ||
            this.hasEnvValue(env, "SERVICENOW_INSTANCE")) &&
          (this.hasEnvValue(env, "SERVICENOW_ACCESS_TOKEN") ||
            this.hasAllEnvValues(env, ["SERVICENOW_USERNAME", "SERVICENOW_PASSWORD"]))
        );
      case "linear":
        return this.hasEnvValue(env, "LINEAR_API_KEY");
      case "asana":
        return this.hasEnvValue(env, "ASANA_ACCESS_TOKEN");
      case "okta":
        return this.hasAllEnvValues(env, ["OKTA_BASE_URL", "OKTA_API_TOKEN"]);
      case "resend":
        return this.hasEnvValue(env, "RESEND_API_KEY");
      default:
        return true;
    }
  }
}
