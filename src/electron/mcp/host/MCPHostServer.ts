/**
 * MCPHostServer - Exposes CoWork's tools as an MCP server
 *
 * This allows external clients (like Claude Code, other AI agents, or MCP clients)
 * to connect to CoWork and use its tools via the MCP protocol over stdio.
 */

import { EventEmitter } from 'events';
import * as readline from 'readline';
import {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
  MCPTool,
  MCPServerInfo,
  MCPServerCapabilities,
  MCP_METHODS,
  MCP_ERROR_CODES,
} from '../types';

// Protocol version we support
const PROTOCOL_VERSION = '2024-11-05';

// Server info
const SERVER_INFO: MCPServerInfo = {
  name: 'CoWork-OSS',
  version: '1.0.0',
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: {
      listChanged: false,
    },
  },
};

// Tool adapter interface - will be injected with ToolRegistry
export interface ToolProvider {
  getTools(): MCPTool[];
  executeTool(name: string, args: Record<string, any>): Promise<any>;
}

export class MCPHostServer extends EventEmitter {
  private static instance: MCPHostServer | null = null;
  private running = false;
  private initialized = false;
  private toolProvider: ToolProvider | null = null;
  private rl: readline.Interface | null = null;

  private constructor() {
    super();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): MCPHostServer {
    if (!MCPHostServer.instance) {
      MCPHostServer.instance = new MCPHostServer();
    }
    return MCPHostServer.instance;
  }

  /**
   * Set the tool provider (typically ToolRegistry)
   */
  setToolProvider(provider: ToolProvider): void {
    this.toolProvider = provider;
  }

  /**
   * Start the MCP host server on stdio
   */
  async startStdio(): Promise<void> {
    if (this.running) {
      console.log('[MCPHostServer] Already running');
      return;
    }

    if (!this.toolProvider) {
      throw new Error('Tool provider not set');
    }

    console.log('[MCPHostServer] Starting stdio server...');

    this.running = true;
    this.initialized = false;

    // Create readline interface for reading from stdin
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    // Listen for lines (JSON-RPC messages)
    this.rl.on('line', (line) => {
      this.handleLine(line);
    });

    this.rl.on('close', () => {
      console.log('[MCPHostServer] Stdin closed');
      this.stop();
    });

    console.log('[MCPHostServer] Listening on stdio');
    this.emit('started');
  }

  /**
   * Stop the MCP host server
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    console.log('[MCPHostServer] Stopping...');

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    this.running = false;
    this.initialized = false;
    this.emit('stopped');

    console.log('[MCPHostServer] Stopped');
  }

  /**
   * Check if the server is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check if a tool provider has been set
   */
  hasToolProvider(): boolean {
    return this.toolProvider !== null;
  }

  /**
   * Handle an incoming line (JSON-RPC message)
   */
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const message = JSON.parse(trimmed);
      this.handleMessage(message);
    } catch (error) {
      console.error('[MCPHostServer] Failed to parse message:', error);
      this.sendError(null, MCP_ERROR_CODES.PARSE_ERROR, 'Parse error');
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private async handleMessage(message: any): Promise<void> {
    // Check if it's a request (has id) or notification (no id)
    if ('id' in message && message.id !== null) {
      await this.handleRequest(message as JSONRPCRequest);
    } else if ('method' in message) {
      await this.handleNotification(message as JSONRPCNotification);
    }
  }

  /**
   * Handle a JSON-RPC request
   */
  private async handleRequest(request: JSONRPCRequest): Promise<void> {
    const { id, method, params } = request;

    try {
      let result: any;

      switch (method) {
        case MCP_METHODS.INITIALIZE:
          result = this.handleInitialize(params);
          break;

        case MCP_METHODS.TOOLS_LIST:
          this.requireInitialized();
          result = this.handleToolsList();
          break;

        case MCP_METHODS.TOOLS_CALL:
          this.requireInitialized();
          result = await this.handleToolsCall(params);
          break;

        case MCP_METHODS.SHUTDOWN:
          result = this.handleShutdown();
          break;

        default:
          throw this.createError(MCP_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
      }

      this.sendResult(id, result);
    } catch (error: any) {
      if (error.code !== undefined) {
        this.sendError(id, error.code, error.message, error.data);
      } else {
        this.sendError(id, MCP_ERROR_CODES.INTERNAL_ERROR, error.message);
      }
    }
  }

  /**
   * Handle a JSON-RPC notification
   */
  private async handleNotification(notification: JSONRPCNotification): Promise<void> {
    const { method, params } = notification;

    switch (method) {
      case MCP_METHODS.INITIALIZED:
        this.handleInitialized();
        break;

      default:
        console.log(`[MCPHostServer] Unhandled notification: ${method}`);
    }
  }

  /**
   * Handle the initialize request
   */
  private handleInitialize(params: any): {
    protocolVersion: string;
    capabilities: MCPServerCapabilities;
    serverInfo: MCPServerInfo;
  } {
    if (this.initialized) {
      throw this.createError(MCP_ERROR_CODES.INVALID_REQUEST, 'Already initialized');
    }

    console.log('[MCPHostServer] Initialize request from client:', params?.clientInfo);

    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: SERVER_INFO.capabilities!,
      serverInfo: SERVER_INFO,
    };
  }

  /**
   * Handle the initialized notification
   */
  private handleInitialized(): void {
    console.log('[MCPHostServer] Client sent initialized notification');
    this.initialized = true;
    this.emit('initialized');
  }

  /**
   * Handle tools/list request
   */
  private handleToolsList(): { tools: MCPTool[] } {
    if (!this.toolProvider) {
      return { tools: [] };
    }

    const tools = this.toolProvider.getTools();
    console.log(`[MCPHostServer] Listing ${tools.length} tools`);

    return { tools };
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(params: any): Promise<any> {
    if (!this.toolProvider) {
      throw this.createError(MCP_ERROR_CODES.INTERNAL_ERROR, 'Tool provider not available');
    }

    const { name, arguments: args } = params || {};

    if (!name) {
      throw this.createError(MCP_ERROR_CODES.INVALID_PARAMS, 'Tool name is required');
    }

    console.log(`[MCPHostServer] Calling tool: ${name}`);

    try {
      const result = await this.toolProvider.executeTool(name, args || {});

      // Format result as MCP content
      if (typeof result === 'string') {
        return {
          content: [{ type: 'text', text: result }],
        };
      } else if (result && typeof result === 'object') {
        // Check if result is already in MCP format
        if (result.content && Array.isArray(result.content)) {
          return result;
        }
        // Convert to text
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } else {
        return {
          content: [{ type: 'text', text: String(result) }],
        };
      }
    } catch (error: any) {
      console.error(`[MCPHostServer] Tool call failed:`, error);
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }

  /**
   * Handle shutdown request
   */
  private handleShutdown(): Record<string, never> {
    console.log('[MCPHostServer] Shutdown request received');
    // Schedule stop after response is sent
    setImmediate(() => this.stop());
    return {};
  }

  /**
   * Send a successful result
   */
  private sendResult(id: string | number, result: any): void {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    this.sendMessage(response);
  }

  /**
   * Send an error response
   */
  private sendError(
    id: string | number | null,
    code: number,
    message: string,
    data?: any
  ): void {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: id ?? 0,
      error: {
        code,
        message,
        data,
      },
    };
    this.sendMessage(response);
  }

  /**
   * Send a message to stdout
   */
  private sendMessage(message: JSONRPCResponse | JSONRPCNotification): void {
    const json = JSON.stringify(message);
    process.stdout.write(json + '\n');
  }

  /**
   * Require that the server is initialized
   */
  private requireInitialized(): void {
    if (!this.initialized) {
      throw this.createError(MCP_ERROR_CODES.SERVER_NOT_INITIALIZED, 'Server not initialized');
    }
  }

  /**
   * Create an error object
   */
  private createError(code: number, message: string, data?: any): { code: number; message: string; data?: any } {
    return { code, message, data };
  }
}
