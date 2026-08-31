import type { JSONRPCRequest, JSONRPCResponse } from "../mcp/types";

export type SecureMcpTunnelTargetType = "cowork-host" | "http";
export type SecureMcpTunnelConnectionState =
  | "stopped"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface SecureMcpTunnelPolicy {
  allowedTools: string[];
  readOnly: boolean;
  maxRequestBytes: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
}

export interface SecureMcpTunnelConfig {
  id: string;
  name: string;
  enabled: boolean;
  relayUrl: string;
  targetType: SecureMcpTunnelTargetType;
  targetUrl?: string;
  coworkHostPort?: number;
  policy: SecureMcpTunnelPolicy;
  clientToken?: string;
  callerToken?: string;
  createdAt: number;
  updatedAt: number;
  lastConnectedAt?: number;
  lastError?: string;
}

export interface SecureMcpTunnelDisplayConfig extends Omit<
  SecureMcpTunnelConfig,
  "clientToken" | "callerToken"
> {
  hasClientToken: boolean;
  hasCallerToken: boolean;
}

export interface SecureMcpTunnelSettings {
  tunnels: SecureMcpTunnelConfig[];
}

export interface SecureMcpTunnelDisplaySettings {
  tunnels: SecureMcpTunnelDisplayConfig[];
}

export interface SecureMcpTunnelStatus {
  tunnelId: string;
  name: string;
  state: SecureMcpTunnelConnectionState;
  relayUrl: string;
  targetUrl: string;
  connectedAt?: number;
  lastConnectedAt?: number;
  lastError?: string;
  reconnectAttempts: number;
  lastRequestAt?: number;
}

export interface SecureMcpTunnelAuditEvent {
  id: string;
  tunnelId: string;
  timestamp: number;
  caller?: string;
  method: string;
  toolName?: string;
  approved: boolean;
  status: "success" | "blocked" | "error";
  durationMs?: number;
  error?: string;
}

export type TunnelClientMessage =
  | {
      type: "hello";
      tunnelId: string;
      protocolVersion: 1;
      targetType: SecureMcpTunnelTargetType;
      policy: SecureMcpTunnelPolicy;
    }
  | {
      type: "pong";
      tunnelId: string;
      timestamp: number;
    }
  | {
      type: "mcp_response";
      tunnelId: string;
      requestId: string;
      payload: JSONRPCResponse;
    }
  | {
      type: "mcp_error";
      tunnelId: string;
      requestId: string;
      error: string;
    }
  | {
      type: "audit_event";
      tunnelId: string;
      event: SecureMcpTunnelAuditEvent;
    };

export type TunnelRelayMessage =
  | {
      type: "ready";
      tunnelId: string;
    }
  | {
      type: "ping";
      timestamp: number;
    }
  | {
      type: "mcp_request";
      tunnelId: string;
      requestId: string;
      caller?: string;
      deadlineMs?: number;
      payload: JSONRPCRequest;
    }
  | {
      type: "error";
      error: string;
    };

export interface SecureMcpTunnelCreateInput {
  name: string;
  relayUrl: string;
  targetType: SecureMcpTunnelTargetType;
  targetUrl?: string;
  coworkHostPort?: number;
  clientToken?: string;
  callerToken?: string;
  policy?: Partial<SecureMcpTunnelPolicy>;
  enabled?: boolean;
}

export interface SecureMcpTunnelUpdateInput extends Partial<
  Omit<SecureMcpTunnelCreateInput, "policy">
> {
  policy?: Partial<SecureMcpTunnelPolicy>;
}

export const DEFAULT_SECURE_MCP_TUNNEL_POLICY: SecureMcpTunnelPolicy = {
  allowedTools: [],
  readOnly: false,
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 1024 * 1024,
  requestTimeoutMs: 60_000,
};

export const DEFAULT_SECURE_MCP_TUNNEL_SETTINGS: SecureMcpTunnelSettings = {
  tunnels: [],
};
