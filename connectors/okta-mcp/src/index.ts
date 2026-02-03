import * as readline from 'readline';

// ==================== MCP Types ====================

type JSONRPCId = string | number;

type JSONRPCRequest = {
  jsonrpc: '2.0';
  id: JSONRPCId;
  method: string;
  params?: Record<string, any>;
};

type JSONRPCNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, any>;
};

type JSONRPCResponse = {
  jsonrpc: '2.0';
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
    type: 'object';
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

const PROTOCOL_VERSION = '2024-11-05';

const MCP_METHODS = {
  INITIALIZE: 'initialize',
  INITIALIZED: 'notifications/initialized',
  SHUTDOWN: 'shutdown',
  TOOLS_LIST: 'tools/list',
  TOOLS_CALL: 'tools/call',
} as const;

const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
} as const;

// ==================== Okta Client ====================

type OktaConfig = {
  baseUrl?: string;
  apiToken?: string;
};

type RateLimitInfo = {
  limit?: number;
  remaining?: number;
  resetAt?: string;
};

type RequestMeta = {
  durationMs: number;
  rateLimit?: RateLimitInfo;
  vendorRequestId?: string;
  baseUrl?: string;
};

type RequestResult = {
  data: any;
  meta: RequestMeta;
  nextCursor?: string;
};

class OktaClient {
  constructor(private config: OktaConfig) {}

  async health(): Promise<RequestResult> {
    return this.requestJson('GET', 'users/me');
  }

  async listUsers(limit?: number, after?: string, q?: string): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (after) params.set('after', after);
    if (q) params.set('q', q);
    const query = params.toString();
    return this.requestJson('GET', `users${query ? `?${query}` : ''}`);
  }

  async getUser(userId: string): Promise<RequestResult> {
    return this.requestJson('GET', `users/${encodeURIComponent(userId)}`);
  }

  async createUser(payload: Record<string, any>, activate?: boolean): Promise<RequestResult> {
    const query = activate === undefined ? '' : `?activate=${activate ? 'true' : 'false'}`;
    return this.requestJson('POST', `users${query}`, payload);
  }

  async updateUser(userId: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', `users/${encodeURIComponent(userId)}`, payload);
  }

  private getBaseUrl(): string {
    if (!this.config.baseUrl) {
      throw new Error('OKTA_BASE_URL is required');
    }
    return `${this.config.baseUrl.replace(/\/$/, '')}/api/v1`;
  }

  private getAuthHeader(): string {
    if (!this.config.apiToken) {
      throw new Error('OKTA_API_TOKEN is required');
    }
    return `SSWS ${this.config.apiToken}`;
  }

  private extractRateLimit(headers: Headers): RateLimitInfo | undefined {
    const limit = headers.get('x-rate-limit-limit');
    const remaining = headers.get('x-rate-limit-remaining');
    const reset = headers.get('x-rate-limit-reset');

    if (!limit && !remaining && !reset) return undefined;

    const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : undefined;

    return {
      limit: limit ? Number(limit) : undefined,
      remaining: remaining ? Number(remaining) : undefined,
      resetAt,
    };
  }

  private extractNextCursor(headers: Headers): string | undefined {
    const link = headers.get('link');
    if (!link) return undefined;

    const match = link.match(/<([^>]+)>;\s*rel="next"/i);
    if (!match) return undefined;

    try {
      const url = new URL(match[1]);
      return url.searchParams.get('after') || undefined;
    } catch {
      return undefined;
    }
  }

  private async requestJson(method: string, path: string, body?: any): Promise<RequestResult> {
    const start = Date.now();
    const url = `${this.getBaseUrl()}/${path.replace(/^\//, '')}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'CoWork-Okta-Connector/0.1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - start;
    const vendorRequestId = res.headers.get('x-okta-request-id') || undefined;

    if (!res.ok) {
      const message = await res.text();
      throw new Error(message || `Okta API error (${res.status})`);
    }

    let data: any = null;
    if (res.status !== 204) {
      data = await res.json();
    }

    return {
      data,
      meta: {
        durationMs,
        vendorRequestId,
        rateLimit: this.extractRateLimit(res.headers),
        baseUrl: this.config.baseUrl,
      },
      nextCursor: this.extractNextCursor(res.headers),
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
    private serverInfo: MCPServerInfo
  ) {}

  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.on('line', (line) => this.handleLine(line));
    this.rl.on('close', () => this.stop());

    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
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
      this.sendError(0, MCP_ERROR_CODES.PARSE_ERROR, 'Parse error');
    }
  }

  private async handleMessage(message: any): Promise<void> {
    if ('id' in message && message.id !== null) {
      await this.handleRequest(message as JSONRPCRequest);
      return;
    }

    if ('method' in message) {
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
        this.sendError(id, MCP_ERROR_CODES.INTERNAL_ERROR, error?.message || 'Internal error');
      }
    }
  }

  private async handleNotification(notification: JSONRPCNotification): Promise<void> {
    const { method } = notification;

    if (method === MCP_METHODS.INITIALIZED) {
      this.initialized = true;
    }
  }

  private handleInitialize(_params: any): {
    protocolVersion: string;
    capabilities: MCPServerInfo['capabilities'];
    serverInfo: MCPServerInfo;
  } {
    if (this.initialized) {
      throw this.createError(MCP_ERROR_CODES.INVALID_REQUEST, 'Already initialized');
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
      throw this.createError(MCP_ERROR_CODES.INVALID_PARAMS, 'Tool name is required');
    }

    try {
      const result = await this.toolProvider.executeTool(name, args || {});

      if (typeof result === 'string') {
        return { content: [{ type: 'text', text: result }] };
      }

      if (result && typeof result === 'object') {
        if (result.content && Array.isArray(result.content)) {
          return result;
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      return { content: [{ type: 'text', text: String(result) }] };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Error: ${error?.message || 'Tool failed'}` }],
        isError: true,
      };
    }
  }

  private handleShutdown(): Record<string, never> {
    setImmediate(() => this.stop());
    return {};
  }

  private sendResult(id: JSONRPCId, result: any): void {
    const response: JSONRPCResponse = { jsonrpc: '2.0', id, result };
    this.sendMessage(response);
  }

  private sendError(id: JSONRPCId, code: number, message: string, data?: any): void {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
    this.sendMessage(response);
  }

  private sendMessage(message: JSONRPCResponse | JSONRPCNotification): void {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw this.createError(MCP_ERROR_CODES.SERVER_NOT_INITIALIZED, 'Server not initialized');
    }
  }

  private createError(code: number, message: string, data?: any): { code: number; message: string; data?: any } {
    return { code, message, data };
  }
}

// ==================== Tool Definitions ====================

const CONNECTOR_PREFIX = 'okta';

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: 'Check connector health and authentication status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_users`,
    description: 'List users',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max users to return' },
        after: { type: 'string', description: 'Pagination cursor' },
        q: { type: 'string', description: 'Search query' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_user`,
    description: 'Fetch a user by id',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'User id' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_user`,
    description: 'Create a user',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { type: 'object', description: 'User payload' },
        activate: { type: 'boolean', description: 'Activate user immediately' },
      },
      required: ['payload'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.update_user`,
    description: 'Update a user',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'User id' },
        payload: { type: 'object', description: 'User payload updates' },
      },
      required: ['id', 'payload'],
      additionalProperties: false,
    },
  },
];

const config: OktaConfig = {
  baseUrl: process.env.OKTA_BASE_URL,
  apiToken: process.env.OKTA_API_TOKEN,
};

const client = new OktaClient(config);

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => buildEnvelope(await client.health()),
  [`${CONNECTOR_PREFIX}.list_users`]: async (args) =>
    buildEnvelope(await client.listUsers(args.limit, args.after, args.q)),
  [`${CONNECTOR_PREFIX}.get_user`]: async (args) => buildEnvelope(await client.getUser(args.id)),
  [`${CONNECTOR_PREFIX}.create_user`]: async (args) =>
    buildEnvelope(await client.createUser(args.payload || {}, args.activate)),
  [`${CONNECTOR_PREFIX}.update_user`]: async (args) =>
    buildEnvelope(await client.updateUser(args.id, args.payload || {})),
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
  name: 'Okta Connector',
  version: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

const server = new StdioMCPServer(toolProvider, serverInfo);
server.start();

function buildEnvelope(result: RequestResult): any {
  return {
    ok: true,
    data: result.data,
    meta: {
      durationMs: result.meta.durationMs,
      vendorRequestId: result.meta.vendorRequestId,
      rateLimit: result.meta.rateLimit,
      baseUrl: result.meta.baseUrl,
    },
    nextCursor: result.nextCursor,
    warnings: [],
  };
}
