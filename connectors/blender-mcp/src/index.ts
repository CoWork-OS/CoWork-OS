import * as readline from "readline";
import * as path from "path";

type JSONRPCId = string | number;
type JSONRPCRequest = { jsonrpc: "2.0"; id: JSONRPCId; method: string; params?: Record<string, any> };
type JSONRPCNotification = { jsonrpc: "2.0"; method: string; params?: Record<string, any> };
type JSONRPCResponse = { jsonrpc: "2.0"; id: JSONRPCId; result?: any; error?: { code: number; message: string; data?: any } };
type MCPToolProperty = { type: string; description?: string; enum?: string[]; default?: any; items?: MCPToolProperty; properties?: Record<string, MCPToolProperty>; required?: string[] };
type MCPTool = { name: string; description?: string; inputSchema: { type: "object"; properties?: Record<string, MCPToolProperty>; required?: string[]; additionalProperties?: boolean } };
type MCPServerInfo = { name: string; version: string; protocolVersion?: string; capabilities?: { tools?: { listChanged?: boolean } } };
type ToolProvider = { getTools(): MCPTool[]; executeTool(name: string, args: Record<string, any>): Promise<any> };

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:17642";
const CONNECTOR = "blender";
const DEFAULT_BRIDGE_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 5_000;
const PATH_FIELD_NAMES = new Set(["filePath", "imagePath", "modelPath", "outputPath", "projectPath", "scenePath"]);

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

class StdioMCPServer {
  private initialized = false;
  private rl: readline.Interface | null = null;

  constructor(
    private readonly toolProvider: ToolProvider,
    private readonly serverInfo: MCPServerInfo,
  ) {}

  start(): void {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
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
      void this.handleMessage(JSON.parse(trimmed));
    } catch {
      this.sendError(0, MCP_ERROR_CODES.PARSE_ERROR, "Parse error");
    }
  }

  private async handleMessage(message: any): Promise<void> {
    if ("id" in message && message.id !== null) {
      await this.handleRequest(message as JSONRPCRequest);
      return;
    }
    if ("method" in message) await this.handleNotification(message as JSONRPCNotification);
  }

  private async handleRequest(request: JSONRPCRequest): Promise<void> {
    try {
      let result: any;
      switch (request.method) {
        case MCP_METHODS.INITIALIZE:
          result = this.handleInitialize();
          break;
        case MCP_METHODS.TOOLS_LIST:
          this.requireInitialized();
          result = { tools: this.toolProvider.getTools() };
          break;
        case MCP_METHODS.TOOLS_CALL:
          this.requireInitialized();
          result = await this.handleToolsCall(request.params);
          break;
        case MCP_METHODS.SHUTDOWN:
          result = {};
          setImmediate(() => this.stop());
          break;
        default:
          throw { code: MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Method not found: ${request.method}` };
      }
      this.sendResult(request.id, result);
    } catch (error: any) {
      this.sendError(request.id, error?.code || MCP_ERROR_CODES.INTERNAL_ERROR, error?.message || "Internal error", error?.data);
    }
  }

  private async handleNotification(notification: JSONRPCNotification): Promise<void> {
    if (notification.method === MCP_METHODS.INITIALIZED) this.initialized = true;
  }

  private handleInitialize(): { protocolVersion: string; capabilities: MCPServerInfo["capabilities"]; serverInfo: MCPServerInfo } {
    if (this.initialized) throw { code: MCP_ERROR_CODES.INVALID_REQUEST, message: "Already initialized" };
    return { protocolVersion: PROTOCOL_VERSION, capabilities: this.serverInfo.capabilities, serverInfo: this.serverInfo };
  }

  private async handleToolsCall(params: any): Promise<any> {
    const { name, arguments: args } = params || {};
    if (!name) throw { code: MCP_ERROR_CODES.INVALID_PARAMS, message: "Tool name is required" };
    try {
      const result = await this.toolProvider.executeTool(name, args || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error?.message || "Tool failed"}` }], isError: true };
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) throw { code: MCP_ERROR_CODES.SERVER_NOT_INITIALIZED, message: "Server not initialized" };
  }

  private sendResult(id: JSONRPCId, result: any): void {
    this.sendMessage({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: JSONRPCId, code: number, message: string, data?: any): void {
    this.sendMessage({ jsonrpc: "2.0", id, error: { code, message, data } });
  }

  private sendMessage(message: JSONRPCResponse): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function bridgeBaseUrl(): string {
  const raw = process.env.BLENDER_MCP_BRIDGE_URL || DEFAULT_BRIDGE_URL;
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("BLENDER_MCP_BRIDGE_URL must point to localhost");
  }
  return url.toString().replace(/\/$/, "");
}

function safeBridgeBaseUrl(): string {
  try {
    return bridgeBaseUrl();
  } catch {
    return process.env.BLENDER_MCP_BRIDGE_URL || DEFAULT_BRIDGE_URL;
  }
}

function bridgeTimeoutMs(endpoint: string): number {
  if (endpoint === "health") return HEALTH_TIMEOUT_MS;
  const raw = Number(process.env.BLENDER_MCP_BRIDGE_TIMEOUT_MS || "");
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30 * 60_000) : DEFAULT_BRIDGE_TIMEOUT_MS;
}

function projectRoot(): string {
  const raw = process.env.COWORK_ARCH_PROJECT_ROOT || process.env.COWORK_WORKSPACE_ROOT || "";
  if (!raw.trim()) {
    throw new Error("COWORK_ARCH_PROJECT_ROOT or COWORK_WORKSPACE_ROOT is required for Blender file path tools.");
  }
  return path.resolve(raw);
}

function normalizeProjectPath(value: unknown, fieldName: string): unknown {
  if (typeof value !== "string" || !value.trim()) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error(`${fieldName} must be a local filesystem path, not a URL.`);
  }
  const root = projectRoot();
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${fieldName} must stay inside project root: ${root}`);
  }
  return resolved;
}

function normalizePathArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizePathArgs(item));
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    next[key] = PATH_FIELD_NAMES.has(key) || /(?:Path|Dir|Directory)$/.test(key)
      ? normalizeProjectPath(item, key)
      : normalizePathArgs(item);
  }
  return next;
}

async function parseResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    return JSON.parse(text);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 2_000), rawText: text.slice(0, 2_000) };
  }
}

async function requestBridge(endpoint: string, body?: Record<string, any>): Promise<any> {
  const url = `${bridgeBaseUrl()}/${endpoint.replace(/^\//, "")}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), bridgeTimeoutMs(endpoint));
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`Blender bridge request timed out for ${endpoint}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const data = await parseResponse(response);
  if (!response.ok) {
    throw new Error(data?.error || data?.message || `Blender bridge returned ${response.status}`);
  }
  return data;
}

function objectSchema(description: string): MCPToolProperty {
  return { type: "object", description, properties: {}, required: [] };
}

const tools: MCPTool[] = [
  { name: "blender.health", description: "Check Blender bridge availability", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "blender.open_scene", description: "Open an existing Blender scene", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"], additionalProperties: false } },
  { name: "blender.create_scene", description: "Create a new Blender scene for an architecture project", inputSchema: { type: "object", properties: { projectId: { type: "string" }, scenePath: { type: "string" } }, required: ["projectId", "scenePath"], additionalProperties: false } },
  { name: "blender.import_model", description: "Import a Rhino-exported model into Blender", inputSchema: { type: "object", properties: { projectId: { type: "string" }, modelPath: { type: "string" }, preserveLayers: { type: "boolean", default: true } }, required: ["projectId", "modelPath"], additionalProperties: false } },
  { name: "blender.assign_materials_by_layer", description: "Assign Blender materials using layer/object names", inputSchema: { type: "object", properties: { projectId: { type: "string" }, materialMap: objectSchema("Layer or object name to material definition map") }, required: ["projectId", "materialMap"], additionalProperties: false } },
  { name: "blender.create_material", description: "Create or update one Blender material", inputSchema: { type: "object", properties: { projectId: { type: "string" }, name: { type: "string" }, material: objectSchema("Material properties") }, required: ["projectId", "name", "material"], additionalProperties: false } },
  { name: "blender.setup_camera", description: "Create or update a render camera", inputSchema: { type: "object", properties: { projectId: { type: "string" }, camera: objectSchema("Camera transform/lens settings") }, required: ["projectId", "camera"], additionalProperties: false } },
  { name: "blender.setup_lighting", description: "Create or update scene lighting", inputSchema: { type: "object", properties: { projectId: { type: "string" }, lighting: objectSchema("Lighting setup") }, required: ["projectId", "lighting"], additionalProperties: false } },
  { name: "blender.set_render_engine", description: "Set render engine and quality options", inputSchema: { type: "object", properties: { projectId: { type: "string" }, engine: { type: "string", enum: ["CYCLES", "BLENDER_EEVEE_NEXT"] }, samples: { type: "number" }, resolutionX: { type: "number" }, resolutionY: { type: "number" } }, required: ["projectId", "engine"], additionalProperties: false } },
  { name: "blender.render_view", description: "Render a camera view to an image", inputSchema: { type: "object", properties: { projectId: { type: "string" }, cameraName: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "outputPath"], additionalProperties: false } },
  { name: "blender.capture_viewport", description: "Capture the current Blender viewport", inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "outputPath"], additionalProperties: false } },
  { name: "blender.save_scene", description: "Save the active Blender scene", inputSchema: { type: "object", properties: { projectId: { type: "string" }, filePath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
];
const DECLARED_TOOL_NAMES = new Set(tools.map((tool) => tool.name));

async function health(): Promise<any> {
  try {
    const data = await requestBridge("health");
    return { ok: true, connector: CONNECTOR, bridgeUrl: bridgeBaseUrl(), bridge: data };
  } catch (error: any) {
    return { ok: false, connector: CONNECTOR, bridgeUrl: safeBridgeBaseUrl(), status: "unavailable", error: error?.message || String(error) };
  }
}

const toolProvider: ToolProvider = {
  getTools: () => tools,
  executeTool: async (name, args) => {
    if (name === "blender.health") return health();
    if (!DECLARED_TOOL_NAMES.has(name)) throw new Error(`Unknown tool: ${name}`);
    const normalizedArgs = normalizePathArgs(args) as Record<string, any>;
    return requestBridge(name.slice("blender.".length), normalizedArgs);
  },
};

const server = new StdioMCPServer(toolProvider, {
  name: "Blender Architecture MCP",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: { tools: { listChanged: false } },
});

server.start();
