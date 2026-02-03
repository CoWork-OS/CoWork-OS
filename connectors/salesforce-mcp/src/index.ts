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

// ==================== Salesforce Client ====================

type SalesforceConfig = {
  instanceUrl?: string;
  accessToken?: string;
  apiVersion: string;
  loginUrl: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
};

type RateLimitInfo = {
  used: number;
  limit: number;
  remaining: number;
};

type RequestMeta = {
  durationMs: number;
  rateLimit?: RateLimitInfo;
  vendorRequestId?: string;
  apiVersion: string;
  instanceUrl?: string;
};

type RequestResult = {
  data: any;
  meta: RequestMeta;
  nextCursor?: string;
};

class SalesforceClient {
  private config: SalesforceConfig;

  constructor(config: SalesforceConfig) {
    this.config = config;
  }

  async health(): Promise<RequestResult> {
    return this.requestJson('GET', 'limits');
  }

  async listObjects(): Promise<RequestResult> {
    return this.requestJson('GET', 'sobjects');
  }

  async describeObject(objectName: string): Promise<RequestResult> {
    return this.requestJson('GET', `sobjects/${encodeURIComponent(objectName)}/describe`);
  }

  async getRecord(objectName: string, recordId: string, fields?: string[]): Promise<RequestResult> {
    const query = fields && fields.length > 0 ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
    return this.requestJson('GET', `sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}${query}`);
  }

  async query(soql: string, cursor?: string): Promise<RequestResult> {
    if (cursor) {
      return this.requestJson('GET', cursor, undefined, true);
    }

    const encoded = encodeURIComponent(soql);
    return this.requestJson('GET', `query?q=${encoded}`);
  }

  async createRecord(objectName: string, fields: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', `sobjects/${encodeURIComponent(objectName)}`, fields);
  }

  async updateRecord(objectName: string, recordId: string, fields: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('PATCH', `sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}`, fields);
  }

  private getBaseUrl(): string {
    if (!this.config.instanceUrl) {
      throw new Error('SALESFORCE_INSTANCE_URL is required');
    }
    return `${this.config.instanceUrl.replace(/\/$/, '')}/services/data/v${this.config.apiVersion}`;
  }

  private async requestJson(
    method: string,
    path: string,
    body?: any,
    absolutePath = false
  ): Promise<RequestResult> {
    const start = Date.now();

    const url = absolutePath
      ? this.buildAbsoluteUrl(path)
      : `${this.getBaseUrl()}/${path.replace(/^\//, '')}`;

    const token = await this.ensureAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'CoWork-Salesforce-Connector/0.1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && this.canRefresh()) {
      await this.refreshAccessToken();
      return this.requestJson(method, path, body, absolutePath);
    }

    const durationMs = Date.now() - start;
    const rateLimit = parseRateLimit(res.headers.get('sforce-limit-info'));
    const vendorRequestId = res.headers.get('sforce-request-id') || undefined;

    if (!res.ok) {
      const message = await this.extractErrorMessage(res);
      throw new Error(message);
    }

    let data: any = null;
    if (res.status !== 204) {
      data = await res.json();
    }

    const nextCursor = data?.nextRecordsUrl;

    return {
      data,
      meta: {
        durationMs,
        rateLimit,
        vendorRequestId,
        apiVersion: this.config.apiVersion,
        instanceUrl: this.config.instanceUrl,
      },
      nextCursor,
    };
  }

  private buildAbsoluteUrl(path: string): string {
    const trimmed = path.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    if (!this.config.instanceUrl) {
      throw new Error('SALESFORCE_INSTANCE_URL is required');
    }
    return `${this.config.instanceUrl.replace(/\/$/, '')}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
  }

  private async extractErrorMessage(res: Response): Promise<string> {
    const text = await res.text();
    if (!text) {
      return `Salesforce API error (status ${res.status})`;
    }

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        const code = first.errorCode ? ` (${first.errorCode})` : '';
        return `${first.message || 'Salesforce API error'}${code}`;
      }
      if (parsed.error && parsed.error_description) {
        return `${parsed.error_description} (${parsed.error})`;
      }
      if (parsed.message) {
        return parsed.message;
      }
      return JSON.stringify(parsed);
    } catch {
      return text;
    }
  }

  private canRefresh(): boolean {
    return Boolean(
      this.config.clientId &&
      this.config.clientSecret &&
      this.config.refreshToken &&
      this.config.loginUrl
    );
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.config.accessToken) {
      return this.config.accessToken;
    }
    if (!this.canRefresh()) {
      throw new Error('SALESFORCE_ACCESS_TOKEN is required (or provide refresh credentials)');
    }
    await this.refreshAccessToken();
    if (!this.config.accessToken) {
      throw new Error('Failed to obtain Salesforce access token');
    }
    return this.config.accessToken;
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.canRefresh()) {
      throw new Error('Missing refresh credentials');
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId as string,
      client_secret: this.config.clientSecret as string,
      refresh_token: this.config.refreshToken as string,
    });

    const url = `${this.config.loginUrl.replace(/\/$/, '')}/services/oauth2/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const message = await this.extractErrorMessage(res);
      throw new Error(`Salesforce OAuth refresh failed: ${message}`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error('Salesforce OAuth refresh returned no access_token');
    }

    this.config.accessToken = data.access_token;
    if (data.instance_url) {
      this.config.instanceUrl = data.instance_url;
    }
  }
}

function parseRateLimit(header: string | null): RateLimitInfo | undefined {
  if (!header) return undefined;
  const match = header.match(/api-usage=(\d+)\/(\d+)/i);
  if (!match) return undefined;
  const used = Number(match[1]);
  const limit = Number(match[2]);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return undefined;
  }
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
  };
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
    } catch (error) {
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

const CONNECTOR_PREFIX = 'salesforce';
const DEFAULT_API_VERSION = '60.0';

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: 'Check connector health and authentication status',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_objects`,
    description: 'List available Salesforce objects',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.describe_object`,
    description: 'Describe a Salesforce object and its fields',
    inputSchema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'Salesforce object name (e.g., Account)', },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['object'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_record`,
    description: 'Fetch a Salesforce record by id',
    inputSchema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'Salesforce object name (e.g., Account)' },
        id: { type: 'string', description: 'Salesforce record id' },
        fields: {
          type: 'array',
          description: 'Optional list of fields to include',
          items: { type: 'string' },
        },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['object', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.search_records`,
    description: 'Run a SOQL query',
    inputSchema: {
      type: 'object',
      properties: {
        soql: { type: 'string', description: 'SOQL query to execute (required if cursor is not provided)' },
        limit: { type: 'number', description: 'Optional LIMIT to append if not present' },
        cursor: { type: 'string', description: 'Pagination cursor (nextRecordsUrl); if provided, soql is optional' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_record`,
    description: 'Create a Salesforce record',
    inputSchema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'Salesforce object name (e.g., Account)' },
        fields: { type: 'object', description: 'Field map for creation' },
        idempotencyKey: { type: 'string', description: 'Optional idempotency key (best-effort)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['object', 'fields'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.update_record`,
    description: 'Update a Salesforce record',
    inputSchema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'Salesforce object name (e.g., Account)' },
        id: { type: 'string', description: 'Salesforce record id' },
        fields: { type: 'object', description: 'Field map for update' },
        idempotencyKey: { type: 'string', description: 'Optional idempotency key (best-effort)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['object', 'id', 'fields'],
      additionalProperties: false,
    },
  },
];

const config: SalesforceConfig = {
  instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
  accessToken: process.env.SALESFORCE_ACCESS_TOKEN,
  apiVersion: process.env.SALESFORCE_API_VERSION || DEFAULT_API_VERSION,
  loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com',
  clientId: process.env.SALESFORCE_CLIENT_ID,
  clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
  refreshToken: process.env.SALESFORCE_REFRESH_TOKEN,
};

const client = new SalesforceClient(config);

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async (args) => {
    const result = await client.health();
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.list_objects`]: async (args) => {
    const result = await client.listObjects();
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.describe_object`]: async (args) => {
    const result = await client.describeObject(args.object);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.get_record`]: async (args) => {
    const result = await client.getRecord(args.object, args.id, args.fields);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.search_records`]: async (args) => {
    const soql = args.soql ? normalizeSoql(args.soql, args.limit) : '';
    if (!args.cursor && !soql) {
      throw new Error('search_records requires either soql or cursor');
    }
    const result = await client.query(soql, args.cursor);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.create_record`]: async (args) => {
    const warnings = args.idempotencyKey
      ? ['Salesforce does not natively support idempotency keys; handled best-effort.']
      : [];
    const result = await client.createRecord(args.object, args.fields || {});
    return buildEnvelope(result, args.requestId, warnings);
  },
  [`${CONNECTOR_PREFIX}.update_record`]: async (args) => {
    const warnings = args.idempotencyKey
      ? ['Salesforce does not natively support idempotency keys; handled best-effort.']
      : [];
    const result = await client.updateRecord(args.object, args.id, args.fields || {});
    return buildEnvelope(result, args.requestId, warnings);
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
  name: 'Salesforce Connector',
  version: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

const server = new StdioMCPServer(toolProvider, serverInfo);
server.start();

function buildEnvelope(result: RequestResult, requestId?: string, warnings: string[] = []): any {
  return {
    ok: true,
    data: result.data,
    meta: {
      requestId,
      durationMs: result.meta.durationMs,
      rateLimit: result.meta.rateLimit,
      vendorRequestId: result.meta.vendorRequestId,
      apiVersion: result.meta.apiVersion,
      instanceUrl: result.meta.instanceUrl,
    },
    nextCursor: result.nextCursor,
    warnings,
  };
}

function normalizeSoql(soql: string, limit?: number): string {
  if (!limit || !Number.isFinite(limit) || limit <= 0) {
    return soql;
  }
  const hasLimit = /\blimit\b/i.test(soql);
  if (hasLimit) {
    return soql;
  }
  return `${soql} LIMIT ${Math.floor(limit)}`;
}
