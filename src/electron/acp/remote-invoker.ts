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

export interface RemoteInvocationResult {
  status: "completed" | "failed" | "pending" | "running" | "cancelled";
  result?: string;
  error?: string;
  remoteTaskId?: string;
}

const REMOTE_REQUEST_TIMEOUT_MS = 15_000;

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

function buildHeaders(agent: ACPAgentCard): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const metadata = (agent.metadata || {}) as Record<string, unknown>;
  const explicitHeader = metadata.authorizationHeader;
  const bearerToken = metadata.bearerToken;
  if (typeof explicitHeader === "string" && explicitHeader.trim()) {
    headers.Authorization = explicitHeader.trim();
  } else if (typeof bearerToken === "string" && bearerToken.trim()) {
    headers.Authorization = `Bearer ${bearerToken.trim()}`;
  }
  return headers;
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
  private async sendRequest<T>(
    agent: ACPAgentCard,
    method: A2AJsonRpcRequest["method"],
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!agent.endpoint) {
      throw new Error(`Remote agent ${agent.id} is missing an endpoint`);
    }
    const endpoint = validateRemoteAgentEndpoint(agent.endpoint).toString();
    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: buildHeaders(agent),
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error: Any) {
      if (error?.name === "AbortError") {
        throw new Error(`Remote agent request timed out after ${REMOTE_REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`Remote agent responded with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as
      | A2AJsonRpcSuccessResponse<T>
      | A2AJsonRpcErrorResponse;
    if ("error" in payload) {
      throw new Error(payload.error.message || "Remote agent invocation failed");
    }
    return payload.result;
  }

  async invoke(agent: ACPAgentCard, task: ACPTaskCreateParams): Promise<RemoteInvocationResult> {
    try {
      const syncResult = await this.sendRequest<A2ARemoteTaskResult>(agent, "tasks/send", {
        title: task.title,
        prompt: task.prompt,
        workspaceId: task.workspaceId,
      });
      const normalized = normalizeRemoteResult(syncResult);
      if (normalized.status !== "pending") {
        return normalized;
      }
    } catch {
      // Some agents only support the async create/get flow.
    }

    const asyncResult = await this.sendRequest<A2ARemoteTaskResult>(agent, "tasks/create", {
      title: task.title,
      prompt: task.prompt,
      workspaceId: task.workspaceId,
    });
    const normalized = normalizeRemoteResult(asyncResult);
    return {
      ...normalized,
      status: normalized.status === "completed" ? "completed" : "running",
    };
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
