import { codexComputerUseAppConsent, isCodexComputerUseServer } from "../codex-computer-use";
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
  JSONRPCRequest,
  MCPToolCallOptions,
} from "../types";
import { StdioTransport } from "./transports/StdioTransport";
import { SSETransport } from "./transports/SSETransport";
import { WebSocketTransport } from "./transports/WebSocketTransport";
import { StreamableHttpTransport } from "./transports/StreamableHttpTransport";
import { createLogger } from "../../utils/logger";
import { isLikelyIntegrationAuthError } from "../../notifications/integration-auth";

// MCP Protocol version we support
/** Latest MCP revision the client implements; servers may answer with an older one. */
const PROTOCOL_VERSION = "2025-06-18";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [
  MODERN_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

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
  private modernProtocol = false;
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
  private toolCallQueue: Promise<void> = Promise.resolve();
  private activeToolCall: MCPToolCallOptions | null = null;

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

  /** Protocol-level event methods are never exposed as model tools. */
  async requestEventMethod(method: string, params?: Record<string, Any>): Promise<Any> {
    if (!this.modernProtocol || this.status !== "connected" || !this.transport) {
      throw new Error(`MCP Events require a connected 2026-07-28 server: ${this.config.name}`);
    }
    if (!method.startsWith("events/")) throw new Error("Unsupported MCP Events method");
    return this.transport.sendRequest(method, params);
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
        if (this.status === "connected" && !this.modernProtocol) {
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
  async callTool(
    name: string,
    args: Record<string, Any> = {},
    options: MCPToolCallOptions = {},
  ): Promise<MCPCallResult> {
    // Stdio elicitation has no reliable parent request ID. Serialize calls so an
    // approval can only reach the task that owns the currently executing call.
    if (this.config.transport !== "stdio") return this.executeToolCall(name, args, options);
    const previous = this.toolCallQueue;
    let release!: () => void;
    this.toolCallQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const context = { ...options };
    this.activeToolCall = context;
    try {
      if (context.signal?.aborted) throw new Error("MCP tool call cancelled");
      return await this.executeToolCall(name, args, context);
    } finally {
      if (this.activeToolCall === context) this.activeToolCall = null;
      release();
    }
  }

  private async executeToolCall(
    name: string,
    args: Record<string, Any>,
    options: MCPToolCallOptions,
  ): Promise<MCPCallResult> {
    if (this.status !== "connected" || !this.transport) {
      throw new Error(`Server ${this.config.name} is not connected`);
    }

    // Verify tool exists
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Tool ${name} not found on server ${this.config.name}`);
    }

    const transport = this.transport;
    const beforeSend = async () => {
      if (options.signal?.aborted) throw new Error("MCP tool call cancelled");
      await options.beforeSend?.();
      if (options.signal?.aborted) throw new Error("MCP tool call cancelled");
      if (
        this.status !== "connected" ||
        this.transport !== transport ||
        !this.tools.some((tool) => tool.name === name)
      )
        throw new Error("MCP connection or tool changed before send");
    };
    await beforeSend();

    logger.debug(`Calling tool ${name} on ${this.config.name}`);

    try {
      const result = await transport.sendRequest(
        MCP_METHODS.TOOLS_CALL,
        {
          name,
          arguments: args,
        },
        { beforeSend, signal: options.signal },
      );

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

    if (this.config.transport === "stdio" || this.config.transport === "streamable-http") {
      this.transport.setProtocolVersion?.(MODERN_PROTOCOL_VERSION);
      try {
        const discovered = await this.transport.sendRequest("server/discover", undefined, {
          signal: AbortSignal.timeout(5000),
        });
        if (
          Array.isArray(discovered?.supportedVersions) &&
          discovered.supportedVersions.includes(MODERN_PROTOCOL_VERSION)
        ) {
          const info = discovered?._meta?.["io.modelcontextprotocol/serverInfo"];
          this.serverInfo = {
            name: info?.name || this.config.name,
            version: info?.version || "unknown",
            protocolVersion: MODERN_PROTOCOL_VERSION,
            capabilities: discovered.capabilities || {},
          };
          this.modernProtocol = true;
          return;
        }
      } catch (error) {
        logger.debug(`Modern MCP discovery unavailable for ${this.config.name}:`, error);
      }
      this.transport.setProtocolVersion?.(PROTOCOL_VERSION);
    }

    const result = await this.transport!.sendRequest(MCP_METHODS.INITIALIZE, {
      protocolVersion: PROTOCOL_VERSION,
      // Declare approval forms only when the transport can answer server requests.
      // Do not advertise roots: this client does not answer roots/list.
      capabilities: this.transport.sendResponse ? { elicitation: { form: {} } } : {},
      clientInfo: CLIENT_INFO,
    });

    if (
      result?.protocolVersion &&
      !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(String(result.protocolVersion))
    ) {
      logger.warn(
        `${this.config.name} negotiated unsupported MCP protocol ${result.protocolVersion}; continuing, but some features may not work`,
      );
    }

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
    if ("method" in message && "id" in message) {
      void this.handleServerRequest(message as JSONRPCRequest).catch((error) => {
        logger.warn("Failed to respond to MCP server request:", error);
      });
      return;
    }
    // Handle notifications
    if ("method" in message && !("id" in message)) {
      this.handleNotification(message as JSONRPCNotification);
    }
  }

  private async handleServerRequest(request: JSONRPCRequest): Promise<void> {
    const transport = this.transport;
    if (!transport?.sendResponse) return;
    if (request.method === "ping") {
      await transport.sendResponse({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    }
    if (request.method !== "elicitation/create") {
      await transport.sendResponse({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Unsupported MCP server request" },
      });
      return;
    }
    const context = this.activeToolCall;
    const params = request.params;
    const schema = params?.requestedSchema;
    const isApprovalForm =
      (params?.mode === undefined || params.mode === "form") &&
      typeof params?.message === "string" &&
      params.message.length > 0 &&
      params.message.length <= 4000 &&
      schema?.type === "object" &&
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties) &&
      Object.keys(schema.properties).length === 0 &&
      (schema.required === undefined ||
        (Array.isArray(schema.required) && schema.required.length === 0));
    let result: { action: "accept" | "decline" | "cancel"; content?: Record<string, never> } = {
      action: "cancel",
    };
    if (isApprovalForm && context?.onElicitation && !context.signal?.aborted) {
      try {
        result = await context.onElicitation({
          message: params!.message,
          ...(isCodexComputerUseServer(this.config)
            ? { computerUseApp: codexComputerUseAppConsent(params?._meta, params!.message) }
            : {}),
          mode: "form",
          requestedSchema: { type: "object", properties: {} },
        });
        // A late approval cannot authorize an expired call or another task.
        if (
          this.activeToolCall !== context ||
          context.signal?.aborted ||
          this.transport !== transport
        ) {
          result = { action: "cancel" };
        } else if (result.action === "accept") {
          result = { action: "accept", content: {} };
        }
      } catch {
        result = { action: "cancel" };
      }
    }
    if (this.transport === transport) {
      await transport.sendResponse({ jsonrpc: "2.0", id: request.id, result });
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
    this.modernProtocol = false;
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
