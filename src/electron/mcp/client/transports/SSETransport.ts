/**
 * SSETransport - MCP transport over Server-Sent Events (SSE)
 *
 * Uses SSE (EventSource) for server-to-client messages and
 * HTTP POST requests for client-to-server messages.
 * This enables web-based MCP servers.
 */

import { EventEmitter } from "events";
import { EventSource } from "eventsource";
import {
  MCPTransport,
  MCPServerConfig,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
} from "../../types";

const MAX_REDIRECTS = 5;

/**
 * fetch for MCP SSE: credentials travel as headers, and a redirect is followed only
 * within the configured origin so they never reach another host.
 */
async function fetchWithinOrigin(
  input: string | URL,
  init: RequestInit,
  credentialHeaders: Record<string, string>,
): Promise<Response> {
  const origin = new URL(String(input)).origin;
  let url = new URL(String(input));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(credentialHeaders)) headers.set(name, value);
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return response;
    const next = new URL(location, url);
    await response.body?.cancel().catch(() => undefined);
    if (next.origin !== origin)
      throw new Error(
        `MCP SSE server redirected to another origin (${next.origin}); refusing to send credentials`,
      );
    url = next;
  }
  throw new Error("MCP SSE server redirected too many times");
}

/** The URL without its query string, for logs. */
function redactUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[redacted]" : ""}`;
}

interface PendingRequest {
  resolve: (result: Any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class SSETransport extends EventEmitter implements MCPTransport {
  private config: MCPServerConfig;
  private eventSource: EventSource | null = null;
  private messageHandler: ((message: JSONRPCResponse | JSONRPCNotification) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private connected = false;
  private requestId = 0;
  private abortController: AbortController | null = null;

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;
  }

  /**
   * Connect to the MCP server via SSE
   */
  async connect(): Promise<void> {
    if (this.connected || this.eventSource) {
      throw new Error("Already connected");
    }

    const { url } = this.config;

    if (!url) {
      throw new Error("No URL specified for SSE transport");
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cleanup();
        reject(
          new Error(
            `Connection timeout: server did not respond within ${this.config.connectionTimeout || 30000}ms`,
          ),
        );
      }, this.config.connectionTimeout || 30000);

      try {
        const sseUrl = this.buildUrl(url, "/sse", { streamRequest: true });
        console.log(`[MCP SSETransport] Connecting to: ${redactUrl(sseUrl)}`);

        // Credentials go in headers through a custom fetch, never in the URL, where
        // proxies and server access logs would record them.
        const credentialHeaders: Record<string, string> = { ...this.config.headers };
        this.addAuthHeaders(credentialHeaders);
        this.eventSource = new EventSource(sseUrl, {
          fetch: (input, init) => fetchWithinOrigin(input, init as RequestInit, credentialHeaders),
        });

        this.eventSource.onopen = () => {
          clearTimeout(timeout);
          this.connected = true;
          console.log(`[MCP SSETransport] Connected successfully`);
          resolve();
        };

        this.eventSource.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.eventSource.onerror = (error) => {
          console.error(`[MCP SSETransport] EventSource error:`, error);
          if (!this.connected) {
            clearTimeout(timeout);
            reject(new Error("Failed to connect to SSE endpoint"));
          } else {
            this.errorHandler?.(new Error("SSE connection error"));
            this.closeHandler?.(new Error("SSE connection lost"));
          }
          this.cleanup();
        };

        // Handle named events (some servers use event types)
        this.eventSource.addEventListener("message", (event) => {
          this.handleMessage(event.data);
        });

        this.eventSource.addEventListener("error", () => {
          if (this.connected) {
            this.closeHandler?.(new Error("SSE stream closed"));
            this.cleanup();
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        console.error(`[MCP SSETransport] Failed to connect:`, error);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    console.log(`[MCP SSETransport] Disconnecting...`);

    // Abort any pending requests
    this.abortController?.abort();

    // Reject all pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Transport disconnected"));
    }
    this.pendingRequests.clear();

    this.cleanup();
  }

  /**
   * Send a JSON-RPC request via HTTP POST and wait for response
   */
  async sendRequest(method: string, params?: Record<string, Any>): Promise<Any> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    const id = ++this.requestId;
    const request: JSONRPCRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for method: ${method}`));
      }, this.config.requestTimeout || 60000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      // Send via HTTP POST
      this.postMessage(request).catch((error) => {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Send a JSON-RPC message (request or notification)
   */
  async send(message: JSONRPCRequest | JSONRPCNotification): Promise<void> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    await this.postMessage(message);
  }

  /**
   * Post a message to the server via HTTP
   */
  private async postMessage(message: JSONRPCRequest | JSONRPCNotification): Promise<void> {
    const { url } = this.config;
    if (!url) {
      throw new Error("No URL configured");
    }

    const postUrl = this.buildUrl(url, "/message");
    this.abortController = new AbortController();

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...this.config.headers,
      };

      // Add auth headers
      this.addAuthHeaders(headers);

      const response = await fetchWithinOrigin(
        postUrl,
        {
          method: "POST",
          body: JSON.stringify(message),
          signal: this.abortController.signal,
        },
        headers,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Some servers return the response in the HTTP response body
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        const responseData = await response.json();
        if (responseData && typeof responseData === "object" && "id" in responseData) {
          this.handleJsonRpcResponse(responseData);
        }
      }
    } catch (error: Any) {
      if (error.name === "AbortError") {
        throw new Error("Request aborted");
      }
      throw error;
    }
  }

  /**
   * Register message handler
   */
  onMessage(handler: (message: JSONRPCResponse | JSONRPCNotification) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Register close handler
   */
  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  /**
   * Register error handler
   */
  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /**
   * Check if transport is connected
   */
  isConnected(): boolean {
    // EventSource readyState: 0=CONNECTING, 1=OPEN, 2=CLOSED
    return this.connected && this.eventSource?.readyState === 1;
  }

  /**
   * Handle incoming SSE message
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);
      this.handleJsonRpcResponse(message);
    } catch {
      console.error(`[MCP SSETransport] Failed to parse message: ${data}`);
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private handleJsonRpcResponse(message: Any): void {
    // Check if this is a response to a pending request
    if ("id" in message && message.id !== null) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timeout);

        if ("error" in message && message.error) {
          pending.reject(new Error(message.error.message || "Unknown error"));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    // Otherwise, pass to message handler (notifications)
    this.messageHandler?.(message as JSONRPCResponse | JSONRPCNotification);
  }

  /**
   * Build URL with optional path
   */
  private buildUrl(
    baseUrl: string,
    path: string,
    options: { streamRequest?: boolean } = {},
  ): string {
    const url = new URL(baseUrl);

    // Append path if base URL doesn't already have it
    if (!url.pathname.endsWith(path)) {
      url.pathname = url.pathname.replace(/\/$/, "") + path;
    }

    // Legacy servers that can only read a query token opt in explicitly; it applies to
    // the stream request alone, and the header is still sent.
    const auth = this.config.auth;
    if (options.streamRequest && auth?.sendTokenInQuery) {
      if (auth.type === "bearer" && auth.token) url.searchParams.set("token", auth.token);
      else if (auth.type === "api-key" && auth.apiKey) url.searchParams.set("api_key", auth.apiKey);
    }

    return url.toString();
  }

  /**
   * Add authentication headers
   */
  private addAuthHeaders(headers: Record<string, string>): void {
    if (!this.config.auth) return;

    switch (this.config.auth.type) {
      case "bearer":
        if (this.config.auth.token) {
          headers["Authorization"] = `Bearer ${this.config.auth.token}`;
        }
        break;
      case "api-key":
        if (this.config.auth.apiKey) {
          const headerName = this.config.auth.headerName || "X-API-Key";
          headers[headerName] = this.config.auth.apiKey;
        }
        break;
      case "basic":
        if (this.config.auth.username && this.config.auth.password) {
          const credentials = Buffer.from(
            `${this.config.auth.username}:${this.config.auth.password}`,
          ).toString("base64");
          headers["Authorization"] = `Basic ${credentials}`;
        }
        break;
    }
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.connected = false;

    // An unexpected stream error must settle callers too. Keep the error
    // generic: a request may have reached the server, so callers must treat a
    // rejected mutation as outcome-uncertain and reconcile before retrying.
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("SSE connection lost; request outcome is uncertain"));
    }
    this.pendingRequests.clear();

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.abortController = null;
  }
}
