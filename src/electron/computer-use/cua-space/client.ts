/**
 * Minimal MCP client for the Cua Driver tool registry served by cua-spacesd at `/mcp`.
 *
 * This reuses CoWork's Streamable HTTP transport but deliberately bypasses
 * MCPClientManager: these tools are an internal Computer Use backend, not
 * connector tools that should be exposed to the agent directly.
 */

import { StreamableHttpTransport } from "../../mcp/client/transports/StreamableHttpTransport";
import { MCP_METHODS, type MCPServerConfig, type MCPTransport } from "../../mcp/types";
import type { CuaSpaceConnectionResult } from "../../../shared/cua-space";
import type { CuaSpaceEndpoint } from "./settings";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "CoWork-OS-cua-space", version: "1.0.0" };
const REQUEST_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 5_000;

export interface CuaToolContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface CuaToolResult {
  content: CuaToolContentBlock[];
  structuredContent?: Record<string, unknown>;
}

export class CuaToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`Cua Space ${tool} failed: ${message}`);
    this.name = "CuaToolError";
  }
}

export interface CuaSpaceClientLike {
  connect(): Promise<void>;
  isConnected(): boolean;
  checkHealth(): Promise<boolean>;
  callTool(name: string, args: Record<string, unknown>): Promise<CuaToolResult>;
  disconnect(): Promise<void>;
}

export type CuaTransportFactory = (config: MCPServerConfig) => MCPTransport;

export class CuaSpaceClient implements CuaSpaceClientLike {
  private transport: MCPTransport | null = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly endpoint: CuaSpaceEndpoint,
    private readonly token: string | undefined,
    private readonly transportFactory: CuaTransportFactory = (config) =>
      new StreamableHttpTransport(config),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConnected(): boolean {
    return Boolean(this.transport?.isConnected());
  }

  async checkHealth(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      // /health is unauthenticated, so never attach the token here.
      const response = await this.fetchImpl(this.endpoint.healthUrl, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  private async open(): Promise<void> {
    const transport = this.transportFactory({
      id: "cua-space",
      name: "Cua Space",
      enabled: true,
      transport: "streamable-http",
      url: this.endpoint.mcpUrl,
      auth: this.token ? { type: "bearer", token: this.token } : { type: "none" },
      requestTimeout: REQUEST_TIMEOUT_MS,
    });
    transport.onClose(() => {
      if (this.transport === transport) this.transport = null;
    });
    transport.onError(() => undefined);
    transport.onMessage(() => undefined);
    await transport.connect();
    try {
      await transport.sendRequest(MCP_METHODS.INITIALIZE, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      await transport.send({ jsonrpc: "2.0", method: MCP_METHODS.INITIALIZED });
    } catch (error) {
      await transport.disconnect().catch(() => undefined);
      throw error;
    }
    this.transport = transport;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CuaToolResult> {
    await this.connect();
    const transport = this.transport;
    if (!transport) {
      throw new CuaToolError(name, "not connected");
    }
    const result = await transport.sendRequest(MCP_METHODS.TOOLS_CALL, { name, arguments: args });
    const content: CuaToolContentBlock[] = Array.isArray(result?.content) ? result.content : [];
    if (result?.isError) {
      const text = content
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .join(" ")
        .trim();
      throw new CuaToolError(name, text || "tool returned an error");
    }
    const structured = result?.structuredContent;
    return {
      content,
      ...(structured && typeof structured === "object" && !Array.isArray(structured)
        ? { structuredContent: structured as Record<string, unknown> }
        : {}),
    };
  }

  async disconnect(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    await transport?.disconnect().catch(() => undefined);
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The fix a person can make when the Space does not answer. */
export function cuaSpaceUnreachableMessage(origin: string): string {
  return `Cua Space at ${origin} is not reachable. Start the Space in Cua Spaces, or turn off "Run in a Cua Space" in Settings > Tools > Computer use to control this computer instead.`;
}

/**
 * Open an MCP session, turning failures into an actionable error. /health is
 * unauthenticated, so only this step catches a wrong token.
 */
export async function connectCuaSpace(client: CuaSpaceClientLike, origin: string): Promise<void> {
  if (client.isConnected()) return;
  if (!(await client.checkHealth())) {
    throw new Error(cuaSpaceUnreachableMessage(origin));
  }
  try {
    await client.connect();
  } catch (error) {
    // Only the HTTP status: the response body comes from whatever answered at this URL.
    const status = (error as { status?: unknown } | null)?.status;
    const detail = typeof status === "number" ? ` (HTTP ${status})` : "";
    throw new Error(
      `Cua Space at ${origin} refused the connection${detail}. Check the Space URL and token in Settings > Tools > Computer use.`,
    );
  }
}

/** Settings "Test connection": reachability plus an authenticated MCP initialize. */
export async function testCuaSpaceConnection(
  client: CuaSpaceClientLike,
  origin: string,
): Promise<CuaSpaceConnectionResult> {
  try {
    await connectCuaSpace(client, origin);
    return { reachable: true };
  } catch (error) {
    return { reachable: false, error: errorMessage(error) };
  } finally {
    await client.disconnect();
  }
}
