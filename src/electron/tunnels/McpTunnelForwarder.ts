import { randomUUID } from "crypto";
import type { JSONRPCRequest, JSONRPCResponse } from "../mcp/types";
import { MCPHostServer } from "../mcp/host/MCPHostServer";
import { createLogger } from "../utils/logger";
import { enforceTunnelPolicy, getMcpToolName, validateJsonRpcRequest } from "./protocol";
import type { SecureMcpTunnelAuditEvent, SecureMcpTunnelConfig } from "./types";

const logger = createLogger("McpTunnelForwarder");

export interface ForwardResult {
  response?: JSONRPCResponse;
  auditEvent: SecureMcpTunnelAuditEvent;
}

export class McpTunnelForwarder {
  constructor(private readonly config: SecureMcpTunnelConfig) {}

  async forward(
    payload: JSONRPCRequest,
    caller?: string,
    deadlineMs?: number,
  ): Promise<ForwardResult> {
    const startedAt = Date.now();
    const method = payload.method;
    const toolName = getMcpToolName(payload);
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf-8");
    const policyResult = enforceTunnelPolicy(this.config.policy, payload, payloadBytes);

    if (!policyResult.approved) {
      return {
        response: buildJsonRpcError(payload.id, -32001, policyResult.reason),
        auditEvent: this.buildAuditEvent({
          caller,
          method,
          toolName: policyResult.toolName || toolName,
          approved: false,
          status: "blocked",
          durationMs: Date.now() - startedAt,
          error: policyResult.reason,
        }),
      };
    }

    try {
      validateJsonRpcRequest(payload);
      const response = await this.forwardHttp(payload, deadlineMs);
      const responseBytes = Buffer.byteLength(JSON.stringify(response), "utf-8");
      if (responseBytes > this.config.policy.maxResponseBytes) {
        throw new Error("Response exceeds tunnel size limit");
      }
      return {
        response,
        auditEvent: this.buildAuditEvent({
          caller,
          method,
          toolName,
          approved: true,
          status: response.error ? "error" : "success",
          durationMs: Date.now() - startedAt,
          error: response.error?.message,
        }),
      };
    } catch (error: Any) {
      logger.warn(`MCP tunnel forwarding failed for ${this.config.name}`, error);
      return {
        response: buildJsonRpcError(
          payload.id,
          -32000,
          error?.message || "Tunnel forwarding failed",
        ),
        auditEvent: this.buildAuditEvent({
          caller,
          method,
          toolName,
          approved: true,
          status: "error",
          durationMs: Date.now() - startedAt,
          error: error?.message || "Tunnel forwarding failed",
        }),
      };
    }
  }

  private async forwardHttp(
    payload: JSONRPCRequest,
    deadlineMs?: number,
  ): Promise<JSONRPCResponse> {
    const targetUrl = this.getTargetUrl();
    const timeoutMs = Math.min(
      this.config.policy.requestTimeoutMs,
      Math.max(1000, deadlineMs ? deadlineMs - Date.now() : this.config.policy.requestTimeoutMs),
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.getTargetAuthHeaders(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`MCP target returned HTTP ${response.status}`);
      }
      const text = await readResponseTextLimited(response, this.config.policy.maxResponseBytes);
      const parsed = JSON.parse(text) as JSONRPCResponse;
      if (!parsed || parsed.jsonrpc !== "2.0") {
        throw new Error("MCP target returned invalid JSON-RPC response");
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getTargetUrl(): string {
    if (this.config.targetType === "cowork-host") {
      return `http://127.0.0.1:${this.config.coworkHostPort || 3333}/mcp`;
    }
    if (!this.config.targetUrl) {
      throw new Error("Tunnel target URL is not configured");
    }
    assertAllowedTargetUrl(this.config.targetUrl);
    return this.config.targetUrl;
  }

  private getTargetAuthHeaders(): Record<string, string> {
    if (this.config.targetType !== "cowork-host") {
      return {};
    }
    const token = MCPHostServer.getInstance().getHttpAuthToken();
    if (!token) {
      throw new Error("CoWork MCP host auth token is not available");
    }
    return { authorization: `Bearer ${token}` };
  }

  private buildAuditEvent(input: {
    caller?: string;
    method: string;
    toolName?: string;
    approved: boolean;
    status: SecureMcpTunnelAuditEvent["status"];
    durationMs?: number;
    error?: string;
  }): SecureMcpTunnelAuditEvent {
    return {
      id: randomUUID(),
      tunnelId: this.config.id,
      timestamp: Date.now(),
      ...input,
    };
  }
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("Response exceeds tunnel size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
}

export function assertAllowedTargetUrl(rawUrl: string): void {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Tunnel target must be an HTTP MCP endpoint");
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLocal =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local");
  const isPrivate =
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
  if (!isLocal && !isPrivate) {
    throw new Error("Tunnel target must be localhost, .local, or a private-network address");
  }
}

function buildJsonRpcError(
  id: JSONRPCRequest["id"],
  code: number,
  message: string,
): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}
