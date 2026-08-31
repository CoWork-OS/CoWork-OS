import { EventEmitter } from "events";
import { createLogger } from "../utils/logger";
import { SecureMcpTunnelAuditStore } from "./audit-store";
import { TunnelClient } from "./TunnelClient";
import { SecureMcpTunnelSettingsManager } from "./settings";
import type {
  SecureMcpTunnelAuditEvent,
  SecureMcpTunnelConfig,
  SecureMcpTunnelStatus,
} from "./types";

const logger = createLogger("SecureMcpTunnelSupervisor");

export class SecureMcpTunnelSupervisor extends EventEmitter {
  private static instance: SecureMcpTunnelSupervisor | null = null;
  private clients = new Map<string, TunnelClient>();
  private statuses = new Map<string, SecureMcpTunnelStatus>();
  private auditEvents: SecureMcpTunnelAuditEvent[] = [];

  static getInstance(): SecureMcpTunnelSupervisor {
    if (!SecureMcpTunnelSupervisor.instance) {
      SecureMcpTunnelSupervisor.instance = new SecureMcpTunnelSupervisor();
    }
    return SecureMcpTunnelSupervisor.instance;
  }

  async startEnabledTunnels(): Promise<void> {
    if (process.env.COWORK_SECURE_MCP_TUNNELS !== "1") {
      return;
    }
    const settings = SecureMcpTunnelSettingsManager.loadSettings();
    for (const tunnel of settings.tunnels.filter((entry) => entry.enabled)) {
      try {
        await this.startTunnel(tunnel.id);
      } catch (error) {
        logger.warn(`Failed to auto-start secure MCP tunnel ${tunnel.name}`, error);
      }
    }
  }

  async startTunnel(tunnelId: string): Promise<SecureMcpTunnelStatus> {
    const config = SecureMcpTunnelSettingsManager.getTunnel(tunnelId);
    if (!config) {
      throw new Error("Secure MCP tunnel not found");
    }
    if (this.clients.has(tunnelId)) {
      return this.clients.get(tunnelId)!.getStatus();
    }
    const client = new TunnelClient(config);
    this.clients.set(tunnelId, client);
    this.setupClientHandlers(config, client);
    try {
      await client.start();
    } catch (error) {
      await client.stop();
      this.clients.delete(tunnelId);
      throw error;
    }
    return client.getStatus();
  }

  async stopTunnel(tunnelId: string): Promise<SecureMcpTunnelStatus | null> {
    const client = this.clients.get(tunnelId);
    if (!client) {
      return this.getStatus(tunnelId) || null;
    }
    await client.stop();
    const status = client.getStatus();
    this.clients.delete(tunnelId);
    this.statuses.set(tunnelId, status);
    this.emit("status", this.getStatuses());
    return status;
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map((client) => client.stop()));
    this.clients.clear();
    this.emit("status", this.getStatuses());
  }

  getStatuses(): SecureMcpTunnelStatus[] {
    const settings = SecureMcpTunnelSettingsManager.loadSettings();
    return settings.tunnels.map((tunnel) => {
      const live = this.clients.get(tunnel.id)?.getStatus() || this.statuses.get(tunnel.id);
      return (
        live || {
          tunnelId: tunnel.id,
          name: tunnel.name,
          state: "stopped",
          relayUrl: tunnel.relayUrl,
          targetUrl:
            tunnel.targetType === "cowork-host"
              ? `http://127.0.0.1:${tunnel.coworkHostPort || 3333}/mcp`
              : tunnel.targetUrl || "",
          lastConnectedAt: tunnel.lastConnectedAt,
          lastError: tunnel.lastError,
          reconnectAttempts: 0,
        }
      );
    });
  }

  getStatus(tunnelId: string): SecureMcpTunnelStatus | undefined {
    return this.getStatuses().find((status) => status.tunnelId === tunnelId);
  }

  getAuditEvents(tunnelId?: string): SecureMcpTunnelAuditEvent[] {
    const persisted = SecureMcpTunnelAuditStore.list(tunnelId, 100);
    if (persisted.length > 0) {
      return persisted;
    }
    const events = tunnelId
      ? this.auditEvents.filter((event) => event.tunnelId === tunnelId)
      : this.auditEvents;
    return events.slice(-100).reverse();
  }

  private setupClientHandlers(config: SecureMcpTunnelConfig, client: TunnelClient): void {
    client.on("status", (status: SecureMcpTunnelStatus) => {
      this.statuses.set(config.id, status);
      this.emit("status", this.getStatuses());
    });
    client.on("audit", (event: SecureMcpTunnelAuditEvent) => {
      this.auditEvents.push(event);
      SecureMcpTunnelAuditStore.append(event);
      if (this.auditEvents.length > 1000) {
        this.auditEvents.splice(0, this.auditEvents.length - 1000);
      }
      this.emit("audit", event);
    });
  }
}
