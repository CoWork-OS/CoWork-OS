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

// ==================== Tool Provider ====================

type ToolProvider = {
  getTools(): MCPTool[];
  executeTool(name: string, args: Record<string, any>): Promise<any>;
};

// ==================== MCP Stdio Server ====================

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

// ==================== Google API Helpers ====================

const GOOGLE_ACCESS_TOKEN = process.env.GOOGLE_ACCESS_TOKEN || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || '';
const GOOGLE_SCOPES = process.env.GOOGLE_SCOPES || process.env.GOOGLE_WORKSPACE_SCOPES || '';

const REQUIRED_GOOGLE_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
];

const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const MAX_CALENDAR_BATCH_READ_EVENTS = 50;
const RFC3339_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

let cachedAccessToken = GOOGLE_ACCESS_TOKEN;
let tokenExpiry = 0;

function normalizeScopeList(scopeText: string): string[] {
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const rawScope of scopeText.split(/\s+/)) {
    const scope = rawScope.trim();
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    scopes.push(scope);
  }
  return scopes;
}

function getMissingRequiredScopes(scopeText: string): string[] {
  const configuredScopes = normalizeScopeList(scopeText);
  if (configuredScopes.length === 0) return [];
  const configured = new Set(configuredScopes);
  return REQUIRED_GOOGLE_WORKSPACE_SCOPES.filter((scope) => !configured.has(scope));
}

async function refreshAccessToken(): Promise<string> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Missing Google OAuth credentials for token refresh');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
    }).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${text}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in?: number };
  cachedAccessToken = data.access_token;
  tokenExpiry = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
  return cachedAccessToken;
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && (tokenExpiry === 0 || Date.now() < tokenExpiry)) {
    return cachedAccessToken;
  }
  return refreshAccessToken();
}

async function googleRequest(
  method: string,
  url: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<unknown> {
  const token = await getAccessToken();

  let fullUrl = url;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    fullUrl = `${url}?${qs}`;
  }

  const response = await fetch(fullUrl, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google API ${response.status}: ${text}`);
  }

  // 204 No Content
  if (response.status === 204) {
    return { ok: true };
  }

  return response.json();
}

function hasOwn(args: Record<string, any>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function pickPresentFields(args: Record<string, any>, fields: string[]): Record<string, any> {
  const body: Record<string, any> = {};
  for (const field of fields) {
    if (hasOwn(args, field) && args[field] !== undefined) {
      body[field] = args[field];
    }
  }
  return body;
}

function pickQueryParams(args: Record<string, any>, fields: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const field of fields) {
    if (hasOwn(args, field) && args[field] !== undefined && args[field] !== null) {
      params[field] = String(args[field]);
    }
  }
  return params;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function requireConfirmation(args: Record<string, any>, action: string): void {
  if (args.confirm !== true) {
    throw new Error(`Confirmation required before ${action}. Set confirm to true only after the user explicitly confirms.`);
  }
}

function randomObjectId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function calendarUrl(path: string): string {
  return `${GOOGLE_CALENDAR_API_BASE}${path}`;
}

function encodeCalendarId(calendarId?: unknown): string {
  const id = typeof calendarId === 'string' && calendarId.trim() ? calendarId.trim() : 'primary';
  return encodeURIComponent(id);
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const items = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(`${label} must include at least one non-empty string`);
  }
  return items;
}

function normalizeCalendarDateField(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object with dateTime or date`);
  }
  const dateField = value as Record<string, any>;
  const body = pickPresentFields(dateField, ['dateTime', 'date', 'timeZone']);
  if (!body.dateTime && !body.date) {
    throw new Error(`${label} must include dateTime or date`);
  }
  if (body.dateTime) {
    body.dateTime = requireRfc3339DateTime(body.dateTime, `${label}.dateTime`);
  }
  return body;
}

function buildCalendarEventBody(args: Record<string, any>, requireCoreFields: boolean): Record<string, any> {
  const body = pickPresentFields(args, ['summary', 'description', 'location', 'visibility', 'transparency']);
  if (hasOwn(args, 'start') && args.start !== undefined) {
    body.start = normalizeCalendarDateField(args.start, 'start');
  }
  if (hasOwn(args, 'end') && args.end !== undefined) {
    body.end = normalizeCalendarDateField(args.end, 'end');
  }
  if (hasOwn(args, 'attendees') && args.attendees !== undefined) {
    if (!Array.isArray(args.attendees)) {
      throw new Error('attendees must be an array');
    }
    body.attendees = args.attendees.map((attendee: unknown) => {
      if (!attendee || typeof attendee !== 'object' || Array.isArray(attendee)) {
        throw new Error('attendees entries must be objects with email');
      }
      const email = requireNonEmptyString((attendee as Record<string, any>).email, 'attendee email');
      return { ...pickPresentFields(attendee as Record<string, any>, ['displayName', 'optional']), email };
    });
  }
  if (hasOwn(args, 'attendeeEmails') && args.attendeeEmails !== undefined) {
    const attendeesFromEmails = requireStringArray(args.attendeeEmails, 'attendeeEmails').map((email) => ({ email }));
    body.attendees = [...(body.attendees || []), ...attendeesFromEmails];
  }
  if (hasOwn(args, 'reminders') && args.reminders !== undefined) {
    body.reminders = args.reminders;
  }
  if (hasOwn(args, 'conferenceData') && args.conferenceData !== undefined) {
    body.conferenceData = args.conferenceData;
  }
  if (requireCoreFields) {
    body.summary = requireNonEmptyString(body.summary, 'summary');
    if (!body.start) throw new Error('Missing start');
    if (!body.end) throw new Error('Missing end');
  }
  if (Object.keys(body).length === 0) {
    throw new Error('At least one calendar event field must be provided');
  }
  return body;
}

function requireRfc3339DateTime(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, label);
  if (!RFC3339_WITH_ZONE_RE.test(text)) {
    throw new Error(`${label} must be an RFC3339 datetime with Z or an explicit UTC offset`);
  }
  return text;
}

function requireValidTimeWindow(timeMinValue: unknown, timeMaxValue: unknown): { timeMin: string; timeMax: string } {
  const timeMin = requireRfc3339DateTime(timeMinValue, 'timeMin');
  const timeMax = requireRfc3339DateTime(timeMaxValue, 'timeMax');
  if (Date.parse(timeMin) >= Date.parse(timeMax)) {
    throw new Error('timeMin must be before timeMax');
  }
  return { timeMin, timeMax };
}

// ==================== Tool Definitions ====================

const tools: MCPTool[] = [
  // Health
  {
    name: 'google-workspace.health',
    description: 'Check Google Workspace connector health and authentication status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  // ── Sheets ──────────────────────────────────────────────
  {
    name: 'google-workspace.sheets_create',
    description: 'Create a new Google Spreadsheet',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the new spreadsheet' },
        sheets: {
          type: 'array',
          description: 'Optional list of sheet names to create (defaults to one sheet named "Sheet1")',
          items: { type: 'string' },
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.sheets_get',
    description: 'Get spreadsheet metadata including sheet names, dimensions, and properties',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'The spreadsheet ID from its URL' },
      },
      required: ['spreadsheetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.sheets_values_get',
    description: 'Read cell values from a spreadsheet range (e.g. "Sheet1!A1:D10")',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'The spreadsheet ID' },
        range: { type: 'string', description: 'A1 notation range, e.g. "Sheet1!A1:D10" or "A1:D10"' },
        majorDimension: {
          type: 'string',
          enum: ['ROWS', 'COLUMNS'],
          description: 'Whether values are arranged by rows or columns (default: ROWS)',
          default: 'ROWS',
        },
      },
      required: ['spreadsheetId', 'range'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.sheets_values_update',
    description: 'Write values to a spreadsheet range',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'The spreadsheet ID' },
        range: { type: 'string', description: 'A1 notation range to write into, e.g. "Sheet1!A1"' },
        values: {
          type: 'array',
          description: '2D array of values (rows of columns)',
          items: { type: 'array', items: { type: 'string' } },
        },
        valueInputOption: {
          type: 'string',
          enum: ['RAW', 'USER_ENTERED'],
          description: 'How input data should be interpreted (default: USER_ENTERED)',
          default: 'USER_ENTERED',
        },
      },
      required: ['spreadsheetId', 'range', 'values'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.sheets_values_append',
    description: 'Append rows to a spreadsheet after the last row with data',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'The spreadsheet ID' },
        range: { type: 'string', description: 'A1 notation range to search for existing data, e.g. "Sheet1!A1"' },
        values: {
          type: 'array',
          description: '2D array of rows to append',
          items: { type: 'array', items: { type: 'string' } },
        },
        valueInputOption: {
          type: 'string',
          enum: ['RAW', 'USER_ENTERED'],
          default: 'USER_ENTERED',
        },
      },
      required: ['spreadsheetId', 'range', 'values'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.sheets_values_clear',
    description: 'Clear values from a spreadsheet range',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'The spreadsheet ID' },
        range: { type: 'string', description: 'A1 notation range to clear' },
      },
      required: ['spreadsheetId', 'range'],
      additionalProperties: false,
    },
  },

  // ── Docs ─────────────────────────────────────────────────
  {
    name: 'google-workspace.docs_create',
    description: 'Create a new Google Document',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the new document' },
        content: {
          type: 'string',
          description: 'Optional plain-text content to insert as the first paragraph',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.docs_get',
    description: 'Get a Google Document including its full content and structure',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'The document ID from its URL' },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.docs_append_text',
    description: 'Append plain text to the end of a Google Document',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'The document ID' },
        text: { type: 'string', description: 'Text to append (use \\n for new lines)' },
      },
      required: ['documentId', 'text'],
      additionalProperties: false,
    },
  },

  // ── Chat ─────────────────────────────────────────────────
  {
    name: 'google-workspace.chat_spaces_list',
    description: 'List Google Chat spaces (rooms and direct messages) the authenticated user belongs to',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: {
          type: 'number',
          description: 'Maximum number of spaces to return (default: 100)',
          default: 100,
        },
        filter: {
          type: 'string',
          description: 'Filter string, e.g. "spaceType = \"SPACE\"" to only return named spaces',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.chat_messages_list',
    description: 'List messages in a Google Chat space',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'Space resource name, e.g. "spaces/AAAABBBBCCCC"',
        },
        pageSize: {
          type: 'number',
          description: 'Maximum number of messages to return (default: 25)',
          default: 25,
        },
        orderBy: {
          type: 'string',
          description: 'Sort order: "createTime ASC" or "createTime DESC" (default: createTime DESC)',
          default: 'createTime DESC',
        },
      },
      required: ['spaceName'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.chat_messages_create',
    description: 'Send a message to a Google Chat space',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'Space resource name, e.g. "spaces/AAAABBBBCCCC"',
        },
        text: { type: 'string', description: 'Plain-text message content' },
        threadKey: {
          type: 'string',
          description: 'Optional thread key to reply in an existing thread',
        },
      },
      required: ['spaceName', 'text'],
      additionalProperties: false,
    },
  },

  // ── Drive (enhanced) ─────────────────────────────────────
  {
    name: 'google-workspace.drive_files_list',
    description: 'List or search files in Google Drive using Drive query syntax',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Drive query string, e.g. "name contains \'report\'" or "mimeType=\'application/vnd.google-apps.spreadsheet\'"',
        },
        pageSize: {
          type: 'number',
          description: 'Number of files to return (default: 20, max: 100)',
          default: 20,
        },
        orderBy: {
          type: 'string',
          description: 'Sort order, e.g. "modifiedTime desc" or "name"',
          default: 'modifiedTime desc',
        },
        fields: {
          type: 'string',
          description: 'Fields to include, e.g. "files(id,name,mimeType,modifiedTime,size)"',
          default: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.drive_files_get',
    description: 'Get metadata for a specific Drive file',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'The file ID' },
        fields: {
          type: 'string',
          description: 'Fields to return',
          default: 'id,name,mimeType,modifiedTime,size,webViewLink,parents',
        },
      },
      required: ['fileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.drive_folders_create',
    description: 'Create a folder in Google Drive',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name' },
        parentId: { type: 'string', description: 'Optional parent folder ID' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },

  // ── Calendar ─────────────────────────────────────────────
  {
    name: 'google-workspace.calendar_calendars_list',
    description: 'List calendars visible to the authenticated Google Calendar user',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Maximum calendars to return (default: 100, max: 250)', default: 100 },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.calendar_events_list',
    description: 'List or search Google Calendar events in a calendar',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (defaults to primary)' },
        query: { type: 'string', description: 'Free-text event search query' },
        timeMin: { type: 'string', description: 'Lower event start bound, RFC3339 datetime' },
        timeMax: { type: 'string', description: 'Upper event start bound, RFC3339 datetime' },
        maxResults: { type: 'number', description: 'Maximum events to return (default: 20, max: 250)', default: 20 },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
        singleEvents: { type: 'boolean', description: 'Expand recurring events into instances (default: true)', default: true },
        orderBy: { type: 'string', enum: ['startTime', 'updated'], description: 'Event ordering' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.calendar_event_get',
    description: 'Get a Google Calendar event by ID',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (defaults to primary)' },
        eventId: { type: 'string', description: 'Google Calendar event ID' },
      },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.calendar_events_batch_get',
    description: 'Get multiple Google Calendar events by ID from one calendar',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (defaults to primary)' },
        eventIds: {
          type: 'array',
          description: 'Google Calendar event IDs to read in order',
          items: { type: 'string' },
        },
      },
      required: ['eventIds'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.calendar_availability_get',
    description: 'Look up busy windows for one or more Google calendars before scheduling',
    inputSchema: {
      type: 'object',
      properties: {
        calendarIds: {
          type: 'array',
          description: 'Calendar IDs such as primary, a coworker email, or a room/resource email',
          items: { type: 'string' },
        },
        timeMin: { type: 'string', description: 'Required RFC3339 datetime with timezone offset or Z' },
        timeMax: { type: 'string', description: 'Required RFC3339 datetime with timezone offset or Z' },
        timeZone: { type: 'string', description: 'IANA timezone for returned busy timestamps' },
      },
      required: ['calendarIds', 'timeMin', 'timeMax'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.calendar_event_create',
    description: 'Create a Google Calendar event. Confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (defaults to primary)' },
        summary: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
        start: {
          type: 'object',
          description: 'Event start object with dateTime or date, plus optional timeZone',
          properties: {
            dateTime: { type: 'string', description: 'RFC3339 start datetime' },
            date: { type: 'string', description: 'All-day start date (YYYY-MM-DD)' },
            timeZone: { type: 'string', description: 'IANA timezone' },
          },
        },
        end: {
          type: 'object',
          description: 'Event end object with dateTime or date, plus optional timeZone',
          properties: {
            dateTime: { type: 'string', description: 'RFC3339 end datetime' },
            date: { type: 'string', description: 'All-day end date (YYYY-MM-DD)' },
            timeZone: { type: 'string', description: 'IANA timezone' },
          },
        },
        attendees: {
          type: 'array',
          description: 'Attendee objects with email',
          items: {
            type: 'object',
            description: 'Attendee object',
            properties: {
              email: { type: 'string', description: 'Attendee email address' },
              displayName: { type: 'string', description: 'Optional display name' },
              optional: { type: 'boolean', description: 'Whether attendance is optional' },
            },
            required: ['email'],
          },
        },
        attendeeEmails: {
          type: 'array',
          description: 'Convenience list of attendee email addresses',
          items: { type: 'string' },
        },
        sendUpdates: { type: 'string', enum: ['all', 'externalOnly', 'none'], description: 'Who receives event update emails' },
        conferenceDataVersion: { type: 'number', description: 'Set to 1 when creating conference data' },
        conferenceData: { type: 'object', description: 'Optional Google Calendar conferenceData object' },
        confirm: {
          type: 'boolean',
          description: 'Must be true after the user explicitly confirms creating this calendar event',
        },
      },
      required: ['summary', 'start', 'end', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.calendar_event_update',
    description: 'Update a Google Calendar event. Confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (defaults to primary)' },
        eventId: { type: 'string', description: 'Google Calendar event ID' },
        summary: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
        start: { type: 'object', description: 'Event start object with dateTime or date, plus optional timeZone' },
        end: { type: 'object', description: 'Event end object with dateTime or date, plus optional timeZone' },
        attendees: {
          type: 'array',
          description: 'Attendee objects with email',
          items: {
            type: 'object',
            description: 'Attendee object',
            properties: {
              email: { type: 'string', description: 'Attendee email address' },
              displayName: { type: 'string', description: 'Optional display name' },
              optional: { type: 'boolean', description: 'Whether attendance is optional' },
            },
            required: ['email'],
          },
        },
        attendeeEmails: {
          type: 'array',
          description: 'Convenience list of attendee email addresses',
          items: { type: 'string' },
        },
        sendUpdates: { type: 'string', enum: ['all', 'externalOnly', 'none'], description: 'Who receives event update emails' },
        conferenceDataVersion: { type: 'number', description: 'Set to 1 when updating conference data' },
        conferenceData: { type: 'object', description: 'Optional Google Calendar conferenceData object' },
        confirm: {
          type: 'boolean',
          description: 'Must be true after the user explicitly confirms updating this calendar event',
        },
      },
      required: ['eventId', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.calendar_event_delete',
    description: 'Delete a Google Calendar event. Confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (defaults to primary)' },
        eventId: { type: 'string', description: 'Google Calendar event ID' },
        sendUpdates: { type: 'string', enum: ['all', 'externalOnly', 'none'], description: 'Who receives cancellation emails' },
        confirm: {
          type: 'boolean',
          description: 'Must be true after the user explicitly confirms deleting this calendar event',
        },
      },
      required: ['eventId', 'confirm'],
      additionalProperties: false,
    },
  },

  // ── Tasks ────────────────────────────────────────────────
  {
    name: 'google-workspace.tasks_lists_list',
    description: 'List Google Tasks task lists',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Maximum task lists to return (default: 20, max: 100)', default: 20 },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_lists_create',
    description: 'Create a Google Tasks task list',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task list title' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_lists_update',
    description: 'Update a Google Tasks task list title',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        title: { type: 'string', description: 'New task list title' },
      },
      required: ['tasklistId', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_lists_delete',
    description: 'Delete a Google Tasks task list. Confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        confirm: {
          type: 'boolean',
          description: 'Must be true after the user explicitly confirms deleting this task list',
        },
      },
      required: ['tasklistId', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_list',
    description: 'List tasks in a Google Tasks task list',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        maxResults: { type: 'number', description: 'Maximum tasks to return (default: 20, max: 100)', default: 20 },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
        showCompleted: { type: 'boolean', description: 'Include completed tasks' },
        showDeleted: { type: 'boolean', description: 'Include deleted tasks' },
        showHidden: { type: 'boolean', description: 'Include hidden tasks' },
        showAssigned: { type: 'boolean', description: 'Include assigned tasks from Docs or Chat Spaces' },
        dueMin: { type: 'string', description: 'Lower due-date bound, RFC3339' },
        dueMax: { type: 'string', description: 'Upper due-date bound, RFC3339' },
        completedMin: { type: 'string', description: 'Lower completion-date bound, RFC3339' },
        completedMax: { type: 'string', description: 'Upper completion-date bound, RFC3339' },
        updatedMin: { type: 'string', description: 'Lower updated-time bound, RFC3339' },
      },
      required: ['tasklistId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_get',
    description: 'Get one Google Tasks task',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        taskId: { type: 'string', description: 'Task ID' },
      },
      required: ['tasklistId', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_create',
    description: 'Create a task in a Google Tasks task list',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        title: { type: 'string', description: 'Task title' },
        notes: { type: 'string', description: 'Task notes or description' },
        due: { type: 'string', description: 'Due date/time, RFC3339 or Google-compatible date string' },
        status: { type: 'string', enum: ['needsAction', 'completed'], description: 'Initial task status' },
        parent: { type: 'string', description: 'Optional parent task ID for subtasks' },
        previous: { type: 'string', description: 'Optional previous sibling task ID for ordering' },
      },
      required: ['tasklistId', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_update',
    description: 'Update a Google Tasks task with provided fields',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        taskId: { type: 'string', description: 'Task ID' },
        title: { type: 'string', description: 'New task title; pass an empty string to clear when Google allows it' },
        notes: { type: 'string', description: 'New task notes; pass an empty string to clear' },
        due: { type: 'string', description: 'New due date/time' },
        clearDue: { type: 'boolean', description: 'Set true to clear the due date' },
        status: { type: 'string', enum: ['needsAction', 'completed'], description: 'New task status' },
      },
      required: ['tasklistId', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_complete',
    description: 'Mark a Google Tasks task completed',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        taskId: { type: 'string', description: 'Task ID' },
      },
      required: ['tasklistId', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_uncomplete',
    description: 'Mark a Google Tasks task as needsAction',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        taskId: { type: 'string', description: 'Task ID' },
      },
      required: ['tasklistId', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_move',
    description: 'Move a Google Tasks task within its list',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        taskId: { type: 'string', description: 'Task ID' },
        parent: { type: 'string', description: 'New parent task ID' },
        previous: { type: 'string', description: 'New previous sibling task ID' },
      },
      required: ['tasklistId', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_delete',
    description: 'Delete a Google Tasks task. Confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        taskId: { type: 'string', description: 'Task ID' },
        confirm: {
          type: 'boolean',
          description: 'Must be true after the user explicitly confirms deleting this task',
        },
        deleteAssignedTaskEverywhere: {
          type: 'boolean',
          description:
            'Required for assigned tasks. Confirms the user understands deleting can remove the original task from Docs or Chat Spaces.',
        },
      },
      required: ['tasklistId', 'taskId', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.tasks_clear_completed',
    description: 'Clear completed tasks from a Google Tasks task list. Confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        tasklistId: { type: 'string', description: 'Task list ID' },
        confirm: {
          type: 'boolean',
          description: 'Must be true after the user explicitly confirms clearing completed tasks',
        },
      },
      required: ['tasklistId', 'confirm'],
      additionalProperties: false,
    },
  },

  // ── Slides ───────────────────────────────────────────────
  {
    name: 'google-workspace.slides_create',
    description: 'Create a new Google Slides presentation',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Presentation title' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.slides_get',
    description: 'Get a Google Slides presentation including page structure',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID from its URL' },
        fields: { type: 'string', description: 'Optional partial response field mask' },
      },
      required: ['presentationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.slides_create_slide',
    description: 'Create a slide in a Google Slides presentation',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        objectId: { type: 'string', description: 'Optional object ID for the new slide' },
        insertionIndex: { type: 'number', description: 'Optional zero-based insertion index' },
        predefinedLayout: {
          type: 'string',
          description: 'Predefined layout name (default: BLANK)',
          default: 'BLANK',
        },
      },
      required: ['presentationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.slides_delete_slide',
    description: 'Delete a slide from a Google Slides presentation. Confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        pageObjectId: { type: 'string', description: 'Slide page object ID to delete' },
        confirm: {
          type: 'boolean',
          description: 'Must be true after the user explicitly confirms deleting this slide',
        },
      },
      required: ['presentationId', 'pageObjectId', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.slides_add_text_box',
    description: 'Add a text box to a Google Slides slide',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        pageObjectId: { type: 'string', description: 'Slide page object ID' },
        text: { type: 'string', description: 'Text to insert into the text box' },
        objectId: { type: 'string', description: 'Optional object ID for the text box' },
        x: { type: 'number', description: 'X offset in unit coordinates (default: 72)', default: 72 },
        y: { type: 'number', description: 'Y offset in unit coordinates (default: 72)', default: 72 },
        width: { type: 'number', description: 'Text box width (default: 576)', default: 576 },
        height: { type: 'number', description: 'Text box height (default: 120)', default: 120 },
        unit: { type: 'string', enum: ['PT', 'EMU'], description: 'Dimension unit (default: PT)', default: 'PT' },
      },
      required: ['presentationId', 'pageObjectId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.slides_replace_all_text',
    description: 'Replace matching text throughout a Google Slides presentation',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        text: { type: 'string', description: 'Text to find' },
        replaceText: { type: 'string', description: 'Replacement text' },
        matchCase: { type: 'boolean', description: 'Whether matching is case-sensitive', default: false },
        confirm: {
          type: 'boolean',
          description: 'Must be true after the user explicitly confirms replacing text throughout the presentation',
        },
      },
      required: ['presentationId', 'text', 'replaceText', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'google-workspace.slides_batch_update',
    description: 'Run raw Google Slides presentations.batchUpdate requests for advanced edits',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        requests: {
          type: 'array',
          description: 'Raw Google Slides API Request objects',
          items: { type: 'object', description: 'Google Slides API Request object' },
        },
        writeControl: { type: 'object', description: 'Optional Google Slides writeControl object' },
        confirm: {
          type: 'boolean',
          description: 'Must be true after the user explicitly confirms running raw batchUpdate requests',
        },
      },
      required: ['presentationId', 'requests', 'confirm'],
      additionalProperties: false,
    },
  },
];

// ==================== Tool Handlers ====================

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {

  'google-workspace.health': async () => {
    const missingScopes = getMissingRequiredScopes(GOOGLE_SCOPES);
    if (missingScopes.length > 0) {
      return {
        ok: true,
        data: {
          status: 'missing_scopes',
          connector: 'google-workspace',
          tokenPresent: Boolean(cachedAccessToken || GOOGLE_REFRESH_TOKEN),
          missingScopes,
          error: `Reconnect Google Workspace with the required scopes: ${missingScopes.join(', ')}`,
        },
      };
    }

    const token = await getAccessToken();
    // Verify the token works by checking the Drive API
    const result = (await googleRequest('GET', 'https://www.googleapis.com/drive/v3/about', undefined, {
      fields: 'user',
    })) as any;

    return {
      ok: true,
      data: {
        status: 'ok',
        connector: 'google-workspace',
        user: result?.user?.emailAddress || 'unknown',
        tokenPresent: Boolean(token),
        scopeWarning: GOOGLE_SCOPES
          ? undefined
          : 'GOOGLE_SCOPES is not configured, so health cannot verify every Workspace API scope.',
      },
    };
  },

  // ── Sheets ──────────────────────────────────────────────

  'google-workspace.sheets_create': async (args) => {
    const body: any = {
      properties: { title: args.title },
    };
    if (args.sheets && Array.isArray(args.sheets)) {
      body.sheets = args.sheets.map((name: string) => ({
        properties: { title: name },
      }));
    }
    const result = await googleRequest(
      'POST',
      'https://sheets.googleapis.com/v4/spreadsheets',
      body,
    );
    return { ok: true, data: result };
  },

  'google-workspace.sheets_get': async (args) => {
    const result = await googleRequest(
      'GET',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}`,
    );
    return { ok: true, data: result };
  },

  'google-workspace.sheets_values_get': async (args) => {
    const params: Record<string, string> = {
      majorDimension: args.majorDimension || 'ROWS',
    };
    const result = await googleRequest(
      'GET',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}`,
      undefined,
      params,
    );
    return { ok: true, data: result };
  },

  'google-workspace.sheets_values_update': async (args) => {
    const params: Record<string, string> = {
      valueInputOption: args.valueInputOption || 'USER_ENTERED',
    };
    const result = await googleRequest(
      'PUT',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}?${new URLSearchParams(params)}`,
      { range: args.range, majorDimension: 'ROWS', values: args.values },
    );
    return { ok: true, data: result };
  },

  'google-workspace.sheets_values_append': async (args) => {
    const params: Record<string, string> = {
      valueInputOption: args.valueInputOption || 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
    };
    const result = await googleRequest(
      'POST',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}:append?${new URLSearchParams(params)}`,
      { range: args.range, majorDimension: 'ROWS', values: args.values },
    );
    return { ok: true, data: result };
  },

  'google-workspace.sheets_values_clear': async (args) => {
    const result = await googleRequest(
      'POST',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}:clear`,
      {},
    );
    return { ok: true, data: result };
  },

  // ── Docs ─────────────────────────────────────────────────

  'google-workspace.docs_create': async (args) => {
    const doc = (await googleRequest(
      'POST',
      'https://docs.googleapis.com/v1/documents',
      { title: args.title },
    )) as any;

    if (args.content && doc.documentId) {
      // Append initial text via batchUpdate
      await googleRequest(
        'POST',
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(doc.documentId)}:batchUpdate`,
        {
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: args.content,
              },
            },
          ],
        },
      );
    }

    return { ok: true, data: doc };
  },

  'google-workspace.docs_get': async (args) => {
    const result = await googleRequest(
      'GET',
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(args.documentId)}`,
    );
    return { ok: true, data: result };
  },

  'google-workspace.docs_append_text': async (args) => {
    // Get the document to find the end index
    const doc = (await googleRequest(
      'GET',
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(args.documentId)}`,
    )) as any;

    const endIndex = doc?.body?.content?.at(-1)?.endIndex ?? 1;
    // Insert before the final newline that terminates the document
    const insertIndex = Math.max(1, endIndex - 1);

    const result = await googleRequest(
      'POST',
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(args.documentId)}:batchUpdate`,
      {
        requests: [
          {
            insertText: {
              location: { index: insertIndex },
              text: args.text,
            },
          },
        ],
      },
    );
    return { ok: true, data: result };
  },

  // ── Chat ─────────────────────────────────────────────────

  'google-workspace.chat_spaces_list': async (args) => {
    const params: Record<string, string> = {
      pageSize: String(args.pageSize || 100),
    };
    if (args.filter) params.filter = args.filter;

    const result = await googleRequest(
      'GET',
      'https://chat.googleapis.com/v1/spaces',
      undefined,
      params,
    );
    return { ok: true, data: result };
  },

  'google-workspace.chat_messages_list': async (args) => {
    const params: Record<string, string> = {
      pageSize: String(args.pageSize || 25),
      orderBy: args.orderBy || 'createTime DESC',
    };

    const result = await googleRequest(
      'GET',
      `https://chat.googleapis.com/v1/${args.spaceName}/messages`,
      undefined,
      params,
    );
    return { ok: true, data: result };
  },

  'google-workspace.chat_messages_create': async (args) => {
    const body: any = { text: args.text };
    const params: Record<string, string> = {};

    if (args.threadKey) {
      params.threadKey = args.threadKey;
    }

    const result = await googleRequest(
      'POST',
      `https://chat.googleapis.com/v1/${args.spaceName}/messages`,
      body,
      Object.keys(params).length ? params : undefined,
    );
    return { ok: true, data: result };
  },

  // ── Drive (enhanced) ─────────────────────────────────────

  'google-workspace.drive_files_list': async (args) => {
    const params: Record<string, string> = {
      pageSize: String(Math.min(args.pageSize || 20, 100)),
      fields: args.fields || 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
      orderBy: args.orderBy || 'modifiedTime desc',
    };
    if (args.query) params.q = args.query;

    const result = await googleRequest(
      'GET',
      'https://www.googleapis.com/drive/v3/files',
      undefined,
      params,
    );
    return { ok: true, data: result };
  },

  'google-workspace.drive_files_get': async (args) => {
    const params: Record<string, string> = {
      fields: args.fields || 'id,name,mimeType,modifiedTime,size,webViewLink,parents',
    };

    const result = await googleRequest(
      'GET',
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.fileId)}`,
      undefined,
      params,
    );
    return { ok: true, data: result };
  },

  'google-workspace.drive_folders_create': async (args) => {
    const body: Record<string, any> = {
      name: args.name,
      mimeType: 'application/vnd.google-apps.folder',
    };
    if (args.parentId) body.parents = [args.parentId];
    const result = await googleRequest(
      'POST',
      'https://www.googleapis.com/drive/v3/files',
      body,
      { fields: 'id,name,mimeType,parents,webViewLink' },
    );
    return { ok: true, data: result };
  },

  // ── Calendar ─────────────────────────────────────────────

  'google-workspace.calendar_calendars_list': async (args) => {
    const params = pickQueryParams(args, ['pageToken']);
    params.maxResults = String(Math.min(numberOrDefault(args.maxResults, 100), 250));
    const result = await googleRequest(
      'GET',
      calendarUrl('/users/me/calendarList'),
      undefined,
      params,
    );
    return { ok: true, data: result };
  },

  'google-workspace.calendar_events_list': async (args) => {
    const calendarId = encodeCalendarId(args.calendarId);
    const params = pickQueryParams(args, ['query', 'timeMin', 'timeMax', 'pageToken', 'orderBy']);
    if (params.query) {
      params.q = params.query;
      delete params.query;
    }
    params.maxResults = String(Math.min(numberOrDefault(args.maxResults, 20), 250));
    params.singleEvents = String(args.singleEvents ?? true);
    const result = await googleRequest(
      'GET',
      calendarUrl(`/calendars/${calendarId}/events`),
      undefined,
      params,
    );
    return { ok: true, data: result };
  },

  'google-workspace.calendar_event_get': async (args) => {
    const calendarId = encodeCalendarId(args.calendarId);
    const eventId = requireNonEmptyString(args.eventId, 'eventId');
    const result = await googleRequest(
      'GET',
      calendarUrl(`/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`),
    );
    return { ok: true, data: result };
  },

  'google-workspace.calendar_events_batch_get': async (args) => {
    const calendarIdRaw = typeof args.calendarId === 'string' && args.calendarId.trim() ? args.calendarId.trim() : 'primary';
    const calendarId = encodeURIComponent(calendarIdRaw);
    const eventIds = requireStringArray(args.eventIds, 'eventIds');
    if (eventIds.length > MAX_CALENDAR_BATCH_READ_EVENTS) {
      throw new Error(`eventIds supports at most ${MAX_CALENDAR_BATCH_READ_EVENTS} events per batch`);
    }
    const events = await Promise.all(
      eventIds.map(async (eventId) => {
        try {
          return {
            eventId,
            data: await googleRequest(
              'GET',
              calendarUrl(`/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`),
            ),
          };
        } catch (error: any) {
          return {
            eventId,
            error: error?.message || String(error),
          };
        }
      }),
    );
    return { ok: true, data: { calendarId: calendarIdRaw, events } };
  },

  'google-workspace.calendar_availability_get': async (args) => {
    const calendarIds = requireStringArray(args.calendarIds, 'calendarIds');
    const { timeMin, timeMax } = requireValidTimeWindow(args.timeMin, args.timeMax);
    const body: Record<string, any> = {
      timeMin,
      timeMax,
      items: calendarIds.map((id) => ({ id })),
    };
    if (args.timeZone) body.timeZone = String(args.timeZone);
    const result = await googleRequest(
      'POST',
      calendarUrl('/freeBusy'),
      body,
    );
    return { ok: true, data: result };
  },

  'google-workspace.calendar_event_create': async (args) => {
    requireConfirmation(args, 'creating a Google Calendar event');
    const calendarId = encodeCalendarId(args.calendarId);
    const body = buildCalendarEventBody(args, true);
    const params = pickQueryParams(args, ['sendUpdates', 'conferenceDataVersion']);
    const result = await googleRequest(
      'POST',
      calendarUrl(`/calendars/${calendarId}/events`),
      body,
      Object.keys(params).length ? params : undefined,
    );
    return { ok: true, data: result };
  },

  'google-workspace.calendar_event_update': async (args) => {
    requireConfirmation(args, 'updating a Google Calendar event');
    const calendarId = encodeCalendarId(args.calendarId);
    const eventId = requireNonEmptyString(args.eventId, 'eventId');
    const body = buildCalendarEventBody(args, false);
    const params = pickQueryParams(args, ['sendUpdates', 'conferenceDataVersion']);
    const result = await googleRequest(
      'PATCH',
      calendarUrl(`/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`),
      body,
      Object.keys(params).length ? params : undefined,
    );
    return { ok: true, data: result };
  },

  'google-workspace.calendar_event_delete': async (args) => {
    requireConfirmation(args, 'deleting a Google Calendar event');
    const calendarId = encodeCalendarId(args.calendarId);
    const eventId = requireNonEmptyString(args.eventId, 'eventId');
    const params = pickQueryParams(args, ['sendUpdates']);
    const result = await googleRequest(
      'DELETE',
      calendarUrl(`/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`),
      undefined,
      Object.keys(params).length ? params : undefined,
    );
    return { ok: true, data: result };
  },

  // ── Tasks ────────────────────────────────────────────────

  'google-workspace.tasks_lists_list': async (args) => {
    const params: Record<string, string> = {
      maxResults: String(Math.min(numberOrDefault(args.maxResults, 20), 100)),
    };
    if (args.pageToken) params.pageToken = String(args.pageToken);

    const result = await googleRequest(
      'GET',
      'https://tasks.googleapis.com/tasks/v1/users/@me/lists',
      undefined,
      params,
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_lists_create': async (args) => {
    const title = requireNonEmptyString(args.title, 'title');
    const result = await googleRequest(
      'POST',
      'https://tasks.googleapis.com/tasks/v1/users/@me/lists',
      { title },
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_lists_update': async (args) => {
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const title = requireNonEmptyString(args.title, 'title');
    const result = await googleRequest(
      'PATCH',
      `https://tasks.googleapis.com/tasks/v1/users/@me/lists/${encodeURIComponent(tasklistId)}`,
      { title },
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_lists_delete': async (args) => {
    requireConfirmation(args, 'deleting a Google Tasks task list');
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const result = await googleRequest(
      'DELETE',
      `https://tasks.googleapis.com/tasks/v1/users/@me/lists/${encodeURIComponent(tasklistId)}`,
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_list': async (args) => {
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const params = pickQueryParams(args, [
      'pageToken',
      'showCompleted',
      'showDeleted',
      'showHidden',
      'showAssigned',
      'dueMin',
      'dueMax',
      'completedMin',
      'completedMax',
      'updatedMin',
    ]);
    params.maxResults = String(Math.min(numberOrDefault(args.maxResults, 20), 100));

    const result = await googleRequest(
      'GET',
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks`,
      undefined,
      params,
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_get': async (args) => {
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const taskId = requireNonEmptyString(args.taskId, 'taskId');
    const result = await googleRequest(
      'GET',
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`,
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_create': async (args) => {
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const title = requireNonEmptyString(args.title, 'title');
    const params = pickQueryParams(args, ['parent', 'previous']);
    const body = {
      ...pickPresentFields(args, ['notes', 'due', 'status']),
      title,
    };

    const result = await googleRequest(
      'POST',
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks`,
      body,
      Object.keys(params).length ? params : undefined,
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_update': async (args) => {
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const taskId = requireNonEmptyString(args.taskId, 'taskId');
    const body = pickPresentFields(args, ['title', 'notes', 'due', 'status']);
    if (args.clearDue === true) {
      if (hasOwn(args, 'due') && args.due !== undefined && args.due !== null && String(args.due).trim()) {
        throw new Error('Use either due or clearDue, not both');
      }
      body.due = null;
    }
    if (Object.keys(body).length === 0) {
      throw new Error('At least one task field must be provided for update');
    }

    const result = await googleRequest(
      'PATCH',
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`,
      body,
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_complete': async (args) => {
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const taskId = requireNonEmptyString(args.taskId, 'taskId');
    const result = await googleRequest(
      'PATCH',
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`,
      { status: 'completed' },
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_uncomplete': async (args) => {
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const taskId = requireNonEmptyString(args.taskId, 'taskId');
    const result = await googleRequest(
      'PATCH',
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`,
      { status: 'needsAction' },
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_move': async (args) => {
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const taskId = requireNonEmptyString(args.taskId, 'taskId');
    const params = pickQueryParams(args, ['parent', 'previous']);
    const result = await googleRequest(
      'POST',
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}/move`,
      undefined,
      Object.keys(params).length ? params : undefined,
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_delete': async (args) => {
    requireConfirmation(args, 'deleting a Google Tasks task');
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const taskId = requireNonEmptyString(args.taskId, 'taskId');
    const task = (await googleRequest(
      'GET',
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`,
    )) as any;
    if (task?.assignmentInfo && args.deleteAssignedTaskEverywhere !== true) {
      throw new Error(
        'This is an assigned task from Google Docs or Chat Spaces. Deleting it may remove the original assigned task. Set deleteAssignedTaskEverywhere to true only after the user explicitly confirms that cross-surface deletion.',
      );
    }
    const result = await googleRequest(
      'DELETE',
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`,
    );
    return { ok: true, data: result };
  },

  'google-workspace.tasks_clear_completed': async (args) => {
    requireConfirmation(args, 'clearing completed Google Tasks tasks');
    const tasklistId = requireNonEmptyString(args.tasklistId, 'tasklistId');
    const result = await googleRequest(
      'POST',
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/clear`,
    );
    return { ok: true, data: result };
  },

  // ── Slides ───────────────────────────────────────────────

  'google-workspace.slides_create': async (args) => {
    const title = requireNonEmptyString(args.title, 'title');
    const result = await googleRequest(
      'POST',
      'https://slides.googleapis.com/v1/presentations',
      { title },
    );
    return { ok: true, data: result };
  },

  'google-workspace.slides_get': async (args) => {
    const presentationId = requireNonEmptyString(args.presentationId, 'presentationId');
    const params = args.fields ? { fields: String(args.fields) } : undefined;
    const result = await googleRequest(
      'GET',
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`,
      undefined,
      params,
    );
    return { ok: true, data: result };
  },

  'google-workspace.slides_create_slide': async (args) => {
    const presentationId = requireNonEmptyString(args.presentationId, 'presentationId');
    const createSlide: Record<string, any> = {
      slideLayoutReference: {
        predefinedLayout: args.predefinedLayout || 'BLANK',
      },
    };
    if (args.objectId) createSlide.objectId = String(args.objectId);
    if (hasOwn(args, 'insertionIndex') && args.insertionIndex !== undefined) {
      createSlide.insertionIndex = args.insertionIndex;
    }

    const result = await googleRequest(
      'POST',
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
      { requests: [{ createSlide }] },
    );
    return { ok: true, data: result };
  },

  'google-workspace.slides_delete_slide': async (args) => {
    requireConfirmation(args, 'deleting a Google Slides slide');
    const presentationId = requireNonEmptyString(args.presentationId, 'presentationId');
    const pageObjectId = requireNonEmptyString(args.pageObjectId, 'pageObjectId');
    const result = await googleRequest(
      'POST',
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
      { requests: [{ deleteObject: { objectId: pageObjectId } }] },
    );
    return { ok: true, data: result };
  },

  'google-workspace.slides_add_text_box': async (args) => {
    const presentationId = requireNonEmptyString(args.presentationId, 'presentationId');
    const pageObjectId = requireNonEmptyString(args.pageObjectId, 'pageObjectId');
    const text = requireNonEmptyString(args.text, 'text');
    const objectId = args.objectId ? String(args.objectId) : randomObjectId('cowork_textbox');
    const unit = args.unit || 'PT';
    const x = numberOrDefault(args.x, 72);
    const y = numberOrDefault(args.y, 72);
    const width = numberOrDefault(args.width, 576);
    const height = numberOrDefault(args.height, 120);

    const result = await googleRequest(
      'POST',
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
      {
        requests: [
          {
            createShape: {
              objectId,
              shapeType: 'TEXT_BOX',
              elementProperties: {
                pageObjectId,
                size: {
                  width: { magnitude: width, unit },
                  height: { magnitude: height, unit },
                },
                transform: {
                  scaleX: 1,
                  scaleY: 1,
                  translateX: x,
                  translateY: y,
                  unit,
                },
              },
            },
          },
          {
            insertText: {
              objectId,
              insertionIndex: 0,
              text,
            },
          },
        ],
      },
    );
    return { ok: true, data: { objectId, result } };
  },

  'google-workspace.slides_replace_all_text': async (args) => {
    requireConfirmation(args, 'replacing text throughout a Google Slides presentation');
    const presentationId = requireNonEmptyString(args.presentationId, 'presentationId');
    const text = requireNonEmptyString(args.text, 'text');
    const replaceText = hasOwn(args, 'replaceText') ? String(args.replaceText) : '';
    const result = await googleRequest(
      'POST',
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
      {
        requests: [
          {
            replaceAllText: {
              containsText: {
                text,
                matchCase: Boolean(args.matchCase),
              },
              replaceText,
            },
          },
        ],
      },
    );
    return { ok: true, data: result };
  },

  'google-workspace.slides_batch_update': async (args) => {
    requireConfirmation(args, 'running raw Google Slides batchUpdate requests');
    const presentationId = requireNonEmptyString(args.presentationId, 'presentationId');
    if (!Array.isArray(args.requests)) {
      throw new Error('requests must be an array');
    }
    const body: Record<string, any> = { requests: args.requests };
    if (args.writeControl) body.writeControl = args.writeControl;

    const result = await googleRequest(
      'POST',
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
      body,
    );
    return { ok: true, data: result };
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

export function listGoogleWorkspaceToolsForTest(): MCPTool[] {
  return tools;
}

export async function executeGoogleWorkspaceToolForTest(name: string, args: Record<string, any>): Promise<any> {
  return toolProvider.executeTool(name, args);
}

const serverInfo: MCPServerInfo = {
  name: 'Google Workspace',
  version: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

export function startGoogleWorkspaceMcpServer(): void {
  const server = new StdioMCPServer(toolProvider, serverInfo);
  server.start();
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  startGoogleWorkspaceMcpServer();
}
