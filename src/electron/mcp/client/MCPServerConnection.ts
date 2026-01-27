/**
 * MCPServerConnection - Manages connection to a single MCP server
 *
 * Handles connection lifecycle, MCP protocol handshake, tool discovery,
 * and tool execution for a single MCP server.
 */

import { EventEmitter } from 'events';
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
} from '../types';
import { StdioTransport } from './transports/StdioTransport';

// MCP Protocol version we support
const PROTOCOL_VERSION = '2024-11-05';

// Client info to send during initialize
const CLIENT_INFO = {
  name: 'CoWork-OSS',
  version: '1.0.0',
};

export interface MCPServerConnectionEvents {
  'status_changed': (status: MCPConnectionStatus, error?: string) => void;
  'tools_changed': (tools: MCPTool[]) => void;
  'resources_changed': (resources: MCPResource[]) => void;
  'prompts_changed': (prompts: MCPPrompt[]) => void;
  'error': (error: Error) => void;
}

export class MCPServerConnection extends EventEmitter {
  private config: MCPServerConfig;
  private transport: MCPTransport | null = null;
  private status: MCPConnectionStatus = 'disconnected';
  private serverInfo: MCPServerInfo | null = null;
  private tools: MCPTool[] = [];
  private resources: MCPResource[] = [];
  private prompts: MCPPrompt[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectedAt: number | null = null;
  private intentionalDisconnect = false;

  constructor(
    config: MCPServerConfig,
    options: {
      maxReconnectAttempts?: number;
      reconnectDelayMs?: number;
    } = {}
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

  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return;
    }

    // Reset intentional disconnect flag for new connection
    this.intentionalDisconnect = false;
    this.setStatus('connecting');

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
      this.setStatus('connected');

      console.log(`[MCPServerConnection] Connected to ${this.config.name}`);

    } catch (error: any) {
      console.error(`[MCPServerConnection] Failed to connect to ${this.config.name}:`, error);
      this.setStatus('error', error.message);
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
        if (this.status === 'connected') {
          await this.transport.send({
            jsonrpc: '2.0',
            method: MCP_METHODS.SHUTDOWN,
          });
        }
      } catch {
        // Ignore errors during shutdown
      }

      await this.transport.disconnect();
    }

    await this.cleanup();
    this.setStatus('disconnected');
    console.log(`[MCPServerConnection] Disconnected from ${this.config.name}`);
  }

  /**
   * Call a tool on this server
   */
  async callTool(name: string, args: Record<string, any> = {}): Promise<MCPCallResult> {
    if (this.status !== 'connected' || !this.transport) {
      throw new Error(`Server ${this.config.name} is not connected`);
    }

    // Verify tool exists
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Tool ${name} not found on server ${this.config.name}`);
    }

    console.log(`[MCPServerConnection] Calling tool ${name} on ${this.config.name}`);

    try {
      const result = await (this.transport as StdioTransport).sendRequest(MCP_METHODS.TOOLS_CALL, {
        name,
        arguments: args,
      });

      return result as MCPCallResult;

    } catch (error: any) {
      console.error(`[MCPServerConnection] Tool call failed:`, error);
      throw new Error(`Tool ${name} failed: ${error.message}`);
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
      case 'stdio':
        return new StdioTransport(this.config);
      case 'sse':
        // TODO: Implement SSETransport
        throw new Error('SSE transport not yet implemented');
      case 'websocket':
        // TODO: Implement WebSocketTransport
        throw new Error('WebSocket transport not yet implemented');
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
      console.log(`[MCPServerConnection] Transport closed for ${this.config.name}`, error);
      // Only trigger reconnection for unexpected disconnections
      if (this.status === 'connected' && !this.intentionalDisconnect) {
        this.handleDisconnection(error);
      }
    });

    this.transport.onError((error) => {
      console.error(`[MCPServerConnection] Transport error for ${this.config.name}:`, error);
      this.emit('error', error);
    });
  }

  /**
   * Perform MCP initialize handshake
   */
  private async initialize(): Promise<void> {
    if (!this.transport) {
      throw new Error('No transport');
    }

    console.log(`[MCPServerConnection] Initializing connection to ${this.config.name}`);

    const result = await (this.transport as StdioTransport).sendRequest(MCP_METHODS.INITIALIZE, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        // We support receiving tool/resource/prompt list change notifications
        roots: {
          listChanged: true,
        },
      },
      clientInfo: CLIENT_INFO,
    });

    this.serverInfo = {
      name: result.serverInfo?.name || this.config.name,
      version: result.serverInfo?.version || 'unknown',
      protocolVersion: result.protocolVersion,
      capabilities: result.capabilities,
    };

    console.log(`[MCPServerConnection] Server info:`, this.serverInfo);

    // Send initialized notification
    await this.transport.send({
      jsonrpc: '2.0',
      method: MCP_METHODS.INITIALIZED,
    });
  }

  /**
   * Discover server capabilities (tools, resources, prompts)
   */
  private async discoverCapabilities(): Promise<void> {
    if (!this.transport) {
      throw new Error('No transport');
    }

    // Discover tools
    if (this.serverInfo?.capabilities?.tools) {
      try {
        const result = await (this.transport as StdioTransport).sendRequest(MCP_METHODS.TOOLS_LIST);
        this.tools = result.tools || [];
        console.log(`[MCPServerConnection] Discovered ${this.tools.length} tools from ${this.config.name}`);
        this.emit('tools_changed', this.tools);
      } catch (error) {
        console.warn(`[MCPServerConnection] Failed to list tools:`, error);
      }
    }

    // Discover resources
    if (this.serverInfo?.capabilities?.resources) {
      try {
        const result = await (this.transport as StdioTransport).sendRequest(MCP_METHODS.RESOURCES_LIST);
        this.resources = result.resources || [];
        console.log(`[MCPServerConnection] Discovered ${this.resources.length} resources from ${this.config.name}`);
        this.emit('resources_changed', this.resources);
      } catch (error) {
        console.warn(`[MCPServerConnection] Failed to list resources:`, error);
      }
    }

    // Discover prompts
    if (this.serverInfo?.capabilities?.prompts) {
      try {
        const result = await (this.transport as StdioTransport).sendRequest(MCP_METHODS.PROMPTS_LIST);
        this.prompts = result.prompts || [];
        console.log(`[MCPServerConnection] Discovered ${this.prompts.length} prompts from ${this.config.name}`);
        this.emit('prompts_changed', this.prompts);
      } catch (error) {
        console.warn(`[MCPServerConnection] Failed to list prompts:`, error);
      }
    }
  }

  /**
   * Handle incoming messages (notifications)
   */
  private handleMessage(message: JSONRPCResponse | JSONRPCNotification): void {
    // Handle notifications
    if ('method' in message && !('id' in message)) {
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
        this.refreshTools();
        break;

      case MCP_METHODS.RESOURCES_LIST_CHANGED:
        // Re-fetch resources
        this.refreshResources();
        break;

      case MCP_METHODS.PROMPTS_LIST_CHANGED:
        // Re-fetch prompts
        this.refreshPrompts();
        break;

      default:
        console.log(`[MCPServerConnection] Unhandled notification: ${notification.method}`);
    }
  }

  /**
   * Refresh tools list
   */
  private async refreshTools(): Promise<void> {
    if (!this.transport || this.status !== 'connected') return;

    try {
      const result = await (this.transport as StdioTransport).sendRequest(MCP_METHODS.TOOLS_LIST);
      this.tools = result.tools || [];
      this.emit('tools_changed', this.tools);
    } catch (error) {
      console.warn(`[MCPServerConnection] Failed to refresh tools:`, error);
    }
  }

  /**
   * Refresh resources list
   */
  private async refreshResources(): Promise<void> {
    if (!this.transport || this.status !== 'connected') return;

    try {
      const result = await (this.transport as StdioTransport).sendRequest(MCP_METHODS.RESOURCES_LIST);
      this.resources = result.resources || [];
      this.emit('resources_changed', this.resources);
    } catch (error) {
      console.warn(`[MCPServerConnection] Failed to refresh resources:`, error);
    }
  }

  /**
   * Refresh prompts list
   */
  private async refreshPrompts(): Promise<void> {
    if (!this.transport || this.status !== 'connected') return;

    try {
      const result = await (this.transport as StdioTransport).sendRequest(MCP_METHODS.PROMPTS_LIST);
      this.prompts = result.prompts || [];
      this.emit('prompts_changed', this.prompts);
    } catch (error) {
      console.warn(`[MCPServerConnection] Failed to refresh prompts:`, error);
    }
  }

  /**
   * Handle unexpected disconnection
   */
  private handleDisconnection(error?: Error): void {
    this.connectedAt = null;
    this.cleanup();

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.setStatus('error', error?.message || 'Connection lost');
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = this.calculateReconnectDelay();

    console.log(`[MCPServerConnection] Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
    this.setStatus('reconnecting');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      try {
        await this.connect();
      } catch (error) {
        console.error(`[MCPServerConnection] Reconnect failed:`, error);
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
    } else if (status === 'connected') {
      this.config.lastError = undefined;
      this.config.lastConnectedAt = Date.now();
    }
    this.emit('status_changed', status, error);
  }
}
