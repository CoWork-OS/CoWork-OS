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
  /** `cowork.preview: true` on a write tool: it can describe the write first. */
  _meta?: Record<string, any>;
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
    return this.request("GET", "/webhooks?limit=1");
  }

  async sendEmail(input: SendEmailInput): Promise<RequestResult> {
    const headers = input.idempotency_key
      ? { "Idempotency-Key": input.idempotency_key }
      : undefined;

    return this.request(
      "POST",
      "/emails",
      {
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
      },
      headers,
    );
  }

  async listWebhooks(args: {
    limit?: number;
    after?: string;
    before?: string;
  }): Promise<RequestResult> {
    const query = new URLSearchParams();
    if (typeof args.limit === "number") query.set("limit", String(args.limit));
    if (args.after) query.set("after", args.after);
    if (args.before) query.set("before", args.before);

    const suffix = query.toString();
    return this.request("GET", suffix ? `/webhooks?${suffix}` : "/webhooks");
  }

  async createWebhook(input: CreateWebhookInput): Promise<RequestResult> {
    return this.request("POST", "/webhooks", {
      endpoint: input.endpoint,
      events: input.events,
    });
  }

  async deleteWebhook(id: string): Promise<RequestResult> {
    return this.request("DELETE", `/webhooks/${encodeURIComponent(id)}`);
  }

  async getEmail(id: string): Promise<RequestResult> {
    return this.request("GET", `/emails/${encodeURIComponent(id)}`);
  }

  async getReceivedEmail(id: string): Promise<RequestResult> {
    return this.request("GET", `/emails/receiving/${encodeURIComponent(id)}`);
  }

  private getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, "");
  }

  private getAuthHeader(): string {
    if (!this.config.apiKey) {
      throw new Error("RESEND_API_KEY is required");
    }
    return `Bearer ${this.config.apiKey}`;
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, any>,
    extraHeaders?: Record<string, string>,
  ): Promise<RequestResult> {
    const start = Date.now();
    const url = `${this.getBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;

    const headers: Record<string, string> = {
      Authorization: this.getAuthHeader(),
      "User-Agent": "CoWork-Resend-Connector/0.1.0",
      ...(extraHeaders || {}),
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
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
        (parsed && typeof parsed === "object" && typeof (parsed as any).message === "string"
          ? (parsed as any).message
          : undefined) ||
        (parsed && typeof parsed === "object" && typeof (parsed as any).error === "string"
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
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    if (cleaned.length === 0) {
      throw new Error(`${field} must contain at least one non-empty string`);
    }
    return cleaned;
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error(`${field} must be a non-empty string`);
    }
    return [trimmed];
  }

  throw new Error(`${field} must be a string or string[]`);
}

function asOptionalString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed || undefined;
}

function asOptionalNumber(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined;
  return input;
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
const PREVIEW_META_KEY = "cowork.preview";

type CallContext = { idempotencyKey?: string; preview?: boolean };
type WriteStatus = "created" | "already_exists" | "unknown";
type WriteOutcome = { status: WriteStatus; result?: any; message?: string };

/** The idempotency key CoWork sent with this call, when well formed, and the preview flag. */
function readIdempotency(params: any): CallContext {
  const key = params?._meta?.[IDEMPOTENCY_META_KEY];
  return {
    ...(typeof key === "string" && IDEMPOTENCY_KEY_PATTERN.test(key)
      ? { idempotencyKey: key }
      : {}),
    ...(params?._meta?.[PREVIEW_META_KEY] === true ? { preview: true } : {}),
  };
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

// ==================== Preview and receipts ====================
//
// A write tool that lists `_meta: { "cowork.preview": true }` describes its write when called
// with `_meta["cowork.preview"]: true` and changes nothing: `status: "preview"` and `prepared`
// (kind, summary, references, payload.fields as label/value pairs). CoWork shows that in the
// approval. After a real write the result carries a `receipt`: what the API returned and, when
// the record could be read back, what was found. CoWork records it as evidence.

const PREVIEW_TOOL_META = { [PREVIEW_META_KEY]: true };

type PreviewField = { label: string; value: string };

/** The answer to a preview call: what the write would do. Nothing is changed. */
function previewResult(summary: string, fields: PreviewField[], references: string[] = []): any {
  return {
    ok: true,
    status: "preview",
    prepared: {
      kind: "preview",
      summary: summary.slice(0, 8000),
      references: references.slice(0, 32),
      payload: {
        fields: fields
          .filter((field) => field.value !== "")
          .slice(0, 40)
          .map((field) => ({ label: field.label, value: field.value.slice(0, 1000) })),
      },
    },
  };
}

/** One preview line per argument, for fields a connector does not name itself. */
function fieldsOf(values: Record<string, any> | undefined, skip: string[] = []): PreviewField[] {
  return Object.entries(values ?? {})
    .filter(([key]) => !skip.includes(key))
    .map(([key, value]) => ({
      label: key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
}

/** A write's receipt: verified when the record could be read back. */
async function receiptFor(
  summary: string,
  source: string,
  readBack: () => Promise<string | undefined>,
): Promise<any> {
  const checkedAt = Date.now();
  try {
    const found = await readBack();
    if (found) {
      return { status: "verified", summary, checkedAt, evidence: [{ source, claim: found }] };
    }
  } catch {
    // The write happened; only reading it back failed.
  }
  return {
    status: "unavailable",
    summary: `${summary}; it could not be read back`,
    checkedAt,
    evidence: [{ source, claim: "The API reported the write." }],
  };
}

/** A write tool's result: the usual envelope plus its `status`, and its receipt. */
function writeResult(outcome: WriteOutcome, envelope: (result: any) => any, receipt?: any): any {
  if (outcome.status === "unknown") {
    return { ok: false, status: "unknown", message: outcome.message };
  }
  return {
    ...envelope(outcome.result),
    status: outcome.status,
    ...(receipt && outcome.status === "created" ? { receipt } : {}),
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
  if (status === "preview") return { structuredContent: { status, prepared: result.prepared } };
  if (status !== "created" && status !== "already_exists" && status !== "unknown") return {};
  return {
    structuredContent: {
      status,
      ...(typeof result.message === "string" ? { message: result.message } : {}),
      ...(result.receipt ? { receipt: result.receipt } : {}),
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
    } catch {
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

const CONNECTOR_PREFIX = "resend";
const DEFAULT_BASE_URL = "https://api.resend.com";
const EVENT_ENUM = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.scheduled",
  "email.suppressed",
  "email.received",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "domain.created",
  "domain.updated",
  "domain.deleted",
] as const;
const EVENT_SET = new Set<string>(EVENT_ENUM);

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: "Check connector health and authentication status",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.send_email`,
    _meta: PREVIEW_TOOL_META,
    description: "Send an email via Resend API",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: 'From address, e.g. "Acme <noreply@example.com>"' },
        to: {
          description: "Recipient email address(es)",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        subject: { type: "string", description: "Email subject" },
        text: { type: "string", description: "Plain text email body" },
        html: { type: "string", description: "HTML email body" },
        cc: {
          description: "CC address(es)",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        bcc: {
          description: "BCC address(es)",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        reply_to: {
          description: "Reply-To address(es)",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        headers: { type: "object", description: "Custom email headers" },
        tags: {
          type: "array",
          description: "Metadata tags",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "string" },
            },
            required: ["name", "value"],
          },
        },
        scheduled_at: {
          type: "string",
          description: 'Scheduled time expression (e.g., "in 10 min")',
        },
        idempotency_key: {
          type: "string",
          description: "Optional idempotency key for safe retries",
        },
      },
      required: ["from", "to", "subject"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_webhooks`,
    description: "List registered Resend webhooks",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max number of webhooks (1-100)" },
        after: { type: "string", description: "Pagination cursor after ID" },
        before: { type: "string", description: "Pagination cursor before ID" },
      },
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_webhook`,
    _meta: PREVIEW_TOOL_META,
    description: "Create a webhook endpoint in Resend",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "Public HTTPS endpoint URL" },
        events: {
          type: "array",
          description: "Events to subscribe to",
          items: { type: "string", enum: [...EVENT_ENUM] },
        },
      },
      required: ["endpoint", "events"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.delete_webhook`,
    description: "Delete an existing webhook by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Webhook ID" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_received_email`,
    description: "Retrieve full content for a received email (html/text/headers) by email_id",
    inputSchema: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "Received email ID from email.received webhook payload",
        },
      },
      required: ["email_id"],
      additionalProperties: false,
    },
  },
];

const config: ResendConfig = {
  baseUrl: process.env.RESEND_BASE_URL || DEFAULT_BASE_URL,
  apiKey: process.env.RESEND_API_KEY,
};

const client = new ResendClient(config);

type ToolHandler = (args: Record<string, any>, context: CallContext) => Promise<any>;

const handlers: Record<string, ToolHandler> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => buildEnvelope(await client.health()),
  [`${CONNECTOR_PREFIX}.send_email`]: async (args, context) => {
    const from = asOptionalString(args.from);
    const subject = asOptionalString(args.subject);
    const to = args.to;
    const text = asOptionalString(args.text);
    const html = asOptionalString(args.html);

    if (!from) throw new Error("from is required");
    if (!subject) throw new Error("subject is required");
    if (text === undefined && html === undefined) {
      throw new Error("Provide at least one of text or html");
    }

    const tags = Array.isArray(args.tags)
      ? args.tags
          .map((tag: any) => ({
            name: asOptionalString(tag?.name),
            value: asOptionalString(tag?.value),
          }))
          .filter(
            (tag): tag is { name: string; value: string } =>
              typeof tag.name === "string" && typeof tag.value === "string",
          )
      : undefined;

    if (context.preview) {
      const recipients = normalizeStringList(to, "to");
      const list = (value: unknown, name: string) =>
        value ? normalizeStringList(value, name).join(", ") : "";
      const body =
        text ??
        (html ?? "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      return previewResult(
        `Send the email "${subject}" to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`,
        [
          { label: "From", value: from },
          { label: "To", value: recipients.join(", ") },
          { label: "Cc", value: list(args.cc, "cc") },
          { label: "Bcc", value: list(args.bcc, "bcc") },
          { label: "Reply to", value: list(args.reply_to, "reply_to") },
          { label: "Subject", value: subject },
          { label: "Scheduled at", value: asOptionalString(args.scheduled_at) ?? "" },
          { label: "Body", value: body.slice(0, 500) },
        ],
      );
    }

    // Resend keeps its own Idempotency-Key for 24 hours, so a resend after an unanswered
    // attempt with the same key does not send twice either.
    const idempotencyKey = asOptionalString(args.idempotency_key) ?? context.idempotencyKey;
    const outcome = await ledger.run(idempotencyKey, () =>
      client.sendEmail({
        from,
        to: normalizeStringList(to, "to"),
        subject,
        text,
        html,
        cc: args.cc ? normalizeStringList(args.cc, "cc") : undefined,
        bcc: args.bcc ? normalizeStringList(args.bcc, "bcc") : undefined,
        reply_to: args.reply_to ? normalizeStringList(args.reply_to, "reply_to") : undefined,
        headers: args.headers && typeof args.headers === "object" ? args.headers : undefined,
        tags,
        scheduled_at: asOptionalString(args.scheduled_at),
        idempotency_key: idempotencyKey,
      }),
    );
    const emailId = outcome.status === "created" ? outcome.result?.data?.id : undefined;
    const receipt = emailId
      ? await receiptFor(
          `Resend accepted email ${emailId}`,
          `resend:email:${emailId}`,
          async () => {
            const read = await client.getEmail(String(emailId));
            return read.data?.id
              ? `Email ${read.data.id} is recorded by Resend${read.data.last_event ? ` (last event: ${read.data.last_event})` : ""}`
              : undefined;
          },
        )
      : undefined;
    return writeResult(outcome, (result) => buildEnvelope(result), receipt);
  },
  [`${CONNECTOR_PREFIX}.list_webhooks`]: async (args) => {
    const limit = asOptionalNumber(args.limit);
    if (limit !== undefined && (limit < 1 || limit > 100)) {
      throw new Error("limit must be between 1 and 100");
    }
    if (args.after && args.before) {
      throw new Error("Provide either after or before, not both");
    }

    return buildEnvelope(
      await client.listWebhooks({
        limit,
        after: asOptionalString(args.after),
        before: asOptionalString(args.before),
      }),
    );
  },
  [`${CONNECTOR_PREFIX}.create_webhook`]: async (args, context) => {
    const endpoint = asOptionalString(args.endpoint);
    if (!endpoint) throw new Error("endpoint is required");

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(endpoint);
    } catch {
      throw new Error("endpoint must be a valid URL");
    }
    if (parsedUrl.protocol !== "https:") {
      throw new Error("endpoint must use https");
    }

    const events = normalizeStringList(args.events, "events");
    const invalidEvents = events.filter((event) => !EVENT_SET.has(event));
    if (invalidEvents.length > 0) {
      throw new Error(`Unsupported webhook event(s): ${invalidEvents.join(", ")}`);
    }
    if (context.preview) {
      return previewResult(`Create a Resend webhook that posts to ${endpoint}`, [
        { label: "Endpoint", value: endpoint },
        { label: "Events", value: events.join(", ") },
      ]);
    }
    const outcome = await ledger.run(
      context.idempotencyKey,
      () => client.createWebhook({ endpoint, events }),
      // After an unanswered attempt, a webhook for the same endpoint is the one it made.
      async () => {
        const found = await client.listWebhooks({ limit: 100 });
        const hook = (found.data?.data ?? []).find(
          (candidate: any) => candidate?.endpoint === endpoint,
        );
        return hook ? { data: hook, meta: found.meta } : undefined;
      },
    );
    return writeResult(outcome, (result) => buildEnvelope(result));
  },
  [`${CONNECTOR_PREFIX}.delete_webhook`]: async (args) => {
    const id = asOptionalString(args.id);
    if (!id) throw new Error("id is required");
    return buildEnvelope(await client.deleteWebhook(id));
  },
  [`${CONNECTOR_PREFIX}.get_received_email`]: async (args) => {
    const emailId = asOptionalString(args.email_id);
    if (!emailId) throw new Error("email_id is required");
    return buildEnvelope(await client.getReceivedEmail(emailId));
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
  name: "Resend Connector",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

export function startResendMcpServer(): void {
  new StdioMCPServer(toolProvider, serverInfo).start();
}

/** Test hook: one `tools/call` request through the server, `_meta` included. */
export async function callResendToolForTest(params: any): Promise<any> {
  return (new StdioMCPServer(toolProvider, serverInfo) as any).handleToolsCall(params);
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startResendMcpServer();
}

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
