import { randomUUID } from "crypto";
import net from "net";
import type {
  ACPAgentCard,
  ACPTaskCreateParams,
  A2AJsonRpcErrorResponse,
  A2AJsonRpcRequest,
  A2AJsonRpcSuccessResponse,
  A2ARemoteTaskResult,
} from "./types";
import {
  createRemoteAgentSecretResolver,
  getRemoteAgentSecretRef,
  type RemoteAgentSecretResolver,
  type RemoteAgentSecrets,
} from "./remote-agent-secrets";

export interface RemoteInvocationResult {
  status: "completed" | "failed" | "pending" | "running" | "cancelled";
  result?: string;
  error?: string;
  remoteTaskId?: string;
}

const REMOTE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Raised only when the remote agent definitively rejected the request before
 * executing it (method unsupported / request refused). Timeouts, network errors,
 * and ambiguous server failures must NOT use this, because the task may exist.
 */
class RemoteMethodNotSupportedError extends Error {
  constructor(method: A2AJsonRpcRequest["method"], message: string) {
    super(`Remote agent does not support ${method}: ${message}`);
    this.name = "RemoteMethodNotSupportedError";
  }
}

// 404 Not Found, 405 Method Not Allowed, 501 Not Implemented: the endpoint refused the method.
const METHOD_UNSUPPORTED_HTTP_STATUSES = new Set([404, 405, 501]);
// -32601 Method not found, -32600 Invalid Request: rejected before execution per JSON-RPC 2.0.
const METHOD_UNSUPPORTED_JSON_RPC_CODES = new Set([-32601, -32600]);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isPrivateIpAddress(hostname: string): boolean {
  if (net.isIP(hostname) === 4) {
    return (
      hostname.startsWith("10.") ||
      hostname.startsWith("127.") ||
      hostname.startsWith("169.254.") ||
      hostname.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    );
  }
  if (net.isIP(hostname) === 6) {
    const normalized = hostname.toLowerCase();
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }
  return false;
}

export function validateRemoteAgentEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Remote agent endpoint must be a valid URL");
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("Remote agent endpoint must use https, or http for loopback development only");
  }

  if (protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("Remote agent endpoint must use https unless it targets localhost");
  }

  if (isPrivateIpAddress(parsed.hostname) && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("Remote agent endpoint cannot target private or link-local IP ranges");
  }

  return parsed;
}

function buildHeaders(secrets: RemoteAgentSecrets | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const explicitHeader = secrets?.authorizationHeader;
  const bearerToken = secrets?.bearerToken;
  if (typeof explicitHeader === "string" && explicitHeader.trim()) {
    headers.Authorization = explicitHeader.trim();
  } else if (typeof bearerToken === "string" && bearerToken.trim()) {
    headers.Authorization = `Bearer ${bearerToken.trim()}`;
  }
  return headers;
}

export interface RemoteAgentInvokerOptions {
  /**
   * Resolves an agent's credentials when a request is sent. Defaults to the
   * secure-settings store; credentials are never read from the agent card.
   */
  resolveSecrets?: RemoteAgentSecretResolver;
}

function normalizeRemoteResult(
  result: A2ARemoteTaskResult | Record<string, unknown>,
): RemoteInvocationResult {
  const status = String(
    (result as A2ARemoteTaskResult).status ||
      (result as Record<string, unknown>).state ||
      "pending",
  ).toLowerCase();
  return {
    status:
      status === "completed" ||
      status === "failed" ||
      status === "running" ||
      status === "cancelled"
        ? (status as RemoteInvocationResult["status"])
        : "pending",
    result:
      typeof (result as A2ARemoteTaskResult).result === "string"
        ? (result as A2ARemoteTaskResult).result
        : typeof (result as A2ARemoteTaskResult).output === "string"
          ? (result as A2ARemoteTaskResult).output
          : undefined,
    error:
      typeof (result as A2ARemoteTaskResult).error === "string"
        ? (result as A2ARemoteTaskResult).error
        : undefined,
    remoteTaskId:
      typeof (result as A2ARemoteTaskResult).taskId === "string"
        ? (result as A2ARemoteTaskResult).taskId
        : typeof (result as A2ARemoteTaskResult).id === "string"
          ? (result as A2ARemoteTaskResult).id
          : undefined,
  };
}

export class RemoteAgentInvoker {
  private readonly resolveSecrets: RemoteAgentSecretResolver;

  constructor(options: RemoteAgentInvokerOptions = {}) {
    this.resolveSecrets = options.resolveSecrets ?? createRemoteAgentSecretResolver();
  }

  private async resolveHeaders(agent: ACPAgentCard): Promise<Record<string, string>> {
    const secrets = await this.resolveSecrets(agent);
    const headers = buildHeaders(secrets);
    if (!headers.Authorization && getRemoteAgentSecretRef(agent)) {
      // Fail closed: the agent was registered with credentials that cannot be read now.
      throw new Error(`Credentials for remote agent ${agent.id} are unavailable`);
    }
    return headers;
  }

  private async sendRequest<T>(
    agent: ACPAgentCard,
    method: A2AJsonRpcRequest["method"],
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!agent.endpoint) {
      throw new Error(`Remote agent ${agent.id} is missing an endpoint`);
    }
    const endpoint = validateRemoteAgentEndpoint(agent.endpoint).toString();
    const headers = await this.resolveHeaders(agent);
    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (METHOD_UNSUPPORTED_HTTP_STATUSES.has(response.status)) {
          throw new RemoteMethodNotSupportedError(method, `HTTP ${response.status}`);
        }
        throw new Error(`Remote agent responded with HTTP ${response.status}`);
      }
      const payload = (await response.json()) as
        | A2AJsonRpcSuccessResponse<T>
        | A2AJsonRpcErrorResponse;
      if (!payload || typeof payload !== "object" || payload.id !== request.id) {
        throw new Error("Remote agent response ID did not match the request");
      }
      if ("error" in payload) {
        if (METHOD_UNSUPPORTED_JSON_RPC_CODES.has(payload.error.code)) {
          throw new RemoteMethodNotSupportedError(
            method,
            payload.error.message || `JSON-RPC error ${payload.error.code}`,
          );
        }
        throw new Error(payload.error.message || "Remote agent invocation failed");
      }
      return payload.result;
    } catch (error: Any) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new Error(`Remote agent request timed out after ${REMOTE_REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async invoke(agent: ACPAgentCard, task: ACPTaskCreateParams): Promise<RemoteInvocationResult> {
    let syncResult: A2ARemoteTaskResult;
    try {
      syncResult = await this.sendRequest<A2ARemoteTaskResult>(agent, "tasks/send", {
        title: task.title,
        prompt: task.prompt,
        workspaceId: task.workspaceId,
      });
    } catch (error) {
      if (!(error instanceof RemoteMethodNotSupportedError)) throw error;
      const asyncResult = await this.sendRequest<A2ARemoteTaskResult>(agent, "tasks/create", {
        title: task.title,
        prompt: task.prompt,
        workspaceId: task.workspaceId,
      });
      return normalizeRemoteResult(asyncResult);
    }
    return normalizeRemoteResult(syncResult);
  }

  async pollStatus(agent: ACPAgentCard, remoteTaskId: string): Promise<RemoteInvocationResult> {
    const result = await this.sendRequest<A2ARemoteTaskResult>(agent, "tasks/get", {
      taskId: remoteTaskId,
    });
    return normalizeRemoteResult(result);
  }

  async cancel(agent: ACPAgentCard, remoteTaskId: string): Promise<RemoteInvocationResult> {
    const result = await this.sendRequest<A2ARemoteTaskResult>(agent, "tasks/cancel", {
      taskId: remoteTaskId,
    });
    return normalizeRemoteResult(result);
  }
}
