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

// ==================== ServiceNow Client ====================

type ServiceNowConfig = {
  instanceUrl?: string;
  instance?: string;
  username?: string;
  password?: string;
  accessToken?: string;
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

class ServiceNowClient {
  constructor(private config: ServiceNowConfig) {}

  async health(): Promise<RequestResult> {
    return this.requestJson('GET', 'table/sys_user?sysparm_limit=1');
  }

  async listRecords(table: string, query?: string, limit?: number, offset?: number, fields?: string[]): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (query) params.set('sysparm_query', query);
    if (limit !== undefined) params.set('sysparm_limit', String(limit));
    if (offset !== undefined) params.set('sysparm_offset', String(offset));
    if (fields && fields.length > 0) params.set('sysparm_fields', fields.join(','));
    const queryString = params.toString();
    return this.requestJson('GET', `table/${encodeURIComponent(table)}${queryString ? `?${queryString}` : ''}`);
  }

  async getRecord(table: string, sysId: string, fields?: string[]): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (fields && fields.length > 0) params.set('sysparm_fields', fields.join(','));
    const queryString = params.toString();
    return this.requestJson('GET', `table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}${queryString ? `?${queryString}` : ''}`);
  }

  async createRecord(table: string, fields: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', `table/${encodeURIComponent(table)}`, fields);
  }

  async updateRecord(table: string, sysId: string, fields: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('PATCH', `table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`, fields);
  }

  private getBaseUrl(): string {
    if (this.config.instanceUrl) {
      return this.config.instanceUrl.replace(/\/$/, '');
    }
    if (this.config.instance) {
      return `https://${this.config.instance}.service-now.com`;
    }
    throw new Error('SERVICENOW_INSTANCE_URL or SERVICENOW_INSTANCE is required');
  }

  private getAuthHeader(): string {
    if (this.config.accessToken) {
      return `Bearer ${this.config.accessToken}`;
    }
    if (this.config.username && this.config.password) {
      const basic = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
      return `Basic ${basic}`;
    }
    throw new Error('Missing ServiceNow credentials');
  }

  private async requestJson(method: string, path: string, body?: any): Promise<RequestResult> {
    const start = Date.now();
    const url = `${this.getBaseUrl()}/api/now/${path.replace(/^\//, '')}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'CoWork-ServiceNow-Connector/0.1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - start;
    const vendorRequestId = res.headers.get('x-request-id') || undefined;

    if (!res.ok) {
      const message = await res.text();
      throw new Error(message || `ServiceNow API error (${res.status})`);
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
        baseUrl: this.getBaseUrl(),
      },
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

const CONNECTOR_PREFIX = 'servicenow';

const config: ServiceNowConfig = {
  instanceUrl: process.env.SERVICENOW_INSTANCE_URL,
  instance: process.env.SERVICENOW_INSTANCE,
  username: process.env.SERVICENOW_USERNAME,
  password: process.env.SERVICENOW_PASSWORD,
  accessToken: process.env.SERVICENOW_ACCESS_TOKEN,
};

const client = new ServiceNowClient(config);

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: 'Check connector health and authentication status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_records`,
    description: 'List records from a ServiceNow table',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (e.g., incident)' },
        query: { type: 'string', description: 'sysparm_query string' },
        limit: { type: 'number', description: 'Max records to return' },
        offset: { type: 'number', description: 'Offset for pagination' },
        fields: { type: 'array', description: 'Fields to return', items: { type: 'string' } },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_record`,
    description: 'Fetch a record by sys_id',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (e.g., incident)' },
        sysId: { type: 'string', description: 'sys_id of the record' },
        fields: { type: 'array', description: 'Fields to return', items: { type: 'string' } },
      },
      required: ['table', 'sysId'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_record`,
    description: 'Create a record in a table',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (e.g., incident)' },
        fields: { type: 'object', description: 'Field map for creation' },
      },
      required: ['table', 'fields'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.update_record`,
    description: 'Update a record in a table',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (e.g., incident)' },
        sysId: { type: 'string', description: 'sys_id of the record' },
        fields: { type: 'object', description: 'Field map for update' },
      },
      required: ['table', 'sysId', 'fields'],
      additionalProperties: false,
    },
  },
];

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => buildEnvelope(await client.health()),
  [`${CONNECTOR_PREFIX}.list_records`]: async (args) =>
    buildEnvelope(await client.listRecords(args.table, args.query, args.limit, args.offset, args.fields)),
  [`${CONNECTOR_PREFIX}.get_record`]: async (args) =>
    buildEnvelope(await client.getRecord(args.table, args.sysId, args.fields)),
  [`${CONNECTOR_PREFIX}.create_record`]: async (args) =>
    buildEnvelope(await client.createRecord(args.table, args.fields || {})),
  [`${CONNECTOR_PREFIX}.update_record`]: async (args) =>
    buildEnvelope(await client.updateRecord(args.table, args.sysId, args.fields || {})),
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
  name: 'ServiceNow Connector',
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
