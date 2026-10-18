import * as readline from "readline";

// ==================== MCP Types ====================

type JSONRPCId = string | number;

type JSONRPCRequest = {
  jsonrpc: "2.0";
  id: JSONRPCId;
  method: string;
  params?: Record<string, any>;
};

type JSONRPCNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, any>;
};

type JSONRPCResponse = {
  jsonrpc: "2.0";
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
    type: "object";
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

const PROTOCOL_VERSION = "2024-11-05";

const MCP_METHODS = {
  INITIALIZE: "initialize",
  INITIALIZED: "notifications/initialized",
  SHUTDOWN: "shutdown",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
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
    return this.requestJson("GET", "limits");
  }

  async listObjects(): Promise<RequestResult> {
    return this.requestJson("GET", "sobjects");
  }

  async describeObject(objectName: string): Promise<RequestResult> {
    return this.requestJson("GET", `sobjects/${encodeURIComponent(objectName)}/describe`);
  }

  async getRecord(objectName: string, recordId: string, fields?: string[]): Promise<RequestResult> {
    const query =
      fields && fields.length > 0 ? `?fields=${encodeURIComponent(fields.join(","))}` : "";
    return this.requestJson(
      "GET",
      `sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}${query}`,
    );
  }

  async query(soql: string, cursor?: string): Promise<RequestResult> {
    if (cursor) {
      return this.requestJson("GET", cursor, undefined, true);
    }

    const encoded = encodeURIComponent(soql);
    return this.requestJson("GET", `query?q=${encoded}`);
  }

  async createRecord(objectName: string, fields: Record<string, any>): Promise<RequestResult> {
    return this.requestJson("POST", `sobjects/${encodeURIComponent(objectName)}`, fields);
  }

  async updateRecord(
    objectName: string,
    recordId: string,
    fields: Record<string, any>,
  ): Promise<RequestResult> {
    return this.requestJson(
      "PATCH",
      `sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}`,
      fields,
    );
  }

  private getBaseUrl(): string {
    if (!this.config.instanceUrl) {
      throw new Error("SALESFORCE_INSTANCE_URL is required");
    }
    return `${this.config.instanceUrl.replace(/\/$/, "")}/services/data/v${this.config.apiVersion}`;
  }

  private async requestJson(
    method: string,
    path: string,
    body?: any,
    absolutePath = false,
    refreshAttempt = 0,
  ): Promise<RequestResult> {
    const start = Date.now();

    const url = absolutePath
      ? this.buildAbsoluteUrl(path)
      : `${this.getBaseUrl()}/${path.replace(/^\//, "")}`;

    const token = await this.ensureAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "CoWork-Salesforce-Connector/0.1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && this.canRefresh() && refreshAttempt < 1) {
      await this.refreshAccessToken();
      return this.requestJson(method, path, body, absolutePath, refreshAttempt + 1);
    }

    const durationMs = Date.now() - start;
    const rateLimit = parseRateLimit(res.headers.get("sforce-limit-info"));
    const vendorRequestId = res.headers.get("sforce-request-id") || undefined;

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
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      // A cursor (nextRecordsUrl) is model-supplied via search_records, and
      // requestJson attaches the live OAuth bearer token to whatever URL comes
      // back from here. Without an origin check, injected content telling the
      // agent to "continue pagination from https://attacker.tld/c" exfiltrates
      // the org's access token — and a 401 from that host triggers a refresh
      // and replays a freshly minted one. Confine it to the Salesforce
      // instance's own REST API.
      if (!this.config.instanceUrl) {
        throw new Error("SALESFORCE_INSTANCE_URL is required");
      }
      let target: URL;
      let instance: URL;
      try {
        target = new URL(trimmed);
        instance = new URL(this.config.instanceUrl);
      } catch {
        throw new Error("Invalid Salesforce URL");
      }
      if (target.origin !== instance.origin) {
        throw new Error(
          `Refusing to request ${target.origin}: Salesforce pagination cursors must stay on ${instance.origin}`,
        );
      }
      if (!target.pathname.startsWith("/services/data/")) {
        throw new Error(
          "Refusing to request a non-REST Salesforce path; cursors must target /services/data/",
        );
      }
      return target.toString();
    }
    if (!this.config.instanceUrl) {
      throw new Error("SALESFORCE_INSTANCE_URL is required");
    }
    return `${this.config.instanceUrl.replace(/\/$/, "")}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
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
        const code = first.errorCode ? ` (${first.errorCode})` : "";
        return `${first.message || "Salesforce API error"}${code}`;
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
      this.config.loginUrl,
    );
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.config.accessToken) {
      return this.config.accessToken;
    }
    if (!this.canRefresh()) {
      throw new Error("SALESFORCE_ACCESS_TOKEN is required (or provide refresh credentials)");
    }
    await this.refreshAccessToken();
    if (!this.config.accessToken) {
      throw new Error("Failed to obtain Salesforce access token");
    }
    return this.config.accessToken;
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.canRefresh()) {
      throw new Error("Missing refresh credentials");
    }

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.config.clientId as string,
      client_secret: this.config.clientSecret as string,
      refresh_token: this.config.refreshToken as string,
    });

    const url = `${this.config.loginUrl.replace(/\/$/, "")}/services/oauth2/token`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const message = await this.extractErrorMessage(res);
      throw new Error(`Salesforce OAuth refresh failed: ${message}`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error("Salesforce OAuth refresh returned no access_token");
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
  executeTool(name: string, args: Record<string, any>, context?: CallContext): Promise<any>;
};

// ==================== Idempotency ====================
//
// CoWork sends one key per tool attempt in the request's `_meta` ("cowork.idempotencyKey"), and a
// retry of the same call carries the same key. Write tools report a `status`:
//   created         the write ran now;
//   already_exists  an earlier attempt with this key made the change, so it was not made again;
//   unknown         the API call ended without a response: the change may or may not exist.
// The ledger lives in this connector process for 24 hours. It covers a retry after CoWork lost
// the response; it does not survive a connector restart.

const IDEMPOTENCY_META_KEY = "cowork.idempotencyKey";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 1000;

type CallContext = { idempotencyKey?: string };
type WriteStatus = "created" | "already_exists" | "unknown";
type WriteOutcome = { status: WriteStatus; result?: any; message?: string };

/** The idempotency key CoWork sent with this call, when it is well formed. */
function readIdempotency(params: any): CallContext {
  const key = params?._meta?.[IDEMPOTENCY_META_KEY];
  return typeof key === "string" && IDEMPOTENCY_KEY_PATTERN.test(key)
    ? { idempotencyKey: key }
    : {};
}

/** A key the caller passed as a tool argument wins over the one in `_meta`. */
function idempotencyKeyFor(args: Record<string, any>, context: CallContext): string | undefined {
  const explicit = typeof args.idempotencyKey === "string" ? args.idempotencyKey.trim() : "";
  return explicit ? explicit.slice(0, 256) : context.idempotencyKey;
}

/** The request never got an answer from the API, so its effect is unknown. */
function isNoResponseError(error: any): boolean {
  const code = String(error?.cause?.code ?? error?.code ?? "");
  // These fail before the API sees the request: nothing can have changed.
  if (/^(ENOTFOUND|ECONNREFUSED|EAI_AGAIN|CERT_|ERR_TLS|UNABLE_TO)/.test(code)) return false;
  return (
    error?.name === "AbortError" ||
    /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|other side closed/i.test(
      `${error?.message ?? ""} ${code}`,
    )
  );
}

class IdempotencyLedger {
  private entries = new Map<
    string,
    { state: "pending" | "done" | "unknown"; result?: any; at: number }
  >();

  /**
   * Run `write` at most once per key. `findExisting` is consulted only after an earlier attempt
   * with this key ended without a response, to find what that attempt may have created.
   */
  async run(
    key: string | undefined,
    write: () => Promise<any>,
    findExisting?: () => Promise<any | undefined>,
  ): Promise<WriteOutcome> {
    this.prune();
    const entry = key ? this.entries.get(key) : undefined;
    if (entry?.state === "done") return { status: "already_exists", result: entry.result };
    if (entry?.state === "pending") {
      return { status: "unknown", message: "An earlier attempt of this call is still running." };
    }
    if (key && entry?.state === "unknown" && findExisting) {
      const existing = await findExisting();
      if (existing !== undefined) {
        this.entries.set(key, { state: "done", result: existing, at: Date.now() });
        return { status: "already_exists", result: existing };
      }
    }
    if (key) this.entries.set(key, { state: "pending", at: Date.now() });
    try {
      const result = await write();
      if (key) this.entries.set(key, { state: "done", result, at: Date.now() });
      return { status: "created", result };
    } catch (error: any) {
      if (isNoResponseError(error)) {
        if (key) this.entries.set(key, { state: "unknown", at: Date.now() });
        return {
          status: "unknown",
          message: `No response from the API (${error?.message || "request failed"}). The change may or may not exist; check before retrying.`,
        };
      }
      if (key) this.entries.delete(key);
      throw error;
    }
  }

  private prune(): void {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= IDEMPOTENCY_MAX_ENTRIES) break;
      this.entries.delete(key);
    }
  }
}

const ledger = new IdempotencyLedger();

/** A write tool's result: the usual envelope plus its `status`. */
function writeResult(outcome: WriteOutcome, envelope: (result: any) => any): any {
  if (outcome.status === "unknown") {
    return { ok: false, status: "unknown", message: outcome.message };
  }
  return {
    ...envelope(outcome.result),
    status: outcome.status,
    ...(outcome.status === "already_exists"
      ? {
          message:
            "An earlier attempt of this call already made this change; it was not made again.",
        }
      : {}),
  };
}

/** `structuredContent` for a write status, so the client can act on it without parsing text. */
function writeStatusContent(result: any): Record<string, any> {
  const status = result && typeof result === "object" ? result.status : undefined;
  if (status !== "created" && status !== "already_exists" && status !== "unknown") return {};
  return {
    structuredContent: {
      status,
      ...(typeof result.message === "string" ? { message: result.message } : {}),
    },
    ...(status === "unknown" ? { isError: true } : {}),
  };
}

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

    this.rl.on("line", (line) => this.handleLine(line));
    this.rl.on("close", () => this.stop());

    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
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
      this.sendError(0, MCP_ERROR_CODES.PARSE_ERROR, "Parse error");
    }
  }

  private async handleMessage(message: any): Promise<void> {
    if ("id" in message && message.id !== null) {
      await this.handleRequest(message as JSONRPCRequest);
      return;
    }

    if ("method" in message) {
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
        this.sendError(id, MCP_ERROR_CODES.INTERNAL_ERROR, error?.message || "Internal error");
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
    capabilities: MCPServerInfo["capabilities"];
    serverInfo: MCPServerInfo;
  } {
    if (this.initialized) {
      throw this.createError(MCP_ERROR_CODES.INVALID_REQUEST, "Already initialized");
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
      throw this.createError(MCP_ERROR_CODES.INVALID_PARAMS, "Tool name is required");
    }

    try {
      const result = await this.toolProvider.executeTool(name, args || {}, readIdempotency(params));

      if (typeof result === "string") {
        return { content: [{ type: "text", text: result }] };
      }

      if (result && typeof result === "object") {
        if (result.content && Array.isArray(result.content)) {
          return result;
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          ...writeStatusContent(result),
        };
      }

      return { content: [{ type: "text", text: String(result) }] };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error?.message || "Tool failed"}` }],
        isError: true,
      };
    }
  }

  private handleShutdown(): Record<string, never> {
    setImmediate(() => this.stop());
    return {};
  }

  private sendResult(id: JSONRPCId, result: any): void {
    const response: JSONRPCResponse = { jsonrpc: "2.0", id, result };
    this.sendMessage(response);
  }

  private sendError(id: JSONRPCId, code: number, message: string, data?: any): void {
    const response: JSONRPCResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message, data },
    };
    this.sendMessage(response);
  }

  private sendMessage(message: JSONRPCResponse | JSONRPCNotification): void {
    process.stdout.write(JSON.stringify(message) + "\n");
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw this.createError(MCP_ERROR_CODES.SERVER_NOT_INITIALIZED, "Server not initialized");
    }
  }

  private createError(
    code: number,
    message: string,
    data?: any,
  ): { code: number; message: string; data?: any } {
    return { code, message, data };
  }
}

// ==================== Tool Definitions ====================

const CONNECTOR_PREFIX = "salesforce";
const DEFAULT_API_VERSION = "60.0";

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: "Check connector health and authentication status",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Optional request id for tracing" },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_objects`,
    description: "List available Salesforce objects",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Optional request id for tracing" },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.describe_object`,
    description: "Describe a Salesforce object and its fields",
    inputSchema: {
      type: "object",
      properties: {
        object: { type: "string", description: "Salesforce object name (e.g., Account)" },
        requestId: { type: "string", description: "Optional request id for tracing" },
      },
      required: ["object"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_record`,
    description: "Fetch a Salesforce record by id",
    inputSchema: {
      type: "object",
      properties: {
        object: { type: "string", description: "Salesforce object name (e.g., Account)" },
        id: { type: "string", description: "Salesforce record id" },
        fields: {
          type: "array",
          description: "Optional list of fields to include",
          items: { type: "string" },
        },
        requestId: { type: "string", description: "Optional request id for tracing" },
      },
      required: ["object", "id"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.search_records`,
    description: "Run a SOQL query",
    inputSchema: {
      type: "object",
      properties: {
        soql: {
          type: "string",
          description: "SOQL query to execute (required if cursor is not provided)",
        },
        limit: { type: "number", description: "Optional LIMIT to append if not present" },
        cursor: {
          type: "string",
          description: "Pagination cursor (nextRecordsUrl); if provided, soql is optional",
        },
        requestId: { type: "string", description: "Optional request id for tracing" },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_record`,
    description: "Create a Salesforce record",
    inputSchema: {
      type: "object",
      properties: {
        object: { type: "string", description: "Salesforce object name (e.g., Account)" },
        fields: { type: "object", description: "Field map for creation" },
        idempotencyKey: { type: "string", description: "Optional idempotency key (best-effort)" },
        requestId: { type: "string", description: "Optional request id for tracing" },
      },
      required: ["object", "fields"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.update_record`,
    description: "Update a Salesforce record",
    inputSchema: {
      type: "object",
      properties: {
        object: { type: "string", description: "Salesforce object name (e.g., Account)" },
        id: { type: "string", description: "Salesforce record id" },
        fields: { type: "object", description: "Field map for update" },
        idempotencyKey: { type: "string", description: "Optional idempotency key (best-effort)" },
        requestId: { type: "string", description: "Optional request id for tracing" },
      },
      required: ["object", "id", "fields"],
      additionalProperties: false,
    },
  },
];

const config: SalesforceConfig = {
  instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
  accessToken: process.env.SALESFORCE_ACCESS_TOKEN,
  apiVersion: process.env.SALESFORCE_API_VERSION || DEFAULT_API_VERSION,
  loginUrl: process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com",
  clientId: process.env.SALESFORCE_CLIENT_ID,
  clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
  refreshToken: process.env.SALESFORCE_REFRESH_TOKEN,
};

const client = new SalesforceClient(config);

type ToolHandler = (args: Record<string, any>, context: CallContext) => Promise<any>;

const handlers: Record<string, ToolHandler> = {
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
    const soql = args.soql ? normalizeSoql(args.soql, args.limit) : "";
    if (!args.cursor && !soql) {
      throw new Error("search_records requires either soql or cursor");
    }
    const result = await client.query(soql, args.cursor);
    return buildEnvelope(result, args.requestId);
  },
  [`${CONNECTOR_PREFIX}.create_record`]: async (args, context) => {
    const fields: Record<string, any> = args.fields || {};
    const outcome = await ledger.run(
      idempotencyKeyFor(args, context),
      () => client.createRecord(args.object, fields),
      // Salesforce has no idempotency key: a record of this object with the same Name created
      // in the last day is taken to be the one the unanswered attempt made.
      typeof fields.Name === "string" && /^[A-Za-z0-9_]+$/.test(String(args.object))
        ? async () => {
            const name = fields.Name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
            const found = await client.query(
              `SELECT Id FROM ${args.object} WHERE Name = '${name}' AND CreatedDate = LAST_N_DAYS:1 ORDER BY CreatedDate DESC LIMIT 1`,
            );
            const id = found.data?.records?.[0]?.Id;
            return id ? { data: { id, success: true }, meta: found.meta } : undefined;
          }
        : undefined,
    );
    return writeResult(outcome, (result) => buildEnvelope(result, args.requestId));
  },
  [`${CONNECTOR_PREFIX}.update_record`]: async (args) => {
    const warnings = args.idempotencyKey
      ? ["Salesforce does not natively support idempotency keys; handled best-effort."]
      : [];
    const result = await client.updateRecord(args.object, args.id, args.fields || {});
    return buildEnvelope(result, args.requestId, warnings);
  },
};

const toolProvider: ToolProvider = {
  getTools: () => tools,
  executeTool: async (name, args, context = {}) => {
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return handler(args, context);
  },
};

const serverInfo: MCPServerInfo = {
  name: "Salesforce Connector",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

export function startSalesforceMcpServer(): void {
  new StdioMCPServer(toolProvider, serverInfo).start();
}

/** Test hook: one `tools/call` request through the server, `_meta` included. */
export async function callSalesforceToolForTest(params: any): Promise<any> {
  return (new StdioMCPServer(toolProvider, serverInfo) as any).handleToolsCall(params);
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startSalesforceMcpServer();
}

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
