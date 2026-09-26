/**
 * WebSocket Control Plane Client Management
 *
 * Handles client connection state, authentication, and tracking.
 */

import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  Frame,
  EventFrame as _EventFrame,
  serializeFrame,
  createEventFrame,
  Events,
} from "./protocol";

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
   * Mark client as authenticated with given scopes
   */
  authenticate(scopes: ClientScope[], deviceName?: string): void {
    this.info.authState = "authenticated";
    this.info.scopes = scopes;
    this.info.deviceName = deviceName;
    this.updateActivity();
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
  } {
    return {
      id: this.info.id,
      remoteAddress: this.info.remoteAddress,
      deviceName: this.info.deviceName,
      authenticated: this.isAuthenticated,
      scopes: this.info.scopes,
      connectedAt: this.info.connectedAt,
      lastActivityAt: this.info.lastActivityAt,
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

  /**
   * Broadcast an event to all authenticated operator clients
   */
  broadcastToOperators(event: string, payload?: unknown, stateVersion?: string): number {
    return this.broadcast(event, payload, stateVersion);
  }
}
