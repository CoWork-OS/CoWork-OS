/**
 * Remote Gateway Client
 *
 * WebSocket client for connecting to a remote Control Plane server.
 * Supports SSH tunnel, Tailscale, or direct network connections.
 */

import WebSocket from "ws";
import crypto from "crypto";
import tls from "tls";
import type {
  RemoteGatewayConfig,
  RemoteGatewayStatus,
  RemoteGatewayConnectionState,
} from "../../shared/types";
import {
  parseFrame,
  serializeFrame,
  FrameType,
  Methods,
  type RequestFrame,
  type ResponseFrame,
  type EventFrame,
} from "./protocol";

/**
 * Create a request frame with numeric ID for tracking
 */
function createRequest(id: number, method: string, params?: unknown): RequestFrame {
  return {
    type: FrameType.Request,
    id: String(id),
    method,
    params,
  };
}

/**
 * Remote gateway client options
 */
export interface RemoteGatewayClientOptions extends RemoteGatewayConfig {
  /** Callback for connection state changes */
  onStateChange?: (state: RemoteGatewayConnectionState, error?: string) => void;
  /** Callback for events from the remote gateway */
  onEvent?: (event: string, payload: unknown) => void;
  /** Callback for responses to requests */
  onResponse?: (id: number, result: unknown, error?: { code: string; message: string }) => void;
}

/**
 * Build a `checkServerIdentity` callback that pins the peer certificate to
 * `expectedFingerprint` (SHA-256, with or without colons, any case).
 *
 * Node's contract for this callback is: return an Error to REJECT, and
 * undefined to ACCEPT. Returning a boolean inverts both outcomes — `false` is
 * falsy and reads as success, so a mismatched certificate would be accepted.
 *
 * Supplying this option also replaces Node's default hostname/SAN check
 * entirely, so we must invoke `tls.checkServerIdentity` ourselves first.
 * Otherwise enabling pinning would *weaken* verification rather than add to it.
 */
export function pinnedServerIdentity(
  expectedFingerprint: string,
): (hostname: string, cert: tls.PeerCertificate) => Error | undefined {
  const expected = expectedFingerprint.toLowerCase().replace(/:/g, "");
  return (hostname, cert) => {
    const hostnameError = tls.checkServerIdentity(hostname, cert);
    if (hostnameError) return hostnameError;

    const actual = String(cert?.fingerprint256 || "")
      .toLowerCase()
      .replace(/:/g, "");
    if (!actual) {
      return new Error("Control Plane certificate has no SHA-256 fingerprint to pin against");
    }
    if (actual !== expected) {
      return new Error(
        "Control Plane certificate fingerprint does not match the pinned value. " +
          "Update the pinned fingerprint if the server certificate was rotated.",
      );
    }
    return undefined;
  };
}

/**
 * Bridge our tls-correct callback onto ws's option type.
 *
 * `@types/ws` declares `checkServerIdentity?(servername: string, cert: CertMeta): boolean`,
 * but ws does not call this itself — it forwards the whole options object to
 * `tls.connect`, where the parameter is a `PeerCertificate` and the contract is
 * "return an Error to reject, undefined to accept". Following the declared
 * boolean signature is what made the original pinning logic accept every
 * mismatched certificate, so the cast is deliberate: the runtime contract wins
 * over the (incorrect) type declaration.
 */
function asWsCheckServerIdentity(
  callback: (hostname: string, cert: tls.PeerCertificate) => Error | undefined,
): NonNullable<WebSocket.ClientOptions["checkServerIdentity"]> {
  return callback as unknown as NonNullable<WebSocket.ClientOptions["checkServerIdentity"]>;
}

/**
 * Remote Gateway Client
 * Connects to a Control Plane server hosted elsewhere
 */
export class RemoteGatewayClient {
  private ws: WebSocket | null = null;
  private config: RemoteGatewayClientOptions;
  private state: RemoteGatewayConnectionState = "disconnected";
  private clientId: string | null = null;
  private scopes: string[] = [];
  private connectedAt: number | null = null;
  private lastActivityAt: number | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private requestId = 0;
  private pendingRequests: Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();

  constructor(options: RemoteGatewayClientOptions) {
    this.config = {
      autoReconnect: true,
      reconnectIntervalMs: 5000,
      maxReconnectAttempts: 10,
      deviceName: "CoWork Remote Client",
      ...options,
    };
  }

  /**
   * Get current connection status
   */
  getStatus(): RemoteGatewayStatus {
    return {
      state: this.state,
      url: this.config.url,
      connectedAt: this.connectedAt ?? undefined,
      clientId: this.clientId ?? undefined,
      scopes: this.scopes.length > 0 ? this.scopes : undefined,
      error: this.state === "error" ? (this.lastError ?? "Connection failed") : undefined,
      reconnectAttempts: this.reconnectAttempts > 0 ? this.reconnectAttempts : undefined,
      lastActivityAt: this.lastActivityAt ?? undefined,
    };
  }

  /**
   * Connect to the remote gateway
   */
  async connect(): Promise<void> {
    if (
      this.state === "connected" ||
      this.state === "connecting" ||
      this.state === "authenticating"
    ) {
      console.log("[RemoteGateway] Already connected or connecting");
      return;
    }

    this.setState("connecting");
    this.lastError = null;
    this.reconnectAttempts = 0;

    return this.doConnect();
  }

  /**
   * Disconnect from the remote gateway
   */
  disconnect(): void {
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.clearPendingRequests();

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "Client disconnecting");
      }
      this.ws = null;
    }

    this.clientId = null;
    this.scopes = [];
    this.connectedAt = null;
    this.lastError = null;
    this.setState("disconnected");
    console.log("[RemoteGateway] Disconnected");
  }

  /**
   * Send a request to the remote gateway
   */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (this.state !== "connected") {
      throw new Error("Not connected to remote gateway");
    }

    const id = ++this.requestId;
    const frame = createRequest(id, method, params);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      this.send(frame);
    });
  }

  /**
   * Test connection to the remote gateway
   */
  async testConnection(): Promise<{ success: boolean; error?: string; latencyMs?: number }> {
    const startTime = Date.now();

    try {
      // Create a temporary connection for testing
      const testOptions: WebSocket.ClientOptions = {
        handshakeTimeout: 10000,
      };

      // Apply TLS fingerprint validation for test connections too
      if (this.config.tlsFingerprint && this.config.url.startsWith("wss://")) {
        testOptions.checkServerIdentity = asWsCheckServerIdentity(
          pinnedServerIdentity(this.config.tlsFingerprint),
        );
      }

      const testWs = new WebSocket(this.config.url, testOptions);

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          testWs.close();
          resolve({ success: false, error: "Connection timeout" });
        }, 15000);

        testWs.on("open", async () => {
          try {
            // Send connect request
            const connectFrame = createRequest(1, Methods.CONNECT, {
              token: this.config.token,
              deviceName: `${this.config.deviceName} (test)`,
            });
            testWs.send(serializeFrame(connectFrame));
          } catch (error: Any) {
            clearTimeout(timeout);
            testWs.close();
            resolve({ success: false, error: error.message });
          }
        });

        testWs.on("message", (data) => {
          const frame = parseFrame(data.toString());
          if (!frame) {
            return;
          }

          if (frame.type === FrameType.Event) {
            const event = frame as EventFrame;
            if (event.event === "challenge" || event.event === "connect.challenge") {
              const connectFrame = createRequest(1, Methods.CONNECT, {
                token: this.config.token,
                deviceName: `${this.config.deviceName} (test)`,
              });
              testWs.send(serializeFrame(connectFrame));
            }
            return;
          }

          if (frame.type !== FrameType.Response) {
            return;
          }

          clearTimeout(timeout);
          const response = frame as ResponseFrame;
          testWs.close();

          if (!response.ok || response.error) {
            resolve({
              success: false,
              error: response.error?.message || "Authentication failed",
            });
            return;
          }

          const latencyMs = Date.now() - startTime;
          resolve({ success: true, latencyMs });
        });

        testWs.on("error", (error) => {
          clearTimeout(timeout);
          resolve({ success: false, error: error.message });
        });
      });
    } catch (error: Any) {
      return { success: false, error: error.message };
    }
  }

  // ===== Private Methods =====

  private normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private isReachabilityError(error: unknown): boolean {
    return /(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|Connection timeout|Opening handshake has timed out|socket hang up)/i.test(
      this.normalizeErrorMessage(error),
    );
  }

  private logConnectionError(prefix: string, error: unknown): void {
    const message = this.normalizeErrorMessage(error);
    if (this.isReachabilityError(error)) {
      console.warn(`${prefix}: ${message}`);
      return;
    }
    console.error(prefix, error);
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Validate TLS fingerprint requirement
        if (this.config.tlsFingerprint && !this.config.url.startsWith("wss://")) {
          const error = new Error("TLS fingerprint requires wss:// URL");
          this.setState("error", error.message);
          reject(error);
          return;
        }

        console.log(`[RemoteGateway] Connecting to ${this.config.url}`);

        const wsOptions: WebSocket.ClientOptions = {
          handshakeTimeout: 10000,
        };

        // TLS certificate fingerprint pinning for wss:// connections
        if (this.config.tlsFingerprint && this.config.url.startsWith("wss://")) {
          wsOptions.checkServerIdentity = asWsCheckServerIdentity(
            pinnedServerIdentity(this.config.tlsFingerprint),
          );
        }

        this.ws = new WebSocket(this.config.url, wsOptions);

        const connectionTimeout = setTimeout(() => {
          if (this.state === "connecting") {
            this.ws?.close();
            const error = new Error("Connection timeout");
            this.setState("error", error.message);
            reject(error);
          }
        }, 15000);

        this.ws.on("open", () => {
          clearTimeout(connectionTimeout);
          console.log("[RemoteGateway] WebSocket connected, authenticating...");
          this.setState("authenticating");
          this.authenticate()
            .then(() => resolve())
            .catch((error) => {
              this.setState("error", error.message);
              reject(error);
            });
        });

        this.ws.on("message", (data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on("close", (code, reason) => {
          clearTimeout(connectionTimeout);
          console.log(`[RemoteGateway] Connection closed: ${code} - ${reason}`);
          this.handleDisconnect(code, reason.toString());
        });

        this.ws.on("error", (error) => {
          clearTimeout(connectionTimeout);
          this.logConnectionError("[RemoteGateway] WebSocket error", error);
          this.setState("error", error.message);
          reject(error);
        });
      } catch (error: Any) {
        this.setState("error", error.message);
        reject(error);
      }
    });
  }

  private async authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }

      const authTimeout = setTimeout(() => {
        reject(new Error("Authentication timeout"));
      }, 10000);

      // Wait for challenge (or direct auth for simpler servers)
      const handleAuthResponse = (data: WebSocket.Data) => {
        const frame = parseFrame(data.toString());
        if (!frame) return;

        if (frame.type === FrameType.Response) {
          const response = frame as ResponseFrame;
          clearTimeout(authTimeout);
          this.ws?.off("message", handleAuthResponse);

          if (!response.ok || response.error) {
            reject(new Error(response.error?.message || "Authentication failed"));
          } else {
            const result = response.payload as { clientId?: string; scopes?: string[] } | undefined;
            this.clientId = result?.clientId || crypto.randomUUID();
            this.scopes = result?.scopes || ["admin"];
            this.connectedAt = Date.now();
            this.lastActivityAt = Date.now();
            this.setState("connected");
            this.startHeartbeat();
            console.log(`[RemoteGateway] Authenticated as ${this.clientId}`);
            resolve();
          }
        } else if (frame.type === FrameType.Event) {
          // Challenge or other event
          const event = frame as EventFrame;
          if (event.event === "challenge") {
            // Send authentication
            this.sendAuthRequest();
          }
        }
      };

      this.ws.on("message", handleAuthResponse);

      // Send connect request immediately (server may or may not send challenge first)
      this.sendAuthRequest();
    });
  }

  private sendAuthRequest(): void {
    const frame = createRequest(++this.requestId, Methods.CONNECT, {
      token: this.config.token,
      deviceName: this.config.deviceName,
    });
    this.send(frame);
  }

  private handleMessage(message: string): void {
    this.lastActivityAt = Date.now();

    const frame = parseFrame(message);
    if (!frame) {
      console.warn("[RemoteGateway] Invalid frame received");
      return;
    }

    switch (frame.type) {
      case FrameType.Response: {
        const response = frame as ResponseFrame;
        const numericId = parseInt(response.id, 10);
        const pending = this.pendingRequests.get(numericId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(numericId);

          if (!response.ok || response.error) {
            pending.reject(new Error(response.error?.message || "Request failed"));
            this.config.onResponse?.(numericId, null, response.error);
          } else {
            pending.resolve(response.payload);
            this.config.onResponse?.(numericId, response.payload, undefined);
          }
        }
        break;
      }

      case FrameType.Event: {
        const event = frame as EventFrame;
        console.log(`[RemoteGateway] Event: ${event.event}`);
        this.config.onEvent?.(event.event, event.payload);

        // Handle shutdown event
        if (event.event === "shutdown") {
          console.log("[RemoteGateway] Server shutting down");
          this.handleDisconnect(1001, "Server shutdown");
        }
        break;
      }
    }
  }

  private handleDisconnect(code: number, _reason: string): void {
    this.clearHeartbeatTimer();
    this.clearPendingRequests();
    this.ws = null;
    this.clientId = null;
    this.scopes = [];
    this.connectedAt = null;

    // Attempt reconnection if configured
    if (
      this.config.autoReconnect &&
      code !== 1000 && // Normal close
      code !== 4001 && // Auth failure
      (this.config.maxReconnectAttempts === 0 ||
        this.reconnectAttempts < (this.config.maxReconnectAttempts || 10))
    ) {
      this.scheduleReconnect();
    } else {
      this.setState("disconnected");
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.setState("reconnecting");
    this.reconnectAttempts++;

    const delay = Math.min(
      (this.config.reconnectIntervalMs || 5000) * Math.pow(2, this.reconnectAttempts - 1),
      5 * 60 * 1000, // Max 5 minutes
    );

    console.log(
      `[RemoteGateway] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.doConnect().catch((error) => {
        this.logConnectionError("[RemoteGateway] Reconnection failed", error);
        if (
          this.config.maxReconnectAttempts !== 0 &&
          this.reconnectAttempts >= (this.config.maxReconnectAttempts || 10)
        ) {
          this.setState(
            "error",
            `Unable to reach remote gateway at ${this.config.url}: ${this.normalizeErrorMessage(error)}`,
          );
        }
      });
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.state === "connected" && this.ws?.readyState === WebSocket.OPEN) {
        this.request(Methods.PING).catch((error) => {
          console.warn("[RemoteGateway] Heartbeat failed:", error);
        });
      }
    }, 30000);
  }

  private send(frame: Any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(serializeFrame(frame));
    }
  }

  private setState(state: RemoteGatewayConnectionState, error?: string): void {
    const stateChanged = this.state !== state;
    const errorChanged = state === "error" && Boolean(error) && error !== this.lastError;

    if (state === "error") {
      this.lastError = error ?? this.lastError;
    } else if (state !== "reconnecting") {
      this.lastError = null;
    }

    if (!stateChanged && !errorChanged) {
      return;
    }

    this.state = state;
    console.log(`[RemoteGateway] State: ${state}${error ? ` (${error})` : ""}`);
    this.config.onStateChange?.(state, error);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearPendingRequests(): void {
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();
  }
}

// Singleton instance for the app
let remoteGatewayClient: RemoteGatewayClient | null = null;

/**
 * Get or create the remote gateway client
 */
export function getRemoteGatewayClient(): RemoteGatewayClient | null {
  return remoteGatewayClient;
}

/**
 * Initialize the remote gateway client with config
 */
export function initRemoteGatewayClient(options: RemoteGatewayClientOptions): RemoteGatewayClient {
  if (remoteGatewayClient) {
    remoteGatewayClient.disconnect();
  }
  remoteGatewayClient = new RemoteGatewayClient(options);
  return remoteGatewayClient;
}

/**
 * Shutdown the remote gateway client
 */
export function shutdownRemoteGatewayClient(): void {
  if (remoteGatewayClient) {
    remoteGatewayClient.disconnect();
    remoteGatewayClient = null;
  }
}
