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

// ==================== Linear Client ====================

type LinearConfig = {
  baseUrl: string;
  apiKey?: string;
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

type GraphQLResponse = {
  data?: any;
  errors?: Array<{ message?: string }>;
};

class LinearClient {
  constructor(private config: LinearConfig) {}

  async health(): Promise<RequestResult> {
    const query = `query Viewer { viewer { id name email } }`;
    return this.requestGraphQL(query, undefined, 'viewer');
  }

  async listProjects(limit?: number, cursor?: string): Promise<RequestResult> {
    const query = `query Projects($first: Int, $after: String) {
      projects(first: $first, after: $after) {
        nodes { id name state { name } }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    return this.requestGraphQL(query, { first: limit, after: cursor }, 'projects');
  }

  async searchIssues(
    queryText: string,
    limit?: number,
    cursor?: string,
    projectId?: string,
    teamId?: string
  ): Promise<RequestResult> {
    const filter: Record<string, any> = {
      title: { contains: queryText },
    };
    if (projectId) {
      filter.project = { id: { eq: projectId } };
    }
    if (teamId) {
      filter.team = { id: { eq: teamId } };
    }

    const query = `query Issues($first: Int, $after: String, $filter: IssueFilter) {
      issues(first: $first, after: $after, filter: $filter) {
        nodes {
          id
          title
          identifier
          url
          state { id name }
          project { id name }
          team { id name }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    return this.requestGraphQL(query, { first: limit, after: cursor, filter }, 'issues');
  }

  async getIssue(issueId: string): Promise<RequestResult> {
    const query = `query Issue($id: String!) {
      issue(id: $id) {
        id
        title
        identifier
        url
        description
        state { id name }
        project { id name }
        team { id name }
        assignee { id name email }
      }
    }`;

    return this.requestGraphQL(query, { id: issueId }, 'issue');
  }

  private getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private getAuthHeader(): string {
    if (!this.config.apiKey) {
      throw new Error('LINEAR_API_KEY is required');
    }
    return `Bearer ${this.config.apiKey}`;
  }

  private async requestGraphQL(
    query: string,
    variables?: Record<string, any>,
    rootField?: string
  ): Promise<RequestResult> {
    const start = Date.now();
    const url = this.getBaseUrl();

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        'User-Agent': 'CoWork-Linear-Connector/0.1.0',
      },
      body: JSON.stringify({ query, variables }),
    });

    const durationMs = Date.now() - start;
    const vendorRequestId = res.headers.get('x-request-id') || undefined;

    if (!res.ok) {
      const message = await res.text();
      throw new Error(message || `Linear API error (${res.status})`);
    }

    const payload = (await res.json()) as GraphQLResponse;
    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors.map((err) => err.message || 'GraphQL error').join('; ');
      throw new Error(message);
    }

    const extracted = rootField ? payload.data?.[rootField] : payload.data;
    const pageInfo = extracted?.pageInfo;
    const nextCursor = pageInfo?.hasNextPage ? pageInfo.endCursor : undefined;

    return {
      data: extracted,
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

const CONNECTOR_PREFIX = 'linear';
const DEFAULT_BASE_URL = 'https://api.linear.app/graphql';

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: 'Check connector health and authentication status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_projects`,
    description: 'List Linear projects',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max projects to return' },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.search_issues`,
    description: 'Search issues by title',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text for issue titles' },
        projectId: { type: 'string', description: 'Filter by project id' },
        teamId: { type: 'string', description: 'Filter by team id' },
        limit: { type: 'number', description: 'Max issues to return' },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_issue`,
    description: 'Fetch an issue by id',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue id' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

const config: LinearConfig = {
  baseUrl: process.env.LINEAR_BASE_URL || DEFAULT_BASE_URL,
  apiKey: process.env.LINEAR_API_KEY,
};

const client = new LinearClient(config);

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => buildEnvelope(await client.health()),
  [`${CONNECTOR_PREFIX}.list_projects`]: async (args) =>
    buildEnvelope(await client.listProjects(args.limit, args.cursor)),
  [`${CONNECTOR_PREFIX}.search_issues`]: async (args) =>
    buildEnvelope(await client.searchIssues(args.query, args.limit, args.cursor, args.projectId, args.teamId)),
  [`${CONNECTOR_PREFIX}.get_issue`]: async (args) => buildEnvelope(await client.getIssue(args.id)),
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
  name: 'Linear Connector',
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
