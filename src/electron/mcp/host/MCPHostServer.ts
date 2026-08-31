/**
 * MCPHostServer - Exposes CoWork's tools as an MCP server
 *
 * This allows external clients (like Claude Code, other AI agents, or MCP clients)
 * to connect to CoWork and use its tools via the MCP protocol over stdio.
 */

import { EventEmitter } from "events";
import { randomBytes } from "crypto";
import * as http from "http";
import * as readline from "readline";
import { createLogger } from "../../utils/logger";
import { readBearerToken, timingSafeEqualString } from "../../utils/webhook-auth";
import {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
  MCPTool,
  MCPResource,
  MCPResourceReadResult,
  MCPServerInfo,
  MCPServerCapabilities,
  MCP_METHODS,
  MCP_ERROR_CODES,
} from "../types";

const logger = createLogger("MCPHostServer");

// Protocol version we support
const PROTOCOL_VERSION = "2024-11-05";

// Server info
const SERVER_INFO: MCPServerInfo = {
  name: "CoWork-OS",
  version: "1.0.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: {
      listChanged: false,
    },
    resources: {
      subscribe: false,
      listChanged: false,
    },
  },
};

// Tool adapter interface - will be injected with ToolRegistry
export interface ToolProvider {
  getTools(): MCPTool[];
  executeTool(name: string, args: Record<string, Any>): Promise<Any>;
  getResources?(): MCPResource[];
  readResource?(uri: string): Promise<MCPResourceReadResult>;
}

export class MCPHostServer extends EventEmitter {
  private static instance: MCPHostServer | null = null;
  private running = false;
  private initialized = false;
  private toolProvider: ToolProvider | null = null;
  private rl: readline.Interface | null = null;
  private httpServer: http.Server | null = null;
  private transportMode: "stdio" | "http" | null = null;
  private httpPort: number | null = null;
  private httpAuthToken: string | null = null;

  private constructor() {
    super();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): MCPHostServer {
    if (!MCPHostServer.instance) {
      MCPHostServer.instance = new MCPHostServer();
    }
    return MCPHostServer.instance;
  }

  /**
   * Set the tool provider (typically ToolRegistry)
   */
  setToolProvider(provider: ToolProvider): void {
    this.toolProvider = provider;
  }

  /**
   * Start the MCP host server on stdio
   */
  async startStdio(): Promise<void> {
    if (this.running) {
      logger.info("Already running");
      return;
    }

    if (!this.toolProvider) {
      throw new Error("Tool provider not set");
    }

    logger.info("Starting stdio server...");

    this.running = true;
    this.initialized = false;
    this.transportMode = "stdio";
    this.httpPort = null;

    // Create readline interface for reading from stdin
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    // Listen for lines (JSON-RPC messages)
    this.rl.on("line", (line) => {
      this.handleLine(line);
    });

    this.rl.on("close", () => {
      logger.info("Stdin closed");
      this.stop();
    });

    logger.info("Listening on stdio");
    this.emit("started");
  }

  async startHttp(port: number): Promise<{ authToken: string }> {
    if (this.running) {
      logger.info("Already running");
      if (this.transportMode !== "http" || !this.httpAuthToken) {
        throw new Error("MCP host is already running on a non-HTTP transport");
      }
      return { authToken: this.httpAuthToken };
    }
    if (!this.toolProvider) {
      throw new Error("Tool provider not set");
    }

    this.running = true;
    this.initialized = true;
    this.transportMode = "http";
    this.httpAuthToken = randomBytes(32).toString("base64url");

    this.httpServer = http.createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              transport: "http",
              port: this.httpPort,
              authRequired: true,
            }),
          );
          return;
        }

        if (req.method !== "POST" || req.url !== "/mcp") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        if (!this.isAllowedHttpRequest(req)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              error: {
                code: MCP_ERROR_CODES.INTERNAL_ERROR,
                message: "Unauthorized",
              },
            }),
          );
          return;
        }

        const body = await this.readHttpBody(req);
        const message = JSON.parse(body);
        const response = await this.processMessage(message);
        if (!response) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (error: Any) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            error: {
              code: MCP_ERROR_CODES.INTERNAL_ERROR,
              message: error?.message || "Internal error",
            },
          }),
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once("error", reject);
      this.httpServer?.listen(port, "127.0.0.1", () => {
        this.httpServer?.off("error", reject);
        const address = this.httpServer?.address();
        if (address && typeof address === "object") {
          this.httpPort = address.port;
        }
        resolve();
      });
    });
    this.httpPort = this.httpPort ?? port;
    logger.info(`Listening on http://127.0.0.1:${this.httpPort}/mcp`);
    this.emit("started");
    return { authToken: this.httpAuthToken };
  }

  /**
   * Stop the MCP host server
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info("Stopping...");

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = null;
    }

    this.running = false;
    this.initialized = false;
    this.transportMode = null;
    this.httpPort = null;
    this.httpAuthToken = null;
    this.emit("stopped");

    logger.info("Stopped");
  }

  /**
   * Check if the server is running
   */
  isRunning(): boolean {
    return this.running;
  }

  getTransportMode(): "stdio" | "http" | null {
    return this.transportMode;
  }

  getHttpPort(): number | null {
    return this.httpPort;
  }

  getHttpAuthToken(): string | null {
    return this.httpAuthToken;
  }

  /**
   * Check if a tool provider has been set
   */
  hasToolProvider(): boolean {
    return this.toolProvider !== null;
  }

  /**
   * Handle an incoming line (JSON-RPC message)
   */
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const message = JSON.parse(trimmed);
      void this.processMessage(message).then((response) => {
        if (response) {
          this.sendMessage(response);
        }
      });
    } catch (error) {
      logger.error("Failed to parse message:", error);
      this.sendError(null, MCP_ERROR_CODES.PARSE_ERROR, "Parse error");
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private async processMessage(message: Any): Promise<JSONRPCResponse | null> {
    // Check if it's a request (has id) or notification (no id)
    if ("id" in message && message.id !== null) {
      return this.handleRequest(message as JSONRPCRequest);
    } else if ("method" in message) {
      await this.handleNotification(message as JSONRPCNotification);
    }
    return null;
  }

  /**
   * Handle a JSON-RPC request
   */
  private async handleRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const { id, method, params } = request;

    try {
      let result: Any;

      switch (method) {
        case MCP_METHODS.INITIALIZE:
          result = this.handleInitialize(params);
          break;

        case MCP_METHODS.TOOLS_LIST:
          this.requireInitialized();
          result = this.handleToolsList();
          break;

        case MCP_METHODS.TOOLS_CALL:
          this.requireInitialized();
          result = await this.handleToolsCall(params);
          break;

        case MCP_METHODS.RESOURCES_LIST:
          this.requireInitialized();
          result = this.handleResourcesList();
          break;

        case MCP_METHODS.RESOURCES_READ:
          this.requireInitialized();
          result = await this.handleResourcesRead(params);
          break;

        case MCP_METHODS.SHUTDOWN:
          result = this.handleShutdown();
          break;

        default:
          throw this.createError(MCP_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
      }

      return this.buildResult(id, result);
    } catch (error: Any) {
      if (error.code !== undefined) {
        return this.buildError(id, error.code, error.message, error.data);
      } else {
        return this.buildError(id, MCP_ERROR_CODES.INTERNAL_ERROR, error.message);
      }
    }
  }

  /**
   * Handle a JSON-RPC notification
   */
  private async handleNotification(notification: JSONRPCNotification): Promise<void> {
    const { method } = notification;

    switch (method) {
      case MCP_METHODS.INITIALIZED:
        this.handleInitialized();
        break;

      default:
        logger.debug(`Unhandled notification: ${method}`);
    }
  }

  /**
   * Handle the initialize request
   */
  private handleInitialize(params: Any): {
    protocolVersion: string;
    capabilities: MCPServerCapabilities;
    serverInfo: MCPServerInfo;
  } {
    if (this.initialized) {
      throw this.createError(MCP_ERROR_CODES.INVALID_REQUEST, "Already initialized");
    }

    logger.info("Initialize request from client:", params?.clientInfo);

    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: SERVER_INFO.capabilities!,
      serverInfo: SERVER_INFO,
    };
  }

  /**
   * Handle the initialized notification
   */
  private handleInitialized(): void {
    logger.info("Client sent initialized notification");
    this.initialized = true;
    this.emit("initialized");
  }

  /**
   * Handle tools/list request
   */
  private handleToolsList(): { tools: MCPTool[] } {
    if (!this.toolProvider) {
      return { tools: [] };
    }

    const tools = this.toolProvider.getTools();
    logger.debug(`Listing ${tools.length} tools`);

    return { tools };
  }

  private handleResourcesList(): { resources: MCPResource[] } {
    if (!this.toolProvider?.getResources) {
      return { resources: [] };
    }
    const resources = this.toolProvider.getResources();
    logger.debug(`Listing ${resources.length} resources`);
    return { resources };
  }

  private async handleResourcesRead(params: Any): Promise<MCPResourceReadResult> {
    if (!this.toolProvider?.readResource) {
      throw this.createError(MCP_ERROR_CODES.METHOD_NOT_FOUND, "Resource provider not available");
    }
    const uri = typeof params?.uri === "string" ? params.uri.trim() : "";
    if (!uri) {
      throw this.createError(MCP_ERROR_CODES.INVALID_PARAMS, "Resource uri is required");
    }
    return this.toolProvider.readResource(uri);
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(params: Any): Promise<Any> {
    if (!this.toolProvider) {
      throw this.createError(MCP_ERROR_CODES.INTERNAL_ERROR, "Tool provider not available");
    }

    const { name, arguments: args } = params || {};

    if (!name) {
      throw this.createError(MCP_ERROR_CODES.INVALID_PARAMS, "Tool name is required");
    }

    logger.debug(`Calling tool: ${name}`);

    try {
      const result = await this.toolProvider.executeTool(name, args || {});

      // Format result as MCP content
      if (typeof result === "string") {
        return {
          content: [{ type: "text", text: result }],
        };
      } else if (result && typeof result === "object") {
        // Check if result is already in MCP format
        if (result.content && Array.isArray(result.content)) {
          return result;
        }
        // Convert to text
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } else {
        return {
          content: [{ type: "text", text: String(result) }],
        };
      }
    } catch (error: Any) {
      logger.error("Tool call failed:", error);
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }

  /**
   * Handle shutdown request
   */
  private handleShutdown(): Record<string, never> {
    logger.info("Shutdown request received");
    // Schedule stop after response is sent
    setImmediate(() => this.stop());
    return {};
  }

  /**
   * Send a successful result
   */
  private buildResult(id: string | number, result: Any): JSONRPCResponse {
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }

  /**
   * Send an error response
   */
  private buildError(
    id: string | number | null,
    code: number,
    message: string,
    data?: Any,
  ): JSONRPCResponse {
    return {
      jsonrpc: "2.0",
      id: id ?? 0,
      error: {
        code,
        message,
        data,
      },
    };
  }

  private sendResult(id: string | number, result: Any): void {
    this.sendMessage(this.buildResult(id, result));
  }

  private sendError(id: string | number | null, code: number, message: string, data?: Any): void {
    this.sendMessage(this.buildError(id, code, message, data));
  }

  /**
   * Send a message to stdout
   */
  private sendMessage(message: JSONRPCResponse | JSONRPCNotification): void {
    const json = JSON.stringify(message);
    process.stdout.write(json + "\n");
  }

  private async readHttpBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  private isAllowedHttpRequest(req: http.IncomingMessage): boolean {
    if (!this.isLoopbackHostHeader(req.headers.host)) {
      return false;
    }
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (origin && !this.isLoopbackOrigin(origin)) {
      return false;
    }
    const token = readBearerToken(req.headers.authorization);
    return Boolean(token && this.httpAuthToken && timingSafeEqualString(token, this.httpAuthToken));
  }

  private isLoopbackHostHeader(hostHeader: string | undefined): boolean {
    // Host/origin checks are defense-in-depth against DNS rebinding; the bearer
    // token is the real gate. A missing Host header is allowed (some clients
    // omit it) because the token is still required below.
    if (!hostHeader) return true;
    const host = hostHeader.trim().toLowerCase();
    return (
      host === "localhost" ||
      host.startsWith("localhost:") ||
      host === "127.0.0.1" ||
      host.startsWith("127.0.0.1:") ||
      host === "[::1]" ||
      host.startsWith("[::1]:") ||
      host === "::1"
    );
  }

  private isLoopbackOrigin(origin: string): boolean {
    try {
      return this.isLoopbackHostHeader(new URL(origin).host);
    } catch {
      return false;
    }
  }

  /**
   * Require that the server is initialized
   */
  private requireInitialized(): void {
    if (!this.initialized) {
      throw this.createError(MCP_ERROR_CODES.SERVER_NOT_INITIALIZED, "Server not initialized");
    }
  }

  /**
   * Create an error object
   */
  private createError(
    code: number,
    message: string,
    data?: Any,
  ): { code: number; message: string; data?: Any } {
    return { code, message, data };
  }
}
