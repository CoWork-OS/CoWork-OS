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

// ==================== HubSpot Client ====================

type HubSpotConfig = {
  baseUrl: string;
  accessToken?: string;
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
  nextCursor?: string;
};

class HubSpotClient {
  constructor(private config: HubSpotConfig) {}

  async health(): Promise<RequestResult> {
    return this.requestJson('GET', 'account-info/v3/details');
  }

  async searchObjects(objectType: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', `crm/v3/objects/${encodeURIComponent(objectType)}/search`, payload);
  }

  async getObject(objectType: string, objectId: string, properties?: string[]): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (properties && properties.length > 0) {
      params.set('properties', properties.join(','));
    }
    const query = params.toString();
    return this.requestJson('GET', `crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}${query ? `?${query}` : ''}`);
  }

  async createObject(objectType: string, properties: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', `crm/v3/objects/${encodeURIComponent(objectType)}`, { properties });
  }

  async updateObject(objectType: string, objectId: string, properties: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('PATCH', `crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`, { properties });
  }

  private getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private getAuthHeader(): string {
    if (!this.config.accessToken) {
      throw new Error('HUBSPOT_ACCESS_TOKEN is required');
    }
    return `Bearer ${this.config.accessToken}`;
  }

  private async requestJson(method: string, path: string, body?: any): Promise<RequestResult> {
    const start = Date.now();
    const url = `${this.getBaseUrl()}/${path.replace(/^\//, '')}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: await this.ensureAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'CoWork-HubSpot-Connector/0.1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - start;
    const vendorRequestId = res.headers.get('x-hubspot-request-id') || undefined;

    if (res.status === 401 && this.canRefresh()) {
      await this.refreshAccessToken();
      return this.requestJson(method, path, body);
    }

    if (!res.ok) {
      const message = await res.text();
      throw new Error(message || `HubSpot API error (${res.status})`);
    }

    let data: any = null;
    if (res.status !== 204) {
      data = await res.json();
    }

    const nextCursor = data?.paging?.next?.after;

    return {
      data,
      meta: {
        durationMs,
        vendorRequestId,
        baseUrl: this.config.baseUrl,
      },
      nextCursor,
    };
  }

  private canRefresh(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.refreshToken);
  }

  private async ensureAuthHeader(): Promise<string> {
    if (this.config.accessToken) {
      return `Bearer ${this.config.accessToken}`;
    }
    if (!this.canRefresh()) {
      throw new Error('HUBSPOT_ACCESS_TOKEN is required');
    }
    await this.refreshAccessToken();
    if (!this.config.accessToken) {
      throw new Error('Failed to refresh HubSpot access token');
    }
    return `Bearer ${this.config.accessToken}`;
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.canRefresh()) {
      throw new Error('Missing HubSpot refresh credentials');
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId as string,
      client_secret: this.config.clientSecret as string,
      refresh_token: this.config.refreshToken as string,
    });

    const res = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HubSpot OAuth refresh failed: ${text}`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error('HubSpot OAuth refresh returned no access_token');
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

const CONNECTOR_PREFIX = 'hubspot';
const DEFAULT_BASE_URL = 'https://api.hubapi.com';

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: 'Check connector health and authentication status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.search_objects`,
    description: 'Search CRM objects with HubSpot search API',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: { type: 'string', description: 'Object type (e.g., contacts, companies, deals)' },
        filterGroups: { type: 'array', description: 'HubSpot filterGroups array', items: { type: 'object' } },
        properties: { type: 'array', description: 'Properties to return', items: { type: 'string' } },
        limit: { type: 'number', description: 'Max results' },
        after: { type: 'string', description: 'Paging cursor' },
      },
      required: ['objectType'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_object`,
    description: 'Fetch a CRM object by ID',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: { type: 'string', description: 'Object type (e.g., contacts, companies, deals)' },
        id: { type: 'string', description: 'Object ID' },
        properties: { type: 'array', description: 'Properties to return', items: { type: 'string' } },
      },
      required: ['objectType', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_object`,
    description: 'Create a CRM object',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: { type: 'string', description: 'Object type (e.g., contacts, companies, deals)' },
        properties: { type: 'object', description: 'Properties for creation' },
      },
      required: ['objectType', 'properties'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.update_object`,
    description: 'Update a CRM object',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: { type: 'string', description: 'Object type (e.g., contacts, companies, deals)' },
        id: { type: 'string', description: 'Object ID' },
        properties: { type: 'object', description: 'Properties for update' },
      },
      required: ['objectType', 'id', 'properties'],
      additionalProperties: false,
    },
  },
];

const config: HubSpotConfig = {
  baseUrl: process.env.HUBSPOT_BASE_URL || DEFAULT_BASE_URL,
  accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
  clientId: process.env.HUBSPOT_CLIENT_ID,
  clientSecret: process.env.HUBSPOT_CLIENT_SECRET,
  refreshToken: process.env.HUBSPOT_REFRESH_TOKEN,
};

const client = new HubSpotClient(config);

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => buildEnvelope(await client.health()),
  [`${CONNECTOR_PREFIX}.search_objects`]: async (args) => {
    const payload: Record<string, any> = {};
    if (args.filterGroups) payload.filterGroups = args.filterGroups;
    if (args.properties) payload.properties = args.properties;
    if (args.limit) payload.limit = args.limit;
    if (args.after) payload.after = args.after;
    const result = await client.searchObjects(args.objectType, payload);
    return buildEnvelope(result);
  },
  [`${CONNECTOR_PREFIX}.get_object`]: async (args) => {
    const result = await client.getObject(args.objectType, args.id, args.properties);
    return buildEnvelope(result);
  },
  [`${CONNECTOR_PREFIX}.create_object`]: async (args) => {
    const result = await client.createObject(args.objectType, args.properties || {});
    return buildEnvelope(result);
  },
  [`${CONNECTOR_PREFIX}.update_object`]: async (args) => {
    const result = await client.updateObject(args.objectType, args.id, args.properties || {});
    return buildEnvelope(result);
  },
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
  name: 'HubSpot Connector',
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
    nextCursor: result.nextCursor,
    warnings: [],
  };
}
