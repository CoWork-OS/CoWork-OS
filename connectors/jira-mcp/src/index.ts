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

// ==================== Jira Client ====================

type JiraConfig = {
  baseUrl?: string;
  apiVersion: string;
  accessToken?: string;
  email?: string;
  apiToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
};

type RateLimitInfo = {
  limit: number;
  remaining: number;
  resetAt?: string;
};

type RequestMeta = {
  durationMs: number;
  rateLimit?: RateLimitInfo;
  vendorRequestId?: string;
  apiVersion: string;
  baseUrl?: string;
};

type RequestResult = {
  data: any;
  meta: RequestMeta;
  nextCursor?: string;
};

class JiraClient {
  private config: JiraConfig;

  constructor(config: JiraConfig) {
    this.config = config;
  }

  async health(): Promise<RequestResult> {
    return this.requestJson('GET', 'myself');
  }

  async listProjects(startAt?: number, maxResults?: number): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (startAt !== undefined) params.set('startAt', String(startAt));
    if (maxResults !== undefined) params.set('maxResults', String(maxResults));
    const query = params.toString();
    return this.requestJson('GET', `project/search${query ? `?${query}` : ''}`);
  }

  async getIssue(issueIdOrKey: string, fields?: string[]): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (fields && fields.length > 0) params.set('fields', fields.join(','));
    const query = params.toString();
    return this.requestJson('GET', `issue/${encodeURIComponent(issueIdOrKey)}${query ? `?${query}` : ''}`);
  }

  async searchIssues(jql: string, startAt?: number, maxResults?: number, fields?: string[]): Promise<RequestResult> {
    const payload: Record<string, any> = { jql };
    if (startAt !== undefined) payload.startAt = startAt;
    if (maxResults !== undefined) payload.maxResults = maxResults;
    if (fields && fields.length > 0) payload.fields = fields;
    return this.requestJson('POST', 'search', payload);
  }

  async createIssue(payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', 'issue', payload);
  }

  async updateIssue(issueIdOrKey: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('PUT', `issue/${encodeURIComponent(issueIdOrKey)}`, payload);
  }

  private getBaseUrl(): string {
    if (!this.config.baseUrl) {
      throw new Error('JIRA_BASE_URL is required');
    }
    return `${this.config.baseUrl.replace(/\/$/, '')}/rest/api/${this.config.apiVersion}`;
  }

  private canRefresh(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.refreshToken);
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.config.accessToken) {
      return this.config.accessToken;
    }
    if (!this.canRefresh()) {
      throw new Error('Missing Jira credentials (provide JIRA_ACCESS_TOKEN or JIRA_EMAIL + JIRA_API_TOKEN)');
    }
    await this.refreshAccessToken();
    if (!this.config.accessToken) {
      throw new Error('Failed to refresh Jira access token');
    }
    return this.config.accessToken;
  }

  private async getAuthHeader(): Promise<string> {
    if (this.config.accessToken || this.canRefresh()) {
      const token = await this.ensureAccessToken();
      return `Bearer ${token}`;
    }
    if (this.config.email && this.config.apiToken) {
      const basic = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
      return `Basic ${basic}`;
    }
    throw new Error('Missing Jira credentials (provide JIRA_ACCESS_TOKEN or JIRA_EMAIL + JIRA_API_TOKEN)');
  }

  private async requestJson(method: string, path: string, body?: any): Promise<RequestResult> {
    const start = Date.now();
    const url = `${this.getBaseUrl()}/${path.replace(/^\//, '')}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: await this.getAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'CoWork-Jira-Connector/0.1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - start;
    const rateLimit = parseRateLimit(res.headers);
    const vendorRequestId = res.headers.get('x-arequestid') || res.headers.get('x-request-id') || undefined;

    if (res.status === 401 && this.canRefresh()) {
      await this.refreshAccessToken();
      return this.requestJson(method, path, body);
    }

    if (!res.ok) {
      const message = await this.extractErrorMessage(res);
      throw new Error(message);
    }

    let data: any = null;
    if (res.status !== 204) {
      data = await res.json();
    }

    const nextCursor = deriveNextCursor(data);

    return {
      data,
      meta: {
        durationMs,
        rateLimit,
        vendorRequestId,
        apiVersion: this.config.apiVersion,
        baseUrl: this.config.baseUrl,
      },
      nextCursor,
    };
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.canRefresh()) {
      throw new Error('Missing Jira refresh credentials');
    }

    const res = await fetch('https://auth.atlassian.com/oauth/token', {
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
      throw new Error(`Jira OAuth refresh failed: ${text}`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error('Jira OAuth refresh returned no access_token');
    }

    this.config.accessToken = data.access_token;
  }

  private async extractErrorMessage(res: Response): Promise<string> {
    const text = await res.text();
    if (!text) {
      return `Jira API error (status ${res.status})`;
    }

    try {
      const parsed = JSON.parse(text);
      if (parsed.errorMessages && Array.isArray(parsed.errorMessages) && parsed.errorMessages.length > 0) {
        return parsed.errorMessages.join('; ');
      }
      if (parsed.errors && typeof parsed.errors === 'object') {
        const messages = Object.entries(parsed.errors).map(([field, msg]) => `${field}: ${msg}`);
        return messages.join('; ');
      }
      if (parsed.message) {
        return parsed.message;
      }
      return JSON.stringify(parsed);
    } catch {
      return text;
    }
  }
}

function parseRateLimit(headers: Headers): RateLimitInfo | undefined {
  const limit = numberHeader(headers.get('x-ratelimit-limit'));
  const remaining = numberHeader(headers.get('x-ratelimit-remaining'));
  const reset = headers.get('x-ratelimit-reset');
  if (limit === undefined || remaining === undefined) {
    return undefined;
  }
  return {
    limit,
    remaining,
    resetAt: reset || undefined,
  };
}

function numberHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function deriveNextCursor(data: any): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  if (typeof data.startAt === 'number' && typeof data.maxResults === 'number' && typeof data.total === 'number') {
    const next = data.startAt + data.maxResults;
    if (next < data.total) {
      return String(next);
    }
  }
  return undefined;
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

const CONNECTOR_PREFIX = 'jira';
const DEFAULT_API_VERSION = '3';

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
    name: `${CONNECTOR_PREFIX}.list_projects`,
    description: 'List Jira projects',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results per page' },
        cursor: { type: 'string', description: 'Pagination cursor (startAt number)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_issue`,
    description: 'Fetch a Jira issue by id or key',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue id or key (e.g., PROJ-123)' },
        fields: {
          type: 'array',
          description: 'Optional list of fields to include',
          items: { type: 'string' },
        },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.search_issues`,
    description: 'Run a JQL query',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'JQL query to execute' },
        fields: {
          type: 'array',
          description: 'Optional list of fields to include',
          items: { type: 'string' },
        },
        limit: { type: 'number', description: 'Max results per page' },
        cursor: { type: 'string', description: 'Pagination cursor (startAt number)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['jql'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_issue`,
    description: 'Create a Jira issue',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'Project key (e.g., PROJ)' },
        issueType: { type: 'string', description: 'Issue type (e.g., Task, Bug)' },
        fields: { type: 'object', description: 'Additional Jira fields to include' },
        idempotencyKey: { type: 'string', description: 'Optional idempotency key (best-effort)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['projectKey', 'issueType', 'fields'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.update_issue`,
    description: 'Update a Jira issue',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue id or key (e.g., PROJ-123)' },
        fields: { type: 'object', description: 'Field map for update' },
        idempotencyKey: { type: 'string', description: 'Optional idempotency key (best-effort)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['id', 'fields'],
      additionalProperties: false,
    },
  },
];

const config: JiraConfig = {
  baseUrl: process.env.JIRA_BASE_URL,
  apiVersion: process.env.JIRA_API_VERSION || DEFAULT_API_VERSION,
  accessToken: process.env.JIRA_ACCESS_TOKEN,
  email: process.env.JIRA_EMAIL,
  apiToken: process.env.JIRA_API_TOKEN,
  clientId: process.env.JIRA_CLIENT_ID,
  clientSecret: process.env.JIRA_CLIENT_SECRET,
  refreshToken: process.env.JIRA_REFRESH_TOKEN,
};

const client = new JiraClient(config);

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async (args) => {
    const result = await client.health();
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.list_projects`]: async (args) => {
    const startAt = parseCursor(args.cursor);
    const result = await client.listProjects(startAt, args.limit);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.get_issue`]: async (args) => {
    const result = await client.getIssue(args.id, args.fields);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.search_issues`]: async (args) => {
    const startAt = parseCursor(args.cursor);
    const result = await client.searchIssues(args.jql, startAt, args.limit, args.fields);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.create_issue`]: async (args) => {
    const payload = buildCreatePayload(args.projectKey, args.issueType, args.fields);
    const warnings = args.idempotencyKey
      ? ['Jira does not natively support idempotency keys; handled best-effort.']
      : [];
    const result = await client.createIssue(payload);
    return buildEnvelope(result, args.requestId, warnings);
  },
  [`${CONNECTOR_PREFIX}.update_issue`]: async (args) => {
    const warnings = args.idempotencyKey
      ? ['Jira does not natively support idempotency keys; handled best-effort.']
      : [];
    const result = await client.updateIssue(args.id, { fields: args.fields });
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
  name: 'Jira Connector',
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
      baseUrl: result.meta.baseUrl,
    },
    nextCursor: result.nextCursor,
    warnings,
  };
}

function parseCursor(cursor?: string): number | undefined {
  if (!cursor) return undefined;
  const value = Number(cursor);
  return Number.isFinite(value) ? value : undefined;
}

function buildCreatePayload(projectKey: string, issueType: string, fields: Record<string, any>): Record<string, any> {
  return {
    fields: {
      ...fields,
      project: { key: projectKey },
      issuetype: { name: issueType },
    },
  };
}
