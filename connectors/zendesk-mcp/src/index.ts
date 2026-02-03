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

// ==================== Zendesk Client ====================

type ZendeskConfig = {
  baseUrl: string;
  accessToken?: string;
  email?: string;
  apiToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
};

type RequestMeta = {
  durationMs: number;
  vendorRequestId?: string;
  baseUrl: string;
};

type RequestResult = {
  data: any;
  meta: RequestMeta;
};

class ZendeskClient {
  constructor(private config: ZendeskConfig) {}

  async health(): Promise<RequestResult> {
    return this.requestJson('GET', 'api/v2/users/me.json');
  }

  async searchTickets(query: string): Promise<RequestResult> {
    const params = new URLSearchParams({ query });
    return this.requestJson('GET', `api/v2/search.json?${params.toString()}`);
  }

  async getTicket(ticketId: string): Promise<RequestResult> {
    return this.requestJson('GET', `api/v2/tickets/${encodeURIComponent(ticketId)}.json`);
  }

  async createTicket(payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', 'api/v2/tickets.json', payload);
  }

  async updateTicket(ticketId: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('PUT', `api/v2/tickets/${encodeURIComponent(ticketId)}.json`, payload);
  }

  private getBaseUrl(): string {
    if (!this.config.baseUrl) {
      throw new Error('ZENDESK_BASE_URL or ZENDESK_SUBDOMAIN is required');
    }
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private canRefresh(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.refreshToken);
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.config.accessToken) {
      return this.config.accessToken;
    }
    if (!this.canRefresh()) {
      throw new Error('Missing Zendesk credentials (ZENDESK_ACCESS_TOKEN or ZENDESK_EMAIL + ZENDESK_API_TOKEN)');
    }
    await this.refreshAccessToken();
    if (!this.config.accessToken) {
      throw new Error('Failed to refresh Zendesk access token');
    }
    return this.config.accessToken;
  }

  private async getAuthHeader(): Promise<string> {
    if (this.config.accessToken || this.canRefresh()) {
      const token = await this.ensureAccessToken();
      return `Bearer ${token}`;
    }
    if (this.config.email && this.config.apiToken) {
      const basic = Buffer.from(`${this.config.email}/token:${this.config.apiToken}`).toString('base64');
      return `Basic ${basic}`;
    }
    throw new Error('Missing Zendesk credentials (ZENDESK_ACCESS_TOKEN or ZENDESK_EMAIL + ZENDESK_API_TOKEN)');
  }

  private async requestJson(method: string, path: string, body?: any): Promise<RequestResult> {
    const start = Date.now();
    const url = `${this.getBaseUrl()}/${path.replace(/^\//, '')}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: await this.getAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'CoWork-Zendesk-Connector/0.1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - start;
    const vendorRequestId = res.headers.get('x-request-id') || undefined;

    if (res.status === 401 && this.canRefresh()) {
      await this.refreshAccessToken();
      return this.requestJson(method, path, body);
    }

    if (!res.ok) {
      const message = await res.text();
      throw new Error(message || `Zendesk API error (${res.status})`);
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
        baseUrl: this.config.baseUrl,
      },
    };
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.canRefresh()) {
      throw new Error('Missing Zendesk refresh credentials');
    }

    const res = await fetch(`${this.getBaseUrl()}/oauth/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zendesk OAuth refresh failed: ${text}`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error('Zendesk OAuth refresh returned no access_token');
    }

    this.config.accessToken = data.access_token;
    if (data.refresh_token) {
      this.config.refreshToken = data.refresh_token;
    }
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

const CONNECTOR_PREFIX = 'zendesk';

const baseUrl = process.env.ZENDESK_BASE_URL
  ? process.env.ZENDESK_BASE_URL
  : process.env.ZENDESK_SUBDOMAIN
    ? `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com`
    : '';

const config: ZendeskConfig = {
  baseUrl,
  accessToken: process.env.ZENDESK_ACCESS_TOKEN,
  email: process.env.ZENDESK_EMAIL,
  apiToken: process.env.ZENDESK_API_TOKEN,
  clientId: process.env.ZENDESK_CLIENT_ID,
  clientSecret: process.env.ZENDESK_CLIENT_SECRET,
  refreshToken: process.env.ZENDESK_REFRESH_TOKEN,
};

const client = new ZendeskClient(config);

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: 'Check connector health and authentication status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.search_tickets`,
    description: 'Search Zendesk tickets with a query string',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (Zendesk search syntax)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_ticket`,
    description: 'Fetch a ticket by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ticket ID' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_ticket`,
    description: 'Create a new ticket',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'object', description: 'Zendesk ticket payload (ticket object)' },
      },
      required: ['ticket'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.update_ticket`,
    description: 'Update a ticket',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ticket ID' },
        ticket: { type: 'object', description: 'Zendesk ticket payload (ticket object)' },
      },
      required: ['id', 'ticket'],
      additionalProperties: false,
    },
  },
];

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => buildEnvelope(await client.health()),
  [`${CONNECTOR_PREFIX}.search_tickets`]: async (args) => buildEnvelope(await client.searchTickets(args.query)),
  [`${CONNECTOR_PREFIX}.get_ticket`]: async (args) => buildEnvelope(await client.getTicket(args.id)),
  [`${CONNECTOR_PREFIX}.create_ticket`]: async (args) => buildEnvelope(await client.createTicket({ ticket: args.ticket })),
  [`${CONNECTOR_PREFIX}.update_ticket`]: async (args) => buildEnvelope(await client.updateTicket(args.id, { ticket: args.ticket })),
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
  name: 'Zendesk Connector',
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
      baseUrl: result.meta.baseUrl,
    },
    warnings: [],
  };
}
