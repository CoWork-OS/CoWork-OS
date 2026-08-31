import { EventEmitter } from "events";
import WebSocket from "ws";
import { createLogger } from "../utils/logger";
import { McpTunnelForwarder } from "./McpTunnelForwarder";
import { parseTunnelRelayMessage, serializeTunnelClientMessage } from "./protocol";
import type {
  SecureMcpTunnelAuditEvent,
  SecureMcpTunnelConfig,
  SecureMcpTunnelConnectionState,
  SecureMcpTunnelStatus,
  TunnelRelayMessage,
} from "./types";
import { SecureMcpTunnelSettingsManager } from "./settings";

const logger = createLogger("SecureMcpTunnelClient");

export interface TunnelClientEvents {
  status: (status: SecureMcpTunnelStatus) => void;
  audit: (event: SecureMcpTunnelAuditEvent) => void;
}

export class TunnelClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: SecureMcpTunnelConnectionState = "stopped";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedAt: number | undefined;
  private lastRequestAt: number | undefined;
  private lastError: string | undefined;
  private intentionalStop = false;
  private readonly forwarder: McpTunnelForwarder;

  constructor(private readonly config: SecureMcpTunnelConfig) {
    super();
    this.forwarder = new McpTunnelForwarder(config);
  }

  getStatus(): SecureMcpTunnelStatus {
    return {
      tunnelId: this.config.id,
      name: this.config.name,
      state: this.state,
      relayUrl: this.config.relayUrl,
      targetUrl: this.getTargetDescription(),
      connectedAt: this.connectedAt,
      lastConnectedAt: this.config.lastConnectedAt,
      lastError: this.lastError || this.config.lastError,
      reconnectAttempts: this.reconnectAttempts,
      lastRequestAt: this.lastRequestAt,
    };
  }

  async start(): Promise<void> {
    if (this.ws || this.state === "connecting" || this.state === "connected") {
      return;
    }
    if (!this.config.clientToken) {
      throw new Error("Tunnel client token is not configured");
    }

    this.intentionalStop = false;
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    assertAllowedRelayUrl(this.config.relayUrl);
    if (new URL(this.config.relayUrl).protocol === "http:") {
      logger.warn(
        `Tunnel ${this.config.id} connecting over plain HTTP (loopback) — the client bearer token is sent in cleartext. Use HTTPS for any non-loopback relay.`,
      );
    }
    const wsUrl = buildRelayConnectUrl(this.config.relayUrl, this.config.id);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws?.terminate();
        reject(new Error("Timed out connecting to tunnel relay"));
      }, 15_000);

      const ws = new WebSocket(wsUrl, {
        headers: {
          authorization: `Bearer ${this.config.clientToken}`,
        },
        handshakeTimeout: 15_000,
      });
      this.ws = ws;

      ws.once("open", () => {
        clearTimeout(timeout);
        this.connectedAt = Date.now();
        this.reconnectAttempts = 0;
        this.lastError = undefined;
        SecureMcpTunnelSettingsManager.markConnected(this.config.id);
        this.send({
          type: "hello",
          tunnelId: this.config.id,
          protocolVersion: 1,
          targetType: this.config.targetType,
          policy: this.config.policy,
        });
        this.setState("connected");
        resolve();
      });

      ws.on("message", (data) => {
        void this.handleRawMessage(data.toString());
      });

      ws.on("error", (error) => {
        this.lastError = error.message;
        this.emitStatus();
        if (this.state !== "connected") {
          clearTimeout(timeout);
          reject(error);
        }
      });

      ws.on("close", () => {
        this.ws = null;
        this.connectedAt = undefined;
        if (!this.intentionalStop) {
          this.scheduleReconnect();
        } else {
          this.setState("stopped");
        }
      });
    });
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      await new Promise<void>((resolve) => {
        const ws = this.ws;
        if (!ws || ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        ws.once("close", () => resolve());
        ws.close(1000, "stopped");
        setTimeout(resolve, 1000);
      });
      this.ws = null;
    }
    this.setState("stopped");
  }

  private async handleRawMessage(raw: string): Promise<void> {
    let message: TunnelRelayMessage;
    try {
      message = parseTunnelRelayMessage(raw);
    } catch (error: Any) {
      this.sendError("", error?.message || "Invalid relay message");
      return;
    }

    if (message.type === "ping") {
      this.send({ type: "pong", tunnelId: this.config.id, timestamp: Date.now() });
      return;
    }
    if (message.type === "error") {
      this.lastError = message.error;
      this.emitStatus();
      return;
    }
    if (message.type !== "mcp_request") {
      return;
    }

    this.lastRequestAt = Date.now();
    const result = await this.forwarder.forward(
      message.payload,
      message.caller,
      message.deadlineMs,
    );
    this.emit("audit", result.auditEvent);
    this.send({ type: "audit_event", tunnelId: this.config.id, event: result.auditEvent });
    if (result.response) {
      this.send({
        type: "mcp_response",
        tunnelId: this.config.id,
        requestId: message.requestId,
        payload: result.response,
      });
    }
    this.emitStatus();
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    this.reconnectAttempts += 1;
    const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((error: Any) => {
        const message = error?.message || "Tunnel reconnect failed";
        this.lastError = message;
        SecureMcpTunnelSettingsManager.markError(this.config.id, message);
        logger.warn(`Tunnel reconnect failed for ${this.config.name}`, error);
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private sendError(requestId: string, error: string): void {
    this.send({ type: "mcp_error", tunnelId: this.config.id, requestId, error });
  }

  private send(message: Parameters<typeof serializeTunnelClientMessage>[0]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(serializeTunnelClientMessage(message));
  }

  private setState(state: SecureMcpTunnelConnectionState): void {
    this.state = state;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit("status", this.getStatus());
  }

  private getTargetDescription(): string {
    if (this.config.targetType === "cowork-host") {
      return `http://127.0.0.1:${this.config.coworkHostPort || 3333}/mcp`;
    }
    return this.config.targetUrl || "";
  }
}

function buildRelayConnectUrl(relayUrl: string, tunnelId: string): string {
  const parsed = new URL(relayUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/v1/tunnels/connect";
  parsed.searchParams.set("tunnel_id", tunnelId);
  return parsed.toString();
}

function assertAllowedRelayUrl(relayUrl: string): void {
  const parsed = new URL(relayUrl);
  if (parsed.protocol === "https:") {
    return;
  }
  if (parsed.protocol !== "http:") {
    throw new Error("Tunnel relay URL must use HTTPS, or HTTP for loopback development");
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (!isLoopback) {
    throw new Error("Plain HTTP tunnel relays are only allowed on loopback hosts");
  }
}
