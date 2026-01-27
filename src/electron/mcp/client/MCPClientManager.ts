/**
 * MCPClientManager - Manages all MCP server connections
 *
 * This is the main interface for the MCP client functionality.
 * It manages multiple server connections, aggregates tools,
 * and routes tool calls to the appropriate server.
 */

import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import {
  MCPServerConfig,
  MCPServerStatus,
  MCPTool,
  MCPCallResult,
  MCPClientEvent,
  MCPSettings,
} from '../types';
import { MCPSettingsManager } from '../settings';
import { MCPServerConnection } from './MCPServerConnection';
import { IPC_CHANNELS } from '../../../shared/types';

export class MCPClientManager extends EventEmitter {
  private static instance: MCPClientManager | null = null;
  private connections: Map<string, MCPServerConnection> = new Map();
  private toolServerMap: Map<string, string> = new Map(); // tool name -> server id
  private initialized = false;

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

    console.log('[MCPClientManager] Initializing...');

    // Initialize settings manager
    MCPSettingsManager.initialize();

    // Load settings
    const settings = MCPSettingsManager.loadSettings();

    // Auto-connect if enabled
    if (settings.autoConnect) {
      const enabledServers = settings.servers.filter((s) => s.enabled);
      console.log(`[MCPClientManager] Auto-connecting to ${enabledServers.length} enabled servers`);

      for (const server of enabledServers) {
        try {
          await this.connectServer(server.id);
        } catch (error) {
          console.error(`[MCPClientManager] Failed to auto-connect to ${server.name}:`, error);
        }
      }
    }

    this.initialized = true;
    console.log('[MCPClientManager] Initialized');
  }

  /**
   * Shutdown and disconnect all servers
   */
  async shutdown(): Promise<void> {
    console.log('[MCPClientManager] Shutting down...');

    const disconnectPromises = Array.from(this.connections.keys()).map((id) =>
      this.disconnectServer(id).catch((error) =>
        console.error(`[MCPClientManager] Error disconnecting ${id}:`, error)
      )
    );

    await Promise.all(disconnectPromises);
    this.connections.clear();
    this.toolServerMap.clear();
    this.initialized = false;

    console.log('[MCPClientManager] Shutdown complete');
  }

  /**
   * Connect to a specific server
   */
  async connectServer(serverId: string): Promise<void> {
    // Check if already connected
    if (this.connections.has(serverId)) {
      const existing = this.connections.get(serverId)!;
      if (existing.getStatus().status === 'connected') {
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

    // Rebuild tool map
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
      if (connection.getStatus().status === 'connected') {
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
  async callTool(toolName: string, args: Record<string, any> = {}): Promise<MCPCallResult> {
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
          status: 'disconnected',
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
        status: 'disconnected',
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
  async testServer(serverId: string): Promise<{ success: boolean; error?: string; tools?: number }> {
    try {
      await this.connectServer(serverId);
      const status = this.getServerStatus(serverId);
      const toolCount = status?.tools.length || 0;
      await this.disconnectServer(serverId);

      return { success: true, tools: toolCount };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Set up event handlers for a connection
   */
  private setupConnectionHandlers(serverId: string, connection: MCPServerConnection): void {
    connection.on('status_changed', (status, error) => {
      console.log(`[MCPClientManager] Server ${serverId} status: ${status}`, error || '');

      // Update settings with last error
      if (error) {
        MCPSettingsManager.updateServerError(serverId, error);
      } else if (status === 'connected') {
        MCPSettingsManager.updateServerError(serverId, undefined);
      }

      // Emit event
      const event: MCPClientEvent = error
        ? { type: 'server_error', serverId, error }
        : status === 'connected'
        ? { type: 'server_connected', serverId, serverInfo: connection.getStatus().serverInfo! }
        : status === 'disconnected'
        ? { type: 'server_disconnected', serverId }
        : status === 'reconnecting'
        ? { type: 'server_reconnecting', serverId, attempt: 0 }
        : { type: 'server_disconnected', serverId };

      this.emit('event', event);

      // Broadcast to renderer
      this.broadcastStatusChange();
    });

    connection.on('tools_changed', (tools) => {
      console.log(`[MCPClientManager] Server ${serverId} tools changed: ${tools.length} tools`);

      // Update settings with tools
      MCPSettingsManager.updateServerTools(serverId, tools);

      // Rebuild tool map
      this.rebuildToolMap();

      // Emit event
      const event: MCPClientEvent = { type: 'tools_changed', serverId, tools };
      this.emit('event', event);

      // Broadcast to renderer
      this.broadcastStatusChange();
    });

    connection.on('error', (error) => {
      console.error(`[MCPClientManager] Server ${serverId} error:`, error);
    });
  }

  /**
   * Rebuild the tool -> server mapping
   */
  private rebuildToolMap(): void {
    this.toolServerMap.clear();

    for (const [serverId, connection] of this.connections) {
      if (connection.getStatus().status === 'connected') {
        for (const tool of connection.getTools()) {
          if (this.toolServerMap.has(tool.name)) {
            console.warn(
              `[MCPClientManager] Tool name collision: ${tool.name} from ${serverId} conflicts with ${this.toolServerMap.get(tool.name)}`
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
    const windows = BrowserWindow.getAllWindows();

    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGE, status);
      }
    }
  }
}
