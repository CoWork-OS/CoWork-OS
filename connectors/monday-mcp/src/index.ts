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

// ==================== Monday.com Client ====================

const MONDAY_API_URL = "https://api.monday.com/v2";

class MondayClient {
  constructor(private token: string | undefined) {}

  private getAuthHeader(): string {
    if (!this.token?.trim()) {
      throw new Error("MONDAY_API_TOKEN is required");
    }
    return this.token.trim();
  }

  private async requestGraphQL<T>(query: string, variables?: Record<string, any>): Promise<T> {
    const res = await fetch(MONDAY_API_URL, {
      method: "POST",
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/json",
        "API-Version": "2024-01",
        "User-Agent": "CoWork-Monday-Connector/0.1.0",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Monday API error (${res.status})`);
    }

    const payload = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (payload.errors && payload.errors.length > 0) {
      const msg = payload.errors.map((e) => e.message || "GraphQL error").join("; ");
      throw new Error(msg);
    }

    return payload.data as T;
  }

  async health(): Promise<{ ok: boolean; data: any }> {
    const result = await this.requestGraphQL<{ me: { id: number; name: string } }>(
      "query { me { id name } }",
    );
    return {
      ok: true,
      data: {
        status: "ok",
        user: (result as any)?.me?.name,
        connector: "monday",
      },
    };
  }

  async listBoards(limit?: number): Promise<any> {
    const query = `query Boards($limit: Int) {
      boards(limit: $limit) {
        id
        name
        state
        board_kind
      }
    }`;
    const result = await this.requestGraphQL<any>(query, { limit: limit ?? 50 });
    return {
      ok: true,
      data: result,
      meta: { connector: "monday" },
    };
  }

  async getBoard(boardId: string | number): Promise<any> {
    const query = `query Board($id: [ID!]) {
      boards(ids: $id) {
        id
        name
        state
        board_kind
      }
    }`;
    const id = typeof boardId === "string" ? parseInt(boardId, 10) : boardId;
    const result = await this.requestGraphQL<any>(query, { id: [id] });
    return {
      ok: true,
      data: result,
      meta: { connector: "monday" },
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

const CONNECTOR_PREFIX = "monday";

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: "Check connector health and authentication status",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_boards`,
    description: "List monday.com boards",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max boards to return" },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_board`,
    description: "Get a board by ID",
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string", description: "Board ID" },
      },
      required: ["boardId"],
      additionalProperties: false,
    },
  },
];

const client = new MondayClient(process.env.MONDAY_API_TOKEN);

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => client.health(),
  [`${CONNECTOR_PREFIX}.list_boards`]: async (args) => client.listBoards(args.limit),
  [`${CONNECTOR_PREFIX}.get_board`]: async (args) => client.getBoard(args.boardId),
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
  name: "monday.com Connector",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

const server = new StdioMCPServer(toolProvider, serverInfo);
server.start();
