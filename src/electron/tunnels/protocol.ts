import type { SecureMcpTunnelPolicy, TunnelClientMessage, TunnelRelayMessage } from "./types";

export function parseTunnelRelayMessage(raw: string): TunnelRelayMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tunnel message must be an object");
  }
  const message = parsed as Record<string, unknown>;
  if (typeof message.type !== "string") {
    throw new Error("Tunnel message is missing type");
  }
  switch (message.type) {
    case "ready":
      requireString(message.tunnelId, "tunnelId");
      return message as TunnelRelayMessage;
    case "ping":
      return message as TunnelRelayMessage;
    case "mcp_request":
      requireString(message.tunnelId, "tunnelId");
      requireString(message.requestId, "requestId");
      validateJsonRpcRequest(message.payload);
      return message as TunnelRelayMessage;
    case "error":
      requireString(message.error, "error");
      return message as TunnelRelayMessage;
    default:
      throw new Error(`Unsupported tunnel message type: ${message.type}`);
  }
}

export function serializeTunnelClientMessage(message: TunnelClientMessage): string {
  return JSON.stringify(message);
}

export function validateJsonRpcRequest(payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("MCP payload must be a JSON-RPC object");
  }
  const request = payload as Record<string, unknown>;
  if (request.jsonrpc !== "2.0") {
    throw new Error("MCP payload must use JSON-RPC 2.0");
  }
  if (typeof request.method !== "string" || !request.method.trim()) {
    throw new Error("MCP payload method is required");
  }
}

export function getMcpToolName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const request = payload as Record<string, unknown>;
  if (request.method !== "tools/call") {
    return undefined;
  }
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const name = (params as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

export function enforceTunnelPolicy(
  policy: SecureMcpTunnelPolicy,
  payload: unknown,
  sizeBytes: number,
): { approved: true } | { approved: false; reason: string; toolName?: string } {
  if (sizeBytes > policy.maxRequestBytes) {
    return { approved: false, reason: "Request exceeds tunnel size limit" };
  }

  const method = (payload as { method?: unknown } | null)?.method;
  const allowedMethods = [
    "initialize",
    "notifications/initialized",
    "notifications/cancelled",
    "ping",
    "tools/list",
    "tools/call",
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "prompts/list",
    "prompts/get",
    "completion/complete",
    "logging/setLevel",
  ];
  if (typeof method !== "string" || !allowedMethods.includes(method)) {
    return {
      approved: false,
      reason: `MCP method is not allowed through tunnels: ${String(method)}`,
    };
  }
  const toolName = getMcpToolName(payload);
  if (method === "tools/call" && !toolName) {
    return { approved: false, reason: "Tool call requires a tool name" };
  }
  if (!toolName) {
    return { approved: true };
  }

  if (policy.allowedTools.length > 0 && !policy.allowedTools.includes(toolName)) {
    return { approved: false, reason: `Tool is not allowed: ${toolName}`, toolName };
  }

  // Tool names and remote annotations do not establish side-effect freedom.
  // Until trusted effect metadata is available, read-only tunnels expose only
  // protocol discovery and resource reads, never arbitrary tools/call requests.
  if (policy.readOnly) {
    return {
      approved: false,
      reason: `Tool is blocked by read-only policy: ${toolName}`,
      toolName,
    };
  }

  return { approved: true };
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tunnel message is missing ${field}`);
  }
}
