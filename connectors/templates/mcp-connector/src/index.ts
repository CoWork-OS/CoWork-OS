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

// ==================== Tool Provider ====================

type ToolProvider = {
  getTools(): MCPTool[];
  executeTool(name: string, args: Record<string, any>, context?: CallContext): Promise<any>;
};

// ==================== MCP Stdio Server ====================

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

// ==================== Example Tools ====================

const CONNECTOR_PREFIX = process.env.CONNECTOR_PREFIX || "example";

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: "Check connector health and authentication status",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_item`,
    _meta: PREVIEW_TOOL_META,
    description:
      "Create an item (example write tool). A retry of the same call returns the first result " +
      "with status already_exists instead of creating a second item.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Item title" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.echo`,
    description: "Echo input for testing",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo back" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

type ToolHandler = (args: Record<string, any>, context: CallContext) => Promise<any>;

const handlers: Record<string, ToolHandler> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => ({
    ok: true,
    data: {
      status: "ok",
      connector: CONNECTOR_PREFIX,
    },
  }),
  // A write tool: run the API call through the ledger and report its status. Pass the API's own
  // idempotency key header too when it has one; pass a lookup as the third argument when it does
  // not, so a retry after an unanswered attempt can find what that attempt created.
  [`${CONNECTOR_PREFIX}.create_item`]: async (args, context) => {
    // Describe the write without doing it when CoWork asks for a preview.
    if (context.preview) {
      return previewResult(`Create an item titled "${args.title}"`, [
        { label: "Title", value: String(args.title ?? "") },
      ]);
    }
    const outcome = await ledger.run(idempotencyKeyFor(args, context), async () => ({
      id: `item-${Date.now()}`,
      title: args.title,
    }));
    // Read the record back for the receipt; here the "API" is this process.
    const receipt =
      outcome.status === "created"
        ? await receiptFor(
            `Created item ${outcome.result.id}`,
            `example:item:${outcome.result.id}`,
            async () =>
              outcome.result?.title === args.title
                ? `Item ${outcome.result.id} has the title`
                : undefined,
          )
        : undefined;
    return writeResult(outcome, (result) => ({ ok: true, data: result }), receipt);
  },
  [`${CONNECTOR_PREFIX}.echo`]: async (args) => ({
    ok: true,
    data: {
      echo: args.text,
    },
  }),
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
  name: `Connector (${CONNECTOR_PREFIX})`,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

export function startExampleMcpServer(): void {
  new StdioMCPServer(toolProvider, serverInfo).start();
}

/** Test hook: one `tools/call` request through the server, `_meta` included. */
export async function callExampleToolForTest(params: any): Promise<any> {
  return (new StdioMCPServer(toolProvider, serverInfo) as any).handleToolsCall(params);
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startExampleMcpServer();
}
