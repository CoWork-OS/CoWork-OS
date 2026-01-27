/**
 * StdioTransport - MCP transport over stdio (stdin/stdout)
 *
 * This is the primary transport for MCP servers that are launched as
 * child processes and communicate via JSON-RPC over stdin/stdout.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  MCPTransport,
  MCPServerConfig,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
} from '../../types';

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class StdioTransport extends EventEmitter implements MCPTransport {
  private process: ChildProcess | null = null;
  private config: MCPServerConfig;
  private messageHandler: ((message: JSONRPCResponse | JSONRPCNotification) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private buffer = '';
  private connected = false;
  private requestId = 0;

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;
  }

  /**
   * Connect to the MCP server by spawning the process
   */
  async connect(): Promise<void> {
    if (this.connected || this.process) {
      throw new Error('Already connected');
    }

    const { command, args = [], env, cwd } = this.config;

    if (!command) {
      throw new Error('No command specified for stdio transport');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cleanup();
        reject(new Error(`Connection timeout: server did not respond within ${this.config.connectionTimeout || 30000}ms`));
      }, this.config.connectionTimeout || 30000);

      try {
        // Merge environment variables
        const processEnv = {
          ...process.env,
          ...env,
        };

        console.log(`[MCP StdioTransport] Spawning: ${command} ${args.join(' ')}`);

        this.process = spawn(command, args, {
          cwd: cwd || process.cwd(),
          env: processEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });

        // Handle stdout (JSON-RPC messages from server)
        this.process.stdout?.on('data', (data: Buffer) => {
          this.handleData(data);
        });

        // Handle stderr (logging/errors from server)
        this.process.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          console.log(`[MCP StdioTransport] Server stderr: ${text}`);
        });

        // Handle process errors
        this.process.on('error', (error) => {
          clearTimeout(timeout);
          console.error(`[MCP StdioTransport] Process error:`, error);
          this.errorHandler?.(error);
          if (!this.connected) {
            reject(error);
          }
          this.cleanup();
        });

        // Handle process exit
        this.process.on('exit', (code, signal) => {
          clearTimeout(timeout);
          const message = `Process exited with code ${code}, signal ${signal}`;
          console.log(`[MCP StdioTransport] ${message}`);

          if (!this.connected) {
            reject(new Error(message));
          } else {
            this.closeHandler?.(code !== 0 ? new Error(message) : undefined);
          }
          this.cleanup();
        });

        // Handle process close
        this.process.on('close', (code) => {
          if (this.connected) {
            this.closeHandler?.(code !== 0 ? new Error(`Process closed with code ${code}`) : undefined);
          }
          this.cleanup();
        });

        // Mark as connected once process is spawned
        // The actual MCP handshake will be done by MCPServerConnection
        this.connected = true;
        clearTimeout(timeout);
        console.log(`[MCP StdioTransport] Process spawned successfully`);
        resolve();

      } catch (error) {
        clearTimeout(timeout);
        console.error(`[MCP StdioTransport] Failed to spawn process:`, error);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (!this.process) {
      return;
    }

    console.log(`[MCP StdioTransport] Disconnecting...`);

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport disconnected'));
    }
    this.pendingRequests.clear();

    // Try graceful shutdown first
    if (this.process.stdin?.writable) {
      try {
        this.process.stdin.end();
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Give process time to exit gracefully
    await new Promise<void>((resolve) => {
      const forceKillTimeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          console.log(`[MCP StdioTransport] Force killing process`);
          this.process.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      if (this.process) {
        this.process.once('exit', () => {
          clearTimeout(forceKillTimeout);
          resolve();
        });

        // Send SIGTERM first
        this.process.kill('SIGTERM');
      } else {
        clearTimeout(forceKillTimeout);
        resolve();
      }
    });

    this.cleanup();
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async sendRequest(method: string, params?: Record<string, any>): Promise<any> {
    if (!this.connected || !this.process?.stdin?.writable) {
      throw new Error('Not connected');
    }

    const id = ++this.requestId;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for method: ${method}`));
      }, this.config.requestTimeout || 60000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        const message = JSON.stringify(request) + '\n';
        this.process!.stdin!.write(message);
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Send a JSON-RPC message (request or notification)
   */
  async send(message: JSONRPCRequest | JSONRPCNotification): Promise<void> {
    if (!this.connected || !this.process?.stdin?.writable) {
      throw new Error('Not connected');
    }

    try {
      const data = JSON.stringify(message) + '\n';
      this.process.stdin.write(data);
    } catch (error) {
      throw new Error(`Failed to send message: ${error}`);
    }
  }

  /**
   * Register message handler
   */
  onMessage(handler: (message: JSONRPCResponse | JSONRPCNotification) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Register close handler
   */
  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  /**
   * Register error handler
   */
  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /**
   * Check if transport is connected
   */
  isConnected(): boolean {
    return this.connected && !!this.process && !this.process.killed;
  }

  /**
   * Handle incoming data from stdout
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // Process complete lines (JSON-RPC messages are newline-delimited)
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (error) {
          console.error(`[MCP StdioTransport] Failed to parse message: ${line}`);
        }
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private handleMessage(message: any): void {
    // Check if this is a response to a pending request
    if ('id' in message && message.id !== null) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timeout);

        if ('error' in message && message.error) {
          pending.reject(new Error(message.error.message || 'Unknown error'));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    // Otherwise, pass to message handler (notifications)
    this.messageHandler?.(message as JSONRPCResponse | JSONRPCNotification);
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.connected = false;
    this.buffer = '';

    // Clear all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.clear();

    if (this.process) {
      this.process.removeAllListeners();
      this.process.stdout?.removeAllListeners();
      this.process.stderr?.removeAllListeners();
      this.process = null;
    }
  }
}
