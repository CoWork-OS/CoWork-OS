import { randomUUID } from "crypto";
import { isIP } from "net";
import {
  isLoopbackAddress,
  isPrivateOrLoopbackAddress,
  normalizeHostname,
} from "../security/address-classes";
import { pinnedFetch } from "../security/pinned-fetch";
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
  hasPlaintextRemoteAgentSecrets,
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

  // URL keeps IPv6 literals bracketed ("[fd00::1]"), which a raw net.isIP check
  // reads as "not an IP" and waves through. Normalize first, and use the shared
  // address classes so IPv4-mapped and encoded literals are classified too.
  const hostname = normalizeHostname(parsed.hostname);
  // `*.localhost` names are not guaranteed to resolve locally, so plaintext http
  // stays limited to `localhost` itself and loopback literals.
  const loopback =
    hostname === "localhost" || (isIP(hostname) !== 0 && isLoopbackAddress(hostname));
  if (protocol === "http:" && !loopback) {
    throw new Error("Remote agent endpoint must use https unless it targets localhost");
  }

  // Literal addresses only. Names are checked by the network policy at dispatch
  // admission and resolved and pinned per request by pinnedFetch, both of which
  // honor the admin `allowedInternalHosts` exception for self-hosted agents.
  if (isIP(hostname) && !loopback && isPrivateOrLoopbackAddress(hostname)) {
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
    if (!headers.Authorization && hasPlaintextRemoteAgentSecrets(agent)) {
      // Fail closed: the card still holds credentials that could not be moved to secure
      // storage yet. Sending without them would call the agent unauthenticated.
      throw new Error(
        `Credentials for remote agent ${agent.id} are waiting to move to secure storage; check that secure storage is available and restart CoWork`,
      );
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
      // pinnedFetch resolves the host, refuses internal answers, and binds the
      // socket to the validated addresses, so a public name that resolves (or
      // rebinds) to a private range is refused. It also does not follow redirects;
      // a 3xx is a non-OK response below rather than a hop to an unchecked host.
      const response = await pinnedFetch(endpoint, {
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
