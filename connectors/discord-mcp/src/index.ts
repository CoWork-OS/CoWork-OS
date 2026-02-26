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

// ==================== Discord Client ====================

const DISCORD_API_BASE = 'https://discord.com/api/v10';

type DiscordConfig = {
  botToken?: string;
  applicationId?: string;
  defaultGuildId?: string;
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
};

type RequestResult = {
  data: any;
  meta: RequestMeta;
  nextCursor?: string;
};

class DiscordClient {
  private config: DiscordConfig;

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  async health(): Promise<RequestResult> {
    return this.requestJson('GET', '/users/@me');
  }

  async listGuilds(limit?: number, after?: string): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (after) params.set('after', after);
    const query = params.toString();
    return this.requestJson('GET', `/users/@me/guilds${query ? `?${query}` : ''}`);
  }

  async getGuild(guildId: string): Promise<RequestResult> {
    return this.requestJson('GET', `/guilds/${encodeURIComponent(guildId)}?with_counts=true`);
  }

  async listChannels(guildId: string): Promise<RequestResult> {
    return this.requestJson('GET', `/guilds/${encodeURIComponent(guildId)}/channels`);
  }

  async getChannel(channelId: string): Promise<RequestResult> {
    return this.requestJson('GET', `/channels/${encodeURIComponent(channelId)}`);
  }

  async createChannel(guildId: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', `/guilds/${encodeURIComponent(guildId)}/channels`, payload);
  }

  async editChannel(channelId: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('PATCH', `/channels/${encodeURIComponent(channelId)}`, payload);
  }

  async deleteChannel(channelId: string): Promise<RequestResult> {
    return this.requestJson('DELETE', `/channels/${encodeURIComponent(channelId)}`);
  }

  async sendMessage(channelId: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', `/channels/${encodeURIComponent(channelId)}/messages`, payload);
  }

  async getMessages(channelId: string, limit?: number, before?: string, after?: string): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (before) params.set('before', before);
    if (after) params.set('after', after);
    const query = params.toString();
    return this.requestJson('GET', `/channels/${encodeURIComponent(channelId)}/messages${query ? `?${query}` : ''}`);
  }

  async createThread(channelId: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', `/channels/${encodeURIComponent(channelId)}/threads`, payload);
  }

  async createMessageThread(
    channelId: string,
    messageId: string,
    payload: Record<string, any>,
  ): Promise<RequestResult> {
    return this.requestJson(
      'POST',
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`,
      payload,
    );
  }

  async listRoles(guildId: string): Promise<RequestResult> {
    return this.requestJson('GET', `/guilds/${encodeURIComponent(guildId)}/roles`);
  }

  async createRole(guildId: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', `/guilds/${encodeURIComponent(guildId)}/roles`, payload);
  }

  async editRole(guildId: string, roleId: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson(
      'PATCH',
      `/guilds/${encodeURIComponent(guildId)}/roles/${encodeURIComponent(roleId)}`,
      payload,
    );
  }

  async deleteRole(guildId: string, roleId: string): Promise<RequestResult> {
    return this.requestJson(
      'DELETE',
      `/guilds/${encodeURIComponent(guildId)}/roles/${encodeURIComponent(roleId)}`,
    );
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<RequestResult> {
    const encoded = encodeURIComponent(emoji);
    return this.requestJson(
      'PUT',
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encoded}/@me`,
    );
  }

  async createWebhook(channelId: string, payload: Record<string, any>): Promise<RequestResult> {
    return this.requestJson('POST', `/channels/${encodeURIComponent(channelId)}/webhooks`, payload);
  }

  async listWebhooks(channelId: string): Promise<RequestResult> {
    return this.requestJson('GET', `/channels/${encodeURIComponent(channelId)}/webhooks`);
  }

  async listMembers(guildId: string, limit?: number, after?: string): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (after) params.set('after', after);
    const query = params.toString();
    return this.requestJson('GET', `/guilds/${encodeURIComponent(guildId)}/members${query ? `?${query}` : ''}`);
  }

  private getToken(): string {
    if (!this.config.botToken) {
      throw new Error('DISCORD_BOT_TOKEN is required');
    }
    return this.config.botToken;
  }

  private async requestJson(method: string, path: string, body?: any, retryCount = 0): Promise<RequestResult> {
    const start = Date.now();
    const url = `${DISCORD_API_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.getToken()}`,
      'User-Agent': 'CoWork-Discord-Connector/0.1.0',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - start;
    const rateLimit = parseRateLimit(res.headers);
    const vendorRequestId = res.headers.get('x-request-id') || undefined;

    // Retry on rate limit (429), up to 2 retries
    if (res.status === 429 && retryCount < 2) {
      const retryBody = await res.text();
      let retryAfterMs = 1000;
      try {
        const parsed = JSON.parse(retryBody);
        if (typeof parsed.retry_after === 'number') {
          retryAfterMs = Math.ceil(parsed.retry_after * 1000);
        }
      } catch {
        // Fall back to 1s
      }
      const cappedDelay = Math.min(retryAfterMs, 10_000); // Cap at 10s
      await new Promise((resolve) => setTimeout(resolve, cappedDelay));
      return this.requestJson(method, path, body, retryCount + 1);
    }

    if (!res.ok) {
      const message = await this.extractErrorMessage(res);
      throw new Error(message);
    }

    let data: any = null;
    if (res.status !== 204) {
      const text = await res.text();
      if (text) {
        data = JSON.parse(text);
      }
    }

    return {
      data,
      meta: {
        durationMs,
        rateLimit,
        vendorRequestId,
        apiVersion: 'v10',
      },
    };
  }

  private async extractErrorMessage(res: Response): Promise<string> {
    const text = await res.text();
    if (!text) {
      return `Discord API error (status ${res.status})`;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed.message) {
        return `Discord API error (${res.status}): ${parsed.message}${parsed.code ? ` [code ${parsed.code}]` : ''}`;
      }
      return JSON.stringify(parsed);
    } catch {
      return text;
    }
  }
}

// ==================== Helpers ====================

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

const CONNECTOR_PREFIX = 'discord';

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
    name: `${CONNECTOR_PREFIX}.list_guilds`,
    description: 'List guilds (servers) the bot has access to',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max guilds to return (1-200, default 200)' },
        cursor: { type: 'string', description: 'Pagination cursor (guild id to start after)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_guild`,
    description: 'Get detailed information about a guild (server)',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string', description: 'Guild id (uses DISCORD_GUILD_ID if omitted)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_channels`,
    description: 'List all channels in a guild',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string', description: 'Guild id (uses DISCORD_GUILD_ID if omitted)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_channel`,
    description: 'Create a new channel in a guild',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string', description: 'Guild id (uses DISCORD_GUILD_ID if omitted)' },
        name: { type: 'string', description: 'Channel name' },
        type: {
          type: 'number',
          description: 'Channel type (0=text, 2=voice, 4=category, 5=announcement, 13=stage, 15=forum)',
        },
        topic: { type: 'string', description: 'Channel topic (up to 1024 characters)' },
        parent_id: { type: 'string', description: 'Category channel id to nest under' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.edit_channel`,
    description: 'Edit an existing channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id' },
        name: { type: 'string', description: 'New channel name' },
        topic: { type: 'string', description: 'New channel topic' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.delete_channel`,
    description: 'Delete a channel (irreversible)',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id to delete' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.send_message`,
    description: 'Send a message to a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id to send to' },
        content: { type: 'string', description: 'Message text content (up to 2000 characters)' },
        embeds: {
          type: 'array',
          description: 'Array of embed objects (rich content cards, max 10)',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Embed title (max 256 characters)' },
              description: { type: 'string', description: 'Embed description (max 4096 characters)' },
              url: { type: 'string', description: 'URL for the title hyperlink' },
              color: { type: 'number', description: 'Color code as integer (e.g. 0x00ff00 = 65280)' },
              footer: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Footer text (max 2048 characters)' },
                  icon_url: { type: 'string', description: 'Footer icon URL' },
                },
              },
              image: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'Image URL' },
                },
              },
              thumbnail: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'Thumbnail URL' },
                },
              },
              author: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Author name (max 256 characters)' },
                  url: { type: 'string', description: 'Author URL' },
                  icon_url: { type: 'string', description: 'Author icon URL' },
                },
              },
              fields: {
                type: 'array',
                description: 'Array of field objects (max 25)',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Field name (max 256 characters)' },
                    value: { type: 'string', description: 'Field value (max 1024 characters)' },
                    inline: { type: 'boolean', description: 'Display field inline' },
                  },
                  required: ['name', 'value'],
                },
              },
            },
          },
        },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_messages`,
    description: 'Get recent messages from a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id' },
        limit: { type: 'number', description: 'Number of messages to fetch (1-100, default 50)' },
        before: { type: 'string', description: 'Get messages before this message id' },
        after: { type: 'string', description: 'Get messages after this message id' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_thread`,
    description: 'Create a new thread from a channel or message',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id to create thread in' },
        name: { type: 'string', description: 'Thread name' },
        message_id: { type: 'string', description: 'Message id to start thread from (optional for forum channels)' },
        auto_archive_duration: {
          type: 'number',
          description: 'Minutes before auto-archive (60, 1440, 4320, 10080)',
        },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['channel_id', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_roles`,
    description: 'List all roles in a guild',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string', description: 'Guild id (uses DISCORD_GUILD_ID if omitted)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_role`,
    description: 'Create a new role in a guild',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string', description: 'Guild id (uses DISCORD_GUILD_ID if omitted)' },
        name: { type: 'string', description: 'Role name' },
        color: { type: 'number', description: 'RGB color value as integer' },
        hoist: { type: 'boolean', description: 'Display role members separately in sidebar' },
        mentionable: { type: 'boolean', description: 'Allow anyone to mention this role' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.add_reaction`,
    description: 'Add a reaction emoji to a message',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id' },
        message_id: { type: 'string', description: 'Message id' },
        emoji: { type: 'string', description: 'Emoji (unicode character or name:id for custom emoji)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['channel_id', 'message_id', 'emoji'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_webhook`,
    description: 'Create a webhook for a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id' },
        name: { type: 'string', description: 'Webhook name (1-80 characters)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['channel_id', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_members`,
    description: 'List members of a guild',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string', description: 'Guild id (uses DISCORD_GUILD_ID if omitted)' },
        limit: { type: 'number', description: 'Max members to return (1-1000, default 100)' },
        cursor: { type: 'string', description: 'Pagination cursor (user id to start after)' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_channel`,
    description: 'Get detailed information about a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.edit_role`,
    description: 'Edit an existing role in a guild',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string', description: 'Guild id (uses DISCORD_GUILD_ID if omitted)' },
        role_id: { type: 'string', description: 'Role id to edit' },
        name: { type: 'string', description: 'New role name' },
        color: { type: 'number', description: 'New RGB color value as integer' },
        hoist: { type: 'boolean', description: 'Display role members separately in sidebar' },
        mentionable: { type: 'boolean', description: 'Allow anyone to mention this role' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['role_id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.delete_role`,
    description: 'Delete a role from a guild (irreversible)',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string', description: 'Guild id (uses DISCORD_GUILD_ID if omitted)' },
        role_id: { type: 'string', description: 'Role id to delete' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['role_id'],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_webhooks`,
    description: 'List all webhooks for a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id' },
        requestId: { type: 'string', description: 'Optional request id for tracing' },
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
  },
];

// ==================== Config & Client ====================

const config: DiscordConfig = {
  botToken: process.env.DISCORD_BOT_TOKEN,
  applicationId: process.env.DISCORD_APPLICATION_ID,
  defaultGuildId: process.env.DISCORD_GUILD_ID,
};

const client = new DiscordClient(config);

// ==================== Tool Handlers ====================

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async (args) => {
    const result = await client.health();
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.list_guilds`]: async (args) => {
    const result = await client.listGuilds(args.limit, args.cursor);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.get_guild`]: async (args) => {
    const guildId = resolveGuildId(args.guild_id);
    const result = await client.getGuild(guildId);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.list_channels`]: async (args) => {
    const guildId = resolveGuildId(args.guild_id);
    const result = await client.listChannels(guildId);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.create_channel`]: async (args) => {
    const guildId = resolveGuildId(args.guild_id);
    const payload: Record<string, any> = { name: args.name };
    if (args.type !== undefined) payload.type = args.type;
    if (args.topic) payload.topic = args.topic;
    if (args.parent_id) payload.parent_id = args.parent_id;
    const result = await client.createChannel(guildId, payload);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.edit_channel`]: async (args) => {
    const payload: Record<string, any> = {};
    if (args.name) payload.name = args.name;
    if (args.topic !== undefined) payload.topic = args.topic;
    const result = await client.editChannel(args.channel_id, payload);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.delete_channel`]: async (args) => {
    const result = await client.deleteChannel(args.channel_id);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.send_message`]: async (args) => {
    if (args.content && args.content.length > 2000) {
      throw new Error('Message content exceeds Discord\'s 2000-character limit');
    }
    if (args.embeds && args.embeds.length > 10) {
      throw new Error('A message can contain at most 10 embeds');
    }
    const payload: Record<string, any> = {};
    if (args.content) payload.content = args.content;
    if (args.embeds) payload.embeds = args.embeds;
    if (!payload.content && !payload.embeds) {
      throw new Error('At least one of content or embeds is required');
    }
    const result = await client.sendMessage(args.channel_id, payload);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.get_messages`]: async (args) => {
    try {
      const result = await client.getMessages(args.channel_id, args.limit, args.before, args.after);
      return buildEnvelope(result, args.requestId);
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('Missing Access') || msg.includes('(403)') || msg.includes('code 50001')) {
        throw new Error(
          `${msg}. Hint: Reading message content requires the "Message Content Intent" to be enabled in your bot's settings at https://discord.com/developers/applications.`,
        );
      }
      throw err;
    }
  },
  [`${CONNECTOR_PREFIX}.create_thread`]: async (args) => {
    const payload: Record<string, any> = { name: args.name };
    if (args.auto_archive_duration) payload.auto_archive_duration = args.auto_archive_duration;
    let result: RequestResult;
    if (args.message_id) {
      result = await client.createMessageThread(args.channel_id, args.message_id, payload);
    } else {
      payload.type = 11; // PUBLIC_THREAD (required for channel threads without a message)
      result = await client.createThread(args.channel_id, payload);
    }
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.list_roles`]: async (args) => {
    const guildId = resolveGuildId(args.guild_id);
    const result = await client.listRoles(guildId);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.create_role`]: async (args) => {
    const guildId = resolveGuildId(args.guild_id);
    const payload: Record<string, any> = { name: args.name };
    if (args.color !== undefined) payload.color = args.color;
    if (args.hoist !== undefined) payload.hoist = args.hoist;
    if (args.mentionable !== undefined) payload.mentionable = args.mentionable;
    const result = await client.createRole(guildId, payload);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.add_reaction`]: async (args) => {
    const result = await client.addReaction(args.channel_id, args.message_id, args.emoji);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.create_webhook`]: async (args) => {
    const result = await client.createWebhook(args.channel_id, { name: args.name });
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.list_members`]: async (args) => {
    const guildId = resolveGuildId(args.guild_id);
    try {
      const result = await client.listMembers(guildId, args.limit, args.cursor);
      return buildEnvelope(result, args.requestId);
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('Missing Access') || msg.includes('(403)') || msg.includes('code 50001')) {
        throw new Error(
          `${msg}. Hint: Listing guild members requires the "Server Members Intent" to be enabled in your bot's settings at https://discord.com/developers/applications.`,
        );
      }
      throw err;
    }
  },
  [`${CONNECTOR_PREFIX}.get_channel`]: async (args) => {
    const result = await client.getChannel(args.channel_id);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.edit_role`]: async (args) => {
    const guildId = resolveGuildId(args.guild_id);
    const payload: Record<string, any> = {};
    if (args.name !== undefined) payload.name = args.name;
    if (args.color !== undefined) payload.color = args.color;
    if (args.hoist !== undefined) payload.hoist = args.hoist;
    if (args.mentionable !== undefined) payload.mentionable = args.mentionable;
    const result = await client.editRole(guildId, args.role_id, payload);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.delete_role`]: async (args) => {
    const guildId = resolveGuildId(args.guild_id);
    const result = await client.deleteRole(guildId, args.role_id);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.list_webhooks`]: async (args) => {
    const result = await client.listWebhooks(args.channel_id);
    return buildEnvelope(result, args.requestId);
  },
};

// ==================== Server Bootstrap ====================

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
  name: 'Discord Connector',
  version: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

const server = new StdioMCPServer(toolProvider, serverInfo);
server.start();

// ==================== Utility Functions ====================

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
    },
    nextCursor: result.nextCursor,
    warnings,
  };
}

function resolveGuildId(explicitId?: string): string {
  const guildId = explicitId || config.defaultGuildId;
  if (!guildId) {
    throw new Error('guild_id is required (provide it in the request or set DISCORD_GUILD_ID)');
  }
  return guildId;
}
