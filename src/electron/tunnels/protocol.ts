import type { SecureMcpTunnelPolicy, TunnelClientMessage, TunnelRelayMessage } from "./types";

const WRITE_TOOL_RE =
  /(^|[_\-\s])(write|create|update|delete|remove|rename|move|copy|patch|edit|send|post|put|publish|execute|run|install|deploy|commit|push)([_\-\s]|$)/i;

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

  const toolName = getMcpToolName(payload);
  if (!toolName) {
    return { approved: true };
  }

  if (policy.allowedTools.length > 0 && !policy.allowedTools.includes(toolName)) {
    return { approved: false, reason: `Tool is not allowed: ${toolName}`, toolName };
  }

  if (policy.readOnly && WRITE_TOOL_RE.test(toolName)) {
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
