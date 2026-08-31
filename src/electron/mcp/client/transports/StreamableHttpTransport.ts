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
  MCPServerConfig,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
} from "../../types";
import { MCPSettingsManager } from "../../settings";
import { BoxSettingsManager } from "../../../settings/box-manager";
import { BOX_TOKEN_URL, getBoxAccessToken } from "../../../utils/box-api";

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
  return new Error(`MCP Streamable HTTP error ${status}${suffix}`);
}

export class StreamableHttpTransport extends EventEmitter implements MCPTransport {
  private config: MCPServerConfig;
  private connected = false;
  private requestId = 0;
  private sessionId: string | null = null;
  private protocolVersion = DEFAULT_PROTOCOL_VERSION;
  private lastInitializeRequest: JSONRPCRequest | null = null;
  private messageHandler: ((message: StreamableMessage) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private activeAbortControllers = new Set<AbortController>();
  private refreshPromise: Promise<void> | null = null;

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;
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

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    const sessionId = this.sessionId;

    for (const controller of this.activeAbortControllers) {
      controller.abort();
    }
    this.activeAbortControllers.clear();

    if (sessionId && this.config.url) {
      try {
        await this.ensureFreshToken();
        const headers = this.buildHeaders();
        headers[SESSION_HEADER] = sessionId;
        await this.fetchWithTimeout(this.config.url, {
          method: "DELETE",
          headers,
        });
      } catch {
        // Session termination is best-effort. The server may not support DELETE.
      }
    }

    this.connected = false;
    this.sessionId = null;
    this.lastInitializeRequest = null;
    this.protocolVersion = DEFAULT_PROTOCOL_VERSION;
  }

  async sendRequest(method: string, params?: Record<string, Any>): Promise<Any> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    const request: JSONRPCRequest = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      ...(params === undefined ? {} : { params }),
    };

    if (method === "initialize") {
      this.lastInitializeRequest = request;
    }

    return (await this.postMessage(request, true)) as Any;
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
  ): Promise<Any | undefined> {
    if (!this.config.url) {
      throw new Error("No URL configured for Streamable HTTP transport");
    }

    await this.ensureFreshToken();
    const response = await this.fetchWithTimeout(this.config.url, {
      method: "POST",
      headers: this.buildHeaders(message),
      body: JSON.stringify(message),
    });

    const returnedSessionId = response.headers.get(SESSION_HEADER);
    if (returnedSessionId) {
      this.sessionId = returnedSessionId;
    }

    if (
      response.status === 404 &&
      this.sessionId &&
      message.method !== "initialize" &&
      allowSessionRecovery &&
      this.lastInitializeRequest
    ) {
      await response.text().catch(() => undefined);
      this.sessionId = null;
      const initializeRequest: JSONRPCRequest = {
        ...this.lastInitializeRequest,
        id: ++this.requestId,
      };
      this.lastInitializeRequest = initializeRequest;
      await this.postMessage(initializeRequest, true, false);
      return this.postMessage(message, expectsResponse, false);
    }

    const body = await response.text();
    if (!response.ok) {
      throw formatHttpError(response.status, response.statusText, body);
    }

    if (!body.trim()) {
      if (expectsResponse) {
        throw new Error(`MCP server accepted ${message.method} without returning a response`);
      }
      return undefined;
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const messages = parseResponseBody(body, contentType);
    const requestId = "id" in message ? message.id : undefined;
    let matchedResponse = false;

    for (const incoming of messages) {
      if (isResponse(incoming) && requestId !== undefined && incoming.id === requestId) {
        matchedResponse = true;
        this.rememberNegotiatedProtocol(message, incoming);
        if (incoming.error) {
          throw new Error(incoming.error.message || `MCP method failed: ${message.method}`);
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
        throw new Error(errorMessage.error.message || `MCP method failed: ${message.method}`);
      }
      return undefined;
    }

    throw new Error(
      `MCP response for ${message.method} did not include request id ${requestId ?? "unknown"}`,
    );
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

  private async ensureFreshToken(): Promise<void> {
    if (this.config.registryId === "box") {
      const boxSettings = BoxSettingsManager.loadSettings();
      if (boxSettings.accessToken || boxSettings.refreshToken) {
        const accessToken = await getBoxAccessToken(boxSettings);
        const previousAuth = this.config.auth;
        const nextAuth = {
          ...(this.config.auth || {}),
          type: "bearer" as const,
          token: accessToken,
          refreshToken: boxSettings.refreshToken,
          clientId: boxSettings.clientId,
          clientSecret: boxSettings.clientSecret,
          tokenUrl: boxSettings.refreshToken ? BOX_TOKEN_URL : undefined,
          expiresAt: boxSettings.tokenExpiresAt,
        };
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

    const auth = this.config.auth;
    if (!auth?.refreshToken || !auth.clientId || !auth.clientSecret || !auth.tokenUrl) {
      return;
    }

    const refreshBefore = 60_000;
    if (auth.token && (!auth.expiresAt || auth.expiresAt > Date.now() + refreshBefore)) {
      return;
    }

    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = (async () => {
      const response = await this.fetchWithTimeout(auth.tokenUrl!, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: auth.clientId!,
          client_secret: auth.clientSecret!,
          refresh_token: auth.refreshToken!,
        }).toString(),
      });
      const body = await response.text();
      if (!response.ok) {
        throw formatHttpError(response.status, response.statusText, body);
      }

      let tokenData: Any;
      try {
        tokenData = JSON.parse(body);
      } catch {
        throw new Error("MCP OAuth token refresh returned invalid JSON");
      }

      if (!tokenData?.access_token) {
        throw new Error("MCP OAuth token refresh did not return an access_token");
      }

      const nextAuth = {
        ...auth,
        token: tokenData.access_token,
        refreshToken: tokenData.refresh_token || auth.refreshToken,
        expiresAt:
          typeof tokenData.expires_in === "number"
            ? Date.now() + tokenData.expires_in * 1000
            : undefined,
      };
      this.config.auth = nextAuth;

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
  ): Promise<Response> {
    const controller = new AbortController();
    this.activeAbortControllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeout || this.config.connectionTimeout || 60000,
    );

    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error: Any) {
      if (error?.name === "AbortError") {
        throw new Error(`Request timeout for MCP method: ${init.method}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeAbortControllers.delete(controller);
    }
  }
}
