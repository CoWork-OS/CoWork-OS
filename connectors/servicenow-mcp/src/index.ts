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
  /** `cowork.objectManifest: true` on the tool CoWork reads the object manifest from. */
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

// ==================== ServiceNow Client ====================

type ServiceNowConfig = {
  instanceUrl?: string;
  instance?: string;
  username?: string;
  password?: string;
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
};

class ServiceNowClient {
  constructor(private config: ServiceNowConfig) {}

  async health(): Promise<RequestResult> {
    return this.requestJson("GET", "table/sys_user?sysparm_limit=1");
  }

  async listRecords(
    table: string,
    query?: string,
    limit?: number,
    offset?: number,
    fields?: string[],
  ): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (query) params.set("sysparm_query", query);
    if (limit !== undefined) params.set("sysparm_limit", String(limit));
    if (offset !== undefined) params.set("sysparm_offset", String(offset));
    if (fields && fields.length > 0) params.set("sysparm_fields", fields.join(","));
    const queryString = params.toString();
    return this.requestJson(
      "GET",
      `table/${encodeURIComponent(table)}${queryString ? `?${queryString}` : ""}`,
    );
  }

  async getRecord(table: string, sysId: string, fields?: string[]): Promise<RequestResult> {
    const params = new URLSearchParams();
    if (fields && fields.length > 0) params.set("sysparm_fields", fields.join(","));
    const queryString = params.toString();
    return this.requestJson(
      "GET",
      `table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}${queryString ? `?${queryString}` : ""}`,
    );
  }

  async createRecord(table: string, fields: Record<string, any>): Promise<RequestResult> {
    return this.requestJson("POST", `table/${encodeURIComponent(table)}`, fields);
  }

  async updateRecord(
    table: string,
    sysId: string,
    fields: Record<string, any>,
  ): Promise<RequestResult> {
    return this.requestJson(
      "PATCH",
      `table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`,
      fields,
    );
  }

  private getBaseUrl(): string {
    if (this.config.instanceUrl) {
      return this.config.instanceUrl.replace(/\/$/, "");
    }
    if (this.config.instance) {
      return `https://${this.config.instance}.service-now.com`;
    }
    throw new Error("SERVICENOW_INSTANCE_URL or SERVICENOW_INSTANCE is required");
  }

  private getAuthHeader(): string {
    if (this.config.accessToken) {
      return `Bearer ${this.config.accessToken}`;
    }
    if (this.config.username && this.config.password) {
      const basic = Buffer.from(`${this.config.username}:${this.config.password}`).toString(
        "base64",
      );
      return `Basic ${basic}`;
    }
    throw new Error("Missing ServiceNow credentials");
  }

  private async requestJson(method: string, path: string, body?: any): Promise<RequestResult> {
    const start = Date.now();
    const url = `${this.getBaseUrl()}/api/now/${path.replace(/^\//, "")}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/json",
        "User-Agent": "CoWork-ServiceNow-Connector/0.1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - start;
    const vendorRequestId = res.headers.get("x-request-id") || undefined;

    if (!res.ok) {
      const message = await res.text();
      throw new Error(message || `ServiceNow API error (${res.status})`);
    }

    let data: any = null;
    if (res.status !== 204) {
      data = await res.json();
    }

    return {
      data,
      meta: {
        durationMs,
        vendorRequestId,
        baseUrl: this.getBaseUrl(),
      },
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
      const result = await this.toolProvider.executeTool(name, args || {});

      if (typeof result === "string") {
        return { content: [{ type: "text", text: result }] };
      }

      if (result && typeof result === "object") {
        if (result.content && Array.isArray(result.content)) {
          return result;
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

const CONNECTOR_PREFIX = "servicenow";
/** On `describe_objects`: CoWork reads the object manifest from it; the model never sees it. */
const OBJECT_MANIFEST_TOOL_META = { "cowork.objectManifest": true };

const config: ServiceNowConfig = {
  instanceUrl: process.env.SERVICENOW_INSTANCE_URL,
  instance: process.env.SERVICENOW_INSTANCE,
  username: process.env.SERVICENOW_USERNAME,
  password: process.env.SERVICENOW_PASSWORD,
  accessToken: process.env.SERVICENOW_ACCESS_TOKEN,
};

const client = new ServiceNowClient(config);

const tools: MCPTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.health`,
    description: "Check connector health and authentication status",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: `${CONNECTOR_PREFIX}.list_records`,
    description: "List records from a ServiceNow table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name (e.g., incident)" },
        query: { type: "string", description: "sysparm_query string" },
        limit: { type: "number", description: "Max records to return" },
        offset: { type: "number", description: "Offset for pagination" },
        fields: { type: "array", description: "Fields to return", items: { type: "string" } },
      },
      required: ["table"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.get_record`,
    description: "Fetch a record by sys_id",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name (e.g., incident)" },
        sysId: { type: "string", description: "sys_id of the record" },
        fields: { type: "array", description: "Fields to return", items: { type: "string" } },
      },
      required: ["table", "sysId"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.create_record`,
    description: "Create a record in a table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name (e.g., incident)" },
        fields: { type: "object", description: "Field map for creation" },
      },
      required: ["table", "fields"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.update_record`,
    description: "Update a record in a table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name (e.g., incident)" },
        sysId: { type: "string", description: "sys_id of the record" },
        fields: { type: "object", description: "Field map for update" },
      },
      required: ["table", "sysId", "fields"],
      additionalProperties: false,
    },
  },
  {
    name: `${CONNECTOR_PREFIX}.describe_objects`,
    _meta: OBJECT_MANIFEST_TOOL_META,
    description:
      "Describe the business objects this connector holds, their fields and which tools read or write them. CoWork reads this itself.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// ==================== Object manifest ====================
//
// `servicenow.describe_objects` tells CoWork which tables this connector works with, their
// fields, state values and relations, and which tools read or write them. CoWork calls it
// itself; the model never sees it. The manifest starts from the tables declared below and,
// when the instance is configured, adds each table's own dictionary columns (custom `u_`
// columns included) and its active state choices. Columns a table inherits from `task` are
// not in its own dictionary, so they always come from the declarations here. A lookup that
// fails leaves its part as declared, a live read that takes longer than 12 seconds gives the
// declared tables, and the tool never fails. It only reads.

type ManifestFieldType =
  | "id"
  | "string"
  | "text"
  | "number"
  | "currency"
  | "percent"
  | "boolean"
  | "date"
  | "datetime"
  | "enum"
  | "reference"
  | "email"
  | "phone"
  | "url"
  | "json";

type ManifestField = {
  name: string;
  type: ManifestFieldType;
  label?: string;
  enum?: string[];
  pii?: boolean;
};

type ManifestObject = {
  type: string;
  label: string;
  entityType: string;
  keyField: string;
  titleField?: string;
  urlTemplate?: string;
  fields: ManifestField[];
  statusField?: { name: string; values: string[]; closed?: string[] };
  relations?: Array<{ field: string; targetType: string; edgeType: string }>;
};

type ManifestTool = {
  name: string;
  effect: "read" | "create" | "update" | "delete";
  risk: "read" | "external_write" | "data_export";
  objects?: string[];
  objectArg?: string;
  recordIdArg?: string;
  resultPath?: string;
  preview?: boolean;
  receipt?: boolean;
};

type ObjectManifest = {
  version: 1;
  connector: string;
  objects: ManifestObject[];
  tools: ManifestTool[];
};

const MANIFEST_MAX_FIELDS = 120;
const MANIFEST_MAX_ENUM_VALUES = 64;
/** Kept under CoWork's 256 KB limit for one manifest. */
const MANIFEST_MAX_BYTES = 240 * 1024;
const MANIFEST_FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_.$:-]{0,119}$/;
/** On a person table, a live column whose name looks personal is marked pii as well. */
const PERSONAL_FIELD_NAME =
  /name|e_?mail|phone|mobile|fax|street|address|city|zip|postal|birth|photo|avatar/i;
/** Rows read from `sys_dictionary` per table. */
const DICTIONARY_ROW_LIMIT = 200;
/**
 * The whole live read gets this long. CoWork runs one call at a time per connector, so a slow
 * instance would hold up the model's own calls; past the deadline the declared manifest goes back.
 */
const LIVE_MANIFEST_DEADLINE_MS = 12_000;

// State, priority, impact and urgency are choice lists whose API values are numeric codes.
const INCIDENT_STATES = ["1", "2", "3", "6", "7", "8"];
const PROBLEM_STATES = ["101", "102", "103", "104", "106", "107"];
const CHANGE_STATES = ["-5", "-4", "-3", "-2", "-1", "0", "3", "4"];
const PRIORITY_CODES = ["1", "2", "3", "4", "5"];
const SEVERITY_CODES = ["1", "2", "3"];

/** Columns incident, problem and change_request inherit from `task`. */
const TASK_FIELDS: ManifestField[] = [
  { name: "sys_id", type: "id", label: "Sys ID" },
  { name: "number", type: "string", label: "Number" },
  { name: "short_description", type: "string", label: "Short description" },
  { name: "description", type: "text", label: "Description", pii: true },
  { name: "priority", type: "enum", label: "Priority", enum: PRIORITY_CODES },
  { name: "impact", type: "enum", label: "Impact", enum: SEVERITY_CODES },
  { name: "urgency", type: "enum", label: "Urgency", enum: SEVERITY_CODES },
  { name: "assigned_to", type: "reference", label: "Assigned to" },
  { name: "assignment_group", type: "reference", label: "Assignment group" },
  { name: "opened_by", type: "reference", label: "Opened by" },
  { name: "opened_at", type: "datetime", label: "Opened" },
  { name: "closed_at", type: "datetime", label: "Closed" },
  { name: "active", type: "boolean", label: "Active" },
  { name: "sys_created_on", type: "datetime", label: "Created" },
  { name: "sys_updated_on", type: "datetime", label: "Updated" },
];

const SERVICENOW_OBJECTS: ManifestObject[] = [
  {
    type: "incident",
    label: "Incident",
    entityType: "incident",
    keyField: "sys_id",
    titleField: "number",
    fields: [
      ...TASK_FIELDS,
      { name: "state", type: "enum", label: "State", enum: INCIDENT_STATES },
      { name: "caller_id", type: "reference", label: "Caller" },
      { name: "category", type: "string", label: "Category" },
      { name: "subcategory", type: "string", label: "Subcategory" },
      { name: "problem_id", type: "reference", label: "Problem" },
      { name: "resolved_at", type: "datetime", label: "Resolved" },
      { name: "close_code", type: "string", label: "Resolution code" },
      { name: "close_notes", type: "text", label: "Resolution notes", pii: true },
    ],
    statusField: { name: "state", values: INCIDENT_STATES, closed: ["6", "7", "8"] },
    relations: [
      { field: "assigned_to", targetType: "sys_user", edgeType: "assigned_to" },
      { field: "caller_id", targetType: "sys_user", edgeType: "reported_by" },
      { field: "opened_by", targetType: "sys_user", edgeType: "related_to" },
      { field: "problem_id", targetType: "problem", edgeType: "related_to" },
    ],
  },
  {
    type: "problem",
    label: "Problem",
    entityType: "problem",
    keyField: "sys_id",
    titleField: "number",
    fields: [
      ...TASK_FIELDS,
      { name: "state", type: "enum", label: "State", enum: PROBLEM_STATES },
      { name: "known_error", type: "boolean", label: "Known error" },
      { name: "resolved_at", type: "datetime", label: "Resolved" },
    ],
    statusField: { name: "state", values: PROBLEM_STATES, closed: ["106", "107"] },
    relations: [
      { field: "assigned_to", targetType: "sys_user", edgeType: "assigned_to" },
      { field: "opened_by", targetType: "sys_user", edgeType: "reported_by" },
    ],
  },
  {
    type: "change_request",
    label: "Change Request",
    entityType: "change",
    keyField: "sys_id",
    titleField: "number",
    fields: [
      ...TASK_FIELDS,
      { name: "state", type: "enum", label: "State", enum: CHANGE_STATES },
      { name: "type", type: "enum", label: "Type", enum: ["standard", "normal", "emergency"] },
      { name: "category", type: "string", label: "Category" },
      { name: "risk", type: "string", label: "Risk" },
      { name: "requested_by", type: "reference", label: "Requested by" },
      { name: "start_date", type: "datetime", label: "Planned start date" },
      { name: "end_date", type: "datetime", label: "Planned end date" },
    ],
    statusField: { name: "state", values: CHANGE_STATES, closed: ["3", "4"] },
    relations: [
      { field: "assigned_to", targetType: "sys_user", edgeType: "assigned_to" },
      { field: "requested_by", targetType: "sys_user", edgeType: "reported_by" },
      { field: "opened_by", targetType: "sys_user", edgeType: "related_to" },
    ],
  },
  {
    type: "sys_user",
    label: "User",
    entityType: "person",
    keyField: "sys_id",
    titleField: "name",
    fields: [
      { name: "sys_id", type: "id", label: "Sys ID" },
      { name: "user_name", type: "string", label: "User ID", pii: true },
      { name: "name", type: "string", label: "Name", pii: true },
      { name: "first_name", type: "string", label: "First name", pii: true },
      { name: "last_name", type: "string", label: "Last name", pii: true },
      { name: "email", type: "email", label: "Email", pii: true },
      { name: "phone", type: "phone", label: "Business phone", pii: true },
      { name: "mobile_phone", type: "phone", label: "Mobile phone", pii: true },
      { name: "street", type: "text", label: "Street", pii: true },
      { name: "city", type: "string", label: "City", pii: true },
      { name: "state", type: "string", label: "State / Province", pii: true },
      { name: "zip", type: "string", label: "Zip / Postal code", pii: true },
      { name: "country", type: "string", label: "Country code", pii: true },
      { name: "title", type: "string", label: "Title" },
      { name: "department", type: "reference", label: "Department" },
      { name: "company", type: "reference", label: "Company" },
      { name: "manager", type: "reference", label: "Manager" },
      { name: "location", type: "reference", label: "Location" },
      { name: "active", type: "boolean", label: "Active" },
      { name: "sys_created_on", type: "datetime", label: "Created" },
      { name: "sys_updated_on", type: "datetime", label: "Updated" },
    ],
  },
];

const SERVICENOW_MANIFEST_TOOLS: ManifestTool[] = [
  {
    name: `${CONNECTOR_PREFIX}.list_records`,
    effect: "read",
    risk: "read",
    objectArg: "table",
    resultPath: "data.result",
  },
  {
    name: `${CONNECTOR_PREFIX}.get_record`,
    effect: "read",
    risk: "read",
    objectArg: "table",
    recordIdArg: "sysId",
    resultPath: "data.result",
  },
  {
    name: `${CONNECTOR_PREFIX}.create_record`,
    effect: "create",
    risk: "external_write",
    objectArg: "table",
  },
  {
    name: `${CONNECTOR_PREFIX}.update_record`,
    effect: "update",
    risk: "external_write",
    objectArg: "table",
    recordIdArg: "sysId",
  },
];

/** Dictionary internal types as manifest types; anything else reads as a string. */
const SERVICENOW_FIELD_TYPES: Record<string, ManifestFieldType> = {
  GUID: "id",
  string: "string",
  translated_text: "string",
  translated_field: "string",
  multi_two_lines: "text",
  html: "text",
  translated_html: "text",
  journal: "text",
  journal_input: "text",
  journal_list: "text",
  integer: "number",
  longint: "number",
  decimal: "number",
  float: "number",
  currency: "currency",
  price: "currency",
  percent_complete: "percent",
  boolean: "boolean",
  glide_date: "date",
  glide_date_time: "datetime",
  due_date: "datetime",
  reference: "reference",
  email: "email",
  ph_number: "phone",
  url: "url",
  choice: "enum",
  json: "json",
};
/**
 * Internal types that hold personal data on any table: email and phone, and every free-text
 * type (journals hold comment and work-note bodies; notes and HTML often quote people).
 */
const SERVICENOW_PII_TYPES = new Set([
  "email",
  "ph_number",
  "multi_two_lines",
  "html",
  "translated_html",
  "journal",
  "journal_input",
  "journal_list",
]);

function manifestLabel(value: unknown): string | undefined {
  const label = typeof value === "string" ? value.trim().slice(0, 120).trim() : "";
  return label || undefined;
}

/** Distinct values the manifest accepts, in order, at most 64. */
function manifestEnum(values: unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (out.size >= MANIFEST_MAX_ENUM_VALUES) break;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && trimmed.length <= 120) out.add(trimmed);
  }
  return [...out];
}

/** A Table API value: a plain string, or a reference's `value`. */
function servicenowValue(value: any): string {
  if (typeof value === "string") return value;
  return typeof value?.value === "string" ? value.value : "";
}

/** The status field with the live values; closed values the instance no longer has drop out. */
function liveStatusField(
  object: ManifestObject,
  fields: ManifestField[],
): ManifestObject["statusField"] {
  const status = object.statusField;
  const values = status && fields.find((field) => field.name === status.name)?.enum;
  if (!status || !values || values.length === 0) return status;
  const closed = (status.closed ?? []).filter((value) => values.includes(value));
  return { name: status.name, values, ...(closed.length > 0 ? { closed } : {}) };
}

/**
 * A declared table updated from its own dictionary rows (labels, extra columns after the
 * declared ones) and its state choices. Declared columns keep their declared types.
 */
function enrichServiceNowObject(
  object: ManifestObject,
  columns: any[] | undefined,
  choices: any[] | undefined,
): ManifestObject {
  const declared = new Set(object.fields.map((field) => field.name));
  const labels = new Map<string, string>();
  const extra = new Map<string, ManifestField>();
  for (const row of columns ?? []) {
    const name = servicenowValue(row?.element);
    if (!MANIFEST_FIELD_NAME.test(name)) continue;
    const label = manifestLabel(servicenowValue(row?.column_label));
    if (declared.has(name)) {
      if (label) labels.set(name, label);
      continue;
    }
    if (extra.has(name)) continue;
    const internalType = servicenowValue(row?.internal_type);
    const field: ManifestField = { name, type: SERVICENOW_FIELD_TYPES[internalType] ?? "string" };
    if (label) field.label = label;
    const personal = object.entityType === "person" && PERSONAL_FIELD_NAME.test(name);
    if (personal || SERVICENOW_PII_TYPES.has(internalType)) field.pii = true;
    extra.set(name, field);
  }
  const states = manifestEnum((choices ?? []).map((row) => servicenowValue(row?.value)));
  const fields = [
    ...object.fields.map((field) => {
      const label = labels.get(field.name) ?? field.label;
      const isState = states.length > 0 && field.name === object.statusField?.name;
      return { ...field, ...(label ? { label } : {}), ...(isState ? { enum: states } : {}) };
    }),
    ...extra.values(),
  ].slice(0, MANIFEST_MAX_FIELDS);
  const statusField = liveStatusField(object, fields);
  return { ...object, fields, ...(statusField ? { statusField } : {}) };
}

/** The instance's https origin for record links; none when the instance is not https. */
function servicenowRecordPageBase(): string | undefined {
  try {
    const base =
      config.instanceUrl || (config.instance ? `https://${config.instance}.service-now.com` : "");
    const url = new URL(base);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function servicenowManifest(objects: ManifestObject[]): ObjectManifest {
  const base = servicenowRecordPageBase();
  return {
    version: 1,
    connector: CONNECTOR_PREFIX,
    objects: objects.map((object) =>
      base
        ? { ...object, urlTemplate: `${base}/nav_to.do?uri=${object.type}.do?sys_id={id}` }
        : object,
    ),
    tools: SERVICENOW_MANIFEST_TOOLS,
  };
}

function manifestBytes(manifest: ObjectManifest): number {
  return Buffer.byteLength(JSON.stringify(manifest), "utf8");
}

/** Whether the instance can be asked at all: an instance plus a token or a user and password. */
function servicenowConfigured(): boolean {
  return Boolean(
    (config.instanceUrl || config.instance) &&
    (config.accessToken || (config.username && config.password)),
  );
}

/** Rows from a Table API read, or undefined when the read failed. */
async function readRows(
  table: string,
  query: string,
  limit: number,
  fields: string[],
): Promise<any[] | undefined> {
  try {
    const result = await client.listRecords(table, query, limit, undefined, fields);
    return Array.isArray(result.data?.result) ? result.data.result : undefined;
  } catch {
    return undefined;
  }
}

/** `work`'s value, or `fallback` once `ms` pass first; the timer never outlives the race. */
async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    (timer as { unref?: () => unknown }).unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The declared tables updated from their dictionaries and state choices. */
async function liveServiceNowObjects(): Promise<ManifestObject[]> {
  return Promise.all(
    SERVICENOW_OBJECTS.map(async (object) => {
      const status = object.statusField?.name;
      const [columns, choices] = await Promise.all([
        readRows(
          "sys_dictionary",
          `name=${object.type}^elementISNOTEMPTY`,
          DICTIONARY_ROW_LIMIT,
          ["element", "column_label", "internal_type"],
        ),
        // English rows only: each translation is its own row and would eat the limit.
        status
          ? readRows(
              "sys_choice",
              `name=${object.type}^element=${status}^inactive=false^language=en^ORDERBYsequence`,
              MANIFEST_MAX_ENUM_VALUES,
              ["value", "label"],
            )
          : undefined,
      ]);
      try {
        return enrichServiceNowObject(object, columns, choices);
      } catch {
        return object;
      }
    }),
  );
}

async function describeServiceNowObjects(): Promise<ObjectManifest> {
  try {
    let objects = SERVICENOW_OBJECTS;
    if (servicenowConfigured()) {
      objects = await withDeadline(
        liveServiceNowObjects(),
        LIVE_MANIFEST_DEADLINE_MS,
        SERVICENOW_OBJECTS,
      );
    }
    const manifest = servicenowManifest(objects);
    if (manifestBytes(manifest) <= MANIFEST_MAX_BYTES) return manifest;
  } catch {
    // Fall back to the declared tables below.
  }
  return servicenowManifest(SERVICENOW_OBJECTS);
}

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  [`${CONNECTOR_PREFIX}.health`]: async () => buildEnvelope(await client.health()),
  [`${CONNECTOR_PREFIX}.list_records`]: async (args) =>
    buildEnvelope(
      await client.listRecords(args.table, args.query, args.limit, args.offset, args.fields),
    ),
  [`${CONNECTOR_PREFIX}.get_record`]: async (args) =>
    buildEnvelope(await client.getRecord(args.table, args.sysId, args.fields)),
  [`${CONNECTOR_PREFIX}.create_record`]: async (args) =>
    buildEnvelope(await client.createRecord(args.table, args.fields || {})),
  [`${CONNECTOR_PREFIX}.update_record`]: async (args) =>
    buildEnvelope(await client.updateRecord(args.table, args.sysId, args.fields || {})),
  [`${CONNECTOR_PREFIX}.describe_objects`]: async () => {
    const manifest = await describeServiceNowObjects();
    return {
      content: [{ type: "text", text: JSON.stringify(manifest) }],
      structuredContent: manifest,
    };
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
  name: "ServiceNow Connector",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

export function startServiceNowMcpServer(): void {
  new StdioMCPServer(toolProvider, serverInfo).start();
}

/** Test hook: one `tools/call` request through the server. */
export async function callServiceNowToolForTest(params: any): Promise<any> {
  return (new StdioMCPServer(toolProvider, serverInfo) as any).handleToolsCall(params);
}

/** Test hook: the tools `tools/list` returns. */
export function listServiceNowToolsForTest(): MCPTool[] {
  return toolProvider.getTools();
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startServiceNowMcpServer();
}

function buildEnvelope(result: RequestResult): any {
  return {
    ok: true,
    data: result.data,
    meta: {
      durationMs: result.meta.durationMs,
      vendorRequestId: result.meta.vendorRequestId,
      baseUrl: result.meta.baseUrl,
    },
    warnings: [],
  };
}
