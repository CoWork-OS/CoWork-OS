import * as fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";

type JSONRPCId = string | number;
type JSONRPCRequest = { jsonrpc: "2.0"; id: JSONRPCId; method: string; params?: Record<string, any> };
type JSONRPCNotification = { jsonrpc: "2.0"; method: string; params?: Record<string, any> };
type JSONRPCResponse = { jsonrpc: "2.0"; id: JSONRPCId; result?: any; error?: { code: number; message: string; data?: any } };
type MCPToolProperty = { type: string; description?: string; enum?: string[]; default?: any; items?: MCPToolProperty; properties?: Record<string, MCPToolProperty>; required?: string[] };
type MCPTool = { name: string; description?: string; inputSchema: { type: "object"; properties?: Record<string, MCPToolProperty>; required?: string[]; additionalProperties?: boolean } };
type MCPServerInfo = { name: string; version: string; protocolVersion?: string; capabilities?: { tools?: { listChanged?: boolean } } };
type ToolProvider = { getTools(): MCPTool[]; executeTool(name: string, args: Record<string, any>): Promise<any> };

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_BASE_URL = "http://127.0.0.1:8188";
const CONNECTOR = "comfyui";
const DEFAULT_API_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;

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

function comfyBaseUrl(): string {
  const raw = process.env.COMFYUI_BASE_URL || DEFAULT_BASE_URL;
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("COMFYUI_BASE_URL must point to localhost");
  }
  return url.toString().replace(/\/$/, "");
}

function safeComfyBaseUrl(): string {
  try {
    return comfyBaseUrl();
  } catch {
    return process.env.COMFYUI_BASE_URL || DEFAULT_BASE_URL;
  }
}

function apiTimeoutMs(endpoint: string): number {
  if (endpoint === "system_stats") return HEALTH_TIMEOUT_MS;
  const raw = Number(process.env.COMFYUI_MCP_TIMEOUT_MS || "");
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30 * 60_000) : DEFAULT_API_TIMEOUT_MS;
}

function projectRoot(): string {
  const raw = process.env.COWORK_ARCH_PROJECT_ROOT || process.env.COWORK_WORKSPACE_ROOT || "";
  if (!raw.trim()) {
    throw new Error("COWORK_ARCH_PROJECT_ROOT or COWORK_WORKSPACE_ROOT is required for ComfyUI file path tools.");
  }
  return path.resolve(raw);
}

function normalizeProjectPath(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
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

async function requestComfy(endpoint: string, options?: { method?: string; body?: Record<string, any> }): Promise<any> {
  const url = `${comfyBaseUrl()}/${endpoint.replace(/^\//, "")}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiTimeoutMs(endpoint));
  let response: Response;
  try {
    response = await fetch(url, {
      method: options?.method || (options?.body ? "POST" : "GET"),
      headers: options?.body ? { "Content-Type": "application/json" } : undefined,
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`ComfyUI request timed out for ${endpoint}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const data = await parseResponse(response);
  if (!response.ok) {
    throw new Error(data?.error || data?.message || `ComfyUI returned ${response.status}`);
  }
  return data;
}

async function fetchComfyBinary(url: string, label: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), apiTimeoutMs("view"));
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`ComfyUI output download timed out for ${label}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const data = await parseResponse(response);
    throw new Error(data?.error || data?.message || `Failed to fetch ComfyUI output ${label}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function objectSchema(description: string): MCPToolProperty {
  return { type: "object", description, properties: {}, required: [] };
}

function viewUrl(image: any): string | null {
  const filename = image?.filename;
  if (!filename) return null;
  const params = new URLSearchParams({
    filename: String(filename),
    subfolder: String(image?.subfolder || ""),
    type: String(image?.type || "output"),
  });
  return `${comfyBaseUrl()}/view?${params.toString()}`;
}

function replaceWorkflowPlaceholders(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === "string") {
    let next = value;
    for (const [key, replacement] of Object.entries(replacements)) {
      next = next.split(`{{${key}}}`).join(replacement);
    }
    return next;
  }
  if (Array.isArray(value)) return value.map((item) => replaceWorkflowPlaceholders(item, replacements));
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    next[key] = replaceWorkflowPlaceholders(item, replacements);
  }
  return next;
}

const tools: MCPTool[] = [
  { name: "comfyui.health", description: "Check ComfyUI API availability", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "comfyui.list_workflows", description: "List local workflow JSON files from COMFYUI_WORKFLOW_DIR", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "comfyui.submit_workflow", description: "Submit a ComfyUI workflow JSON graph", inputSchema: { type: "object", properties: { workflow: objectSchema("ComfyUI prompt/workflow graph"), clientId: { type: "string", description: "Optional ComfyUI client id" } }, required: ["workflow"], additionalProperties: false } },
  { name: "comfyui.submit_flux_photoreal_pass", description: "Submit a Flux-style photoreal workflow graph with project metadata", inputSchema: { type: "object", properties: { workflow: objectSchema("ComfyUI workflow graph with {{prompt}}, {{negativePrompt}}, {{sourceImagePath}}, and {{projectId}} placeholders"), projectId: { type: "string" }, sourceImagePath: { type: "string" }, prompt: { type: "string" }, negativePrompt: { type: "string" }, clientId: { type: "string" } }, required: ["workflow", "prompt"], additionalProperties: false } },
  { name: "comfyui.get_job_status", description: "Get queue/status for a submitted prompt", inputSchema: { type: "object", properties: { promptId: { type: "string" } }, required: [], additionalProperties: false } },
  { name: "comfyui.get_history", description: "Get ComfyUI history, optionally for one prompt id", inputSchema: { type: "object", properties: { promptId: { type: "string" } }, required: [], additionalProperties: false } },
  { name: "comfyui.collect_outputs", description: "Collect output image URLs for a completed prompt id and optionally copy them under the project root", inputSchema: { type: "object", properties: { promptId: { type: "string" }, outputDir: { type: "string", description: "Optional project-root-relative output directory for copied images" } }, required: ["promptId"], additionalProperties: false } },
];

async function health(): Promise<any> {
  try {
    const stats = await requestComfy("system_stats");
    return { ok: true, connector: CONNECTOR, baseUrl: comfyBaseUrl(), stats };
  } catch (error: any) {
    return { ok: false, connector: CONNECTOR, baseUrl: safeComfyBaseUrl(), status: "unavailable", error: error?.message || String(error) };
  }
}

async function listWorkflows(): Promise<any> {
  const workflowDir = process.env.COMFYUI_WORKFLOW_DIR;
  if (!workflowDir) {
    return { ok: true, workflowDir: null, workflows: [], note: "Set COMFYUI_WORKFLOW_DIR to list saved workflows." };
  }
  const safeWorkflowDir = normalizeProjectPath(workflowDir, "COMFYUI_WORKFLOW_DIR");
  const entries = await fs.readdir(safeWorkflowDir, { withFileTypes: true });
  const workflows = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => ({ name: entry.name, path: path.join(safeWorkflowDir, entry.name) }));
  return { ok: true, workflowDir: safeWorkflowDir, workflows };
}

async function submitWorkflow(args: Record<string, any>): Promise<any> {
  const body = {
    prompt: args.workflow,
    client_id: args.clientId || `cowork-${Date.now()}`,
  };
  const response = await requestComfy("prompt", { method: "POST", body });
  return { ok: true, ...response };
}

async function submitFluxPhotorealPass(args: Record<string, any>): Promise<any> {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const workflowText = JSON.stringify(args.workflow || {});
  if (!workflowText.includes("{{prompt}}")) {
    throw new Error("Flux workflow must include a {{prompt}} placeholder so prompt metadata is applied.");
  }
  const sourceImagePath =
    typeof args.sourceImagePath === "string" && args.sourceImagePath.trim()
      ? normalizeProjectPath(args.sourceImagePath, "sourceImagePath")
      : "";
  const workflow = replaceWorkflowPlaceholders(args.workflow, {
    prompt,
    negativePrompt: String(args.negativePrompt || ""),
    sourceImagePath,
    projectId: String(args.projectId || ""),
  });
  const response = await submitWorkflow({ workflow, clientId: args.clientId });
  return {
    ...response,
    substitutions: {
      prompt,
      negativePrompt: String(args.negativePrompt || ""),
      sourceImagePath,
      projectId: String(args.projectId || ""),
    },
  };
}

async function getJobStatus(args: Record<string, any>): Promise<any> {
  const queue = await requestComfy("queue");
  const promptId = args.promptId ? String(args.promptId) : null;
  if (!promptId) return { ok: true, queue };
  const running = Array.isArray(queue?.queue_running) && queue.queue_running.some((item: any) => JSON.stringify(item).includes(promptId));
  const pending = Array.isArray(queue?.queue_pending) && queue.queue_pending.some((item: any) => JSON.stringify(item).includes(promptId));
  return { ok: true, promptId, status: running ? "running" : pending ? "pending" : "not_in_queue", queue };
}

async function getHistory(args: Record<string, any>): Promise<any> {
  const promptId = args.promptId ? String(args.promptId) : "";
  return requestComfy(promptId ? `history/${encodeURIComponent(promptId)}` : "history");
}

async function collectOutputs(args: Record<string, any>): Promise<any> {
  const promptId = String(args.promptId || "");
  if (!promptId) throw new Error("promptId is required");
  const history = await getHistory({ promptId });
  const promptHistory = history?.[promptId] || history;
  const outputs = promptHistory?.outputs || {};
  const outputDir =
    typeof args.outputDir === "string" && args.outputDir.trim()
      ? normalizeProjectPath(args.outputDir, "outputDir")
      : null;
  if (outputDir) await fs.mkdir(outputDir, { recursive: true });
  const images: Array<{ nodeId: string; filename: string; subfolder: string; type: string; url: string | null; localPath?: string }> = [];
  for (const [nodeId, output] of Object.entries(outputs)) {
    const outputImages = (output as any)?.images;
    if (!Array.isArray(outputImages)) continue;
    for (const image of outputImages) {
      const url = viewUrl(image);
      const record: { nodeId: string; filename: string; subfolder: string; type: string; url: string | null; localPath?: string } = {
        nodeId,
        filename: String(image?.filename || ""),
        subfolder: String(image?.subfolder || ""),
        type: String(image?.type || "output"),
        url,
      };
      if (outputDir && url && record.filename) {
        const data = await fetchComfyBinary(url, record.filename);
        const localPath = path.join(outputDir, path.basename(record.filename));
        await fs.writeFile(localPath, data);
        record.localPath = localPath;
      }
      images.push(record);
    }
  }
  return { ok: true, promptId, outputDir, images };
}

const toolProvider: ToolProvider = {
  getTools: () => tools,
  executeTool: async (name, args) => {
    switch (name) {
      case "comfyui.health":
        return health();
      case "comfyui.list_workflows":
        return listWorkflows();
      case "comfyui.submit_workflow":
        return submitWorkflow(args);
      case "comfyui.submit_flux_photoreal_pass":
        return submitFluxPhotorealPass(args);
      case "comfyui.get_job_status":
        return getJobStatus(args);
      case "comfyui.get_history":
        return getHistory(args);
      case "comfyui.collect_outputs":
        return collectOutputs(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
};

const server = new StdioMCPServer(toolProvider, {
  name: "ComfyUI MCP",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: { tools: { listChanged: false } },
});

server.start();
