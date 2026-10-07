import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { MCPClientManager } from "../../electron/mcp/client/MCPClientManager";
import { MCPRegistryManager } from "../../electron/mcp/registry/MCPRegistryManager";
import type {
  McpInstallConfirmationHandler,
  McpInstallConfirmationRequest,
} from "../../electron/mcp/registry/MCPRegistryManager";
import { MCPSettingsManager } from "../../electron/mcp/settings";
import {
  CONNECTOR_BLOCKED_PUBLIC_MESSAGE,
  assertMcpServerEnableAllowed,
  isConnectorBlockedError,
} from "../../electron/mcp/connector-policy";
import type {
  MCPAuthConfig,
  MCPRegistry,
  MCPRegistryEntry,
  MCPRegistrySearchOptions,
  MCPServerConfig,
  MCPServerStatus,
  MCPSettings,
  MCPTool,
  MCPUpdateInfo,
} from "../../electron/mcp/types";
import { isTempWorkspaceId, type Workspace } from "../../shared/types";
import type { BrowserDesktopDefinition, BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { WebApplicationError, type WebRequestContext } from "../web/WebApplication";

const MAX_SERVERS = 50;
const MAX_REGISTRY_ENTRIES = 100;
const MAX_TOOLS = 100;
const MAX_INSTALL_APPROVALS = 100;
const INSTALL_APPROVAL_TTL_MS = 5 * 60_000;
const SENSITIVE_LAUNCH_ARGUMENT =
  /^--?(?:access[-_]?token|api[-_]?key|client[-_]?secret|password|secret|token|auth(?:orization)?|credential)(?:$|=)/i;
const EMBEDDED_CREDENTIAL_PATTERN =
  /(?:\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b)/;
const EMBEDDED_CREDENTIAL_REDACTION =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/g;
const MCP_TRANSPORTS = ["stdio", "sse", "websocket", "streamable-http"] as const;
const MCP_STATUSES = ["disconnected", "connecting", "connected", "reconnecting", "error"];
const MCP_INSTALL_METHODS = ["npm", "pip", "binary", "docker", "manual"] as const;

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const registryIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const boundedText = (max: number) => z.string().max(max);
const transport = z.enum(MCP_TRANSPORTS);
const secretText = z.string().max(4096);
const environmentValues = z
  .record(z.string().min(1).max(128), secretText)
  .refine((value) => Object.keys(value).length <= 64);
const headerValues = z
  .record(z.string().min(1).max(100), boundedText(1000))
  .refine((value) => Object.keys(value).length <= 32);

const authSchema = z
  .object({
    type: z.enum(["none", "bearer", "api-key", "basic"]),
    token: secretText.optional(),
    apiKey: secretText.optional(),
    username: boundedText(500).optional(),
    password: secretText.optional(),
    headerName: boundedText(100).optional(),
    refreshToken: secretText.optional(),
    clientId: boundedText(500).optional(),
    clientSecret: secretText.optional(),
    tokenUrl: z.string().url().max(500).optional(),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const serverConfigFields = {
  name: z.string().trim().min(1).max(200),
  description: boundedText(1000).optional(),
  enabled: z.boolean().default(true),
  transport,
  command: z.string().trim().min(1).max(1000).optional(),
  args: z.array(boundedText(500)).max(50).optional(),
  env: environmentValues.optional(),
  cwd: boundedText(4096).optional(),
  url: z.string().url().max(500).optional(),
  headers: headerValues.optional(),
  registryId: boundedText(200).optional(),
  auth: authSchema.optional(),
  connectionTimeout: z.number().int().min(1000).max(120_000).optional(),
  requestTimeout: z.number().int().min(1000).max(300_000).optional(),
  version: boundedText(100).optional(),
  author: boundedText(200).optional(),
  homepage: z.string().url().max(500).optional(),
  repository: z.string().url().max(500).optional(),
  license: boundedText(100).optional(),
};

const createServerSchema = z
  .object(serverConfigFields)
  .strict()
  .superRefine((value, ctx) => {
    if (value.transport === "stdio" && !value.command) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "A stdio command is required." });
    }
    if (value.transport !== "stdio" && !value.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "A remote MCP URL is required." });
    }
    if (value.transport === "stdio" && value.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "stdio servers cannot set a URL." });
    }
    if (value.transport !== "stdio" && (value.command || value.args || value.env || value.cwd)) {
      ctx.addIssue({
        code: "custom",
        path: ["transport"],
        message: "Remote MCP servers cannot include local process settings.",
      });
    }
  });

const updateServerSchema = z
  .object({
    name: serverConfigFields.name.optional(),
    description: serverConfigFields.description,
    enabled: z.boolean().optional(),
    transport: transport.optional(),
    command: serverConfigFields.command,
    args: serverConfigFields.args,
    env: serverConfigFields.env,
    cwd: serverConfigFields.cwd,
    url: serverConfigFields.url,
    headers: serverConfigFields.headers,
    registryId: serverConfigFields.registryId,
    auth: authSchema.optional(),
    removeEnvKeys: z.array(z.string().min(1).max(128)).max(64).optional(),
    connectionTimeout: serverConfigFields.connectionTimeout,
    requestTimeout: serverConfigFields.requestTimeout,
    version: serverConfigFields.version,
    author: serverConfigFields.author,
    homepage: serverConfigFields.homepage,
    repository: serverConfigFields.repository,
    license: serverConfigFields.license,
  })
  .strict();

const safeServerSchema = z
  .object({
    id: identifier,
    name: boundedText(200),
    description: boundedText(1000).optional(),
    enabled: z.boolean(),
    transport,
    registryId: boundedText(200).optional(),
    version: boundedText(100).optional(),
    installedAt: z.number().finite().optional(),
    connectionTimeout: z.number().int().optional(),
    requestTimeout: z.number().int().optional(),
    hasAuthentication: z.boolean(),
    environmentVariableCount: z.number().int().min(0).max(64),
    customHeaderCount: z.number().int().min(0).max(32),
  })
  .strict();

const settingsPatchSchema = z
  .object({
    servers: z.array(safeServerSchema).max(MAX_SERVERS).optional(),
    autoConnect: z.boolean().optional(),
    toolNamePrefix: z.string().max(50).optional(),
    maxReconnectAttempts: z.number().int().min(0).max(20).optional(),
    reconnectDelayMs: z.number().int().min(100).max(60_000).optional(),
    registryEnabled: z.boolean().optional(),
    storageStatus: z
      .enum([
        "success",
        "not_found",
        "decryption_failed",
        "checksum_mismatch",
        "os_encryption_unavailable",
      ])
      .optional(),
  })
  .strict();

const workspaceOnly = z.object({ workspaceId: identifier }).strict();
const serverRequest = z.object({ workspaceId: identifier, serverId: identifier }).strict();
const registrySearchRequest = z
  .object({
    workspaceId: identifier,
    query: z.string().max(200).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
  })
  .strict();
const registryEntryRequest = z
  .object({ workspaceId: identifier, entryId: registryIdentifier })
  .strict();
const installRequest = z
  .object({
    workspaceId: identifier,
    entryId: registryIdentifier,
    approvalToken: z.string().uuid(),
  })
  .strict();
const updatePreviewRequest = z.object({ workspaceId: identifier, serverId: identifier }).strict();
const registryUpdateRequest = z
  .object({
    workspaceId: identifier,
    serverId: identifier,
    approvalToken: z.string().uuid(),
  })
  .strict();

export interface BrowserMCPSettingsPort {
  loadSettings(): MCPSettings;
  getSettingsForDisplay(): MCPSettings & { storageStatus: string };
  saveSettings(settings: MCPSettings): void;
  addServer(config: Omit<MCPServerConfig, "id">): MCPServerConfig;
  updateServer(id: string, updates: Partial<MCPServerConfig>): MCPServerConfig | null;
  removeServer(id: string): boolean;
  getServer(id: string): MCPServerConfig | undefined;
}

export interface BrowserMCPClientPort {
  getStatus(): MCPServerStatus[];
  getServerStatus(serverId: string): MCPServerStatus | null;
  getServerTools(serverId: string): MCPTool[];
  getAllTools(): MCPTool[];
  connectServer(serverId: string): Promise<void>;
  disconnectServer(serverId: string): Promise<void>;
  testServer(
    serverId: string,
  ): Promise<{ success: boolean; error?: string; tools?: number; blockedByPolicy?: boolean }>;
}

export interface BrowserMCPRegistryPort {
  fetchRegistry(forceRefresh?: boolean): Promise<MCPRegistry>;
  getServer(serverId: string): Promise<MCPRegistryEntry | null>;
  searchServers(options: MCPRegistrySearchOptions): Promise<MCPRegistryEntry[]>;
  getCategories(): Promise<string[]>;
  installServer(
    entryId: string,
    extraArgs?: string[],
    confirmationHandler?: McpInstallConfirmationHandler,
  ): Promise<MCPServerConfig>;
  uninstallServer(serverId: string): Promise<void>;
  checkForUpdates(): Promise<MCPUpdateInfo[]>;
  updateServer(
    serverId: string,
    confirmationHandler?: McpInstallConfirmationHandler,
  ): Promise<MCPServerConfig>;
}

export interface BrowserMCPMethodOptions {
  /** The fixed profile owner authenticated by this host instance. */
  profileId: string;
  resolveWorkspace: (workspaceId: string) => Promise<Workspace | null>;
  settings?: BrowserMCPSettingsPort;
  client?: BrowserMCPClientPort;
  registry?: BrowserMCPRegistryPort;
  now?: () => number;
  makeApprovalToken?: () => string;
}

interface PendingInstallApproval {
  key: string;
  token: string;
  entryId: string;
  workspaceId: string;
  expiresAt: number;
  request: McpInstallConfirmationRequest;
  requestHash: string;
  operation: "install" | "update";
  serverId?: string;
}

/** MCP lifecycle adapter for the authenticated browser host API. */
export function createBrowserMCPDefinitions(
  options: BrowserMCPMethodOptions,
): BrowserDesktopDefinitions {
  const settings = options.settings ?? MCPSettingsManager;
  const client = options.client ?? MCPClientManager.getInstance();
  const registry = options.registry ?? MCPRegistryManager;
  const now = options.now ?? Date.now;
  const makeApprovalToken = options.makeApprovalToken ?? randomUUID;
  const installApprovals = new Map<string, PendingInstallApproval>();

  const authorize = async (
    context: WebRequestContext,
    workspaceId: string,
    mutation: boolean,
  ): Promise<Workspace> => {
    if (
      !context.sessionId ||
      !context.identity.profileId ||
      context.identity.profileId !== options.profileId
    ) {
      throw forbidden();
    }
    const workspace = await options.resolveWorkspace(workspaceId);
    if (
      !workspace ||
      workspace.id !== workspaceId ||
      workspace.permissions.read !== true ||
      (mutation && workspace.permissions.write !== true) ||
      (mutation && (workspace.isTemp === true || isTempWorkspaceId(workspace.id)))
    ) {
      throw forbidden();
    }
    return workspace;
  };

  const method = <S extends z.ZodTypeAny>(
    schema: S,
    handler: (context: WebRequestContext, value: z.infer<S>) => unknown | Promise<unknown>,
    mutation = false,
  ): BrowserDesktopDefinition => ({
    capability: "connectors.configure",
    mutation,
    minArgs: 1,
    maxArgs: 1,
    validate: (args) => {
      try {
        return [schema.parse(args[0])];
      } catch {
        throw invalid();
      }
    },
    handler: ([value], context) => handler(context, value as z.infer<S>),
  });

  const currentSecrets = (): string[] => {
    const values: string[] = [];
    for (const server of settings.loadSettings().servers.slice(0, MAX_SERVERS)) {
      for (const value of [
        server.auth?.token,
        server.auth?.apiKey,
        server.auth?.password,
        server.auth?.refreshToken,
        server.auth?.clientSecret,
        ...Object.values(server.env ?? {}),
        ...Object.values(server.headers ?? {}),
      ]) {
        if (typeof value === "string" && value.length > 0 && !values.includes(value)) {
          values.push(value);
        }
      }
    }
    return values;
  };

  const scrubText = (value: unknown, maxLength: number, secrets = currentSecrets()): string => {
    if (typeof value !== "string") return "";
    let result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    for (const secret of secrets) result = result.split(secret).join("[redacted]");
    result = result.replace(EMBEDDED_CREDENTIAL_REDACTION, "[redacted]");
    return result.slice(0, maxLength);
  };

  const projectServer = (server: MCPServerConfig): Record<string, unknown> => ({
    id: server.id,
    name: scrubText(server.name, 200),
    ...(server.description ? { description: scrubText(server.description, 1000) } : {}),
    enabled: server.enabled === true,
    transport: server.transport,
    ...(server.registryId ? { registryId: scrubText(server.registryId, 200) } : {}),
    ...(server.version ? { version: scrubText(server.version, 100) } : {}),
    ...(typeof server.installedAt === "number" ? { installedAt: server.installedAt } : {}),
    ...(typeof server.connectionTimeout === "number"
      ? { connectionTimeout: server.connectionTimeout }
      : {}),
    ...(typeof server.requestTimeout === "number" ? { requestTimeout: server.requestTimeout } : {}),
    hasAuthentication: hasCredential(server.auth),
    environmentVariableCount: Math.min(Object.keys(server.env ?? {}).length, 64),
    customHeaderCount: Math.min(Object.keys(server.headers ?? {}).length, 32),
  });

  const projectSettings = (): Record<string, unknown> => {
    const current = settings.loadSettings();
    let storageStatus = "not_found";
    try {
      const status = settings.getSettingsForDisplay().storageStatus;
      if (
        [
          "success",
          "not_found",
          "decryption_failed",
          "checksum_mismatch",
          "os_encryption_unavailable",
        ].includes(status)
      ) {
        storageStatus = status;
      }
    } catch {
      storageStatus = "not_found";
    }
    return {
      servers: current.servers.slice(0, MAX_SERVERS).map(projectServer),
      autoConnect: current.autoConnect === true,
      toolNamePrefix: scrubText(current.toolNamePrefix, 50),
      maxReconnectAttempts: Math.min(Math.max(current.maxReconnectAttempts, 0), 20),
      reconnectDelayMs: Math.min(Math.max(current.reconnectDelayMs, 100), 60_000),
      registryEnabled: current.registryEnabled === true,
      storageStatus,
    };
  };

  const requireServer = (serverId: string): MCPServerConfig => {
    const server = settings.getServer(serverId);
    if (!server) throw new WebApplicationError("NOT_FOUND", "MCP server is unavailable.", 404);
    return server;
  };

  const safeTool = (tool: MCPTool): Record<string, unknown> => {
    const properties = tool.inputSchema?.properties ?? {};
    const safeProperties = Object.fromEntries(
      Object.entries(properties)
        .slice(0, 50)
        .flatMap(([name, property]) => {
          const safeName = scrubText(name, 100);
          if (!safeName) return [];
          return [[safeName, { type: scrubText(property?.type, 40) || "string" }]];
        }),
    );
    return {
      name: scrubText(tool.name, 120),
      description: scrubText(tool.description, 500),
      inputSchema: {
        type: "object",
        ...(Object.keys(safeProperties).length ? { properties: safeProperties } : {}),
        required: Array.isArray(tool.inputSchema?.required)
          ? tool.inputSchema.required.slice(0, 50).map((name) => scrubText(name, 100))
          : [],
      },
    };
  };

  const safeStatus = (status: MCPServerStatus): Record<string, unknown> => {
    const server = settings.getServer(status.id);
    return {
      id: status.id,
      name: scrubText(status.name || server?.name || status.id, 200),
      status: MCP_STATUSES.includes(status.status) ? status.status : "disconnected",
      ...(status.blockedByPolicy === true
        ? { blockedByPolicy: true, error: CONNECTOR_BLOCKED_PUBLIC_MESSAGE }
        : status.status === "error"
          ? { error: "MCP operation failed. Review the server configuration on the host." }
          : {}),
      tools: Array.isArray(status.tools) ? status.tools.slice(0, MAX_TOOLS).map(safeTool) : [],
      ...(typeof status.lastPing === "number" && Number.isFinite(status.lastPing)
        ? { lastPing: status.lastPing }
        : {}),
      ...(typeof status.uptime === "number" && Number.isFinite(status.uptime)
        ? { uptime: status.uptime }
        : {}),
    };
  };

  const safeRegistryEntry = (entry: MCPRegistryEntry): Record<string, unknown> => {
    const safeTools = Array.isArray(entry.tools)
      ? entry.tools.slice(0, MAX_TOOLS).flatMap((tool) => {
          const name = scrubText(tool?.name, 120);
          return name ? [{ name, description: scrubText(tool.description, 500) }] : [];
        })
      : [];
    return {
      id: scrubText(entry.id, 100),
      name: scrubText(entry.name, 200),
      description: scrubText(entry.description, 2000),
      version: scrubText(entry.version, 80),
      author: scrubText(entry.author, 200),
      installMethod: MCP_INSTALL_METHODS.includes(entry.installMethod)
        ? entry.installMethod
        : "manual",
      transport: MCP_TRANSPORTS.includes(entry.transport) ? entry.transport : "stdio",
      tools: safeTools,
      tags: Array.isArray(entry.tags)
        ? entry.tags
            .slice(0, 50)
            .map((tag) => scrubText(tag, 50))
            .filter(Boolean)
        : [],
      ...(entry.category ? { category: scrubText(entry.category, 100) } : {}),
      ...(entry.license ? { license: scrubText(entry.license, 100) } : {}),
      verified: entry.verified === true,
      ...(entry.featured === true ? { featured: true } : {}),
      ...(typeof entry.downloads === "number" && Number.isFinite(entry.downloads)
        ? { downloads: Math.max(0, Math.floor(entry.downloads)) }
        : {}),
      ...(entry.tagline ? { tagline: scrubText(entry.tagline, 200) } : {}),
      // Commands, arguments, URLs, environment values and install package
      // details are available only through the separately reviewed preview.
    };
  };

  const safeRegistry = async (value: MCPRegistry): Promise<Record<string, unknown>> => {
    const categories = await registry.getCategories();
    return {
      version: scrubText(value.version, 80),
      lastUpdated: scrubText(value.lastUpdated, 80),
      servers: value.servers.slice(0, MAX_REGISTRY_ENTRIES).map(safeRegistryEntry),
      categories: safeList(categories, 100, 100).map((category) => scrubText(category, 100)),
      featured: value.servers
        .filter((entry) => entry.featured === true)
        .slice(0, 20)
        .map(safeRegistryEntry),
    };
  };

  const findCredentialInPlan = (request: McpInstallConfirmationRequest): boolean => {
    const secrets = currentSecrets();
    const planText = [
      request.name,
      request.publisher ?? "",
      request.command ?? "",
      ...request.args,
      ...request.envKeys,
      request.url ?? "",
    ].join("\n");
    if (secrets.some((secret) => planText.includes(secret))) return true;
    if (EMBEDDED_CREDENTIAL_PATTERN.test(planText)) return true;
    return request.args.some((argument, index) => {
      if (SENSITIVE_LAUNCH_ARGUMENT.test(argument)) {
        const separator = argument.indexOf("=");
        const inlineValue = separator >= 0 ? argument.slice(separator + 1).trim() : "";
        const following = request.args[index + 1];
        return Boolean(inlineValue || (following && !following.startsWith("-")));
      }
      return false;
    });
  };

  const planRequest = (entry: MCPRegistryEntry): McpInstallConfirmationRequest => ({
    entryId: entry.id,
    name: entry.name,
    publisher: entry.author,
    transport: entry.transport,
    command: entry.defaultCommand || entry.installCommand,
    args: [...(entry.defaultArgs || [])],
    envKeys: Object.keys(entry.defaultEnv || {}),
    url: entry.defaultUrl,
  });

  const approvalKey = (context: WebRequestContext, token: string) =>
    `${context.audience}:${context.identity.profileId}:${context.sessionId}:${token}`;

  const pruneApprovals = () => {
    const timestamp = now();
    for (const [key, approval] of installApprovals) {
      if (approval.expiresAt <= timestamp) installApprovals.delete(key);
    }
    if (installApprovals.size >= MAX_INSTALL_APPROVALS) {
      throw new WebApplicationError(
        "RATE_LIMITED",
        "Too many MCP install previews are pending. Wait for one to expire and try again.",
        429,
      );
    }
  };

  const createLaunchPlanPreview = (
    context: WebRequestContext,
    workspaceId: string,
    entry: MCPRegistryEntry,
    operation: PendingInstallApproval["operation"],
    serverId?: string,
  ) => {
    const request = planRequest(entry);
    if (findCredentialInPlan(request)) {
      throw new WebApplicationError(
        "INVALID_REQUEST",
        "This launch plan contains a saved credential and cannot be reviewed in the browser.",
        400,
      );
    }
    validateInstallPreview(request);
    const token = makeApprovalToken();
    const key = approvalKey(context, token);
    const expiresAt = now() + INSTALL_APPROVAL_TTL_MS;
    installApprovals.set(key, {
      key,
      token,
      entryId: entry.id,
      workspaceId,
      expiresAt,
      request,
      requestHash: hashConfirmationRequest(request),
      operation,
      ...(serverId ? { serverId } : {}),
    });
    return {
      approvalToken: token,
      expiresAt,
      plan: {
        entryId: scrubText(request.entryId, 100),
        name: scrubText(request.name, 200),
        ...(request.publisher ? { publisher: scrubText(request.publisher, 200) } : {}),
        transport: request.transport,
        ...(request.command ? { command: scrubText(request.command, 1000) } : {}),
        args: request.args.map((arg) => scrubText(arg, 500)),
        envKeys: request.envKeys.slice(0, 64).map((key) => scrubText(key, 128)),
        ...(request.url ? { url: sanitizeInstallUrl(request.url) } : {}),
      },
    };
  };

  const definitions: BrowserDesktopDefinitions = {
    getMCPSettings: method(workspaceOnly, async (context, { workspaceId }) => {
      await authorize(context, workspaceId, false);
      return projectSettings();
    }),

    saveMCPSettings: method(
      z
        .object({
          workspaceId: identifier,
          settings: settingsPatchSchema,
        })
        .strict(),
      async (context, { workspaceId, settings: patch }) => {
        await authorize(context, workspaceId, true);
        const current = structuredClone(settings.loadSettings());
        if (patch.servers) {
          const patchById = new Map(patch.servers.map((server) => [server.id, server]));
          if (patchById.size !== current.servers.length || patchById.size > MAX_SERVERS) {
            throw invalid();
          }
          for (const currentServer of current.servers) {
            const submitted = patchById.get(currentServer.id);
            if (!submitted || !sameSafeServer(submitted, projectServer(currentServer))) {
              throw invalid();
            }
            assertEnableAllowed(currentServer, { ...currentServer, enabled: submitted.enabled });
            currentServer.enabled = submitted.enabled;
          }
        }
        if (patch.autoConnect !== undefined) current.autoConnect = patch.autoConnect;
        if (patch.toolNamePrefix !== undefined) current.toolNamePrefix = patch.toolNamePrefix;
        if (patch.maxReconnectAttempts !== undefined)
          current.maxReconnectAttempts = patch.maxReconnectAttempts;
        if (patch.reconnectDelayMs !== undefined) current.reconnectDelayMs = patch.reconnectDelayMs;
        if (patch.registryEnabled !== undefined) current.registryEnabled = patch.registryEnabled;
        settings.saveSettings(current);
        return projectSettings();
      },
      true,
    ),

    addMCPServer: method(
      z.object({ workspaceId: identifier, config: createServerSchema }).strict(),
      async (context, { workspaceId, config }) => {
        await authorize(context, workspaceId, true);
        assertEnableAllowed(undefined, { ...config, id: "" } as MCPServerConfig);
        const created = settings.addServer(config as Omit<MCPServerConfig, "id">);
        return projectServer(created);
      },
      true,
    ),

    updateMCPServer: method(
      z
        .object({ workspaceId: identifier, serverId: identifier, updates: updateServerSchema })
        .strict(),
      async (context, { workspaceId, serverId, updates }) => {
        await authorize(context, workspaceId, true);
        if (
          updates.transport !== undefined ||
          updates.command !== undefined ||
          updates.args !== undefined ||
          updates.cwd !== undefined ||
          updates.url !== undefined
        ) {
          throw new WebApplicationError(
            "INVALID_REQUEST",
            "Browser MCP updates cannot change a server's launch command or endpoint. Remove and add the server again, or review a registry launch plan before updating it.",
            400,
          );
        }
        const current = requireServer(serverId);
        // registryId is the connector identity admin policy matches on; it is set at install.
        if (updates.registryId !== undefined && updates.registryId !== current.registryId) {
          throw new WebApplicationError(
            "INVALID_REQUEST",
            "A server's registry ID cannot be changed. Reinstall it instead.",
            400,
          );
        }
        const merged = { ...current, ...updates };
        const validated = createServerSchema.safeParse(pickServerConfigFields(merged));
        if (!validated.success) throw invalid();
        assertEnableAllowed(current, merged as MCPServerConfig);
        const { removeEnvKeys = [], ...configUpdates } = updates;
        const nextEnvironment =
          updates.env === undefined && removeEnvKeys.length === 0
            ? undefined
            : { ...current.env, ...updates.env };
        if (nextEnvironment) {
          for (const key of removeEnvKeys) delete nextEnvironment[key];
        }
        const safeUpdates = {
          ...configUpdates,
          ...(nextEnvironment ? { env: nextEnvironment } : {}),
        } as Partial<MCPServerConfig>;
        const updated = settings.updateServer(serverId, safeUpdates);
        if (!updated) throw new WebApplicationError("NOT_FOUND", "MCP server is unavailable.", 404);
        return projectServer(updated);
      },
      true,
    ),

    removeMCPServer: method(
      serverRequest,
      async (context, { workspaceId, serverId }) => {
        await authorize(context, workspaceId, true);
        requireServer(serverId);
        try {
          await client.disconnectServer(serverId);
        } catch {
          // Removing the stored config is still authoritative if a dead
          // connection cannot complete its best-effort shutdown.
        }
        return { success: settings.removeServer(serverId) };
      },
      true,
    ),

    connectMCPServer: method(
      serverRequest,
      async (context, { workspaceId, serverId }) => {
        await authorize(context, workspaceId, true);
        requireServer(serverId);
        await runManagerOperation(() => client.connectServer(serverId), "connect");
        const status = client.getServerStatus(serverId) ?? {
          id: serverId,
          name: settings.getServer(serverId)?.name ?? serverId,
          status: "connected" as const,
          tools: [],
        };
        return { success: true, status: safeStatus(status) };
      },
      true,
    ),

    disconnectMCPServer: method(
      serverRequest,
      async (context, { workspaceId, serverId }) => {
        await authorize(context, workspaceId, true);
        requireServer(serverId);
        await runManagerOperation(() => client.disconnectServer(serverId), "disconnect");
        return { success: true };
      },
      true,
    ),

    getMCPStatus: method(workspaceOnly, async (context, { workspaceId }) => {
      await authorize(context, workspaceId, false);
      return client.getStatus().slice(0, MAX_SERVERS).map(safeStatus);
    }),

    getMCPServerStatus: method(serverRequest, async (context, { workspaceId, serverId }) => {
      await authorize(context, workspaceId, false);
      requireServer(serverId);
      const status = client.getServerStatus(serverId);
      return status ? safeStatus(status) : null;
    }),

    getMCPServerTools: method(serverRequest, async (context, { workspaceId, serverId }) => {
      await authorize(context, workspaceId, false);
      requireServer(serverId);
      return client.getServerTools(serverId).slice(0, MAX_TOOLS).map(safeTool);
    }),

    getMCPAllTools: method(workspaceOnly, async (context, { workspaceId }) => {
      await authorize(context, workspaceId, false);
      return client.getAllTools().slice(0, MAX_TOOLS).map(safeTool);
    }),

    testMCPServer: method(
      serverRequest,
      async (context, { workspaceId, serverId }) => {
        await authorize(context, workspaceId, true);
        requireServer(serverId);
        const result = await runManagerOperation(
          () => client.testServer(serverId),
          "test connection",
        );
        return result.success
          ? { success: true, tools: Math.min(Math.max(result.tools ?? 0, 0), MAX_TOOLS) }
          : result.blockedByPolicy === true
            ? { success: false, blockedByPolicy: true, error: CONNECTOR_BLOCKED_PUBLIC_MESSAGE }
            : {
                success: false,
                error: "MCP connection test failed. Review the server configuration on the host.",
              };
      },
      true,
    ),

    fetchMCPRegistry: method(workspaceOnly, async (context, { workspaceId }) => {
      await authorize(context, workspaceId, false);
      try {
        const fetched = await registry.fetchRegistry();
        return safeRegistry(fetched);
      } catch {
        throw safeManagerError("registry fetch");
      }
    }),

    searchMCPRegistry: method(registrySearchRequest, async (context, request) => {
      await authorize(context, request.workspaceId, false);
      try {
        const results = await registry.searchServers({
          query: request.query,
          tags: request.tags,
          limit: 50,
          offset: 0,
        });
        return results.slice(0, 50).map(safeRegistryEntry);
      } catch {
        throw safeManagerError("registry search");
      }
    }),

    previewMCPServerInstall: method(
      registryEntryRequest,
      async (context, { workspaceId, entryId }) => {
        await authorize(context, workspaceId, true);
        pruneApprovals();
        let entry: MCPRegistryEntry | null;
        try {
          entry = await registry.getServer(entryId);
        } catch {
          throw safeManagerError("registry lookup");
        }
        if (!entry)
          throw new WebApplicationError("NOT_FOUND", "MCP registry entry is unavailable.", 404);
        const existing = settings
          .loadSettings()
          .servers.some(
            (server) =>
              server.registryId === entry.id ||
              server.name === entry.name ||
              Boolean(entry.packageName && server.command?.includes(entry.packageName)),
          );
        if (existing) {
          throw new WebApplicationError("CONFLICT", "MCP server is already installed.", 409);
        }
        return createLaunchPlanPreview(context, workspaceId, entry, "install");
      },
      true,
    ),

    previewMCPServerUpdate: method(
      updatePreviewRequest,
      async (context, { workspaceId, serverId }) => {
        await authorize(context, workspaceId, true);
        pruneApprovals();
        const installed = requireServer(serverId);
        let entry: MCPRegistryEntry | undefined;
        try {
          const currentRegistry = await registry.fetchRegistry(true);
          entry = currentRegistry.servers.find(
            (candidate) =>
              candidate.id === installed.registryId ||
              candidate.name === installed.name ||
              Boolean(candidate.packageName && installed.command?.includes(candidate.packageName)),
          );
        } catch {
          throw safeManagerError("registry lookup");
        }
        if (!entry) {
          throw new WebApplicationError(
            "NOT_FOUND",
            "MCP server is unavailable in the registry.",
            404,
          );
        }
        return createLaunchPlanPreview(context, workspaceId, entry, "update", serverId);
      },
      true,
    ),

    installMCPServer: method(
      installRequest,
      async (context, { workspaceId, entryId, approvalToken }) => {
        await authorize(context, workspaceId, true);
        const key = approvalKey(context, approvalToken);
        const approval = installApprovals.get(key);
        if (
          !approval ||
          approval.expiresAt <= now() ||
          approval.entryId !== entryId ||
          approval.workspaceId !== workspaceId ||
          approval.operation !== "install"
        ) {
          installApprovals.delete(key);
          throw new WebApplicationError(
            "FORBIDDEN",
            "Review the current MCP launch plan before installing this server.",
            403,
          );
        }

        installApprovals.delete(key);
        const confirm: McpInstallConfirmationHandler = async (request) =>
          hashConfirmationRequest(request) === approval.requestHash;
        try {
          const installed = await registry.installServer(entryId, [], confirm);
          return projectServer(installed);
        } catch (error) {
          throw safeManagerError("registry install", error);
        }
      },
      true,
    ),

    uninstallMCPServer: method(
      serverRequest,
      async (context, { workspaceId, serverId }) => {
        await authorize(context, workspaceId, true);
        requireServer(serverId);
        try {
          await client.disconnectServer(serverId);
        } catch {
          // Best-effort shutdown before the registry manager removes settings.
        }
        try {
          await registry.uninstallServer(serverId);
          return { success: true };
        } catch {
          throw safeManagerError("registry uninstall");
        }
      },
      true,
    ),

    checkMCPUpdates: method(workspaceOnly, async (context, { workspaceId }) => {
      await authorize(context, workspaceId, false);
      try {
        const updates = await registry.checkForUpdates();
        return updates.slice(0, MAX_SERVERS).map((update) => ({
          serverId: update.serverId,
          currentVersion: scrubText(update.currentVersion, 80),
          latestVersion: scrubText(update.latestVersion, 80),
          registryEntry: safeRegistryEntry(update.registryEntry),
        }));
      } catch {
        throw safeManagerError("update check");
      }
    }),

    updateMCPServerFromRegistry: method(
      registryUpdateRequest,
      async (context, { workspaceId, serverId, approvalToken }) => {
        await authorize(context, workspaceId, true);
        requireServer(serverId);
        const key = approvalKey(context, approvalToken);
        const approval = installApprovals.get(key);
        if (
          !approval ||
          approval.expiresAt <= now() ||
          approval.workspaceId !== workspaceId ||
          approval.serverId !== serverId ||
          approval.operation !== "update"
        ) {
          installApprovals.delete(key);
          throw new WebApplicationError(
            "FORBIDDEN",
            "Review the current MCP launch plan before updating this server.",
            403,
          );
        }
        installApprovals.delete(key);
        const confirm: McpInstallConfirmationHandler = async (request) =>
          hashConfirmationRequest(request) === approval.requestHash;
        try {
          const updated = await registry.updateServer(serverId, confirm);
          return projectServer(updated);
        } catch (error) {
          throw safeManagerError("registry update", error);
        }
      },
      true,
    ),
  };

  return definitions;
}

function hasCredential(auth: MCPAuthConfig | undefined): boolean {
  if (!auth) return false;
  return Boolean(
    auth.token ||
    auth.apiKey ||
    auth.password ||
    auth.refreshToken ||
    auth.clientSecret ||
    auth.username,
  );
}

function pickServerConfigFields(value: MCPServerConfig): Record<string, unknown> {
  const keys = [
    "name",
    "description",
    "enabled",
    "transport",
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "headers",
    "registryId",
    "auth",
    "connectionTimeout",
    "requestTimeout",
    "version",
    "author",
    "homepage",
    "repository",
    "license",
  ] as const;
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

function sameSafeServer(submitted: z.infer<typeof safeServerSchema>, current: unknown): boolean {
  const parsedCurrent = safeServerSchema.safeParse(current);
  if (!parsedCurrent.success) return false;
  const { enabled: _enabled, ...submittedSafe } = submitted;
  const { enabled: _currentEnabled, ...currentSafe } = parsedCurrent.data;
  return JSON.stringify(submittedSafe) === JSON.stringify(currentSafe);
}

function safeList(values: unknown, itemLimit: number, itemLength: number): string[] {
  if (!Array.isArray(values)) return [];
  const result = values
    .slice(0, itemLimit)
    .flatMap((value) =>
      typeof value === "string"
        ? [value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, itemLength)]
        : [],
    );
  return [...new Set(result)].sort();
}

function hashConfirmationRequest(request: McpInstallConfirmationRequest): string {
  const normalized = {
    entryId: request.entryId,
    name: request.name,
    publisher: request.publisher ?? null,
    transport: request.transport,
    command: request.command ?? null,
    args: [...request.args],
    envKeys: [...request.envKeys].sort(),
    url: request.url ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function validateInstallPreview(request: McpInstallConfirmationRequest): void {
  const valid = z
    .object({
      entryId: registryIdentifier,
      name: z.string().trim().min(1).max(200).refine(hasNoControlCharacters),
      publisher: boundedText(200).refine(hasNoControlCharacters).optional(),
      transport: z.enum(MCP_TRANSPORTS),
      command: boundedText(1000).refine(hasNoControlCharacters).optional(),
      args: z.array(boundedText(500).refine(hasNoControlCharacters)).max(50),
      envKeys: z.array(z.string().min(1).max(128).refine(hasNoControlCharacters)).max(64),
      url: z.string().url().max(500).optional(),
    })
    .strict()
    .safeParse(request);
  if (!valid.success) throw invalid("The MCP launch plan cannot be reviewed safely.");
  if (request.url && urlContainsCredentials(request.url)) {
    throw invalid(
      "This MCP launch plan embeds URL credentials and cannot be reviewed in the browser.",
    );
  }
}

function hasNoControlCharacters(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function sanitizeInstallUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  for (const key of url.searchParams.keys()) {
    if (/(?:token|secret|key|password|credential|auth)/i.test(key)) {
      url.searchParams.set(key, "[redacted]");
    }
  }
  return url.toString().slice(0, 500);
}

function urlContainsCredentials(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      Boolean(url.username || url.password) ||
      [...url.searchParams.keys()].some((key) =>
        /(?:token|secret|key|password|credential|auth)/i.test(key),
      )
    );
  } catch {
    return true;
  }
}

async function runManagerOperation<T>(operation: () => Promise<T>, label: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw safeManagerError(label, error);
  }
}

function connectorBlocked(): WebApplicationError {
  return new WebApplicationError("FORBIDDEN", CONNECTOR_BLOCKED_PUBLIC_MESSAGE, 403);
}

/** Admin policy `connectors.blocked` refuses switching a blocked server on. */
function assertEnableAllowed(
  current: MCPServerConfig | undefined,
  next: MCPServerConfig & { enabled?: boolean },
): void {
  try {
    assertMcpServerEnableAllowed(current, next);
  } catch (error) {
    if (isConnectorBlockedError(error)) throw connectorBlocked();
    throw error;
  }
}

function safeManagerError(operation: string, error?: unknown): WebApplicationError {
  if (isConnectorBlockedError(error)) return connectorBlocked();
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/timed?\s*out|timeout/i.test(message)) {
    return new WebApplicationError("HOST_UNAVAILABLE", "The MCP operation timed out.", 504);
  }
  if (/already installed/i.test(message)) {
    return new WebApplicationError("CONFLICT", "MCP server is already installed.", 409);
  }
  if (/not found|unavailable/i.test(message)) {
    return new WebApplicationError("NOT_FOUND", "MCP server is unavailable.", 404);
  }
  if (/declined|launch plan|confirmation/i.test(message)) {
    return new WebApplicationError(
      "FORBIDDEN",
      "MCP installation was not approved for this launch plan. Review the plan and try again.",
      403,
    );
  }
  const operationLabel =
    operation === "registry fetch" || operation === "registry search"
      ? "MCP registry request"
      : `MCP ${operation}`;
  return new WebApplicationError(
    "HOST_UNAVAILABLE",
    `${operationLabel} failed on the host. Review MCP settings and host logs.`,
    502,
  );
}

function forbidden(): WebApplicationError {
  return new WebApplicationError("FORBIDDEN", "MCP access is unavailable for this workspace.", 403);
}

function invalid(message = "Invalid MCP request."): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", message, 400);
}
