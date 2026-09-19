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

type ProviderId =
  | "daloopa"
  | "morningstar"
  | "spglobal"
  | "factset"
  | "moodys"
  | "mtnewswires"
  | "aiera"
  | "lseg"
  | "pitchbook"
  | "chronograph"
  | "egnyte";

type ProviderConfig = {
  id: ProviderId;
  displayName: string;
  envPrefix: string;
  tools: Array<
    | "health"
    | "search"
    | "get_company_profile"
    | "get_financials"
    | "get_market_data"
    | "get_news"
    | "get_documents"
  >;
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
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
} as const;

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  daloopa: {
    id: "daloopa",
    displayName: "Daloopa",
    envPrefix: "DALOOPA",
    tools: ["health", "search", "get_financials", "get_documents"],
  },
  morningstar: {
    id: "morningstar",
    displayName: "Morningstar",
    envPrefix: "MORNINGSTAR",
    tools: ["health", "search", "get_company_profile", "get_market_data", "get_financials"],
  },
  spglobal: {
    id: "spglobal",
    displayName: "S&P Global",
    envPrefix: "SPGLOBAL",
    tools: ["health", "search", "get_company_profile", "get_financials", "get_market_data"],
  },
  factset: {
    id: "factset",
    displayName: "FactSet",
    envPrefix: "FACTSET",
    tools: [
      "health",
      "search",
      "get_company_profile",
      "get_financials",
      "get_market_data",
      "get_news",
    ],
  },
  moodys: {
    id: "moodys",
    displayName: "Moody's",
    envPrefix: "MOODYS",
    tools: ["health", "search", "get_company_profile", "get_market_data", "get_documents"],
  },
  mtnewswires: {
    id: "mtnewswires",
    displayName: "MT Newswires",
    envPrefix: "MTNEWSWIRES",
    tools: ["health", "search", "get_news"],
  },
  aiera: {
    id: "aiera",
    displayName: "Aiera",
    envPrefix: "AIERA",
    tools: ["health", "search", "get_documents", "get_news"],
  },
  lseg: {
    id: "lseg",
    displayName: "LSEG",
    envPrefix: "LSEG",
    tools: [
      "health",
      "search",
      "get_company_profile",
      "get_financials",
      "get_market_data",
      "get_news",
    ],
  },
  pitchbook: {
    id: "pitchbook",
    displayName: "PitchBook",
    envPrefix: "PITCHBOOK",
    tools: ["health", "search", "get_company_profile", "get_financials"],
  },
  chronograph: {
    id: "chronograph",
    displayName: "Chronograph",
    envPrefix: "CHRONOGRAPH",
    tools: ["health", "search", "get_company_profile", "get_financials", "get_documents"],
  },
  egnyte: {
    id: "egnyte",
    displayName: "Egnyte",
    envPrefix: "EGNYTE",
    tools: ["health", "search", "get_documents"],
  },
};

function getProviderFromArgs(): ProviderConfig {
  const providerArgIndex = process.argv.findIndex((arg) => arg === "--provider");
  const fromArgs = providerArgIndex >= 0 ? process.argv[providerArgIndex + 1] : undefined;
  const providerId = (
    fromArgs ||
    process.env.COWORK_FINANCE_PROVIDER ||
    ""
  ).toLowerCase() as ProviderId;
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(
      `Unknown finance provider "${providerId || "(missing)"}". Set --provider to one of: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return provider;
}

function envValue(provider: ProviderConfig, suffix: string): string | undefined {
  return process.env[`${provider.envPrefix}_${suffix}`] || process.env[`FINANCE_DATA_${suffix}`];
}

class FinanceDataClient {
  constructor(private readonly provider: ProviderConfig) {}

  private get baseUrl(): string {
    const value = envValue(this.provider, "BASE_URL")?.trim();
    if (!value) {
      throw new Error(
        `${this.provider.envPrefix}_BASE_URL is required for ${this.provider.displayName}`,
      );
    }
    return value.replace(/\/+$/, "");
  }

  private get credential(): string {
    const value =
      envValue(this.provider, "API_KEY")?.trim() ||
      envValue(this.provider, "ACCESS_TOKEN")?.trim() ||
      envValue(this.provider, "TOKEN")?.trim();
    if (!value) {
      throw new Error(
        `${this.provider.envPrefix}_API_KEY, ${this.provider.envPrefix}_ACCESS_TOKEN, or FINANCE_DATA_API_KEY is required for ${this.provider.displayName}`,
      );
    }
    return value;
  }

  private authHeaders(): Record<string, string> {
    const headerName = envValue(this.provider, "API_KEY_HEADER") || "Authorization";
    if (headerName.toLowerCase() === "authorization") {
      return { Authorization: `Bearer ${this.credential}` };
    }
    return { [headerName]: this.credential };
  }

  private endpoint(tool: string): string {
    const override = envValue(this.provider, `${tool.toUpperCase()}_PATH`);
    if (override) return override.startsWith("/") ? override : `/${override}`;
    return `/cowork/${tool.replace(/^get_/, "")}`;
  }

  private async request(tool: string, params: Record<string, any>): Promise<any> {
    const url = new URL(this.endpoint(tool), this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      if (typeof value === "object") {
        url.searchParams.set(key, JSON.stringify(value));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        ...this.authHeaders(),
        Accept: "application/json",
        "User-Agent": `CoWork-FinanceData/${this.provider.id}`,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `${this.provider.displayName} request failed (${res.status}): ${text || res.statusText}`,
      );
    }
    const data = text ? JSON.parse(text) : null;
    return {
      ok: true,
      provider: this.provider.id,
      retrievedAt: new Date().toISOString(),
      retrievalPath: url.toString(),
      data,
    };
  }

  async execute(toolName: string, args: Record<string, any>): Promise<any> {
    const [, action] = toolName.split(".");
    if (!action || !this.provider.tools.includes(action as any)) {
      throw new Error(`Unsupported tool for ${this.provider.displayName}: ${toolName}`);
    }
    if (action === "health") {
      return this.request("health", {});
    }
    return this.request(action, args);
  }
}

class FinanceToolProvider {
  private readonly client: FinanceDataClient;

  constructor(private readonly provider: ProviderConfig) {
    this.client = new FinanceDataClient(provider);
  }

  getTools(): MCPTool[] {
    return this.provider.tools.map((tool) => ({
      name: `${this.provider.id}.${tool}`,
      description: `${this.provider.displayName} read-only ${tool.replace(/_/g, " ")}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Search query, ticker, company, entity, document, or account identifier",
          },
          companyId: {
            type: "string",
            description: "Provider-specific company or entity identifier",
          },
          ticker: { type: "string", description: "Ticker or instrument identifier" },
          period: { type: "string", description: "Reporting period, date, quarter, or time range" },
          limit: { type: "number", description: "Maximum records to return" },
          filters: { type: "object", description: "Provider-specific read-only filters" },
        },
      },
    }));
  }

  async executeTool(name: string, args: Record<string, any>): Promise<any> {
    return this.client.execute(name, args || {});
  }
}

class StdioMCPServer {
  private initialized = false;
  private rl: readline.Interface | null = null;

  constructor(
    private readonly toolProvider: FinanceToolProvider,
    private readonly provider: ProviderConfig,
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
    if ("method" in message) {
      await this.handleNotification(message as JSONRPCNotification);
    }
  }

  private async handleRequest(request: JSONRPCRequest): Promise<void> {
    try {
      switch (request.method) {
        case MCP_METHODS.INITIALIZE:
          this.sendResult(request.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `finance-data-${this.provider.id}`, version: "0.1.0" },
          });
          return;
        case MCP_METHODS.TOOLS_LIST:
          this.requireInitialized();
          this.sendResult(request.id, { tools: this.toolProvider.getTools() });
          return;
        case MCP_METHODS.TOOLS_CALL:
          this.requireInitialized();
          this.sendResult(request.id, await this.handleToolsCall(request.params));
          return;
        case MCP_METHODS.SHUTDOWN:
          this.sendResult(request.id, {});
          setImmediate(() => this.stop());
          return;
        default:
          this.sendError(
            request.id,
            MCP_ERROR_CODES.METHOD_NOT_FOUND,
            `Method not found: ${request.method}`,
          );
      }
    } catch (error: any) {
      this.sendError(
        request.id,
        error?.code || MCP_ERROR_CODES.INTERNAL_ERROR,
        error?.message || "Internal error",
      );
    }
  }

  private async handleNotification(notification: JSONRPCNotification): Promise<void> {
    if (notification.method === MCP_METHODS.INITIALIZED) this.initialized = true;
  }

  private async handleToolsCall(params: any): Promise<any> {
    const { name, arguments: args } = params || {};
    if (!name) throw { code: MCP_ERROR_CODES.INVALID_PARAMS, message: "Tool name is required" };
    try {
      const result = await this.toolProvider.executeTool(name, args || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return {
        content: [
          { type: "text", text: `Error: ${error?.message || "Finance data request failed"}` },
        ],
        isError: true,
      };
    }
  }

  private requireInitialized(): void {
    if (!this.initialized)
      throw { code: MCP_ERROR_CODES.SERVER_NOT_INITIALIZED, message: "Server not initialized" };
  }

  private sendResult(id: JSONRPCId, result: any): void {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private sendError(id: JSONRPCId, code: number, message: string): void {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  }
}

try {
  const provider = getProviderFromArgs();
  new StdioMCPServer(new FinanceToolProvider(provider), provider).start();
} catch (error: any) {
  process.stderr.write(`[finance-data-mcp] ${error?.message || String(error)}\n`);
  process.exit(1);
}
