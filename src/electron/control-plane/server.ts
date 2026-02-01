/**
 * WebSocket Control Plane Server
 *
 * The main WebSocket server that handles client connections, authentication,
 * and message routing for the control plane.
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import {
  Frame,
  RequestFrame,
  FrameType,
  parseFrame,
  serializeFrame,
  createResponseFrame,
  createErrorResponse,
  createEventFrame,
  ErrorCodes,
  Events,
  Methods,
} from './protocol';
import {
  ControlPlaneClient,
  ClientRegistry,
  type ClientScope,
} from './client';
import {
  ControlPlaneSettingsManager,
  type ControlPlaneSettings,
} from './settings';
import {
  startTailscaleExposure,
  stopTailscaleExposure,
  getExposureStatus,
  type TailscaleExposureResult,
} from '../tailscale';

/**
 * Control plane server configuration
 */
export interface ControlPlaneConfig {
  /** Port to listen on (default: 18789) */
  port?: number;
  /** Host to bind to (default: 127.0.0.1) */
  host?: string;
  /** Authentication token */
  token: string;
  /** Handshake timeout in milliseconds (default: 10000) */
  handshakeTimeoutMs?: number;
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Cleanup interval in milliseconds for disconnected clients (default: 60000) */
  cleanupIntervalMs?: number;
  /** Maximum payload size in bytes (default: 10MB) */
  maxPayloadBytes?: number;
  /** Maximum failed auth attempts before temporary ban (default: 5) */
  maxAuthAttempts?: number;
  /** Auth ban duration in milliseconds (default: 300000 = 5 minutes) */
  authBanDurationMs?: number;
  /** Event handler for server events */
  onEvent?: (event: ControlPlaneServerEvent) => void;
}

/**
 * Server events emitted for monitoring
 */
export interface ControlPlaneServerEvent {
  action: 'started' | 'stopped' | 'client_connected' | 'client_disconnected' | 'client_authenticated' | 'request' | 'error';
  timestamp: number;
  clientId?: string;
  method?: string;
  error?: string;
  details?: unknown;
}

/**
 * Method handler function signature
 */
export type MethodHandler = (
  client: ControlPlaneClient,
  params?: unknown
) => Promise<unknown>;

/**
 * WebSocket Control Plane Server
 */
export class ControlPlaneServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: ClientRegistry;
  private config: Required<ControlPlaneConfig>;
  private methods: Map<string, MethodHandler> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private tailscaleCleanup: (() => Promise<void>) | null = null;

  // Rate limiting for auth attempts: Map<remoteAddress, { attempts: number, bannedUntil?: number }>
  private authAttempts: Map<string, { attempts: number; bannedUntil?: number }> = new Map();

  constructor(config: ControlPlaneConfig) {
    this.config = {
      port: config.port ?? 18789,
      host: config.host ?? '127.0.0.1',
      token: config.token,
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? 10000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30000,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 60000,
      maxPayloadBytes: config.maxPayloadBytes ?? 10 * 1024 * 1024,
      maxAuthAttempts: config.maxAuthAttempts ?? 5,
      authBanDurationMs: config.authBanDurationMs ?? 5 * 60 * 1000, // 5 minutes
      onEvent: config.onEvent ?? (() => {}),
    };

    this.clients = new ClientRegistry();
    this.registerBuiltinMethods();
  }

  /**
   * Check if the server is running
   */
  get isRunning(): boolean {
    return this.httpServer !== null && this.wss !== null;
  }

  /**
   * Get server address
   */
  getAddress(): { host: string; port: number; wsUrl: string } | null {
    if (!this.httpServer) return null;
    const addr = this.httpServer.address();
    if (typeof addr === 'string' || !addr) return null;

    return {
      host: addr.address,
      port: addr.port,
      wsUrl: `ws://${addr.address}:${addr.port}`,
    };
  }

  /**
   * Start the control plane server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.info('[ControlPlane] Server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      // Create HTTP server for WebSocket upgrade
      this.httpServer = http.createServer((req, res) => {
        // Health check endpoint
        if (req.url === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            timestamp: Date.now(),
            clients: this.clients.count,
          }));
          return;
        }

        // Return 404 for other HTTP requests
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      // Create WebSocket server
      this.wss = new WebSocketServer({
        server: this.httpServer,
        maxPayload: this.config.maxPayloadBytes,
      });

      // Handle new connections
      this.wss.on('connection', (socket, request) => {
        this.handleConnection(socket, request);
      });

      this.wss.on('error', (error) => {
        console.error('[ControlPlane] WebSocket server error:', error);
        this.emitEvent({ action: 'error', timestamp: Date.now(), error: String(error) });
      });

      this.httpServer.on('error', (error) => {
        console.error('[ControlPlane] HTTP server error:', error);
        reject(error);
      });

      // Start listening
      this.httpServer.listen(this.config.port, this.config.host, () => {
        console.info(`[ControlPlane] Server listening on ws://${this.config.host}:${this.config.port}`);
        this.emitEvent({ action: 'started', timestamp: Date.now() });

        // Start heartbeat interval
        this.startHeartbeat();

        // Start cleanup interval
        this.startCleanup();

        resolve();
      });
    });
  }

  /**
   * Start with Tailscale exposure
   */
  async startWithTailscale(): Promise<TailscaleExposureResult | null> {
    const settings = ControlPlaneSettingsManager.loadSettings();

    // Start the WebSocket server first
    await this.start();

    // If Tailscale is configured, start exposure
    if (settings.tailscale.mode !== 'off') {
      const result = await startTailscaleExposure({
        mode: settings.tailscale.mode,
        port: this.config.port,
        resetOnExit: settings.tailscale.resetOnExit,
        log: (msg) => console.log(msg),
        warn: (msg) => console.warn(msg),
      });

      if (result.cleanup) {
        this.tailscaleCleanup = result.cleanup;
      }

      return result;
    }

    return null;
  }

  /**
   * Stop the control plane server
   */
  async stop(): Promise<void> {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Stop cleanup
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Cleanup Tailscale
    if (this.tailscaleCleanup) {
      await this.tailscaleCleanup();
      this.tailscaleCleanup = null;
    }

    // Broadcast shutdown event
    this.clients.broadcast(Events.SHUTDOWN, { reason: 'Server stopping' });

    // Close all client connections
    this.clients.closeAll(1001, 'Server shutting down');

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => {
          console.info('[ControlPlane] Server stopped');
          this.emitEvent({ action: 'stopped', timestamp: Date.now() });
          this.httpServer = null;
          resolve();
        });
      });
    }
  }

  /**
   * Register a method handler
   */
  registerMethod(method: string, handler: MethodHandler): void {
    this.methods.set(method, handler);
  }

  /**
   * Get server status
   */
  getStatus(): {
    running: boolean;
    address: ReturnType<ControlPlaneServer['getAddress']>;
    clients: ReturnType<ClientRegistry['getStatus']>;
    tailscale: ReturnType<typeof getExposureStatus>;
  } {
    return {
      running: this.isRunning,
      address: this.getAddress(),
      clients: this.clients.getStatus(),
      tailscale: getExposureStatus(),
    };
  }

  /**
   * Broadcast an event to all authenticated clients
   */
  broadcast(event: string, payload?: unknown): number {
    return this.clients.broadcast(event, payload);
  }

  // ===== Private Methods =====

  /**
   * Handle a new WebSocket connection
   */
  private handleConnection(socket: WebSocket, request: http.IncomingMessage): void {
    const remoteAddress =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      request.socket.remoteAddress ||
      'unknown';
    const userAgent = request.headers['user-agent'];
    const origin = request.headers['origin'];

    const client = new ControlPlaneClient(socket, remoteAddress, userAgent, origin);
    this.clients.add(client);

    console.info(`[ControlPlane] Client connected: ${client.id} from ${remoteAddress}`);
    this.emitEvent({
      action: 'client_connected',
      timestamp: Date.now(),
      clientId: client.id,
    });

    // Send challenge
    client.sendChallenge();

    // Set handshake timeout
    const handshakeTimeout = setTimeout(() => {
      if (!client.isAuthenticated) {
        console.warn(`[ControlPlane] Handshake timeout for client ${client.id}`);
        client.close(4008, 'Handshake timeout');
      }
    }, this.config.handshakeTimeoutMs);

    // Handle messages
    socket.on('message', async (data) => {
      try {
        const message = data.toString();
        await this.handleMessage(client, message);
      } catch (error) {
        console.error(`[ControlPlane] Message handling error:`, error);
      }
    });

    // Handle close
    socket.on('close', (code, reason) => {
      clearTimeout(handshakeTimeout);

      // If this was a node, broadcast disconnection event to operators
      if (client.isNode) {
        const nodeInfo = client.getNodeInfo();
        this.clients.broadcastToOperators(Events.NODE_DISCONNECTED, {
          nodeId: client.id,
          node: nodeInfo,
        });
        console.info(`[ControlPlane] Node disconnected: ${client.id} (${nodeInfo?.displayName || 'unnamed'}) (code: ${code})`);
      } else {
        console.info(`[ControlPlane] Client disconnected: ${client.id} (code: ${code})`);
      }

      this.clients.remove(client.id);
      this.emitEvent({
        action: 'client_disconnected',
        timestamp: Date.now(),
        clientId: client.id,
        details: { code, reason: reason.toString(), wasNode: client.isNode },
      });
    });

    // Handle error
    socket.on('error', (error) => {
      console.error(`[ControlPlane] Client error (${client.id}):`, error);
    });
  }

  /**
   * Handle an incoming message from a client
   */
  private async handleMessage(client: ControlPlaneClient, message: string): Promise<void> {
    const frame = parseFrame(message);

    if (!frame) {
      console.warn(`[ControlPlane] Invalid frame from ${client.id}`);
      return;
    }

    client.updateActivity();

    // Only handle request frames
    if (frame.type !== FrameType.Request) {
      return;
    }

    const request = frame as RequestFrame;

    // Handle connect method (authentication)
    if (request.method === Methods.CONNECT) {
      await this.handleConnect(client, request);
      return;
    }

    // All other methods require authentication
    if (!client.isAuthenticated) {
      client.send(createErrorResponse(
        request.id,
        ErrorCodes.UNAUTHORIZED,
        'Authentication required'
      ));
      return;
    }

    // Route to method handler
    await this.handleRequest(client, request);
  }

  /**
   * Handle connect/authentication request
   */
  private async handleConnect(client: ControlPlaneClient, request: RequestFrame): Promise<void> {
    const remoteAddress = client.info.remoteAddress;

    // Check if IP is banned due to too many failed attempts
    const authRecord = this.authAttempts.get(remoteAddress);
    if (authRecord?.bannedUntil && authRecord.bannedUntil > Date.now()) {
      const remainingMs = authRecord.bannedUntil - Date.now();
      console.warn(`[ControlPlane] Auth blocked for ${remoteAddress}: banned for ${Math.ceil(remainingMs / 1000)}s`);
      client.send(createErrorResponse(
        request.id,
        ErrorCodes.UNAUTHORIZED,
        `Too many failed attempts. Try again in ${Math.ceil(remainingMs / 1000)} seconds.`
      ));
      client.close(4029, 'Rate limited');
      return;
    }

    const params = request.params as {
      token?: string;
      deviceName?: string;
      nonce?: string;
      // Node-specific params (Mobile Companions)
      role?: 'operator' | 'node';
      client?: {
        id?: string;
        displayName?: string;
        version?: string;
        platform?: 'ios' | 'android' | 'macos';
        mode?: string;
        deviceFamily?: string;
        modelIdentifier?: string;
      };
      capabilities?: string[];
      commands?: string[];
      permissions?: Record<string, boolean>;
    } | undefined;

    // Verify token
    const providedToken = params?.token || '';
    if (!this.verifyToken(providedToken)) {
      // Track failed attempt
      this.recordFailedAuth(remoteAddress);

      client.reject();
      client.send(createErrorResponse(
        request.id,
        ErrorCodes.UNAUTHORIZED,
        'Invalid token'
      ));
      client.close(4001, 'Authentication failed');
      return;
    }

    // Clear auth attempts on success
    this.authAttempts.delete(remoteAddress);

    // Check if this is a node (mobile companion) connection
    const isNode = params?.role === 'node';

    if (isNode) {
      // Authenticate as a node
      const platform = (params?.client?.platform || 'ios') as 'ios' | 'android' | 'macos';
      const capabilities = (params?.capabilities || []) as any[];
      const commands = params?.commands || [];
      const permissions = params?.permissions || {};

      client.authenticateAsNode({
        deviceName: params?.client?.displayName || params?.deviceName,
        platform,
        version: params?.client?.version || '0.0.0',
        deviceId: params?.client?.id,
        modelIdentifier: params?.client?.modelIdentifier,
        capabilities,
        commands,
        permissions,
      });

      console.info(`[ControlPlane] Node authenticated: ${client.id} (${params?.client?.displayName || 'unnamed'}) [${platform}]`);
      this.emitEvent({
        action: 'client_authenticated',
        timestamp: Date.now(),
        clientId: client.id,
        details: {
          deviceName: params?.client?.displayName,
          role: 'node',
          platform,
          capabilities,
        },
      });

      // Broadcast node connected event to operators
      this.clients.broadcastToOperators(Events.NODE_CONNECTED, {
        nodeId: client.id,
        node: client.getNodeInfo(),
      });

      // Send success response
      client.send(createResponseFrame(request.id, {
        clientId: client.id,
        role: 'node',
        scopes: ['read'],
      }));
    } else {
      // Authenticate as operator with admin scope
      const scopes: ClientScope[] = ['admin'];
      client.authenticate(scopes, params?.deviceName);

      console.info(`[ControlPlane] Client authenticated: ${client.id} (${params?.deviceName || 'unnamed'})`);
      this.emitEvent({
        action: 'client_authenticated',
        timestamp: Date.now(),
        clientId: client.id,
        details: { deviceName: params?.deviceName, role: 'operator' },
      });

      // Send success response
      client.send(createResponseFrame(request.id, {
        clientId: client.id,
        role: 'operator',
        scopes,
      }));
    }

    // Send connect success event
    client.sendEvent(Events.CONNECT_SUCCESS, {
      clientId: client.id,
      serverVersion: '1.0.0',
    });
  }

  /**
   * Record a failed authentication attempt for rate limiting
   */
  private recordFailedAuth(remoteAddress: string): void {
    const record = this.authAttempts.get(remoteAddress) || { attempts: 0 };
    record.attempts++;

    if (record.attempts >= this.config.maxAuthAttempts) {
      record.bannedUntil = Date.now() + this.config.authBanDurationMs;
      console.warn(`[ControlPlane] IP ${remoteAddress} banned for ${this.config.authBanDurationMs / 1000}s after ${record.attempts} failed attempts`);
    }

    this.authAttempts.set(remoteAddress, record);
  }

  /**
   * Handle an authenticated request
   */
  private async handleRequest(client: ControlPlaneClient, request: RequestFrame): Promise<void> {
    const handler = this.methods.get(request.method);

    this.emitEvent({
      action: 'request',
      timestamp: Date.now(),
      clientId: client.id,
      method: request.method,
    });

    if (!handler) {
      client.send(createErrorResponse(
        request.id,
        ErrorCodes.UNKNOWN_METHOD,
        `Unknown method: ${request.method}`
      ));
      return;
    }

    try {
      const result = await handler(client, request.params);
      client.send(createResponseFrame(request.id, result));
    } catch (error: any) {
      console.error(`[ControlPlane] Method error (${request.method}):`, error);
      client.send(createErrorResponse(
        request.id,
        ErrorCodes.METHOD_FAILED,
        error.message || 'Method execution failed',
        error.details
      ));
    }
  }

  /**
   * Verify authentication token
   */
  private verifyToken(provided: string): boolean {
    if (!this.config.token || !provided) return false;

    const expected = Buffer.from(this.config.token);
    const actual = Buffer.from(provided);
    if (expected.length !== actual.length) return false;

    return crypto.timingSafeEqual(expected, actual);
  }

  /**
   * Register built-in method handlers
   */
  private registerBuiltinMethods(): void {
    // Ping/health check
    this.registerMethod(Methods.PING, async () => ({
      pong: true,
      timestamp: Date.now(),
    }));

    this.registerMethod(Methods.HEALTH, async () => ({
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
    }));

    // Status
    this.registerMethod(Methods.STATUS, async () => this.getStatus());

    // ===== Node (Mobile Companion) Methods =====

    // List connected nodes
    this.registerMethod(Methods.NODE_LIST, async () => {
      return {
        nodes: this.clients.getNodeInfoList(),
      };
    });

    // Describe a specific node
    this.registerMethod(Methods.NODE_DESCRIBE, async (client, params) => {
      const { nodeId } = params as { nodeId?: string };
      if (!nodeId) {
        throw { code: ErrorCodes.INVALID_PARAMS, message: 'nodeId is required' };
      }
      const node = this.clients.getNodeByIdOrName(nodeId);
      if (!node) {
        throw { code: ErrorCodes.NODE_NOT_FOUND, message: `Node not found: ${nodeId}` };
      }
      return {
        node: node.getNodeInfo(),
      };
    });

    // Invoke a command on a node
    this.registerMethod(Methods.NODE_INVOKE, async (client, params) => {
      const { nodeId, command, params: commandParams, timeoutMs = 30000 } = params as {
        nodeId?: string;
        command?: string;
        params?: Record<string, unknown>;
        timeoutMs?: number;
      };

      if (!nodeId) {
        throw { code: ErrorCodes.INVALID_PARAMS, message: 'nodeId is required' };
      }
      if (!command) {
        throw { code: ErrorCodes.INVALID_PARAMS, message: 'command is required' };
      }

      const node = this.clients.getNodeByIdOrName(nodeId);
      if (!node) {
        throw { code: ErrorCodes.NODE_NOT_FOUND, message: `Node not found: ${nodeId}` };
      }

      // Check if node supports this command
      const nodeInfo = node.getNodeInfo();
      if (!nodeInfo?.commands.includes(command)) {
        throw {
          code: ErrorCodes.NODE_COMMAND_FAILED,
          message: `Node does not support command: ${command}`,
        };
      }

      // Check if node is in foreground (required for most commands)
      if (!nodeInfo.isForeground && ['camera.snap', 'camera.clip', 'screen.record'].includes(command)) {
        throw {
          code: ErrorCodes.NODE_BACKGROUND_UNAVAILABLE,
          message: 'Node app must be in foreground for this command',
        };
      }

      // Forward the command to the node
      return await this.invokeNodeCommand(node, command, commandParams, timeoutMs);
    });

    // Handle node events (from nodes to gateway)
    this.registerMethod(Methods.NODE_EVENT, async (client, params) => {
      if (!client.isNode) {
        throw { code: ErrorCodes.UNAUTHORIZED, message: 'Only nodes can send node events' };
      }

      const { event, payload } = params as { event?: string; payload?: unknown };
      if (!event) {
        throw { code: ErrorCodes.INVALID_PARAMS, message: 'event is required' };
      }

      // Handle specific node events
      if (event === 'foreground_changed') {
        const isForeground = (payload as any)?.isForeground ?? true;
        client.setForeground(isForeground);
        this.clients.broadcastToOperators(Events.NODE_EVENT, {
          nodeId: client.id,
          event: 'foreground_changed',
          isForeground,
        });
      } else if (event === 'capabilities_changed') {
        const { capabilities, commands, permissions } = payload as any;
        if (capabilities && commands && permissions) {
          client.updateCapabilities(capabilities, commands, permissions);
          this.clients.broadcastToOperators(Events.NODE_CAPABILITIES_CHANGED, {
            nodeId: client.id,
            node: client.getNodeInfo(),
          });
        }
      }

      return { ok: true };
    });
  }

  /**
   * Invoke a command on a node and wait for response
   */
  private async invokeNodeCommand(
    node: ControlPlaneClient,
    command: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number
  ): Promise<{ ok: boolean; payload?: unknown; error?: { code: string; message: string } }> {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      let timeoutHandle: NodeJS.Timeout;

      // Set up one-time response handler
      const handleResponse = (data: Buffer | string) => {
        try {
          const message = data.toString();
          const frame = parseFrame(message);
          if (frame && frame.type === FrameType.Response && (frame as any).id === requestId) {
            clearTimeout(timeoutHandle);
            node.info.socket.removeListener('message', handleResponse);
            const response = frame as any;
            if (response.ok) {
              resolve({ ok: true, payload: response.payload });
            } else {
              resolve({
                ok: false,
                error: response.error || { code: 'UNKNOWN', message: 'Command failed' },
              });
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      node.info.socket.on('message', handleResponse);

      // Set timeout
      timeoutHandle = setTimeout(() => {
        node.info.socket.removeListener('message', handleResponse);
        resolve({
          ok: false,
          error: { code: ErrorCodes.NODE_TIMEOUT, message: `Command timed out after ${timeoutMs}ms` },
        });
      }, timeoutMs);

      // Send command to node
      const requestFrame = {
        type: FrameType.Request,
        id: requestId,
        method: 'node.invoke',
        params: { command, params },
      };
      node.info.socket.send(JSON.stringify(requestFrame));
    });
  }

  /**
   * Start heartbeat interval
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const event = createEventFrame(Events.HEARTBEAT, {
        timestamp: Date.now(),
        clients: this.clients.count,
      });

      for (const client of this.clients.getAuthenticated()) {
        client.send(event);
        client.updateHeartbeat();
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Start cleanup interval
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const removed = this.clients.cleanup();
      if (removed > 0) {
        console.info(`[ControlPlane] Cleaned up ${removed} disconnected clients`);
      }

      // Also clean up expired auth bans
      const now = Date.now();
      for (const [ip, record] of this.authAttempts) {
        if (record.bannedUntil && record.bannedUntil < now) {
          this.authAttempts.delete(ip);
        }
      }
    }, this.config.cleanupIntervalMs);
  }

  /**
   * Emit a server event
   */
  private emitEvent(event: ControlPlaneServerEvent): void {
    if (this.config.onEvent) {
      try {
        this.config.onEvent(event);
      } catch (error) {
        console.error('[ControlPlane] Event handler error:', error);
      }
    }
  }
}
