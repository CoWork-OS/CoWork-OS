import * as readline from "readline";

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
  type: string | string[];
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

type HomeAssistantState = {
  entity_id: string;
  state: string;
  attributes?: Record<string, any>;
  last_changed?: string;
  last_updated?: string;
};

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LIST_LIMIT = 500;

/**
 * Service domains that can run arbitrary code, reconfigure or stop Home
 * Assistant, or destroy history. These stay blocked even when a user
 * allowlists them, because an agent-issued call is not an appropriate way to
 * reach them.
 */
const BLOCKED_SERVICE_DOMAINS = new Set([
  "shell_command",
  "python_script",
  "pyscript",
  "command_line",
  "rest_command",
  "hassio",
  "recorder",
  "backup",
  "system_log",
  "logger",
  "frontend",
  "lovelace",
  "cloud",
]);
const HOMEASSISTANT_SAFE_SERVICES = new Set(["turn_on", "turn_off", "toggle", "update_entity"]);
const TARGET_KEYS = ["entity_id", "device_id", "area_id", "floor_id", "label_id", "target"];
/**
 * Physical-security domains. Calls here need `confirm: true`, which the agent
 * may only set after the user explicitly agrees, so an "always allow" MCP
 * approval rule cannot silently unlock a door or disarm an alarm.
 */
const CONFIRM_REQUIRED_DOMAINS = new Set([
  "lock",
  "alarm_control_panel",
  "cover",
  "valve",
  "siren",
]);
const ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const SLUG_RE = /^[a-z0-9_]+$/;

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
    private readonly toolProvider: {
      getTools(): MCPTool[];
      executeTool(name: string, args: Record<string, any>): Promise<any>;
    },
    private readonly serverInfo: MCPServerInfo,
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
      this.handleMessage(JSON.parse(trimmed));
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
          throw {
            code: MCP_ERROR_CODES.METHOD_NOT_FOUND,
            message: `Method not found: ${request.method}`,
          };
      }
      this.sendResult(request.id, result);
    } catch (error: any) {
      this.sendError(
        request.id,
        error?.code || MCP_ERROR_CODES.INTERNAL_ERROR,
        error?.message || "Internal error",
        error?.data,
      );
    }
  }

  private async handleNotification(notification: JSONRPCNotification): Promise<void> {
    if (notification.method === MCP_METHODS.INITIALIZED) this.initialized = true;
  }

  private handleInitialize(): {
    protocolVersion: string;
    capabilities: MCPServerInfo["capabilities"];
    serverInfo: MCPServerInfo;
  } {
    if (this.initialized) {
      throw { code: MCP_ERROR_CODES.INVALID_REQUEST, message: "Already initialized" };
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: this.serverInfo.capabilities,
      serverInfo: this.serverInfo,
    };
  }

  private async handleToolsCall(params: any): Promise<any> {
    const { name, arguments: args } = params || {};
    if (!name) throw { code: MCP_ERROR_CODES.INVALID_PARAMS, message: "Tool name is required" };
    try {
      const result = await this.toolProvider.executeTool(name, args || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error?.message || "Tool failed"}` }],
        isError: true,
      };
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw { code: MCP_ERROR_CODES.SERVER_NOT_INITIALIZED, message: "Server not initialized" };
    }
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

// ==================== Configuration ====================

function envValue(name: string): string {
  return (process.env[name] || "").trim();
}

function listEnv(name: string): string[] {
  return envValue(name)
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function baseUrl(): string {
  const raw = envValue("HOME_ASSISTANT_URL").replace(/\/+$/, "").replace(/\/api$/, "");
  if (!raw) {
    throw new Error(
      "HOME_ASSISTANT_URL is not configured. Set it to your instance, e.g. http://homeassistant.local:8123",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("HOME_ASSISTANT_URL must be a full http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HOME_ASSISTANT_URL must use http or https");
  }
  return raw;
}

function token(): string {
  const value = envValue("HOME_ASSISTANT_TOKEN");
  if (!value) {
    throw new Error(
      "HOME_ASSISTANT_TOKEN is not configured. Create a long-lived access token in your Home Assistant profile (Security tab).",
    );
  }
  return value;
}

/** Warns when the bearer token would travel unencrypted beyond this machine. */
export function transportWarning(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return undefined;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      return undefined;
    }
    return "HOME_ASSISTANT_URL uses plain HTTP, so the access token crosses the network unencrypted. Use https:// (for example via Nabu Casa or a reverse proxy) where possible.";
  } catch {
    return undefined;
  }
}

function timeoutMs(): number {
  const parsed = Number(envValue("HOME_ASSISTANT_TIMEOUT_MS"));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 120_000) : DEFAULT_TIMEOUT_MS;
}

function allowedDomains(): string[] {
  return listEnv("HOME_ASSISTANT_ALLOWED_DOMAINS");
}

function allowedEntityPatterns(): string[] {
  return listEnv("HOME_ASSISTANT_ALLOWED_ENTITIES");
}

function matchesPattern(entityId: string, pattern: string): boolean {
  if (!pattern.includes("*")) return entityId === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9_]*");
  return new RegExp(`^${escaped}$`).test(entityId);
}

// ==================== HTTP ====================

class HomeAssistantError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function haRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new HomeAssistantError(`Home Assistant did not respond within ${timeoutMs()} ms`);
    }
    throw new HomeAssistantError(
      `Cannot reach Home Assistant at ${baseUrl()}: ${error?.message || "network error"}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new HomeAssistantError(
      "Home Assistant rejected the access token. Create a new long-lived access token and update HOME_ASSISTANT_TOKEN.",
      response.status,
    );
  }
  if (response.status === 404) {
    throw new HomeAssistantError(`Not found: ${path}`, 404);
  }
  if (response.status === 429) {
    throw new HomeAssistantError("Home Assistant is rate limiting requests; retry shortly.", 429);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HomeAssistantError(
      `Home Assistant returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
      response.status,
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// ==================== Helpers ====================

function requireEntityId(value: unknown, label = "entityId"): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ENTITY_ID_RE.test(text)) throw new Error(`${label} must look like light.kitchen`);
  return text;
}

function requireSlug(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SLUG_RE.test(text)) throw new Error(`${label} must be a lowercase Home Assistant slug`);
  return text;
}

function compactState(state: HomeAssistantState): Record<string, any> {
  return {
    entityId: state.entity_id,
    domain: state.entity_id.split(".")[0],
    state: state.state,
    friendlyName: state.attributes?.friendly_name,
    unit: state.attributes?.unit_of_measurement,
    deviceClass: state.attributes?.device_class,
    lastChanged: state.last_changed,
  };
}

/** Throws unless the call satisfies the configured allowlists. Exported for tests. */
export function assertServiceCallAllowed(
  domain: string,
  service: string,
  entityIds: string[],
  config: { domains: string[]; entities: string[] } = {
    domains: allowedDomains(),
    entities: allowedEntityPatterns(),
  },
): void {
  if (BLOCKED_SERVICE_DOMAINS.has(domain)) {
    throw new Error(`The ${domain} service domain is blocked for agent use.`);
  }
  if (domain === "homeassistant" && !HOMEASSISTANT_SAFE_SERVICES.has(service)) {
    throw new Error(`homeassistant.${service} is blocked for agent use.`);
  }
  if (config.domains.length === 0 && config.entities.length === 0) {
    throw new Error(
      "Service calls are disabled until you allowlist domains or entities. Set HOME_ASSISTANT_ALLOWED_DOMAINS (e.g. light,switch) or HOME_ASSISTANT_ALLOWED_ENTITIES (e.g. light.kitchen,switch.fan_*) in Settings > Connectors > Home Assistant.",
    );
  }
  if (entityIds.length === 0) {
    throw new Error("Service calls must name at least one target entity in entityIds.");
  }
  const domainAllowed = domain === "homeassistant" || config.domains.includes(domain);
  if (!domainAllowed && config.entities.length === 0) {
    throw new Error(`The ${domain} domain is not in HOME_ASSISTANT_ALLOWED_DOMAINS.`);
  }
  for (const entityId of entityIds) {
    const entityDomain = entityId.split(".")[0];
    const allowed =
      config.domains.includes(entityDomain) ||
      config.entities.some((pattern) => matchesPattern(entityId, pattern));
    if (!allowed) {
      throw new Error(`${entityId} is not allowlisted for service calls.`);
    }
    if (domain !== "homeassistant" && !domainAllowed && entityDomain !== domain) {
      throw new Error(`${domain}.${service} cannot target ${entityId}.`);
    }
  }
}

// ==================== Tools ====================

const tools: MCPTool[] = [
  {
    name: "home-assistant.health",
    description:
      "Check that Home Assistant is reachable and the token works. Returns the instance version and which service calls are allowlisted.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "home-assistant.list_entities",
    description:
      "List or search Home Assistant entities (lights, sensors, switches, climate, etc.) with their current state. Use to find the entity_id before reading or controlling a device.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Only entities in this domain, e.g. light" },
        query: {
          type: "string",
          description: "Case-insensitive match on entity_id or friendly name",
        },
        limit: { type: "number", description: `Maximum results (default 100, max ${MAX_LIST_LIMIT})` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "home-assistant.get_state",
    description:
      "Read one entity's current state and attributes, e.g. a thermostat's target temperature or whether a door sensor is open.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "Entity ID, e.g. sensor.living_room_temperature" },
      },
      required: ["entityId"],
      additionalProperties: false,
    },
  },
  {
    name: "home-assistant.list_services",
    description:
      "List the services Home Assistant exposes (optionally for one domain) with their fields, and whether each is allowlisted. Use before call_service to find valid service names and data fields.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Only services in this domain, e.g. climate" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "home-assistant.call_service",
    description:
      "Control a device by calling a Home Assistant service on explicit entities, e.g. light.turn_on for light.kitchen. Only allowlisted domains/entities are accepted and every call goes through CoWork approval.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Service domain, e.g. light" },
        service: { type: "string", description: "Service name, e.g. turn_on" },
        entityIds: {
          type: "array",
          items: { type: "string" },
          description: "Target entity IDs; at least one is required",
        },
        data: {
          type: "object",
          description:
            "Service data such as brightness_pct or temperature. Target keys (entity_id, area_id, device_id, target) are not accepted here.",
        },
        confirm: {
          type: "boolean",
          description:
            "Required for lock, alarm_control_panel, cover, valve and siren services. Set true only after the user explicitly confirms this exact action.",
        },
      },
      required: ["domain", "service", "entityIds"],
      additionalProperties: false,
    },
  },
];

const handlers: Record<string, (args: Record<string, any>) => Promise<any>> = {
  "home-assistant.health": async () => {
    const config = await haRequest("GET", "/api/config");
    return {
      ok: true,
      data: {
        status: "ok",
        connector: "home-assistant",
        version: config?.version,
        locationName: config?.location_name,
        timeZone: config?.time_zone,
        warning: transportWarning(baseUrl()),
        serviceCalls: {
          enabled: allowedDomains().length > 0 || allowedEntityPatterns().length > 0,
          allowedDomains: allowedDomains(),
          allowedEntities: allowedEntityPatterns(),
        },
      },
    };
  },

  "home-assistant.list_entities": async (args) => {
    const domain = args.domain ? requireSlug(args.domain, "domain") : undefined;
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(Math.floor(args.limit), MAX_LIST_LIMIT))
        : 100;
    const states = ((await haRequest("GET", "/api/states")) || []) as HomeAssistantState[];
    const matches = states.filter((state) => {
      if (typeof state?.entity_id !== "string") return false;
      if (domain && !state.entity_id.startsWith(`${domain}.`)) return false;
      if (!query) return true;
      const name = String(state.attributes?.friendly_name || "").toLowerCase();
      return state.entity_id.includes(query) || name.includes(query);
    });
    matches.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    return {
      ok: true,
      data: {
        total: matches.length,
        truncated: matches.length > limit,
        entities: matches.slice(0, limit).map(compactState),
      },
    };
  },

  "home-assistant.get_state": async (args) => {
    const entityId = requireEntityId(args.entityId);
    const state = (await haRequest(
      "GET",
      `/api/states/${encodeURIComponent(entityId)}`,
    )) as HomeAssistantState;
    return { ok: true, data: { ...compactState(state), attributes: state.attributes || {} } };
  },

  "home-assistant.list_services": async (args) => {
    const domainFilter = args.domain ? requireSlug(args.domain, "domain") : undefined;
    const domains = ((await haRequest("GET", "/api/services")) || []) as Array<{
      domain: string;
      services: Record<string, { name?: string; description?: string; fields?: Record<string, any> }>;
    }>;
    const configured = { domains: allowedDomains(), entities: allowedEntityPatterns() };
    const result = domains
      .filter((entry) => !domainFilter || entry.domain === domainFilter)
      .map((entry) => ({
        domain: entry.domain,
        blocked: BLOCKED_SERVICE_DOMAINS.has(entry.domain),
        allowlisted:
          !BLOCKED_SERVICE_DOMAINS.has(entry.domain) &&
          (configured.domains.includes(entry.domain) ||
            configured.entities.some((pattern) => pattern.startsWith(`${entry.domain}.`))),
        services: Object.entries(entry.services || {}).map(([service, spec]) => ({
          service,
          name: spec?.name,
          description: spec?.description,
          fields: Object.keys(spec?.fields || {}),
        })),
      }));
    return { ok: true, data: { domains: result } };
  },

  "home-assistant.call_service": async (args) => {
    const domain = requireSlug(args.domain, "domain");
    const service = requireSlug(args.service, "service");
    if (!Array.isArray(args.entityIds)) throw new Error("entityIds must be an array");
    const entityIds: string[] = [
      ...new Set<string>(args.entityIds.map((id: unknown) => requireEntityId(id, "entityIds[]"))),
    ];
    if (
      args.data !== undefined &&
      args.data !== null &&
      (typeof args.data !== "object" || Array.isArray(args.data))
    ) {
      throw new Error("data must be an object");
    }
    const data = (args.data ?? {}) as Record<string, unknown>;
    for (const key of TARGET_KEYS) {
      if (key in data) throw new Error(`Pass targets through entityIds, not data.${key}`);
    }
    assertServiceCallAllowed(domain, service, entityIds);
    const sensitive = [domain, ...entityIds.map((id) => id.split(".")[0])].find((value) =>
      CONFIRM_REQUIRED_DOMAINS.has(value),
    );
    if (sensitive && args.confirm !== true) {
      throw new Error(
        `${domain}.${service} on ${entityIds.join(", ")} affects a ${sensitive} device. Ask the user to confirm this exact action, then call again with confirm: true.`,
      );
    }

    const changed = (await haRequest(
      "POST",
      `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
      { ...data, entity_id: entityIds },
    )) as HomeAssistantState[] | null;
    return {
      ok: true,
      data: {
        called: `${domain}.${service}`,
        targets: entityIds,
        changedStates: Array.isArray(changed) ? changed.map(compactState) : [],
      },
    };
  },
};

const toolProvider = {
  getTools: () => tools,
  executeTool: async (name: string, args: Record<string, any>) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler(args || {});
  },
};

export function listHomeAssistantToolsForTest(): MCPTool[] {
  return tools;
}

export async function executeHomeAssistantToolForTest(
  name: string,
  args: Record<string, any>,
): Promise<any> {
  return toolProvider.executeTool(name, args);
}

const serverInfo: MCPServerInfo = {
  name: "Home Assistant",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
  },
};

export function startHomeAssistantMcpServer(): void {
  new StdioMCPServer(toolProvider, serverInfo).start();
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startHomeAssistantMcpServer();
}
