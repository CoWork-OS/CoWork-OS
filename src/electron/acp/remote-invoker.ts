import { randomUUID } from "crypto";
import { lookup } from "node:dns/promises";
import net from "net";
import { Agent } from "undici";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { assertNetworkPolicyAllowed } from "../security/network-policy";
import type {
  ACPAgentCard,
  ACPTaskCreateParams,
  A2AV1Message,
  A2AV1TaskResult,
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
const REMOTE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const REMOTE_CREDENTIAL_CATEGORY = "acp" as const;

interface ACPRemoteCredentialSettings {
  credentials?: Record<string, string>;
  [key: string]: unknown;
}

class RemoteAgentRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "RemoteAgentRpcError";
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isPrivateIpAddress(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (net.isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  if (net.isIP(normalized) === 6) {
    if (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized)
    ) {
      return true;
    }
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIpAddress(mapped[1]) : false;
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

  if (parsed.username || parsed.password) {
    throw new Error("Remote agent endpoint cannot contain credentials");
  }

  if (isPrivateIpAddress(parsed.hostname) && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("Remote agent endpoint cannot target private or link-local IP ranges");
  }

  return parsed;
}

async function resolvePinnedEndpoint(
  parsed: URL,
): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = normalizeHostname(parsed.hostname);
  if (isLoopbackHostname(hostname)) {
    return { address: hostname === "::1" ? "::1" : "127.0.0.1", family: hostname === "::1" ? 6 : 4 };
  }
  const directFamily = net.isIP(hostname);
  if (directFamily) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error("Remote agent endpoint cannot target private or link-local IP ranges");
    }
    return { address: hostname, family: directFamily as 4 | 6 };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Remote agent endpoint hostname could not be resolved: ${hostname}`);
  }
  if (!addresses.length) {
    throw new Error(`Remote agent endpoint hostname returned no addresses: ${parsed.hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateIpAddress(address) || isLoopbackHostname(address)) {
      throw new Error("Remote agent endpoint resolved to a private or link-local IP range");
    }
  }
  const pinned = addresses[0];
  return { address: pinned.address, family: pinned.family as 4 | 6 };
}

export type RemoteCredentialResolver = (
  credentialRef: string,
) => string | undefined | Promise<string | undefined>;

function resolveCredentialFromSecureSettings(credentialRef: string): string | undefined {
  if (!SecureSettingsRepository.isInitialized()) return undefined;
  const settings = SecureSettingsRepository.getInstance().load<ACPRemoteCredentialSettings>(
    REMOTE_CREDENTIAL_CATEGORY,
  );
  return settings?.credentials?.[credentialRef];
}

export function saveRemoteAgentCredential(credentialRef: string, token: string): void {
  const ref = credentialRef.trim();
  const value = token.trim();
  if (!ref || ref.length > 256) throw new Error("Remote credential reference is invalid");
  if (!value || value.length > 16_384) throw new Error("Remote credential value is invalid");
  if (!SecureSettingsRepository.isInitialized()) {
    throw new Error("Secure settings are not initialized");
  }
  const repository = SecureSettingsRepository.getInstance();
  const loaded = repository.loadWithStatus<ACPRemoteCredentialSettings>(
    REMOTE_CREDENTIAL_CATEGORY,
  );
  if (loaded.status !== "success" && loaded.status !== "not_found") {
    throw new Error(`Remote credential store is unavailable: ${loaded.status}`);
  }
  const current = loaded.data || {};
  repository.save(REMOTE_CREDENTIAL_CATEGORY, {
    ...current,
    credentials: { ...current.credentials, [ref]: value },
  });
}

export function deleteRemoteAgentCredential(credentialRef: string): boolean {
  const ref = credentialRef.trim();
  if (!ref || !SecureSettingsRepository.isInitialized()) return false;
  const repository = SecureSettingsRepository.getInstance();
  const loaded = repository.loadWithStatus<ACPRemoteCredentialSettings>(
    REMOTE_CREDENTIAL_CATEGORY,
  );
  if (loaded.status !== "success" && loaded.status !== "not_found") {
    throw new Error(`Remote credential store is unavailable: ${loaded.status}`);
  }
  const current = loaded.data;
  if (!current?.credentials?.[ref]) return false;
  const credentials = { ...current.credentials };
  delete credentials[ref];
  repository.save(REMOTE_CREDENTIAL_CATEGORY, { ...current, credentials });
  return true;
}

async function buildHeaders(
  agent: ACPAgentCard,
  resolveCredential?: RemoteCredentialResolver,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const metadata = (agent.metadata || {}) as Record<string, unknown>;
  if (typeof metadata.authorizationHeader === "string" || typeof metadata.bearerToken === "string") {
    throw new Error(
      "Remote agent credentials must use metadata.credentialRef; inline authorization values are refused",
    );
  }
  const credentialRef = metadata.credentialRef;
  if (typeof credentialRef === "string" && credentialRef.trim()) {
    if (!resolveCredential) {
      throw new Error(`No secure credential resolver is configured for ${credentialRef}`);
    }
    const token = await resolveCredential(credentialRef.trim());
    if (!token?.trim()) throw new Error(`Remote credential is unavailable: ${credentialRef}`);
    headers.Authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  }
  return headers;
}

function extractA2AText(parts: A2AV1Message["parts"] | undefined): string | undefined {
  const chunks = (parts || [])
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean);
  return chunks.length ? chunks.join("\n") : undefined;
}

function normalizeA2AV1Result(result: A2AV1TaskResult): RemoteInvocationResult {
  if (!result.status && !result.artifacts && result.messageId && result.parts) {
    return {
      status: "completed",
      result: extractA2AText(result.parts),
      remoteTaskId: result.taskId,
    };
  }
  const state = String(result.status?.state || "SUBMITTED")
    .toUpperCase()
    .replace(/^TASK_STATE_/, "");
  const artifactText = result.artifacts
    ?.map((artifact) => extractA2AText(artifact.parts))
    .filter(Boolean)
    .join("\n");
  const messageText = extractA2AText(result.status?.message?.parts || result.message?.parts);
  const status: RemoteInvocationResult["status"] =
    state === "COMPLETED"
      ? "completed"
      : state === "FAILED" || state === "REJECTED"
        ? "failed"
        : state === "CANCELED" || state === "CANCELLED"
          ? "cancelled"
          : state === "WORKING" || state === "RUNNING"
            ? "running"
            : "pending";
  return {
    status,
    result: artifactText || messageText,
    error: status === "failed" ? messageText || `Remote agent returned ${state}` : undefined,
    remoteTaskId: result.id || result.taskId,
  };
}

function normalizeRemoteResult(result: A2ARemoteTaskResult | Record<string, unknown>): RemoteInvocationResult {
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
    error: typeof (result as A2ARemoteTaskResult).error === "string" ? (result as A2ARemoteTaskResult).error : undefined,
    remoteTaskId:
      typeof (result as A2ARemoteTaskResult).taskId === "string"
        ? (result as A2ARemoteTaskResult).taskId
        : typeof (result as A2ARemoteTaskResult).id === "string"
          ? (result as A2ARemoteTaskResult).id
          : undefined,
  };
}

export class RemoteAgentInvoker {
  constructor(
    private readonly resolveCredential: RemoteCredentialResolver = resolveCredentialFromSecureSettings,
  ) {}

  private async sendRequest<T>(agent: ACPAgentCard, method: A2AJsonRpcRequest["method"], params: Record<string, unknown>): Promise<T> {
    if (!agent.endpoint) {
      throw new Error(`Remote agent ${agent.id} is missing an endpoint`);
    }
    const parsedEndpoint = validateRemoteAgentEndpoint(agent.endpoint);
    assertNetworkPolicyAllowed({
      url: parsedEndpoint.toString(),
      toolName: "acp_remote_agent",
    });
    const pinned = await resolvePinnedEndpoint(parsedEndpoint);
    const endpoint = parsedEndpoint.toString();
    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_REQUEST_TIMEOUT_MS);
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _options, callback) => {
          callback(null, pinned.address, pinned.family);
        },
      },
    });
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: await buildHeaders(agent, this.resolveCredential),
        body: JSON.stringify(request),
        signal: controller.signal,
        redirect: "manual",
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`Remote agent redirects are not allowed (HTTP ${response.status})`);
      }
      if (!response.ok) {
        throw new Error(`Remote agent responded with HTTP ${response.status}`);
      }
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > REMOTE_RESPONSE_MAX_BYTES) {
        throw new Error("Remote agent response exceeds the 4 MiB limit");
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > REMOTE_RESPONSE_MAX_BYTES) {
        throw new Error("Remote agent response exceeds the 4 MiB limit");
      }
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as
        | A2AJsonRpcSuccessResponse<T>
        | A2AJsonRpcErrorResponse;
      if ("error" in payload) {
        throw new RemoteAgentRpcError(
          payload.error.message || "Remote agent invocation failed",
          payload.error.code,
        );
      }
      return payload.result;
    } catch (error: Any) {
      if (error?.name === "AbortError") {
        throw new Error(`Remote agent request timed out after ${REMOTE_REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      await dispatcher.close();
    }
  }

  async invoke(agent: ACPAgentCard, task: ACPTaskCreateParams): Promise<RemoteInvocationResult> {
    if (agent.protocol === "a2a-v1") {
      const result = await this.sendRequest<A2AV1TaskResult>(agent, "message/send", {
        message: {
          role: "ROLE_USER",
          parts: [{ text: task.prompt, mediaType: "text/plain" }],
          messageId: randomUUID().replaceAll("-", ""),
        },
      });
      return normalizeA2AV1Result(result);
    }
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
    } catch (error) {
      if (!(error instanceof RemoteAgentRpcError) || error.code !== -32601) {
        throw error;
      }
      // Some legacy agents only support the async create/get flow.
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
    if (agent.protocol === "a2a-v1") {
      const result = await this.sendRequest<A2AV1TaskResult>(agent, "tasks/get", {
        id: remoteTaskId,
      });
      return normalizeA2AV1Result(result);
    }
    const result = await this.sendRequest<A2ARemoteTaskResult>(agent, "tasks/get", {
      taskId: remoteTaskId,
    });
    return normalizeRemoteResult(result);
  }

  async cancel(agent: ACPAgentCard, remoteTaskId: string): Promise<RemoteInvocationResult> {
    if (agent.protocol === "a2a-v1") {
      const result = await this.sendRequest<A2AV1TaskResult>(agent, "tasks/cancel", {
        id: remoteTaskId,
      });
      return normalizeA2AV1Result(result);
    }
    const result = await this.sendRequest<A2ARemoteTaskResult>(agent, "tasks/cancel", {
      taskId: remoteTaskId,
    });
    return normalizeRemoteResult(result);
  }
}
