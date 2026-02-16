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
  type?: string;
  description?: string;
  enum?: string[];
  default?: any;
  items?: MCPToolProperty;
  properties?: Record<string, MCPToolProperty>;
  required?: string[];
  oneOf?: MCPToolProperty[];
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

// ==================== Resend Client ====================

type ResendConfig = {
  baseUrl: string;
  apiKey?: string;
};

type RequestMeta = {
  durationMs: number;
  baseUrl: string;
};

type RequestResult = {
  data: any;
  meta: RequestMeta;
  status: number;
};

type SendEmailInput = {
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
  scheduled_at?: string;
  idempotency_key?: string;
};

type CreateWebhookInput = {
  endpoint: string;
  events: string[];
};

class ResendClient {
  constructor(private config: ResendConfig) {}

  async health(): Promise<RequestResult> {
    return this.request('GET', '/webhooks?limit=1');
  }

  async sendEmail(input: SendEmailInput): Promise<RequestResult> {
    const headers = input.idempotency_key
      ? { 'Idempotency-Key': input.idempotency_key }
      : undefined;

    return this.request('POST', '/emails', {
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      cc: input.cc,
      bcc: input.bcc,
      reply_to: input.reply_to,
      headers: input.headers,
      tags: input.tags,
      scheduled_at: input.scheduled_at,
    }, headers);
  }

  async listWebhooks(args: { limit?: number; after?: string; before?: string }): Promise<RequestResult> {
    const query = new URLSearchParams();
    if (typeof args.limit === 'number') query.set('limit', String(args.limit));
    if (args.after) query.set('after', args.after);
    if (args.before) query.set('before', args.before);

    const suffix = query.toString();
    return this.request('GET', suffix ? `/webhooks?${suffix}` : '/webhooks');
  }

  async createWebhook(input: CreateWebhookInput): Promise<RequestResult> {
    return this.request('POST', '/webhooks', {
      endpoint: input.endpoint,
      events: input.events,
    });
  }

  async deleteWebhook(id: string): Promise<RequestResult> {
    return this.request('DELETE', `/webhooks/${encodeURIComponent(id)}`);
  }

  async getReceivedEmail(id: string): Promise<RequestResult> {
    return this.request('GET', `/emails/receiving/${encodeURIComponent(id)}`);
  }

  private getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private getAuthHeader(): string {
    if (!this.config.apiKey) {
      throw new Error('RESEND_API_KEY is required');
    }
    return `Bearer ${this.config.apiKey}`;
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, any>,
    extraHeaders?: Record<string, string>,
  ): Promise<RequestResult> {
    const start = Date.now();
    const url = `${this.getBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;

    const headers: Record<string, string> = {
      Authorization: this.getAuthHeader(),
      'User-Agent': 'CoWork-Resend-Connector/0.1.0',
      ...(extraHeaders || {}),
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(stripUndefined(body)) : undefined,
    });

    const durationMs = Date.now() - start;
    const responseText = await res.text();
    const parsed = safeJsonParse(responseText);

    if (!res.ok) {
      const fromPayload =
        (parsed && typeof parsed === 'object' && typeof (parsed as any).message === 'string'
          ? (parsed as any).message
          : undefined) ||
        (parsed && typeof parsed === 'object' && typeof (parsed as any).error === 'string'
          ? (parsed as any).error
          : undefined);

      throw new Error(fromPayload || responseText || `Resend API error (${res.status})`);
    }

    return {
      data: parsed ?? responseText,
      status: res.status,
      meta: {
        durationMs,
        baseUrl: this.config.baseUrl,
      },
    };
  }
}

function safeJsonParse(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripUndefined<T extends Record<string, any>>(value: T): T {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries) as T;
}

function normalizeStringList(input: unknown, field: string): string[] {
  if (Array.isArray(input)) {
    const cleaned = input
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
    if (cleaned.length === 0) {
      throw new Error(`${field} must contain at least one non-empty string`);
    }
    return cleaned;
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error(`${field} must be a non-empty string`);
    }
    return [trimmed];
  }

  throw new Error(`${field} must be a string or string[]`);
}

function asOptionalString(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  return trimmed || undefined;
}

function asOptionalNumber(input: unknown): number | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input)) return undefined;
  return input;
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

const CONNECTOR_PREFIX = 'resend';
const DEFAULT_BASE_URL = 'https://api.resend.com';
const EVENT_ENUM = [
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.opened',
  'email.clicked',
  'email.failed',
  'email.scheduled',
  'email.suppressed',
  'email.received',
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'domain.created',
  'domain.updated',
  'domain.deleted',
] as const;
const EVENT_SET = new Set<string>(EVENT_ENUM);

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: 'Check connector health and authentication status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.send_email`,
    description: 'Send an email via Resend API',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'From address, e.g. "Acme <noreply@example.com>"' },
        to: {
          description: 'Recipient email address(es)',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        subject: { type: 'string', description: 'Email subject' },
        text: { type: 'string', description: 'Plain text email body' },
        html: { type: 'string', description: 'HTML email body' },
        cc: {
          description: 'CC address(es)',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        bcc: {
          description: 'BCC address(es)',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        reply_to: {
          description: 'Reply-To address(es)',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        headers: { type: 'object', description: 'Custom email headers' },
        tags: {
          type: 'array',
          description: 'Metadata tags',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['name', 'value'],
          },
        },
        scheduled_at: { type: 'string', description: 'Scheduled time expression (e.g., "in 10 min")' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key for safe retries' },
      },
      required: ['from', 'to', 'subject'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_webhooks`,
    description: 'List registered Resend webhooks',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of webhooks (1-100)' },
        after: { type: 'string', description: 'Pagination cursor after ID' },
        before: { type: 'string', description: 'Pagination cursor before ID' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_webhook`,
    description: 'Create a webhook endpoint in Resend',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: 'Public HTTPS endpoint URL' },
        events: {
          type: 'array',
          description: 'Events to subscribe to',
          items: { type: 'string', enum: [...EVENT_ENUM] },
        },
      },
      required: ['endpoint', 'events'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.delete_webhook`,
    description: 'Delete an existing webhook by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Webhook ID' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_received_email`,
    description: 'Retrieve full content for a received email (html/text/headers) by email_id',
    inputSchema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'Received email ID from email.received webhook payload' },
      },
      required: ['email_id'],
      additionalProperties: false,
    },
  },
];

const config: ResendConfig = {
  baseUrl: process.env.RESEND_BASE_URL || DEFAULT_BASE_URL,
  apiKey: process.env.RESEND_API_KEY,
};

const client = new ResendClient(config);

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async () =>
    buildEnvelope(await client.health()),
  [`${CONNECTOR_PREFIX}.send_email`]: async (args) => {
    const from = asOptionalString(args.from);
    const subject = asOptionalString(args.subject);
    const to = args.to;
    const text = asOptionalString(args.text);
    const html = asOptionalString(args.html);

    if (!from) throw new Error('from is required');
    if (!subject) throw new Error('subject is required');
    if (text === undefined && html === undefined) {
      throw new Error('Provide at least one of text or html');
    }

    const tags = Array.isArray(args.tags)
      ? args.tags
          .map((tag: any) => ({
            name: asOptionalString(tag?.name),
            value: asOptionalString(tag?.value),
          }))
          .filter(
            (tag): tag is { name: string; value: string } =>
              typeof tag.name === 'string' && typeof tag.value === 'string',
          )
      : undefined;

    return buildEnvelope(
      await client.sendEmail({
        from,
        to: normalizeStringList(to, 'to'),
        subject,
        text,
        html,
        cc: args.cc ? normalizeStringList(args.cc, 'cc') : undefined,
        bcc: args.bcc ? normalizeStringList(args.bcc, 'bcc') : undefined,
        reply_to: args.reply_to ? normalizeStringList(args.reply_to, 'reply_to') : undefined,
        headers: args.headers && typeof args.headers === 'object' ? args.headers : undefined,
        tags,
        scheduled_at: asOptionalString(args.scheduled_at),
        idempotency_key: asOptionalString(args.idempotency_key),
      }),
    );
  },
  [`${CONNECTOR_PREFIX}.list_webhooks`]: async (args) => {
    const limit = asOptionalNumber(args.limit);
    if (limit !== undefined && (limit < 1 || limit > 100)) {
      throw new Error('limit must be between 1 and 100');
    }
    if (args.after && args.before) {
      throw new Error('Provide either after or before, not both');
    }

    return buildEnvelope(
      await client.listWebhooks({
        limit,
        after: asOptionalString(args.after),
        before: asOptionalString(args.before),
      }),
    );
  },
  [`${CONNECTOR_PREFIX}.create_webhook`]: async (args) => {
    const endpoint = asOptionalString(args.endpoint);
    if (!endpoint) throw new Error('endpoint is required');

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(endpoint);
    } catch {
      throw new Error('endpoint must be a valid URL');
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('endpoint must use https');
    }

    const events = normalizeStringList(args.events, 'events');
    const invalidEvents = events.filter((event) => !EVENT_SET.has(event));
    if (invalidEvents.length > 0) {
      throw new Error(`Unsupported webhook event(s): ${invalidEvents.join(', ')}`);
    }
    return buildEnvelope(await client.createWebhook({ endpoint, events }));
  },
  [`${CONNECTOR_PREFIX}.delete_webhook`]: async (args) => {
    const id = asOptionalString(args.id);
    if (!id) throw new Error('id is required');
    return buildEnvelope(await client.deleteWebhook(id));
  },
  [`${CONNECTOR_PREFIX}.get_received_email`]: async (args) => {
    const emailId = asOptionalString(args.email_id);
    if (!emailId) throw new Error('email_id is required');
    return buildEnvelope(await client.getReceivedEmail(emailId));
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
  name: 'Resend Connector',
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
      baseUrl: result.meta.baseUrl,
      status: result.status,
    },
    warnings: [],
  };
}
