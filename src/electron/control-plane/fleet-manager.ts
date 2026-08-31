import type {
  ManagedDevice,
  RemoteGatewayConnectionState,
  RemoteGatewayStatus,
  SSHTunnelStatus,
} from "../../shared/types";
import { RemoteGatewayClient } from "./remote-client";
import { SSHTunnelManager } from "./ssh-tunnel";

export interface FleetObserverEntry {
  id: string;
  timestamp: number;
  title: string;
  detail?: string;
  level: "none" | "info" | "warning" | "critical";
}

export interface FleetConnectionManagerCallbacks {
  onStateChange?: (params: {
    deviceId: string;
    state: RemoteGatewayConnectionState;
    error?: string;
    status: RemoteGatewayStatus;
  }) => void;
  onEvent?: (params: {
    deviceId: string;
    event: string;
    payload: unknown;
    status: RemoteGatewayStatus;
  }) => void;
  onTunnelStateChange?: (params: {
    deviceId: string;
    status: SSHTunnelStatus;
    error?: string;
  }) => void;
}

interface FleetConnectionEntry {
  deviceId: string;
  client: RemoteGatewayClient;
  tunnel?: SSHTunnelManager;
  observer: FleetObserverEntry[];
}

function toLevelForState(state: RemoteGatewayConnectionState): FleetObserverEntry["level"] {
  switch (state) {
    case "connected":
      return "info";
    case "error":
      return "critical";
    case "reconnecting":
    case "authenticating":
    case "connecting":
      return "warning";
    default:
      return "none";
  }
}

function toLevelForTunnelState(state: SSHTunnelStatus["state"]): FleetObserverEntry["level"] {
  switch (state) {
    case "connected":
      return "info";
    case "error":
      return "critical";
    case "reconnecting":
    case "connecting":
      return "warning";
    default:
      return "none";
  }
}

function pushObserver(
  entry: FleetConnectionEntry,
  next: Omit<FleetObserverEntry, "id" | "timestamp"> & { timestamp?: number },
): void {
  entry.observer.unshift({
    id: `${entry.deviceId}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    timestamp: next.timestamp ?? Date.now(),
    title: next.title,
    detail: next.detail,
    level: next.level,
  });
  if (entry.observer.length > 60) {
    entry.observer.length = 60;
  }
}

export class FleetConnectionManager {
  private connections = new Map<string, FleetConnectionEntry>();
  private callbacks: FleetConnectionManagerCallbacks = {};

  constructor(callbacks?: FleetConnectionManagerCallbacks) {
    if (callbacks) {
      this.callbacks = callbacks;
    }
  }

  setCallbacks(callbacks: FleetConnectionManagerCallbacks): void {
    this.callbacks = callbacks;
  }

  listDeviceIds(): string[] {
    return Array.from(this.connections.keys());
  }

  getClient(deviceId: string): RemoteGatewayClient | null {
    return this.connections.get(deviceId)?.client ?? null;
  }

  getObserver(deviceId: string): FleetObserverEntry[] {
    return [...(this.connections.get(deviceId)?.observer ?? [])];
  }

  getTunnelStatus(deviceId: string): SSHTunnelStatus | undefined {
    return this.connections.get(deviceId)?.tunnel?.getStatus();
  }

  getStatus(deviceId: string): RemoteGatewayStatus {
    const entry = this.connections.get(deviceId);
    if (!entry) {
      return { state: "disconnected" };
    }
    return {
      ...entry.client.getStatus(),
      ...(entry.tunnel ? { sshTunnel: entry.tunnel.getStatus() } : {}),
    };
  }

  async connectDevice(device: ManagedDevice): Promise<RemoteGatewayStatus> {
    if (device.role !== "remote") {
      throw new Error("Only remote devices can be connected");
    }
    if (!device.config?.url || !device.config?.token) {
      throw new Error("Remote gateway URL and token are required");
    }

    const existing = this.connections.get(device.id);
    const observer = existing?.observer ?? [];
    if (existing) {
      existing.client.disconnect();
      existing.tunnel?.disconnect();
    }

    const effectiveConfig = { ...device.config };
    const entry: FleetConnectionEntry = {
      deviceId: device.id,
      client: new RemoteGatewayClient({
        ...effectiveConfig,
        onStateChange: (state, error) => {
          pushObserver(entry, {
            title: `Connection ${state}`,
            detail: error,
            level: toLevelForState(state),
          });
          this.callbacks.onStateChange?.({
            deviceId: device.id,
            state,
            error,
            status: this.getStatus(device.id),
          });
        },
        onEvent: (event, payload) => {
          pushObserver(entry, {
            title: event,
            detail:
              payload && typeof payload === "object"
                ? JSON.stringify(payload).slice(0, 220)
                : undefined,
            level: event.includes("error") ? "critical" : "info",
          });
          this.callbacks.onEvent?.({
            deviceId: device.id,
            event,
            payload,
            status: this.getStatus(device.id),
          });
        },
      }),
      observer,
    };

    this.connections.set(device.id, entry);

    if (effectiveConfig.sshTunnel?.enabled) {
      const tunnel = new SSHTunnelManager({
        ...effectiveConfig.sshTunnel,
        enabled: true,
      });
      entry.tunnel = tunnel;
      tunnel.on("stateChange", (_state: string, error?: string) => {
        const status = tunnel.getStatus();
        pushObserver(entry, {
          title: `SSH tunnel ${status.state}`,
          detail: error || status.error,
          level: toLevelForTunnelState(status.state),
        });
        this.callbacks.onTunnelStateChange?.({
          deviceId: device.id,
          status,
          error,
        });
      });
      await tunnel.connect();
      effectiveConfig.url = tunnel.getLocalUrl();
    }

    try {
      await entry.client.connect();
      return this.getStatus(device.id);
    } catch (error) {
      entry.client.disconnect();
      entry.tunnel?.disconnect();
      throw error;
    }
  }

  disconnectDevice(deviceId: string): void {
    const entry = this.connections.get(deviceId);
    if (!entry) return;
    entry.client.disconnect();
    entry.tunnel?.disconnect();
  }

  removeDevice(deviceId: string): void {
    this.disconnectDevice(deviceId);
    this.connections.delete(deviceId);
  }

  disconnectAll(): void {
    for (const deviceId of this.connections.keys()) {
      this.disconnectDevice(deviceId);
    }
    this.connections.clear();
  }
}

let fleetConnectionManager: FleetConnectionManager | null = null;

export function initFleetConnectionManager(
  callbacks?: FleetConnectionManagerCallbacks,
): FleetConnectionManager {
  if (!fleetConnectionManager) {
    fleetConnectionManager = new FleetConnectionManager(callbacks);
  } else if (callbacks) {
    fleetConnectionManager.setCallbacks(callbacks);
  }
  return fleetConnectionManager;
}

export function getFleetConnectionManager(): FleetConnectionManager | null {
  return fleetConnectionManager;
}

export function shutdownFleetConnectionManager(): void {
  if (!fleetConnectionManager) return;
  fleetConnectionManager.disconnectAll();
  fleetConnectionManager = null;
}
