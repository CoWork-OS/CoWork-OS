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
  MCPToolCallOptions,
  MCPSettings as _MCPSettings,
} from "../types";
import { MCPSettingsManager } from "../settings";
import { MCPServerConnection } from "./MCPServerConnection";
import { IPC_CHANNELS } from "../../../shared/types";
import { createLogger } from "../../utils/logger";
import {
  detectConnectorCapabilityId,
  getKnownConnectorIds,
  isConnectorConfiguredByCapability,
} from "../connectors/capabilities";
import type { MCPConnectorEvent } from "./MCPServerConnection";
import {
  isLikelyIntegrationAuthError,
  notifyIntegrationAuthIssue,
} from "../../notifications/integration-auth";
import { loadPolicies, type AdminPolicies } from "../../admin/policies";
import {
  assertMcpServerNotBlocked,
  connectorBlockedMessage,
  findBlockedConnectorId,
  isConnectorBlockedError,
} from "../connector-policy";

const KNOWN_CONNECTORS = new Set(getKnownConnectorIds());
const logger = createLogger("MCPClientManager");

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
  private toolCatalogSnapshot: { version: number; tools: MCPTool[] } = { version: 0, tools: [] };
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private isInitializing = false; // Flag to batch operations during startup
  private rebuildToolMapDebounceTimer: NodeJS.Timeout | null = null;
  private desiredTriggerResourceSubscriptions: Map<string, Set<string>> = new Map();
  /** Per-server set of executor IDs that currently reference the connection */
  private connectionRefCounts: Map<string, Set<string>> = new Map();
  /** Server IDs that were connected during initial startup — these are never auto-disconnected */
  private initialServerIds: Set<string> = new Set();
  /** Servers kept offline by admin policy that should come back when the block is lifted */
  private policyBlockedServerIds: Set<string> = new Set();
  private startupStats: { enabled: number; attempted: number; connected: number; failed: number } =
    {
      enabled: 0,
      attempted: 0,
      connected: 0,
      failed: 0,
    };

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
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = this.initializeConnections();
    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
      this.isInitializing = false;
      MCPSettingsManager.endBatch();
    }
  }

  private async initializeConnections(): Promise<void> {
    logger.info("Initializing...");
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
      const policies = loadPolicies();
      for (const server of enabledServers) {
        const blockedId = findBlockedConnectorId(server, policies);
        if (blockedId) {
          // Keep the user's enabled flag so lifting the block restores the connector.
          logger.info(`Skipping auto-connect: ${connectorBlockedMessage(server, blockedId)}`);
          this.policyBlockedServerIds.add(server.id);
          continue;
        }
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
      logger.info(`Auto-connecting to ${autoConnectServers.length} enabled server(s) in parallel`);

      const connectionPromises = autoConnectServers.map((server) =>
        this.connectServer(server.id).catch((error) => {
          logger.error(`Failed to auto-connect to ${server.name}:`, error);
          return null; // Don't throw, allow other connections to continue
        }),
      );

      await Promise.allSettled(connectionPromises);
      const connected = autoConnectServers.filter(
        (server) => this.connections.get(server.id)?.getStatus().status === "connected",
      ).length;
      const failed = autoConnectServers.length - connected;
      this.startupStats = {
        enabled: enabledServers.length,
        attempted: autoConnectServers.length,
        connected,
        failed,
      };
      logger.info(
        `Auto-connect summary: enabled=${enabledServers.length}, attempted=${autoConnectServers.length}, connected=${connected}, failed=${failed}`,
      );
    } else {
      this.startupStats = { enabled: 0, attempted: 0, connected: 0, failed: 0 };
    }

    this.isInitializing = false;
    this.initialized = true;

    // Snapshot initial server IDs so they are never auto-disconnected by releaseForExecutor
    this.initialServerIds = new Set(
      Array.from(this.connections.entries())
        .filter(([, conn]) => conn.getStatus().status === "connected")
        .map(([id]) => id),
    );

    // Rebuild tool map once after all connections are established
    this.rebuildToolMapImmediate();

    logger.info("Initialized");
  }

  /**
   * Register that an executor is using a particular MCP server connection.
   * Call this when a task executor starts using tools from a dynamically-connected server.
   */
  acquireForExecutor(executorId: string, serverId: string): void {
    const normalizedExecutorId = String(executorId || "").trim();
    const normalizedServerId = String(serverId || "").trim();
    if (!normalizedExecutorId || !normalizedServerId) return;

    let refs = this.connectionRefCounts.get(normalizedServerId);
    if (!refs) {
      refs = new Set();
      this.connectionRefCounts.set(normalizedServerId, refs);
    }
    refs.add(normalizedExecutorId);
  }

  /**
   * Release all MCP server references held by an executor.
   * Servers that were connected at startup (initial servers) are never auto-disconnected.
   * Dynamically-connected servers with no remaining references are disconnected to prevent leaks.
   */
  async releaseForExecutor(executorId: string): Promise<void> {
    const normalizedExecutorId = String(executorId || "").trim();
    if (!normalizedExecutorId) return;

    const serversToDisconnect: string[] = [];
    for (const [serverId, refs] of this.connectionRefCounts.entries()) {
      refs.delete(normalizedExecutorId);
      if (refs.size === 0) {
        this.connectionRefCounts.delete(serverId);
        if (!this.initialServerIds.has(serverId)) {
          serversToDisconnect.push(serverId);
        }
      }
    }

    await Promise.all(
      serversToDisconnect.map((serverId) =>
        this.disconnectServer(serverId).catch((error) =>
          logger.error(`Error releasing MCP server ${serverId}:`, error),
        ),
      ),
    );
  }

  /**
   * Shutdown and disconnect all servers
   */
  async shutdown(): Promise<void> {
    logger.debug("Shutting down...");

    // Clear debounce timer to prevent memory leaks
    if (this.rebuildToolMapDebounceTimer) {
      clearTimeout(this.rebuildToolMapDebounceTimer);
      this.rebuildToolMapDebounceTimer = null;
    }

    const disconnectPromises = Array.from(this.connections.keys()).map((id) =>
      this.disconnectServer(id).catch((error) => logger.error(`Error disconnecting ${id}:`, error)),
    );

    await Promise.all(disconnectPromises);
    this.connections.clear();
    this.toolServerMap.clear();
    this.toolCatalogSnapshot = {
      version: this.toolCatalogSnapshot.version + 1,
      tools: [],
    };
    this.initialized = false;

    logger.debug("Shutdown complete");
  }

  /**
   * Connect to a specific server
   */
  async connectServer(serverId: string): Promise<void> {
    // Admin policy comes first so a blocked server is never reported as connectable.
    this.assertServerNotBlocked(serverId);

    // Check if already connected
    if (this.connections.has(serverId)) {
      const existing = this.connections.get(serverId)!;
      if (existing.getStatus().status === "connected") {
        logger.debug(`Server ${serverId} already connected`);
        return;
      }
    }

    // Get server config
    const config = MCPSettingsManager.getServer(serverId);
    if (!config) {
      throw new Error(`Server ${serverId} not found`);
    }

    logger.debug(`Connecting to server: ${config.name}`);

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
      logger.debug(`Server ${serverId} not connected`);
      return;
    }

    logger.debug(`Disconnecting from server: ${serverId}`);
    await connection.disconnect();
    this.connections.delete(serverId);

    // Rebuild tool map
    this.rebuildToolMap();
  }

  /**
   * Get all available tools from all connected servers
   */
  getAllTools(): MCPTool[] {
    return this.toolCatalogSnapshot.tools.map((tool) => ({
      ...tool,
      inputSchema: tool.inputSchema ? { ...tool.inputSchema } : tool.inputSchema,
    }));
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

  getServerIdForTool(toolName: string): string | null {
    return this.toolServerMap.get(toolName) || null;
  }

  getServerConfigForTool(toolName: string): MCPServerConfig | null {
    const serverId = this.getServerIdForTool(toolName);
    if (!serverId) return null;
    return MCPSettingsManager.getServer(serverId) || null;
  }

  getConnectorIdForTool(toolName: string): string | null {
    const serverId = this.getServerIdForTool(toolName);
    if (!serverId) return null;
    const server = MCPSettingsManager.getServer(serverId);
    return server ? this.detectConnectorId(server) : null;
  }

  async syncTriggerResourceSubscriptions(
    triggers: Array<{ serverId?: string; connectorId?: string; resourceUri?: string }>,
  ): Promise<void> {
    const resourcesByServer = new Map<string, Set<string>>();
    for (const trigger of triggers) {
      const resourceUri = String(trigger.resourceUri || "").trim();
      if (!resourceUri) continue;
      const targetServerIds = new Set<string>();
      if (trigger.serverId) {
        targetServerIds.add(trigger.serverId);
      } else if (trigger.connectorId) {
        for (const [serverId] of this.connections) {
          const config = MCPSettingsManager.getServer(serverId);
          if (config && this.detectConnectorId(config) === trigger.connectorId) {
            targetServerIds.add(serverId);
          }
        }
      }
      for (const serverId of targetServerIds) {
        if (!resourcesByServer.has(serverId)) {
          resourcesByServer.set(serverId, new Set());
        }
        resourcesByServer.get(serverId)!.add(resourceUri);
      }
    }
    this.desiredTriggerResourceSubscriptions = resourcesByServer;
    const policies = loadPolicies();

    await Promise.all(
      Array.from(this.connections.entries()).map(async ([serverId, connection]) => {
        const config = MCPSettingsManager.getServer(serverId);
        const blocked = config ? findBlockedConnectorId(config, policies) !== null : false;
        try {
          await connection.syncResourceSubscriptions(
            blocked ? [] : this.desiredTriggerResourceSubscriptions.get(serverId) || [],
          );
        } catch (error) {
          logger.debug(`Failed to sync resource subscriptions for ${serverId}:`, error);
        }
      }),
    );
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
  async callTool(
    toolName: string,
    args: Record<string, Any> = {},
    options?: MCPToolCallOptions,
  ): Promise<MCPCallResult> {
    const serverId = this.toolServerMap.get(toolName);
    if (!serverId) {
      throw new Error(`Tool ${toolName} not found`);
    }

    // A server connected before the block was added must still be refused.
    this.assertServerNotBlocked(serverId);

    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Server ${serverId} not connected`);
    }

    try {
      return await connection.callTool(toolName, args, {
        ...options,
        beforeSend: this.policyCheckedBeforeSend(serverId, options?.beforeSend),
      });
    } catch (error) {
      const config = MCPSettingsManager.getServer(serverId);
      await this.notifyConnectorAuthIssue(serverId, config, error);
      throw error;
    }
  }

  /**
   * Call a tool on an explicitly selected server.
   *
   * Background source synchronizers must not route by global tool name: two
   * MCP servers can expose the same tool, and the selected server is part of
   * the source's access boundary.
   */
  async callServerTool(
    serverId: string,
    toolName: string,
    args: Record<string, Any> = {},
  ): Promise<MCPCallResult> {
    this.assertServerNotBlocked(serverId);

    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Server ${serverId} not connected`);
    }

    try {
      return await connection.callTool(toolName, args, {
        beforeSend: this.policyCheckedBeforeSend(serverId),
      });
    } catch (error) {
      const config = MCPSettingsManager.getServer(serverId);
      await this.notifyConnectorAuthIssue(serverId, config, error);
      throw error;
    }
  }

  getToolCatalogVersion(): number {
    return this.toolCatalogSnapshot.version;
  }

  /**
   * Get status of all servers
   */
  getStatus(): MCPServerStatus[] {
    const statuses: MCPServerStatus[] = [];
    const settings = MCPSettingsManager.loadSettings();
    const policies = loadPolicies();

    for (const config of settings.servers) {
      const connection = this.connections.get(config.id);
      if (connection) {
        statuses.push(this.withPolicyStatus(connection.getStatus(), config, policies));
      } else {
        // Server not connected
        statuses.push(
          this.withPolicyStatus(
            {
              id: config.id,
              name: config.name,
              status: "disconnected",
              error: config.lastError,
              tools: config.tools || [],
              lastPing: config.lastConnectedAt,
            },
            config,
            policies,
          ),
        );
      }
    }

    return statuses;
  }

  /**
   * Get status of a specific server
   */
  getServerStatus(serverId: string): MCPServerStatus | null {
    const config = MCPSettingsManager.getServer(serverId);
    const connection = this.connections.get(serverId);
    if (connection) {
      const status = connection.getStatus();
      return config ? this.withPolicyStatus(status, config) : status;
    }

    // Check if server exists in settings
    if (config) {
      return this.withPolicyStatus(
        {
          id: config.id,
          name: config.name,
          status: "disconnected",
          error: config.lastError,
          tools: config.tools || [],
          lastPing: config.lastConnectedAt,
        },
        config,
      );
    }

    return null;
  }

  /**
   * Apply the admin `connectors.blocked` policy to live connections: disconnect servers that
   * are now blocked, and reconnect servers that were kept offline only by a block that has
   * since been lifted. Tool calls are refused independently, so this only tidies up state.
   */
  async reconcileConnectorPolicy(): Promise<void> {
    const policies = loadPolicies();
    const settings = MCPSettingsManager.loadSettings();
    const toDisconnect: string[] = [];
    const toReconnect: string[] = [];

    for (const server of settings.servers) {
      if (findBlockedConnectorId(server, policies)) {
        if (this.connections.has(server.id)) {
          toDisconnect.push(server.id);
          this.policyBlockedServerIds.add(server.id);
        } else if (server.enabled && settings.autoConnect && this.initialized) {
          this.policyBlockedServerIds.add(server.id);
        }
        continue;
      }
      if (
        this.policyBlockedServerIds.delete(server.id) &&
        this.initialized &&
        server.enabled &&
        !this.connections.has(server.id) &&
        this.shouldAutoConnect(server)
      ) {
        toReconnect.push(server.id);
      }
    }

    await Promise.all(
      toDisconnect.map((serverId) =>
        this.disconnectServer(serverId).catch((error) =>
          logger.error(`Failed to disconnect policy-blocked server ${serverId}:`, error),
        ),
      ),
    );
    await Promise.all(
      toReconnect.map(async (serverId) => {
        try {
          await this.connectServer(serverId);
          // It would have been connected at startup, so keep it out of executor release.
          this.initialServerIds.add(serverId);
        } catch (error) {
          logger.error(`Failed to reconnect unblocked server ${serverId}:`, error);
        }
      }),
    );

    if (toDisconnect.length > 0 || toReconnect.length > 0) {
      logger.info(
        `Connector policy applied: disconnected=${toDisconnect.length}, reconnected=${toReconnect.length}`,
      );
    }
    this.broadcastStatusChange();
  }

  /**
   * Test connection to a server (connect and disconnect)
   */
  async testServer(
    serverId: string,
  ): Promise<{ success: boolean; error?: string; tools?: number; blockedByPolicy?: boolean }> {
    try {
      await this.connectServer(serverId);
      const status = this.getServerStatus(serverId);
      const toolCount = status?.tools.length || 0;
      await this.disconnectServer(serverId);

      return { success: true, tools: toolCount };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message,
        ...(isConnectorBlockedError(error) ? { blockedByPolicy: true } : {}),
      };
    }
  }

  getStartupStats(): { enabled: number; attempted: number; connected: number; failed: number } {
    return { ...this.startupStats };
  }

  /**
   * Set up event handlers for a connection
   */
  private setupConnectionHandlers(serverId: string, connection: MCPServerConnection): void {
    connection.on("status_changed", (status, error) => {
      logger.debug(`Server ${serverId} status: ${status}`, error || "");

      // Update settings with last error
      if (error) {
        MCPSettingsManager.updateServerError(serverId, error);
        const config = MCPSettingsManager.getServer(serverId);
        void this.notifyConnectorAuthIssue(serverId, config, new Error(error));
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

      if (status === "connected" || status === "disconnected" || status === "reconnecting") {
        this.rebuildToolMap();
      }
      if (status === "connected") {
        void connection
          .syncResourceSubscriptions(this.desiredTriggerResourceSubscriptions.get(serverId) || [])
          .catch((error) => {
            logger.debug(`Failed to restore resource subscriptions for ${serverId}:`, error);
          });
      }

      this.emit("event", event);

      // Broadcast to renderer
      this.broadcastStatusChange();
    });

    connection.on("tools_changed", (tools) => {
      logger.debug(`Server ${serverId} tools changed: ${tools.length} tools`);

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

    connection.on("connector_event", (event: MCPConnectorEvent) => {
      const config = MCPSettingsManager.getServer(serverId);
      if (config && findBlockedConnectorId(config)) {
        // Data from a blocked connector must not reach triggers before reconcile disconnects it.
        logger.debug(`Dropping connector event from policy-blocked server ${serverId}`);
        return;
      }
      const connectorId = config ? this.detectConnectorId(config) : undefined;
      this.emit("connector_event", {
        ...event,
        connectorId: event.connectorId || connectorId,
      });
    });

    connection.on("error", (error) => {
      logger.error(`Server ${serverId} error:`, error);
      const config = MCPSettingsManager.getServer(serverId);
      void this.notifyConnectorAuthIssue(serverId, config, error);
    });
  }

  /** Throws ConnectorBlockedError when admin policy blocks this server. */
  private assertServerNotBlocked(serverId: string): void {
    const config = MCPSettingsManager.getServer(serverId);
    if (config) assertMcpServerNotBlocked(config);
  }

  /** Re-check the block right before the request is sent; approvals can take a while. */
  private policyCheckedBeforeSend(
    serverId: string,
    beforeSend?: () => Promise<void>,
  ): () => Promise<void> {
    return async () => {
      this.assertServerNotBlocked(serverId);
      await beforeSend?.();
      this.assertServerNotBlocked(serverId);
    };
  }

  private withPolicyStatus(
    status: MCPServerStatus,
    config: MCPServerConfig,
    policies?: AdminPolicies,
  ): MCPServerStatus {
    const blockedId = findBlockedConnectorId(config, policies);
    if (!blockedId) return status;
    return {
      ...status,
      blockedByPolicy: true,
      error: connectorBlockedMessage(config, blockedId),
    };
  }

  private async notifyConnectorAuthIssue(
    serverId: string,
    config: MCPServerConfig | undefined,
    error: unknown,
  ): Promise<void> {
    // A policy block is not a sign-in problem, even if the server name mentions OAuth.
    if (isConnectorBlockedError(error) || !isLikelyIntegrationAuthError(error)) return;
    const connectorId = config ? this.detectConnectorId(config) : undefined;
    await notifyIntegrationAuthIssue({
      integrationId: connectorId || serverId,
      integrationName: config?.name || connectorId || serverId,
      settingsPath: "Settings > Integrations",
      reason: error instanceof Error ? error.message : String(error),
      dedupeKey: `mcp-${serverId}-auth`,
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

    if (this.rebuildToolMapDebounceTimer) {
      clearTimeout(this.rebuildToolMapDebounceTimer);
      this.rebuildToolMapDebounceTimer = null;
    }
    this.rebuildToolMapImmediate();
  }

  /**
   * Immediately rebuild the tool -> server mapping (no debounce)
   */
  private rebuildToolMapImmediate(): void {
    const nextToolServerMap = new Map<string, string>();
    const nextTools: MCPTool[] = [];

    for (const [serverId, connection] of this.connections) {
      if (connection.getStatus().status === "connected") {
        for (const tool of connection.getTools()) {
          if (nextToolServerMap.has(tool.name)) {
            logger.warn(
              `Tool name collision: ${tool.name} from ${serverId} conflicts with ${nextToolServerMap.get(tool.name)}`,
            );
          } else {
            nextToolServerMap.set(tool.name, serverId);
            nextTools.push({
              ...tool,
              inputSchema: tool.inputSchema ? { ...tool.inputSchema } : tool.inputSchema,
            });
          }
        }
      }
    }

    this.toolServerMap.clear();
    for (const [toolName, serverId] of nextToolServerMap.entries()) {
      this.toolServerMap.set(toolName, serverId);
    }
    this.toolCatalogSnapshot = {
      version: this.toolCatalogSnapshot.version + 1,
      tools: nextTools,
    };

    logger.debug(`Tool map rebuilt: ${this.toolServerMap.size} tools`);
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

    logger.debug(
      `Skipping auto-connect for unconfigured connector: ${server.name} (${connectorId})`,
    );
    return false;
  }

  private detectConnectorId(server: MCPServerConfig): string | null {
    const detected = detectConnectorCapabilityId(server);
    if (!detected) return null;
    return KNOWN_CONNECTORS.has(detected) ? detected : null;
  }

  private isConnectorConfigured(
    connectorId: string,
    env: Record<string, string> | undefined,
  ): boolean {
    return isConnectorConfiguredByCapability(connectorId, env);
  }
}
