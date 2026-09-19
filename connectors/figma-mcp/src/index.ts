import * as readline from "readline";

// ==================== MCP Types ====================

type JSONRPCId = string | number;

type JSONRPCRequest = {
  jsonrpc: "2.0";
  id: JSONRPCId;
  method: string;
  params?: Record<string, any>;
};

type JSONRPCNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, any>;
};

type JSONRPCResponse = {
  jsonrpc: "2.0";
  id: JSONRPCId;
  result?: any;
  error?: { code: number; message: string; data?: any };
};

type MCPToolProperty = {
  type: string;
  description?: string;
  enum?: string[];
  default?: any;
  items?: MCPToolProperty;
  properties?: Record<string, MCPToolProperty>;
  required?: string[];
};

type MCPTool = {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, MCPToolProperty>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

type MCPServerInfo = {
  name: string;
  version: string;
  protocolVersion?: string;
  capabilities?: {
    tools?: { listChanged?: boolean };
  };
};

const PROTOCOL_VERSION = "2024-11-05";

const MCP_METHODS = {
  INITIALIZE: "initialize",
  INITIALIZED: "notifications/initialized",
  SHUTDOWN: "shutdown",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
} as const;

const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
} as const;

// ==================== Figma Client ====================

const FIGMA_BASE_URL = "https://api.figma.com/v1";

class FigmaClient {
  constructor(private token: string | undefined) {}

  private getAuthHeader(): string {
    if (!this.token?.trim()) {
      throw new Error("FIGMA_ACCESS_TOKEN is required");
    }
    return this.token.trim();
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, FIGMA_BASE_URL);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Figma-Token": this.getAuthHeader(),
        Accept: "application/json",
        "User-Agent": "CoWork-Figma-Connector/0.1.0",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Figma API error (${res.status})`);
    }

    return res.json() as Promise<T>;
  }

  async health(): Promise<{ ok: boolean; data: any }> {
    // Use /v1/me to verify token
    const me = await this.request<{ handle: string; id: string }>("/me");
    return {
      ok: true,
      data: {
        status: "ok",
        user: me.handle || me.id,
        connector: "figma",
      },
    };
  }

  async getFile(fileKey: string, ids?: string, depth?: number): Promise<any> {
    const params: Record<string, string> = {};
    if (ids) params.ids = ids;
    if (depth != null) params.depth = String(depth);
    const file = await this.request<any>(`/files/${fileKey}`, params);
    return {
      ok: true,
      data: file,
      meta: { connector: "figma" },
    };
  }

  async getFileNodes(fileKey: string, ids: string): Promise<any> {
    if (!ids?.trim()) {
      throw new Error("ids is required (comma-separated node ids)");
    }
    const file = await this.request<any>(`/files/${fileKey}`, { ids: ids.trim() });
    return {
      ok: true,
      data: file,
      meta: { connector: "figma" },
    };
  }

  async getFileComponents(fileKey: string): Promise<any> {
    const file = await this.request<any>(`/files/${fileKey}/components`);
    return {
      ok: true,
      data: file,
      meta: { connector: "figma" },
    };
  }

  async getFileStyles(fileKey: string): Promise<any> {
    const file = await this.request<any>(`/files/${fileKey}/styles`);
    return {
      ok: true,
      data: file,
      meta: { connector: "figma" },
    };
  }
}

// ==================== MCP Stdio Server ====================

type ToolProvider = {
  getTools(): MCPTool[];
  executeTool(name: string, args: Record<string, any>): Promise<any>;
};

class StdioMCPServer {
  private initialized = false;
  private rl: readline.Interface | null = null;

  constructor(
    private toolProvider: ToolProvider,
    private serverInfo: MCPServerInfo,
  ) {}

  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.on("line", (line) => this.handleLine(line));
    this.rl.on("close", () => this.stop());

    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    process.exit(0);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const message = JSON.parse(trimmed);
      this.handleMessage(message);
    } catch {
      this.sendError(0, MCP_ERROR_CODES.PARSE_ERROR, "Parse error");
    }
  }

  private async handleMessage(message: any): Promise<void> {
    if ("id" in message && message.id !== null) {
      await this.handleRequest(message as JSONRPCRequest);
      return;
    }

    if ("method" in message) {
      await this.handleNotification(message as JSONRPCNotification);
    }
  }

  private async handleRequest(request: JSONRPCRequest): Promise<void> {
    const { id, method, params } = request;

    try {
      let result: any;

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
        case MCP_METHODS.SHUTDOWN:
          result = this.handleShutdown();
          break;
        default:
          throw this.createError(MCP_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
      }

      this.sendResult(id, result);
    } catch (error: any) {
      if (error.code !== undefined) {
        this.sendError(id, error.code, error.message, error.data);
      } else {
        this.sendError(id, MCP_ERROR_CODES.INTERNAL_ERROR, error?.message || "Internal error");
      }
    }
  }

  private async handleNotification(notification: JSONRPCNotification): Promise<void> {
    if (notification.method === MCP_METHODS.INITIALIZED) {
      this.initialized = true;
    }
  }

  private handleInitialize(_params: any): any {
    if (this.initialized) {
      throw this.createError(MCP_ERROR_CODES.INVALID_REQUEST, "Already initialized");
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: this.serverInfo.capabilities,
      serverInfo: this.serverInfo,
    };
  }

  private handleToolsList(): { tools: MCPTool[] } {
    return { tools: this.toolProvider.getTools() };
  }

  private async handleToolsCall(params: any): Promise<any> {
    const { name, arguments: args } = params || {};
    if (!name) {
      throw this.createError(MCP_ERROR_CODES.INVALID_PARAMS, "Tool name is required");
    }

    try {
      const result = await this.toolProvider.executeTool(name, args || {});

      if (typeof result === "string") {
        return { content: [{ type: "text", text: result }] };
      }

      if (result && typeof result === "object") {
        if (result.content && Array.isArray(result.content)) {
          return result;
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      return { content: [{ type: "text", text: String(result) }] };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error?.message || "Tool failed"}` }],
        isError: true,
      };
    }
  }

  private handleShutdown(): Record<string, never> {
    setImmediate(() => this.stop());
    return {};
  }

  private sendResult(id: JSONRPCId, result: any): void {
    this.sendMessage({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: JSONRPCId, code: number, message: string, data?: any): void {
    this.sendMessage({ jsonrpc: "2.0", id, error: { code, message, data } });
  }

  private sendMessage(message: any): void {
    process.stdout.write(JSON.stringify(message) + "\n");
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw this.createError(MCP_ERROR_CODES.SERVER_NOT_INITIALIZED, "Server not initialized");
    }
  }

  private createError(
    code: number,
    message: string,
    data?: any,
  ): { code: number; message: string; data?: any } {
    return { code, message, data };
  }
}

// ==================== Tool Definitions ====================

const CONNECTOR_PREFIX = "figma";

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: "Check connector health and authentication status",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_file`,
    description: "Get a Figma file by key",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string", description: "Figma file key (from URL)" },
        ids: { type: "string", description: "Comma-separated node IDs to fetch" },
        depth: { type: "number", description: "Depth of node tree to return" },
      },
      required: ["fileKey"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_file_nodes`,
    description: "Get specific nodes from a Figma file",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string", description: "Figma file key" },
        ids: { type: "string", description: "Comma-separated node IDs" },
      },
      required: ["fileKey", "ids"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_file_components`,
    description: "Get components from a Figma file",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string", description: "Figma file key" },
      },
      required: ["fileKey"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_file_styles`,
    description: "Get styles from a Figma file",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string", description: "Figma file key" },
      },
      required: ["fileKey"],
      additionalProperties: false,
    },
  },
];

const client = new FigmaClient(process.env.FIGMA_ACCESS_TOKEN);

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => client.health(),
  [`${CONNECTOR_PREFIX}.get_file`]: async (args) =>
    client.getFile(args.fileKey, args.ids, args.depth),
  [`${CONNECTOR_PREFIX}.get_file_nodes`]: async (args) =>
    client.getFileNodes(args.fileKey, args.ids),
  [`${CONNECTOR_PREFIX}.get_file_components`]: async (args) =>
    client.getFileComponents(args.fileKey),
  [`${CONNECTOR_PREFIX}.get_file_styles`]: async (args) => client.getFileStyles(args.fileKey),
};

const toolProvider: ToolProvider = {
  getTools: () => tools,
  executeTool: async (name, args) => {
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return handler(args);
  },
};

const serverInfo: MCPServerInfo = {
  name: "Figma Connector",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

const server = new StdioMCPServer(toolProvider, serverInfo);
server.start();
