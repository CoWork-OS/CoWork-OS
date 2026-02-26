/**
 * WebSocket Control Plane Client Management
 *
 * Handles client connection state, authentication, and tracking.
 */

import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import { Frame, EventFrame as _EventFrame, serializeFrame, createEventFrame, Events } from "./protocol";

/**
 * Client authentication state
 */
export type ClientAuthState =
  | "pending" // Initial state, awaiting handshake
  | "authenticated" // Successfully authenticated
  | "rejected"; // Authentication failed

/**
 * Client scope/permissions
 */
export type ClientScope =
  | "admin" // Full access
  | "read" // Read-only access
  | "write" // Read + write access
  | "operator"; // Task operations only

/**
 * Client role in the Control Plane
 */
export type ClientRole = "operator" | "node";

/**
 * Node capability categories
 */
export type NodeCapabilityType =
  | "camera"
  | "location"
  | "screen"
  | "sms"
  | "voice"
  | "canvas"
  | "system";

/**
 * Node platform type
 */
export type NodePlatform = "ios" | "android" | "macos";

/**
 * Information about a connected client
 */
export interface ClientInfo {
  /** Unique client connection ID */
  id: string;
  /** WebSocket connection */
  socket: WebSocket;
  /** Client's remote address */
  remoteAddress: string;
  /** Client's user agent */
  userAgent?: string;
  /** Client's origin */
  origin?: string;
  /** Authentication state */
  authState: ClientAuthState;
  /** Granted scopes */
  scopes: ClientScope[];
  /** Connection timestamp */
  connectedAt: number;
  /** Last activity timestamp */
  lastActivityAt: number;
  /** Last heartbeat timestamp */
  lastHeartbeatAt: number;
  /** Optional device/client name */
  deviceName?: string;
  /** Authentication nonce */
  authNonce?: string;
  /** Client role: 'operator' (default) or 'node' (mobile companion) */
  role: ClientRole;
  /** Node platform (for nodes only) */
  platform?: NodePlatform;
  /** Node client version (for nodes only) */
  version?: string;
  /** Device identifier (persisted across connections) */
  deviceId?: string;
  /** Model identifier (e.g., "iPhone15,3") */
  modelIdentifier?: string;
  /** Node capability categories (for nodes only) */
  capabilities?: NodeCapabilityType[];
  /** Specific commands supported (for nodes only) */
  commands?: string[];
  /** Permission status for each capability (for nodes only) */
  permissions?: Record<string, boolean>;
  /** Whether the node app is in the foreground (for nodes only) */
  isForeground?: boolean;
}

/**
 * Control plane client wrapper
 */
export class ControlPlaneClient {
  readonly info: ClientInfo;
  private eventSeq = 0;

  constructor(socket: WebSocket, remoteAddress: string, userAgent?: string, origin?: string) {
    this.info = {
      id: randomUUID(),
      socket,
      remoteAddress,
      userAgent,
      origin,
      authState: "pending",
      scopes: [],
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      authNonce: randomUUID(),
      role: "operator", // Default role
    };
  }

  /**
   * Get the client ID
   */
  get id(): string {
    return this.info.id;
  }

  /**
   * Check if client is authenticated
   */
  get isAuthenticated(): boolean {
    return this.info.authState === "authenticated";
  }

  /**
   * Check if client is connected
   */
  get isConnected(): boolean {
    return this.info.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Check if client has a specific scope
   */
  hasScope(scope: ClientScope): boolean {
    return this.info.scopes.includes("admin") || this.info.scopes.includes(scope);
  }

  /**
   * Check if client is a node (mobile companion)
   */
  get isNode(): boolean {
    return this.info.role === "node";
  }

  /**
   * Mark client as authenticated with given scopes
   */
  authenticate(scopes: ClientScope[], deviceName?: string): void {
    this.info.authState = "authenticated";
    this.info.scopes = scopes;
    this.info.deviceName = deviceName;
    this.updateActivity();
  }

  /**
   * Authenticate as a node with capabilities
   */
  authenticateAsNode(options: {
    deviceName?: string;
    platform: NodePlatform;
    version: string;
    deviceId?: string;
    modelIdentifier?: string;
    capabilities: NodeCapabilityType[];
    commands: string[];
    permissions: Record<string, boolean>;
  }): void {
    this.info.authState = "authenticated";
    this.info.role = "node";
    this.info.scopes = ["read"]; // Nodes have limited scope
    this.info.deviceName = options.deviceName;
    this.info.platform = options.platform;
    this.info.version = options.version;
    this.info.deviceId = options.deviceId;
    this.info.modelIdentifier = options.modelIdentifier;
    this.info.capabilities = options.capabilities;
    this.info.commands = options.commands;
    this.info.permissions = options.permissions;
    this.info.isForeground = true; // Assume foreground on initial connect
    this.updateActivity();
  }

  /**
   * Update node capabilities (e.g., when permissions change)
   */
  updateCapabilities(
    capabilities: NodeCapabilityType[],
    commands: string[],
    permissions: Record<string, boolean>,
  ): void {
    if (this.info.role !== "node") return;
    this.info.capabilities = capabilities;
    this.info.commands = commands;
    this.info.permissions = permissions;
    this.updateActivity();
  }

  /**
   * Update node foreground state
   */
  setForeground(isForeground: boolean): void {
    if (this.info.role !== "node") return;
    this.info.isForeground = isForeground;
    this.updateActivity();
  }

  /**
   * Get node info (for node clients only)
   */
  getNodeInfo(): {
    id: string;
    displayName: string;
    platform: NodePlatform;
    version: string;
    deviceId?: string;
    modelIdentifier?: string;
    capabilities: NodeCapabilityType[];
    commands: string[];
    permissions: Record<string, boolean>;
    connectedAt: number;
    lastActivityAt: number;
    isForeground?: boolean;
  } | null {
    if (this.info.role !== "node") return null;
    return {
      id: this.info.id,
      displayName: this.info.deviceName || "Unknown Node",
      platform: this.info.platform || "ios",
      version: this.info.version || "0.0.0",
      deviceId: this.info.deviceId,
      modelIdentifier: this.info.modelIdentifier,
      capabilities: this.info.capabilities || [],
      commands: this.info.commands || [],
      permissions: this.info.permissions || {},
      connectedAt: this.info.connectedAt,
      lastActivityAt: this.info.lastActivityAt,
      isForeground: this.info.isForeground,
    };
  }

  /**
   * Mark client as rejected
   */
  reject(): void {
    this.info.authState = "rejected";
  }

  /**
   * Update last activity timestamp
   */
  updateActivity(): void {
    this.info.lastActivityAt = Date.now();
  }

  /**
   * Update heartbeat timestamp
   */
  updateHeartbeat(): void {
    this.info.lastHeartbeatAt = Date.now();
    this.updateActivity();
  }

  /**
   * Send a frame to the client
   */
  send(frame: Frame): boolean {
    if (!this.isConnected) {
      return false;
    }

    try {
      this.info.socket.send(serializeFrame(frame));
      return true;
    } catch (error) {
      console.error(`[ControlPlane Client ${this.id}] Send error:`, error);
      return false;
    }
  }

  /**
   * Send an event to the client
   */
  sendEvent(event: string, payload?: unknown, stateVersion?: string): boolean {
    const seq = this.eventSeq++;
    const frame = createEventFrame(event, payload, seq, stateVersion);
    return this.send(frame);
  }

  /**
   * Send the initial connection challenge
   */
  sendChallenge(): void {
    this.sendEvent(Events.CONNECT_CHALLENGE, {
      nonce: this.info.authNonce,
      ts: Date.now(),
    });
  }

  /**
   * Close the client connection
   */
  close(code?: number, reason?: string): void {
    if (this.isConnected) {
      this.info.socket.close(code || 1000, reason || "Connection closed");
    }
  }

  /**
   * Get client summary for status reports
   */
  getSummary(): {
    id: string;
    remoteAddress: string;
    deviceName?: string;
    authenticated: boolean;
    scopes: ClientScope[];
    connectedAt: number;
    lastActivityAt: number;
    role: ClientRole;
    platform?: NodePlatform;
    capabilities?: NodeCapabilityType[];
  } {
    return {
      id: this.info.id,
      remoteAddress: this.info.remoteAddress,
      deviceName: this.info.deviceName,
      authenticated: this.isAuthenticated,
      scopes: this.info.scopes,
      connectedAt: this.info.connectedAt,
      lastActivityAt: this.info.lastActivityAt,
      role: this.info.role,
      platform: this.info.platform,
      capabilities: this.info.capabilities,
    };
  }
}

/**
 * Client registry for managing multiple clients
 */
export class ClientRegistry {
  private clients = new Map<string, ControlPlaneClient>();

  /**
   * Add a client to the registry
   */
  add(client: ControlPlaneClient): void {
    this.clients.set(client.id, client);
  }

  /**
   * Remove a client from the registry
   */
  remove(clientId: string): boolean {
    return this.clients.delete(clientId);
  }

  /**
   * Get a client by ID
   */
  get(clientId: string): ControlPlaneClient | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Get all clients
   */
  getAll(): ControlPlaneClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get all authenticated clients
   */
  getAuthenticated(): ControlPlaneClient[] {
    return this.getAll().filter((c) => c.isAuthenticated);
  }

  /**
   * Get connected client count
   */
  get count(): number {
    return this.clients.size;
  }

  /**
   * Get authenticated client count
   */
  get authenticatedCount(): number {
    return this.getAuthenticated().length;
  }

  /**
   * Broadcast an event to all authenticated clients
   */
  broadcast(event: string, payload?: unknown, stateVersion?: string): number {
    let sent = 0;
    for (const client of this.getAuthenticated()) {
      if (client.sendEvent(event, payload, stateVersion)) {
        sent++;
      }
    }
    return sent;
  }

  /**
   * Close all client connections
   */
  closeAll(code?: number, reason?: string): void {
    for (const client of this.getAll()) {
      client.close(code, reason);
    }
    this.clients.clear();
  }

  /**
   * Clean up disconnected clients
   */
  cleanup(): number {
    let removed = 0;
    for (const [id, client] of this.clients) {
      if (!client.isConnected) {
        this.clients.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get status summary
   */
  getStatus(): {
    total: number;
    authenticated: number;
    pending: number;
    clients: ReturnType<ControlPlaneClient["getSummary"]>[];
  } {
    const all = this.getAll();
    return {
      total: all.length,
      authenticated: all.filter((c) => c.isAuthenticated).length,
      pending: all.filter((c) => c.info.authState === "pending").length,
      clients: all.map((c) => c.getSummary()),
    };
  }

  // ===== Node (Mobile Companion) Methods =====

  /**
   * Get all connected nodes (mobile companions)
   */
  getNodes(): ControlPlaneClient[] {
    return this.getAuthenticated().filter((c) => c.isNode);
  }

  /**
   * Get node count
   */
  get nodeCount(): number {
    return this.getNodes().length;
  }

  /**
   * Get a node by ID or display name
   */
  getNodeByIdOrName(idOrName: string): ControlPlaneClient | undefined {
    const nodes = this.getNodes();
    // Try exact ID match first
    const byId = nodes.find((n) => n.id === idOrName);
    if (byId) return byId;
    // Then try display name match (case-insensitive)
    const lowerName = idOrName.toLowerCase();
    return nodes.find((n) => n.info.deviceName?.toLowerCase() === lowerName);
  }

  /**
   * Get all node info summaries
   */
  getNodeInfoList(): NonNullable<ReturnType<ControlPlaneClient["getNodeInfo"]>>[] {
    return this.getNodes()
      .map((n) => n.getNodeInfo())
      .filter((info): info is NonNullable<typeof info> => info !== null);
  }

  /**
   * Broadcast an event to all connected nodes
   */
  broadcastToNodes(event: string, payload?: unknown, stateVersion?: string): number {
    let sent = 0;
    for (const client of this.getNodes()) {
      if (client.sendEvent(event, payload, stateVersion)) {
        sent++;
      }
    }
    return sent;
  }

  /**
   * Broadcast an event to all non-node (operator) clients
   */
  broadcastToOperators(event: string, payload?: unknown, stateVersion?: string): number {
    let sent = 0;
    for (const client of this.getAuthenticated()) {
      if (!client.isNode && client.sendEvent(event, payload, stateVersion)) {
        sent++;
      }
    }
    return sent;
  }
}
