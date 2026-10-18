import { credentialFingerprint, recordOAuthRefresh } from "../../../security/oauth-refresh-proof";
/**
 * StreamableHttpTransport - MCP Streamable HTTP transport
 *
 * The Streamable HTTP transport sends every JSON-RPC message to one MCP
 * endpoint with POST. A server may return either a JSON response or an SSE
 * stream containing the response and any intermediate notifications.
 */

import { EventEmitter } from "events";
import {
  MCPTransport,
  MCPTransportRequestOptions,
  MCPServerConfig,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
} from "../../types";
import { MCPSettingsManager } from "../../settings";
import { BoxSettingsManager } from "../../../settings/box-manager";
import { BOX_TOKEN_URL, getBoxAccessToken } from "../../../utils/box-api";
import {
  canRenewWithoutUser,
  McpAuthorizationRequiredError,
  oauthSettings,
  renewOAuthToken,
} from "../../oauth/mcp-oauth";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SESSION_HEADER = "Mcp-Session-Id";
const PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";

type StreamableMessage = JSONRPCResponse | JSONRPCNotification;
type OutgoingMessage = JSONRPCRequest | JSONRPCNotification;

function isRecord(value: Any): value is Record<string, Any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isResponse(value: Any): value is JSONRPCResponse {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "id");
}

function isNotification(value: Any): value is JSONRPCNotification {
  return isRecord(value) && typeof value.method === "string" && !isResponse(value);
}

function parseJsonBody(body: string): Any[] {
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseSseBody(body: string): Any[] {
  const messages: Any[] = [];
  const blocks = body.split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") continue;

    try {
      messages.push(JSON.parse(data));
    } catch {
      throw new Error("Invalid JSON in MCP Streamable HTTP event stream");
    }
  }

  return messages;
}

function parseResponseBody(body: string, contentType: string): Any[] {
  if (contentType.includes("text/event-stream")) {
    return parseSseBody(body);
  }

  try {
    return parseJsonBody(body);
  } catch (jsonError) {
    try {
      return parseSseBody(body);
    } catch {
      throw new Error(
        `Invalid MCP response: ${jsonError instanceof Error ? jsonError.message : "malformed body"}`,
      );
    }
  }
}

function formatHttpError(status: number, statusText: string, body: string): Error {
  const detail = body
    .replace(
      /("(?:access_token|refresh_token|client_secret|token)"\s*:\s*")[^"]+/gi,
      "$1[REDACTED]",
    )
    .trim()
    .slice(0, 500);
  const suffix = detail ? `: ${detail}` : statusText ? `: ${statusText}` : "";
  return Object.assign(new Error(`MCP Streamable HTTP error ${status}${suffix}`), { status });
}

const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 30_000;

/** Retry-After as seconds or an HTTP date; falls back to exponential backoff. */
function retryDelayMs(header: string | null, attempt: number): number {
  const seconds = header && /^\d+$/.test(header.trim()) ? Number(header) : NaN;
  const dateMs = header && Number.isNaN(seconds) ? Date.parse(header) - Date.now() : NaN;
  const fromHeader = Number.isFinite(seconds) ? seconds * 1000 : dateMs;
  const delay = Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : 1000 * 2 ** attempt;
  return Math.min(delay, MAX_RETRY_AFTER_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("MCP tool call cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("MCP tool call cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class StreamableHttpTransport extends EventEmitter implements MCPTransport {
  private config: MCPServerConfig;
  private connected = false;
  private connectionGeneration = 0;
  private requestId = 0;
  private sessionId: string | null = null;
  private protocolVersion = DEFAULT_PROTOCOL_VERSION;
  private lastInitializeRequest: JSONRPCRequest | null = null;
  private messageHandler: ((message: StreamableMessage) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private activeAbortControllers = new Set<AbortController>();
  private refreshPromise: Promise<void> | null = null;
  private readonly responseReleases = new WeakMap<Response, () => void>();

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      throw new Error("Already connected");
    }

    const { url } = this.config;
    if (!url) {
      throw new Error("No URL specified for Streamable HTTP transport");
    }

    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Streamable HTTP transport requires an http:// or https:// URL");
    }

    this.connectionGeneration++;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    const sessionId = this.sessionId;
    this.connected = false;
    this.connectionGeneration++;

    for (const controller of this.activeAbortControllers) {
      controller.abort();
    }
    this.activeAbortControllers.clear();

    if (sessionId && this.config.url) {
      try {
        await this.ensureFreshToken();
        const headers = this.buildHeaders();
        headers[SESSION_HEADER] = sessionId;
        const response = await this.fetchWithTimeout(this.config.url, {
          method: "DELETE",
          headers,
        });
        try {
          await response.text();
        } catch {
          // Best effort session termination.
        } finally {
          this.releaseResponse(response);
        }
      } catch {
        // Session termination is best-effort. The server may not support DELETE.
      }
    }

    this.connected = false;
    this.sessionId = null;
    this.lastInitializeRequest = null;
    this.protocolVersion = DEFAULT_PROTOCOL_VERSION;
  }

  async sendRequest(
    method: string,
    params?: Record<string, Any>,
    options: MCPTransportRequestOptions = {},
  ): Promise<Any> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    const request: JSONRPCRequest = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      ...(this.protocolVersion === "2026-07-28"
        ? {
            params: {
              ...params,
              _meta: {
                ...params?._meta,
                "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
                "io.modelcontextprotocol/clientInfo": { name: "CoWork-OS", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }
        : params === undefined
          ? {}
          : { params }),
    };

    if (method === "initialize") {
      this.lastInitializeRequest = request;
    }

    return (await this.postMessage(request, true, true, options)) as Any;
  }

  async send(message: JSONRPCRequest | JSONRPCNotification): Promise<void> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    await this.postMessage(message, false);
  }

  onMessage(handler: (message: JSONRPCResponse | JSONRPCNotification) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async postMessage(
    message: OutgoingMessage,
    expectsResponse: boolean,
    allowSessionRecovery = true,
    options: MCPTransportRequestOptions = {},
    retry: { auth?: boolean; rateLimit?: number } = {},
  ): Promise<Any | undefined> {
    if (!this.config.url) {
      throw new Error("No URL configured for Streamable HTTP transport");
    }

    const endpoint = this.config.url;
    const generation = this.connectionGeneration;
    if (options.signal?.aborted) throw new Error("MCP tool call cancelled");
    await this.ensureFreshToken();
    if (options.signal?.aborted) throw new Error("MCP tool call cancelled");
    await options.beforeSend?.();
    if (options.signal?.aborted) throw new Error("MCP tool call cancelled");
    if (!this.connected || generation !== this.connectionGeneration || endpoint !== this.config.url)
      throw new Error("MCP HTTP connection or endpoint changed before send");
    const response = await this.fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: this.buildHeaders(message),
        body: JSON.stringify(message),
      },
      options.signal,
    );

    if (!this.connected || generation !== this.connectionGeneration) {
      this.releaseResponse(response);
      throw new Error(
        message.method === "tools/call"
          ? "MCP_TOOL_OUTCOME_UNCONFIRMED: connection changed after submission. Inspect the outcome before retrying."
          : "MCP HTTP connection changed after submission",
      );
    }
    const returnedSessionId = response.headers.get(SESSION_HEADER);
    if (returnedSessionId) {
      this.sessionId = returnedSessionId;
    }

    if (response.status === 404 && message.method === "tools/call") {
      await response.text().catch(() => undefined);
      this.releaseResponse(response);
      throw new Error(
        "MCP_TOOL_OUTCOME_UNCONFIRMED: tool request returned 404. Inspect its outcome before retrying; no automatic replay was sent.",
      );
    }

    if (
      response.status === 404 &&
      this.sessionId &&
      message.method !== "initialize" &&
      allowSessionRecovery &&
      this.lastInitializeRequest
    ) {
      await response.text().catch(() => undefined);
      this.releaseResponse(response);
      this.sessionId = null;
      const initializeRequest: JSONRPCRequest = {
        ...this.lastInitializeRequest,
        id: ++this.requestId,
      };
      this.lastInitializeRequest = initializeRequest;
      await this.postMessage(initializeRequest, true, false, options);
      return this.postMessage(message, expectsResponse, false, options);
    }

    // 401: the server rejected the credential before running anything, so one
    // renewal and resend is safe even for tools/call.
    if (response.status === 401) {
      const challenge = response.headers.get("WWW-Authenticate");
      await response.text().catch(() => undefined);
      this.releaseResponse(response);
      if (!retry.auth && canRenewWithoutUser(this.config.auth)) {
        await this.ensureFreshToken(true);
        return this.postMessage(message, expectsResponse, allowSessionRecovery, options, {
          ...retry,
          auth: true,
        });
      }
      throw Object.assign(
        new McpAuthorizationRequiredError(
          `MCP server "${this.config.name}" needs authorization${
            challenge && /error="([^"]+)"/.exec(challenge)?.[1]
              ? ` (${/error="([^"]+)"/.exec(challenge)![1]})`
              : ""
          }: sign in from Settings > MCP Servers`,
        ),
        { status: 401 },
      );
    }

    // 429 is a rejection before execution. 503 may follow partial work, so a
    // tool call is not resent; other methods back off and retry.
    const rateLimited =
      response.status === 429 || (response.status === 503 && message.method !== "tools/call");
    if (rateLimited && (retry.rateLimit ?? 0) < MAX_RATE_LIMIT_RETRIES) {
      const attempt = retry.rateLimit ?? 0;
      const delay = retryDelayMs(response.headers.get("Retry-After"), attempt);
      await response.text().catch(() => undefined);
      this.releaseResponse(response);
      await sleep(delay, options.signal);
      return this.postMessage(message, expectsResponse, allowSessionRecovery, options, {
        ...retry,
        rateLimit: attempt + 1,
      });
    }

    try {
      if (!response.ok) {
        const body = await response.text();
        throw formatHttpError(response.status, response.statusText, body);
      }
      const body = await this.readResponseBody(response, "id" in message ? message.id : undefined);

      if (!body.text.trim() && body.messages.length === 0) {
        if (expectsResponse) {
          throw new Error(`MCP server accepted ${message.method} without returning a response`);
        }
        return undefined;
      }

      const messages = body.messages.length
        ? body.messages
        : parseResponseBody(body.text, body.contentType);
      const requestId = "id" in message ? message.id : undefined;
      let matchedResponse = false;

      for (const incoming of messages) {
        if (isResponse(incoming) && requestId !== undefined && incoming.id === requestId) {
          matchedResponse = true;
          this.rememberNegotiatedProtocol(message, incoming);
          if (incoming.error) {
            throw Object.assign(
              new Error(incoming.error.message || `MCP method failed: ${message.method}`),
              { code: incoming.error.code, data: incoming.error.data },
            );
          }
          return incoming.result;
        }

        if (isNotification(incoming) || isResponse(incoming)) {
          this.messageHandler?.(incoming as StreamableMessage);
        }
      }

      if (!expectsResponse && !matchedResponse) {
        const errorMessage = messages.find((incoming) => isRecord(incoming) && incoming.error);
        if (errorMessage?.error) {
          throw Object.assign(
            new Error(errorMessage.error.message || `MCP method failed: ${message.method}`),
            { code: errorMessage.error.code, data: errorMessage.error.data },
          );
        }
        return undefined;
      }

      throw new Error(
        `MCP response for ${message.method} did not include request id ${requestId ?? "unknown"}`,
      );
    } finally {
      this.releaseResponse(response);
    }
  }

  private buildHeaders(message?: OutgoingMessage): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.config.headers,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      [PROTOCOL_VERSION_HEADER]: this.protocolVersion,
    };

    if (message) {
      headers["Mcp-Method"] = message.method;
      const params = message.params;
      const mcpName = params?.name || params?.uri || params?.taskId;
      if (typeof mcpName === "string" && mcpName.trim()) {
        headers["Mcp-Name"] = mcpName;
      }
      if (this.sessionId && message.method !== "initialize") {
        headers[SESSION_HEADER] = this.sessionId;
      }
    }

    this.addAuthHeaders(headers);
    return headers;
  }

  private addAuthHeaders(headers: Record<string, string>): void {
    const auth = this.config.auth;
    if (!auth) return;

    switch (auth.type) {
      case "bearer":
        if (auth.token) {
          headers.Authorization = `Bearer ${auth.token}`;
        }
        break;
      case "api-key":
        if (auth.apiKey) {
          headers[auth.headerName || "X-API-Key"] = auth.apiKey;
        }
        break;
      case "basic":
        if (auth.username && auth.password) {
          headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
        }
        break;
      case "none":
        break;
    }
  }

  private async ensureFreshToken(force = false): Promise<void> {
    if (this.config.registryId === "box") {
      const boxSettings = BoxSettingsManager.loadSettings();
      if (boxSettings.accessToken || boxSettings.refreshToken) {
        const previousAuth = this.config.auth ? structuredClone(this.config.auth) : undefined;
        const accessToken = await getBoxAccessToken(boxSettings);
        const nextAuth = {
          ...this.config.auth,
          type: "bearer" as const,
          token: accessToken,
          refreshToken: boxSettings.refreshToken,
          clientId: boxSettings.clientId,
          clientSecret: boxSettings.clientSecret,
          tokenUrl: boxSettings.refreshToken ? BOX_TOKEN_URL : undefined,
          expiresAt: boxSettings.tokenExpiresAt,
        };
        let currentAuth = previousAuth;
        try {
          currentAuth = MCPSettingsManager.getServer(this.config.id)?.auth ?? previousAuth;
        } catch {
          /* Unavailable settings retain the local flow. */
        }
        if (
          credentialFingerprint(currentAuth) !== credentialFingerprint(previousAuth) ||
          credentialFingerprint(this.config.auth) !== credentialFingerprint(previousAuth)
        )
          throw new Error("MCP credentials changed during Box token refresh");
        this.config.auth = nextAuth;

        const authChanged =
          previousAuth?.type !== nextAuth.type ||
          previousAuth.token !== nextAuth.token ||
          previousAuth.refreshToken !== nextAuth.refreshToken ||
          previousAuth.clientId !== nextAuth.clientId ||
          previousAuth.clientSecret !== nextAuth.clientSecret ||
          previousAuth.tokenUrl !== nextAuth.tokenUrl ||
          previousAuth.expiresAt !== nextAuth.expiresAt;
        if (authChanged) {
          try {
            MCPSettingsManager.updateServer(this.config.id, { auth: nextAuth });
          } catch {
            // The in-memory token remains usable if settings persistence is unavailable.
          }
        }
        return;
      }
    }

    const auth = this.config.auth ? structuredClone(this.config.auth) : undefined;
    if (!canRenewWithoutUser(auth)) {
      // An OAuth server with no usable token cannot be called until someone signs in.
      if (oauthSettings(auth) && !auth?.token)
        throw new McpAuthorizationRequiredError(
          `MCP server "${this.config.name}" needs authorization: sign in from Settings > MCP Servers`,
        );
      return;
    }

    const refreshBefore = 60_000;
    if (
      !force &&
      auth!.token &&
      (!auth!.expiresAt || auth!.expiresAt > Date.now() + refreshBefore)
    ) {
      return;
    }

    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = (async () => {
      // The token request carries its own timeout and manual-redirect policy.
      const nextAuth = await renewOAuthToken(auth!, (url, init) => fetch(url, init));
      // A manual credential edit during refresh must not be overwritten by its late response.
      let currentAuth = auth;
      try {
        currentAuth = MCPSettingsManager.getServer(this.config.id)?.auth ?? auth;
      } catch {
        /* Unavailable settings retain the local flow. */
      }
      if (
        credentialFingerprint(currentAuth) !== credentialFingerprint(auth) ||
        credentialFingerprint(this.config.auth) !== credentialFingerprint(auth)
      )
        throw new Error("MCP credentials changed during token refresh");
      this.config.auth = nextAuth;
      recordOAuthRefresh(auth!, nextAuth);

      try {
        MCPSettingsManager.updateServer(this.config.id, { auth: nextAuth });
      } catch {
        // The in-memory token remains usable if settings persistence is unavailable.
      }
    })().finally(() => {
      this.refreshPromise = null;
    });

    await this.refreshPromise;
  }

  private rememberNegotiatedProtocol(message: OutgoingMessage, response: JSONRPCResponse): void {
    if (message.method !== "initialize") return;

    const negotiated = response.result?.protocolVersion;
    if (typeof negotiated === "string" && negotiated.trim()) {
      this.protocolVersion = negotiated;
      return;
    }

    const requested = message.params?.protocolVersion;
    if (typeof requested === "string" && requested.trim()) {
      this.protocolVersion = requested;
    }
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit & { method: string },
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    this.activeAbortControllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeout || this.config.connectionTimeout || 60000,
    );

    let response: Response | undefined;
    try {
      if (signal?.aborted) throw new Error("MCP tool call cancelled");
      response = await fetch(input, {
        ...init,
        redirect: "manual",
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      });
      this.responseReleases.set(response, () => {
        clearTimeout(timeout);
        this.activeAbortControllers.delete(controller);
      });
      return response;
    } catch (error: Any) {
      if (signal?.aborted) throw new Error("MCP tool call cancelled");
      if (error?.name === "AbortError") {
        throw new Error(`Request timeout for MCP method: ${init.method}`);
      }
      throw error;
    } finally {
      if (!response) {
        clearTimeout(timeout);
        this.activeAbortControllers.delete(controller);
      }
    }
  }

  private releaseResponse(response: Response): void {
    const release = this.responseReleases.get(response);
    if (release) {
      this.responseReleases.delete(response);
      release();
    }
  }

  private async readResponseBody(
    response: Response,
    requestId?: string | number,
  ): Promise<{ text: string; messages: Any[]; contentType: string }> {
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/event-stream") || !response.body?.getReader) {
      return { text: await response.text(), messages: [], contentType };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const messages: Any[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          for (const parsed of parseSseBody(block)) {
            messages.push(parsed);
            // Once the matching response arrives, cancel the open stream. This
            // resolves the RPC without waiting for an SSE server to close it.
            if (requestId !== undefined && isResponse(parsed) && parsed.id === requestId) {
              await reader.cancel();
              return { text: "", messages, contentType };
            }
          }
        }
        if (done) break;
      }
      // Some fetch implementations deliver the final event in the decoder
      // buffer alongside `done`, without another separator iteration.
      messages.push(...parseSseBody(buffer));
    } finally {
      reader.releaseLock();
    }
    return { text: "", messages, contentType };
  }
}
