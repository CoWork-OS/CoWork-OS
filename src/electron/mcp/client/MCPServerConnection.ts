/**
 * MCPServerConnection - Manages connection to a single MCP server
 *
 * Handles connection lifecycle, MCP protocol handshake, tool discovery,
 * and tool execution for a single MCP server.
 */

import { EventEmitter } from "events";
import {
  MCPServerConfig,
  MCPServerStatus,
  MCPServerInfo,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPCallResult,
  MCPConnectionStatus,
  MCPTransport,
  MCP_METHODS,
  JSONRPCNotification,
  JSONRPCResponse,
} from "../types";
import { StdioTransport } from "./transports/StdioTransport";
import { SSETransport } from "./transports/SSETransport";
import { WebSocketTransport } from "./transports/WebSocketTransport";
import { StreamableHttpTransport } from "./transports/StreamableHttpTransport";
import { createLogger } from "../../utils/logger";
import { isLikelyIntegrationAuthError } from "../../notifications/integration-auth";

// MCP Protocol version we support
const PROTOCOL_VERSION = "2024-11-05";
const STREAMABLE_HTTP_PROTOCOL_VERSION = "2025-06-18";

// Client info to send during initialize
const CLIENT_INFO = {
  name: "CoWork-OS",
  version: "1.0.0",
};
const logger = createLogger("MCPServerConnection");

export interface MCPServerConnectionEvents {
  status_changed: (status: MCPConnectionStatus, error?: string) => void;
  tools_changed: (tools: MCPTool[]) => void;
  resources_changed: (resources: MCPResource[]) => void;
  prompts_changed: (prompts: MCPPrompt[]) => void;
  connector_event: (event: MCPConnectorEvent) => void;
  error: (error: Error) => void;
}

export interface MCPConnectorEvent {
  serverId: string;
  serverName: string;
  connectorId?: string;
  type: "tool_list_changed" | "resource_list_changed" | "resource_updated" | "prompt_list_changed";
  resourceUri?: string;
  timestamp: number;
  payload?: Record<string, Any>;
}

export class MCPServerConnection extends EventEmitter {
  private config: MCPServerConfig;
  private transport: MCPTransport | null = null;
  private status: MCPConnectionStatus = "disconnected";
  private serverInfo: MCPServerInfo | null = null;
  private tools: MCPTool[] = [];
  private resources: MCPResource[] = [];
  private prompts: MCPPrompt[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedAt: number | null = null;
  private intentionalDisconnect = false;
  private subscribedResourceUris = new Set<string>();

  constructor(
    config: MCPServerConfig,
    options: {
      maxReconnectAttempts?: number;
      reconnectDelayMs?: number;
    } = {},
  ) {
    super();
    this.config = config;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  }

  /**
   * Get current connection status
   */
  getStatus(): MCPServerStatus {
    return {
      id: this.config.id,
      name: this.config.name,
      status: this.status,
      error: this.config.lastError,
      tools: this.tools,
      resources: this.resources,
      prompts: this.prompts,
      serverInfo: this.serverInfo || undefined,
      lastPing: this.config.lastConnectedAt,
      uptime: this.connectedAt ? Date.now() - this.connectedAt : undefined,
    };
  }

  /**
   * Get available tools from this server
   */
  getTools(): MCPTool[] {
    return this.tools;
  }

  getResources(): MCPResource[] {
    return this.resources;
  }

  getPrompts(): MCPPrompt[] {
    return this.prompts;
  }

  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") {
      return;
    }

    // Reset intentional disconnect flag for new connection
    this.intentionalDisconnect = false;
    this.setStatus("connecting");

    try {
      // Create transport based on config
      this.transport = this.createTransport();

      // Set up transport handlers
      this.setupTransportHandlers();

      // Connect transport
      await this.transport.connect();

      // Perform MCP handshake
      await this.initialize();

      // Discover capabilities
      await this.discoverCapabilities();

      // Mark as connected
      this.connectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.setStatus("connected");

      logger.debug(`Connected to ${this.config.name}`);
    } catch (error: Any) {
      logger.error(`Failed to connect to ${this.config.name}:`, error);
      this.setStatus("error", error.message);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    // Mark as intentional to prevent reconnection attempts
    this.intentionalDisconnect = true;
    this.cancelReconnect();

    if (this.transport) {
      try {
        // Send shutdown notification if connected
        if (this.status === "connected") {
          await this.transport.send({
            jsonrpc: "2.0",
            method: MCP_METHODS.SHUTDOWN,
          });
        }
      } catch {
        // Ignore errors during shutdown
      }

      await this.transport.disconnect();
    }

    await this.cleanup();
    this.setStatus("disconnected");
    logger.debug(`Disconnected from ${this.config.name}`);
  }

  /**
   * Call a tool on this server
   */
  async callTool(name: string, args: Record<string, Any> = {}): Promise<MCPCallResult> {
    if (this.status !== "connected" || !this.transport) {
      throw new Error(`Server ${this.config.name} is not connected`);
    }

    // Verify tool exists
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Tool ${name} not found on server ${this.config.name}`);
    }

    logger.debug(`Calling tool ${name} on ${this.config.name}`);

    try {
      const result = await this.transport!.sendRequest(MCP_METHODS.TOOLS_CALL, {
        name,
        arguments: args,
      });

      return result as MCPCallResult;
    } catch (error: Any) {
      logger.error("Tool call failed:", error);
      throw new Error(`Tool ${name} failed: ${error.message}`);
    }
  }

  async subscribeResource(uri: string): Promise<void> {
    if (!uri.trim()) return;
    if (!this.transport || this.status !== "connected") {
      throw new Error(`Server ${this.config.name} is not connected`);
    }
    if (!this.serverInfo?.capabilities?.resources?.subscribe) {
      return;
    }
    if (this.subscribedResourceUris.has(uri)) {
      return;
    }
    await this.transport.sendRequest(MCP_METHODS.RESOURCES_SUBSCRIBE, { uri });
    this.subscribedResourceUris.add(uri);
  }

  async unsubscribeResource(uri: string): Promise<void> {
    if (!uri.trim()) return;
    if (!this.transport || this.status !== "connected") {
      this.subscribedResourceUris.delete(uri);
      return;
    }
    if (!this.serverInfo?.capabilities?.resources?.subscribe) {
      this.subscribedResourceUris.delete(uri);
      return;
    }
    await this.transport.sendRequest(MCP_METHODS.RESOURCES_UNSUBSCRIBE, { uri });
    this.subscribedResourceUris.delete(uri);
  }

  async syncResourceSubscriptions(resourceUris: Iterable<string>): Promise<void> {
    const nextUris = new Set(
      Array.from(resourceUris)
        .map((uri) => String(uri || "").trim())
        .filter(Boolean),
    );
    const toUnsubscribe = Array.from(this.subscribedResourceUris).filter(
      (uri) => !nextUris.has(uri),
    );
    const toSubscribe = Array.from(nextUris).filter((uri) => !this.subscribedResourceUris.has(uri));
    for (const uri of toUnsubscribe) {
      await this.unsubscribeResource(uri);
    }
    for (const uri of toSubscribe) {
      await this.subscribeResource(uri);
    }
  }

  /**
   * Update the server configuration
   */
  updateConfig(config: MCPServerConfig): void {
    this.config = config;
  }

  /**
   * Create the appropriate transport based on config
   */
  private createTransport(): MCPTransport {
    switch (this.config.transport) {
      case "stdio":
        return new StdioTransport(this.config);
      case "sse":
        if (!this.config.url) {
          throw new Error("URL is required for SSE transport");
        }
        return new SSETransport(this.config);
      case "websocket":
        if (!this.config.url) {
          throw new Error("URL is required for WebSocket transport");
        }
        return new WebSocketTransport(this.config);
      case "streamable-http":
        if (!this.config.url) {
          throw new Error("URL is required for Streamable HTTP transport");
        }
        return new StreamableHttpTransport(this.config);
      default:
        throw new Error(`Unknown transport type: ${this.config.transport}`);
    }
  }

  /**
   * Set up transport event handlers
   */
  private setupTransportHandlers(): void {
    if (!this.transport) return;

    this.transport.onMessage((message) => {
      this.handleMessage(message);
    });

    this.transport.onClose((error) => {
      logger.debug(`Transport closed for ${this.config.name}`, error);
      // Only trigger reconnection for unexpected disconnections
      if (this.status === "connected" && !this.intentionalDisconnect) {
        this.handleDisconnection(error);
      }
    });

    this.transport.onError((error) => {
      logger.error(`Transport error for ${this.config.name}:`, error);
      this.emit("error", error);
    });
  }

  /**
   * Perform MCP initialize handshake
   */
  private async initialize(): Promise<void> {
    if (!this.transport) {
      throw new Error("No transport");
    }

    logger.debug(`Initializing connection to ${this.config.name}`);

    const result = await this.transport!.sendRequest(MCP_METHODS.INITIALIZE, {
      protocolVersion:
        this.config.transport === "streamable-http"
          ? STREAMABLE_HTTP_PROTOCOL_VERSION
          : PROTOCOL_VERSION,
      capabilities: {
        // Declare capabilities we actually support
        // Note: roots capability removed - we don't respond to roots/list requests
        // and some servers timeout waiting for the response
      },
      clientInfo: CLIENT_INFO,
    });

    this.serverInfo = {
      name: result.serverInfo?.name || this.config.name,
      version: result.serverInfo?.version || "unknown",
      protocolVersion: result.protocolVersion,
      capabilities: result.capabilities,
    };

    logger.debug("Server info:", this.serverInfo);

    // Send initialized notification
    await this.transport.send({
      jsonrpc: "2.0",
      method: MCP_METHODS.INITIALIZED,
    });
  }

  /**
   * Discover server capabilities (tools, resources, prompts)
   */
  private async discoverCapabilities(): Promise<void> {
    if (!this.transport) {
      throw new Error("No transport");
    }

    // Discover tools
    if (this.serverInfo?.capabilities?.tools) {
      try {
        const result = await this.transport!.sendRequest(MCP_METHODS.TOOLS_LIST);
        this.tools = result.tools || [];
        logger.debug(`Discovered ${this.tools.length} tools from ${this.config.name}`);
        this.emit("tools_changed", this.tools);
      } catch (error) {
        logger.warn("Failed to list tools:", error);
      }
    }

    // Discover resources
    if (this.serverInfo?.capabilities?.resources) {
      try {
        const result = await this.transport!.sendRequest(MCP_METHODS.RESOURCES_LIST);
        this.resources = result.resources || [];
        logger.debug(`Discovered ${this.resources.length} resources from ${this.config.name}`);
        this.emit("resources_changed", this.resources);
      } catch (error) {
        logger.warn("Failed to list resources:", error);
      }
    }

    // Discover prompts
    if (this.serverInfo?.capabilities?.prompts) {
      try {
        const result = await this.transport!.sendRequest(MCP_METHODS.PROMPTS_LIST);
        this.prompts = result.prompts || [];
        logger.debug(`Discovered ${this.prompts.length} prompts from ${this.config.name}`);
        this.emit("prompts_changed", this.prompts);
      } catch (error) {
        logger.warn("Failed to list prompts:", error);
      }
    }
  }

  /**
   * Handle incoming messages (notifications)
   */
  private handleMessage(message: JSONRPCResponse | JSONRPCNotification): void {
    // Handle notifications
    if ("method" in message && !("id" in message)) {
      this.handleNotification(message as JSONRPCNotification);
    }
  }

  /**
   * Handle MCP notifications
   */
  private handleNotification(notification: JSONRPCNotification): void {
    switch (notification.method) {
      case MCP_METHODS.TOOLS_LIST_CHANGED:
        // Re-fetch tools
        void this.refreshTools();
        this.emitConnectorEvent("tool_list_changed", notification.params);
        break;

      case MCP_METHODS.RESOURCES_LIST_CHANGED:
        // Re-fetch resources
        void this.refreshResources();
        this.emitConnectorEvent("resource_list_changed", notification.params);
        break;

      case MCP_METHODS.RESOURCES_UPDATED:
        this.emitConnectorEvent(
          "resource_updated",
          notification.params,
          typeof notification.params?.uri === "string"
            ? notification.params.uri
            : typeof notification.params?.resource?.uri === "string"
              ? notification.params.resource.uri
              : undefined,
        );
        break;

      case MCP_METHODS.PROMPTS_LIST_CHANGED:
        // Re-fetch prompts
        void this.refreshPrompts();
        this.emitConnectorEvent("prompt_list_changed", notification.params);
        break;

      case MCP_METHODS.CANCELLED:
        // Request was cancelled by the server - this is informational
        // The corresponding pending request will be rejected with an error
        break;

      case MCP_METHODS.PROGRESS:
        // Progress updates for long-running operations - currently ignored
        break;

      case MCP_METHODS.MESSAGE:
        // Server log messages - could be logged at debug level if needed
        break;

      default:
        // Only log truly unknown notifications at debug level
        logger.debug(`Unknown notification: ${notification.method}`);
    }
  }

  private emitConnectorEvent(
    type: MCPConnectorEvent["type"],
    payload?: Record<string, Any>,
    resourceUri?: string,
  ): void {
    this.emit("connector_event", {
      serverId: this.config.id,
      serverName: this.config.name,
      type,
      resourceUri,
      timestamp: Date.now(),
      payload,
    } satisfies MCPConnectorEvent);
  }

  /**
   * Refresh tools list
   */
  private async refreshTools(): Promise<void> {
    if (!this.transport || this.status !== "connected") return;

    try {
      const result = await this.transport!.sendRequest(MCP_METHODS.TOOLS_LIST);
      this.tools = result.tools || [];
      this.emit("tools_changed", this.tools);
    } catch (error) {
      logger.warn("Failed to refresh tools:", error);
    }
  }

  /**
   * Refresh resources list
   */
  private async refreshResources(): Promise<void> {
    if (!this.transport || this.status !== "connected") return;

    try {
      const result = await this.transport!.sendRequest(MCP_METHODS.RESOURCES_LIST);
      this.resources = result.resources || [];
      this.emit("resources_changed", this.resources);
    } catch (error) {
      logger.warn("Failed to refresh resources:", error);
    }
  }

  /**
   * Refresh prompts list
   */
  private async refreshPrompts(): Promise<void> {
    if (!this.transport || this.status !== "connected") return;

    try {
      const result = await this.transport!.sendRequest(MCP_METHODS.PROMPTS_LIST);
      this.prompts = result.prompts || [];
      this.emit("prompts_changed", this.prompts);
    } catch (error) {
      logger.warn("Failed to refresh prompts:", error);
    }
  }

  /**
   * Handle unexpected disconnection
   */
  private handleDisconnection(error?: Error): void {
    this.connectedAt = null;
    this.cleanup();

    if (error && isLikelyIntegrationAuthError(error)) {
      this.setStatus("error", error.message || "Integration authorization failed");
      return;
    }

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.setStatus("error", error?.message || "Connection lost");
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = this.calculateReconnectDelay();

    logger.debug(
      `Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
    );
    this.setStatus("reconnecting");

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      try {
        await this.connect();
      } catch (error) {
        logger.error("Reconnect failed:", error);
        // connect() will handle further reconnection attempts
      }
    }, delay);
  }

  /**
   * Calculate reconnect delay with exponential backoff
   */
  private calculateReconnectDelay(): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s (capped)
    const baseDelay = this.reconnectDelayMs;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
    // Add some jitter (±20%)
    const jitter = delay * 0.2 * (Math.random() - 0.5);
    return Math.round(delay + jitter);
  }

  /**
   * Cancel any pending reconnection
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Clean up resources
   */
  private async cleanup(): Promise<void> {
    if (this.transport) {
      this.transport = null;
    }
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.subscribedResourceUris.clear();
    this.serverInfo = null;
    this.connectedAt = null;
  }

  /**
   * Set status and emit event
   */
  private setStatus(status: MCPConnectionStatus, error?: string): void {
    this.status = status;
    if (error) {
      this.config.lastError = error;
    } else if (status === "connected") {
      this.config.lastError = undefined;
      this.config.lastConnectedAt = Date.now();
    }
    this.emit("status_changed", status, error);
  }
}
