/**
 * WebSocketTransport - MCP transport over WebSocket
 *
 * Provides full-duplex bidirectional communication for real-time
 * MCP server interactions. Supports automatic reconnection and
 * ping/pong keepalive.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
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

export class WebSocketTransport extends EventEmitter implements MCPTransport {
  private config: MCPServerConfig;
  private ws: WebSocket | null = null;
  private messageHandler: ((message: JSONRPCResponse | JSONRPCNotification) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private connected = false;
  private requestId = 0;
  private pingInterval: ReturnType<typeof setTimeout> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;

  // Ping/pong settings
  private readonly PING_INTERVAL = 30000; // 30 seconds
  private readonly PONG_TIMEOUT = 10000; // 10 seconds

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;
  }

  /**
   * Connect to the MCP server via WebSocket
   */
  async connect(): Promise<void> {
    if (this.connected || this.ws) {
      throw new Error('Already connected');
    }

    const { url } = this.config;

    if (!url) {
      throw new Error('No URL specified for WebSocket transport');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cleanup();
        reject(new Error(`Connection timeout: server did not respond within ${this.config.connectionTimeout || 30000}ms`));
      }, this.config.connectionTimeout || 30000);

      try {
        // Convert http(s) URL to ws(s) if needed
        const wsUrl = this.buildWebSocketUrl(url);
        console.log(`[MCP WebSocketTransport] Connecting to: ${wsUrl}`);

        // Build headers with auth
        const headers: Record<string, string> = {
          ...this.config.headers,
        };
        this.addAuthHeaders(headers);

        // Create WebSocket connection
        this.ws = new WebSocket(wsUrl, {
          headers,
          handshakeTimeout: this.config.connectionTimeout || 30000,
        });

        this.ws.on('open', () => {
          clearTimeout(timeout);
          this.connected = true;
          console.log(`[MCP WebSocketTransport] Connected successfully`);

          // Start ping/pong keepalive
          this.startPingPong();

          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('error', (error) => {
          console.error(`[MCP WebSocketTransport] WebSocket error:`, error);
          this.errorHandler?.(error);
          if (!this.connected) {
            clearTimeout(timeout);
            reject(error);
          }
        });

        this.ws.on('close', (code, reason) => {
          const message = `WebSocket closed: code=${code}, reason=${reason?.toString() || 'unknown'}`;
          console.log(`[MCP WebSocketTransport] ${message}`);

          if (this.connected) {
            this.closeHandler?.(code !== 1000 ? new Error(message) : undefined);
          } else if (!this.connected) {
            clearTimeout(timeout);
            reject(new Error(message));
          }
          this.cleanup();
        });

        this.ws.on('pong', () => {
          // Clear pong timeout - connection is alive
          if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
          }
        });

      } catch (error) {
        clearTimeout(timeout);
        console.error(`[MCP WebSocketTransport] Failed to connect:`, error);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    console.log(`[MCP WebSocketTransport] Disconnecting...`);

    // Stop ping/pong
    this.stopPingPong();

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport disconnected'));
    }
    this.pendingRequests.clear();

    // Close WebSocket gracefully
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return new Promise((resolve) => {
        const forceCloseTimeout = setTimeout(() => {
          if (this.ws) {
            this.ws.terminate();
          }
          this.cleanup();
          resolve();
        }, 5000);

        this.ws!.once('close', () => {
          clearTimeout(forceCloseTimeout);
          this.cleanup();
          resolve();
        });

        this.ws!.close(1000, 'Client disconnect');
      });
    }

    this.cleanup();
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async sendRequest(method: string, params?: Record<string, any>): Promise<any> {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
        this.ws!.send(JSON.stringify(request));
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
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    try {
      this.ws.send(JSON.stringify(message));
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
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

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
    } catch (error) {
      console.error(`[MCP WebSocketTransport] Failed to parse message: ${data}`);
    }
  }

  /**
   * Convert HTTP URL to WebSocket URL
   */
  private buildWebSocketUrl(url: string): string {
    const parsed = new URL(url);

    // Convert protocol
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'ws:';
    } else if (parsed.protocol === 'https:') {
      parsed.protocol = 'wss:';
    }

    // Append /ws path if not already present
    if (!parsed.pathname.includes('/ws')) {
      parsed.pathname = parsed.pathname.replace(/\/$/, '') + '/ws';
    }

    return parsed.toString();
  }

  /**
   * Add authentication headers
   */
  private addAuthHeaders(headers: Record<string, string>): void {
    if (!this.config.auth) return;

    switch (this.config.auth.type) {
      case 'bearer':
        if (this.config.auth.token) {
          headers['Authorization'] = `Bearer ${this.config.auth.token}`;
        }
        break;
      case 'api-key':
        if (this.config.auth.apiKey) {
          const headerName = this.config.auth.headerName || 'X-API-Key';
          headers[headerName] = this.config.auth.apiKey;
        }
        break;
      case 'basic':
        if (this.config.auth.username && this.config.auth.password) {
          const credentials = Buffer.from(
            `${this.config.auth.username}:${this.config.auth.password}`
          ).toString('base64');
          headers['Authorization'] = `Basic ${credentials}`;
        }
        break;
    }
  }

  /**
   * Start ping/pong keepalive
   */
  private startPingPong(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Set pong timeout - if we don't get pong, connection is dead
        this.pongTimeout = setTimeout(() => {
          console.warn(`[MCP WebSocketTransport] Pong timeout - connection may be dead`);
          this.errorHandler?.(new Error('WebSocket ping timeout'));
          this.ws?.terminate();
        }, this.PONG_TIMEOUT);

        // Send ping
        this.ws.ping();
      }
    }, this.PING_INTERVAL);
  }

  /**
   * Stop ping/pong keepalive
   */
  private stopPingPong(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.connected = false;
    this.stopPingPong();

    // Clear all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.clear();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
  }
}
