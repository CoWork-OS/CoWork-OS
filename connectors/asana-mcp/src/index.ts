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

// ==================== Asana Client ====================

type AsanaConfig = {
  baseUrl: string;
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
  nextCursor?: string;
};

class AsanaClient {
  constructor(private config: AsanaConfig) {}

  async health(): Promise<RequestResult> {
    return this.requestJson('GET', 'users/me');
  }

  async listProjects(workspaceGid: string, limit?: number, offset?: string, archived?: boolean): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset) params.set('offset', offset);
    if (archived !== undefined) params.set('archived', archived ? 'true' : 'false');
    const query = params.toString();
    return this.requestJson(
      'GET',
      `workspaces/${encodeURIComponent(workspaceGid)}/projects${query ? `?${query}` : ''}`
    );
  }

  async getTask(taskId: string, fields?: string[]): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (fields && fields.length > 0) {
      params.set('opt_fields', fields.join(','));
    }
    const query = params.toString();
    return this.requestJson('GET', `tasks/${encodeURIComponent(taskId)}${query ? `?${query}` : ''}`);
  }

  async searchTasks(
    workspaceGid: string,
    text?: string,
    assigneeGid?: string,
    projectGid?: string,
    completed?: boolean,
    limit?: number,
    offset?: string,
    fields?: string[]
  ): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (fields && fields.length > 0) {
      params.set('opt_fields', fields.join(','));
    }
    const query = params.toString();

    const payload: Record<string, any> = {};
    if (text) payload.text = text;
    if (assigneeGid) payload.assignee = assigneeGid;
    if (projectGid) payload.projects = [projectGid];
    if (completed !== undefined) payload.completed = completed;
    if (limit !== undefined) payload.limit = limit;
    if (offset) payload.offset = offset;

    return this.requestJson(
      'POST',
      `workspaces/${encodeURIComponent(workspaceGid)}/tasks/search${query ? `?${query}` : ''}`,
      { data: payload }
    );
  }

  async createTask(data: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', 'tasks', { data });
  }

  async updateTask(taskId: string, data: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('PUT', `tasks/${encodeURIComponent(taskId)}`, { data });
  }

  private getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private getAuthHeader(): string {
    if (!this.config.accessToken) {
      throw new Error('ASANA_ACCESS_TOKEN is required');
    }
    return `Bearer ${this.config.accessToken}`;
  }

  private async requestJson(method: string, path: string, body?: any): Promise<RequestResult> {
    const start = Date.now();
    const url = `${this.getBaseUrl()}/${path.replace(/^\//, '')}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'CoWork-Asana-Connector/0.1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - start;
    const vendorRequestId = res.headers.get('x-request-id') || undefined;

    if (!res.ok) {
      const message = await res.text();
      throw new Error(message || `Asana API error (${res.status})`);
    }

    let data: any = null;
    if (res.status !== 204) {
      data = await res.json();
    }

    const nextCursor = data?.next_page?.offset;

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

const CONNECTOR_PREFIX = 'asana';
const DEFAULT_BASE_URL = 'https://app.asana.com/api/1.0';

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: 'Check connector health and authentication status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_projects`,
    description: 'List projects in a workspace',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceGid: { type: 'string', description: 'Workspace GID' },
        limit: { type: 'number', description: 'Max projects to return' },
        offset: { type: 'string', description: 'Pagination offset' },
        archived: { type: 'boolean', description: 'Include archived projects' },
      },
      required: ['workspaceGid'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_task`,
    description: 'Fetch a task by id',
    inputSchema: {
      type: 'object',
      properties: {
        taskGid: { type: 'string', description: 'Task GID' },
        fields: { type: 'array', description: 'Fields to return', items: { type: 'string' } },
      },
      required: ['taskGid'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.search_tasks`,
    description: 'Search tasks in a workspace',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceGid: { type: 'string', description: 'Workspace GID' },
        text: { type: 'string', description: 'Search text' },
        assigneeGid: { type: 'string', description: 'Assignee GID' },
        projectGid: { type: 'string', description: 'Project GID' },
        completed: { type: 'boolean', description: 'Filter by completion' },
        limit: { type: 'number', description: 'Max tasks to return' },
        offset: { type: 'string', description: 'Pagination offset' },
        fields: { type: 'array', description: 'Fields to return', items: { type: 'string' } },
      },
      required: ['workspaceGid'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_task`,
    description: 'Create a task',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'Task payload (Asana task fields)' },
      },
      required: ['data'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.update_task`,
    description: 'Update a task',
    inputSchema: {
      type: 'object',
      properties: {
        taskGid: { type: 'string', description: 'Task GID' },
        data: { type: 'object', description: 'Task payload to update' },
      },
      required: ['taskGid', 'data'],
      additionalProperties: false,
    },
  },
];

const config: AsanaConfig = {
  baseUrl: process.env.ASANA_BASE_URL || DEFAULT_BASE_URL,
  accessToken: process.env.ASANA_ACCESS_TOKEN,
};

const client = new AsanaClient(config);

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => buildEnvelope(await client.health()),
  [`${CONNECTOR_PREFIX}.list_projects`]: async (args) =>
    buildEnvelope(await client.listProjects(args.workspaceGid, args.limit, args.offset, args.archived)),
  [`${CONNECTOR_PREFIX}.get_task`]: async (args) =>
    buildEnvelope(await client.getTask(args.taskGid, args.fields)),
  [`${CONNECTOR_PREFIX}.search_tasks`]: async (args) =>
    buildEnvelope(
      await client.searchTasks(
        args.workspaceGid,
        args.text,
        args.assigneeGid,
        args.projectGid,
        args.completed,
        args.limit,
        args.offset,
        args.fields
      )
    ),
  [`${CONNECTOR_PREFIX}.create_task`]: async (args) =>
    buildEnvelope(await client.createTask(args.data || {})),
  [`${CONNECTOR_PREFIX}.update_task`]: async (args) =>
    buildEnvelope(await client.updateTask(args.taskGid, args.data || {})),
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
  name: 'Asana Connector',
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
