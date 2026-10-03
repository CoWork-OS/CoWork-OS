import { EventEmitter } from "events";
import { createLogger } from "../utils/logger";
import { SecureMcpTunnelAuditStore } from "./audit-store";
import { TunnelClient } from "./TunnelClient";
import { SecureMcpTunnelSettingsManager } from "./settings";
import type {
  SecureMcpTunnelAuditEvent,
  SecureMcpTunnelConfig,
  SecureMcpTunnelStatus,
  SecureMcpTunnelUpdateInput,
} from "./types";

const logger = createLogger("SecureMcpTunnelSupervisor");

export class SecureMcpTunnelSupervisor extends EventEmitter {
  private static instance: SecureMcpTunnelSupervisor | null = null;
  private lifecycle = new Map<string, Promise<unknown>>();
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

  private withTunnelLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycle.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.lifecycle.set(id, next);
    void next
      .finally(() => {
        if (this.lifecycle.get(id) === next) this.lifecycle.delete(id);
      })
      .catch(() => undefined);
    return next;
  }

  async startTunnel(tunnelId: string): Promise<SecureMcpTunnelStatus> {
    return this.withTunnelLock(tunnelId, () => this.startTunnelUnlocked(tunnelId));
  }

  private async startTunnelUnlocked(tunnelId: string): Promise<SecureMcpTunnelStatus> {
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
    return this.withTunnelLock(tunnelId, () => this.stopTunnelUnlocked(tunnelId));
  }

  private async stopTunnelUnlocked(tunnelId: string): Promise<SecureMcpTunnelStatus | null> {
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

  async updateTunnel(tunnelId: string, updates: SecureMcpTunnelUpdateInput) {
    return this.withTunnelLock(tunnelId, () => this.updateTunnelUnlocked(tunnelId, updates));
  }

  private async updateTunnelUnlocked(tunnelId: string, updates: SecureMcpTunnelUpdateInput) {
    const wasRunning = this.clients.has(tunnelId);
    // Revoke the old connection before acknowledging or publishing new authority.
    if (wasRunning) await this.stopTunnelUnlocked(tunnelId);
    const updated = SecureMcpTunnelSettingsManager.updateTunnel(tunnelId, updates);
    if (updated && wasRunning && updated.enabled) await this.startTunnelUnlocked(tunnelId);
    return updated;
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.keys()).map((id) => this.stopTunnel(id)));
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
