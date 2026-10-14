/**
 * In-app Workday agent setup (docs/remote-mcp-oauth.md).
 *
 * A Workday preset MCP server signs in as an external agent whose skills and
 * tools are registered in the tenant's Agent System of Record (ASOR). This
 * module manages that definition without scripts: a person signs in with a
 * Workday admin API client ("Register API Client", Agent System of Record
 * scope), searches the tenant's agent resource catalog, and registers or
 * updates the agent definition.
 *
 * - The admin connection (hosts, client ID, encrypted secret, PKCE choice) is
 *   stored on the server as `workdayAdmin`, apart from `auth`, so it never
 *   signs the MCP server out.
 * - The admin access token lives only in this process's memory, per server,
 *   until it expires. It is never persisted, logged or returned to callers.
 * - Admin calls go only to the tenant's own hosts (*.myworkday.com or
 *   *.workday.com over https). The agent gateway (*.agent.workday.com) rejects
 *   tenant-issued tokens, so it is refused as an admin host.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  WorkdayAdminConnectionSummary,
  WorkdayAgentExecutionMode,
  WorkdayAgentModel,
  WorkdayAgentResource,
  WorkdayAgentSaveResult,
  WorkdayAgentSearchResult,
  WorkdayAgentSkill,
} from "../../../shared/types";
import { assertMcpServerNotBlocked } from "../connector-policy";
import { MASKED_VALUE, MCPSettingsManager } from "../settings";
import type { MCPServerConfig, WorkdayAdminConnection } from "../types";
import {
  authorizeCodeFlow,
  McpSignInCancelledError,
  postTokenRequest,
  redactOAuthText,
  SAFE_SEGMENT,
} from "./mcp-oauth";
import { WORKDAY_OAUTH_REDIRECT_URI } from "./mcp-server-authorization";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const ASOR_TIMEOUT_MS = 30_000;
/** Renew a little before Workday's stated expiry rather than fail mid-save. */
const TOKEN_EXPIRY_MARGIN_MS = 30_000;
const SEARCH_LIMIT = 100;
const LIST_LIMIT = 100;
const MAX_TOOLS_PER_AGENT = 200;
const VERIFY_CONCURRENCY = 4;

export const DEFAULT_AGENT_URL = "https://github.com/CoWork-OS/CoWork-OS";
export const DEFAULT_AGENT_DOCUMENTATION_URL =
  "https://github.com/CoWork-OS/CoWork-OS/blob/main/docs/remote-mcp-oauth.md";

// ---------------------------------------------------------------------------
// Hosts and endpoints
// ---------------------------------------------------------------------------

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A Workday tenant host: a *.myworkday.com or *.workday.com hostname, given
 * bare or as an https origin. http, ports, paths, credentials and the agent
 * gateway are refused.
 */
export function normalizeWorkdayHost(input: string, label = "Workday host"): string {
  let value = input.trim().toLowerCase();
  if (!value) throw new Error(`${label} is required`);
  if (value.includes("://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${label} is not a valid host`);
    }
    if (url.protocol !== "https:") throw new Error(`${label} must use https`);
    if (url.username || url.password || url.port || (url.pathname && url.pathname !== "/"))
      throw new Error(`${label} must be a host name only, e.g. impl.wd5.myworkday.com`);
    if (url.search || url.hash) throw new Error(`${label} must be a host name only`);
    value = url.hostname;
  }
  value = value.replace(/\/$/, "");
  const labels = value.split(".");
  if (
    value.length > 253 ||
    labels.length < 3 ||
    !labels.every((part) => HOST_LABEL.test(part)) ||
    !(value.endsWith(".myworkday.com") || value.endsWith(".workday.com"))
  )
    throw new Error(`${label} must be a Workday host (*.myworkday.com or *.workday.com)`);
  if (value.endsWith(".agent.workday.com"))
    throw new Error(
      `${label} must be the tenant's own host; the agent gateway rejects tenant-issued tokens`,
    );
  return value;
}

/** odpimpl.wd119.myworkday.com -> odpimpl-services1.wd119.myworkday.com. */
export function deriveWorkdayServicesHost(tenantHost: string): string {
  const host = normalizeWorkdayHost(tenantHost, "Tenant host");
  const [first, ...rest] = host.split(".");
  if (first.endsWith("-services1")) return host;
  return [`${first}-services1`, ...rest].join(".");
}

export interface WorkdayAdminEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  /** ASOR API base, without a trailing slash. */
  asorBaseUrl: string;
}

export function workdayAdminEndpoints(
  connection: Pick<WorkdayAdminConnection, "tenantHost" | "servicesHost">,
  tenant: string,
): WorkdayAdminEndpoints {
  if (!SAFE_SEGMENT.test(tenant)) throw new Error("Invalid Workday tenant name");
  const tenantHost = normalizeWorkdayHost(connection.tenantHost, "Tenant host");
  const servicesHost = connection.servicesHost
    ? normalizeWorkdayHost(connection.servicesHost, "Services host")
    : deriveWorkdayServicesHost(tenantHost);
  const path = encodeURIComponent(tenant);
  return {
    authorizationUrl: `https://${tenantHost}/${path}/authorize`,
    tokenUrl: `https://${servicesHost}/ccx/oauth2/${path}/token`,
    asorBaseUrl: `https://${servicesHost}/ccx/api/asor/v1/${path}`,
  };
}

/**
 * Overrides for tests: a fake fetch and endpoints on a local fake Workday.
 * Production callers (the IPC handlers) never pass these, so admin calls only
 * ever reach the validated https hosts.
 */
export interface WorkdayAdminTransport {
  fetchImpl?: FetchLike;
  endpoints?: (connection: WorkdayAdminConnection, tenant: string) => WorkdayAdminEndpoints;
  /** A loopback redirect on a free port instead of the registered one. */
  redirectUri?: string;
}

function endpointsFor(
  connection: WorkdayAdminConnection,
  tenant: string,
  transport: WorkdayAdminTransport,
): WorkdayAdminEndpoints {
  return transport.endpoints
    ? transport.endpoints(connection, tenant)
    : workdayAdminEndpoints(connection, tenant);
}

// ---------------------------------------------------------------------------
// Server and admin connection
// ---------------------------------------------------------------------------

function workdayServer(serverId: string): { server: MCPServerConfig; tenant: string } {
  const server = MCPSettingsManager.getServer(serverId);
  if (!server) throw new Error("MCP server not found");
  assertMcpServerNotBlocked(server);
  const preset = server.auth?.type === "bearer" ? server.auth.oauth?.preset : undefined;
  if (server.transport !== "streamable-http" || preset?.kind !== "workday")
    throw new Error("Agent setup applies to Workday servers added with the Workday preset");
  if (!SAFE_SEGMENT.test(preset.tenant)) throw new Error("Invalid Workday tenant name");
  return { server, tenant: preset.tenant };
}

function requireConnection(server: MCPServerConfig): WorkdayAdminConnection {
  if (!server.workdayAdmin?.clientId || !server.workdayAdmin.tenantHost)
    throw new Error("Save the Workday admin connection first");
  return server.workdayAdmin;
}

/** Identifies a connection without holding its secret: any change voids the admin token. */
function connectionKey(connection: WorkdayAdminConnection, tenant: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        tenant,
        connection.tenantHost,
        connection.servicesHost ?? "",
        connection.clientId,
        connection.clientSecret ?? "",
        Boolean(connection.usePkce),
      ]),
    )
    .digest("hex");
}

export const WorkdayAdminConnectionSchema = z
  .object({
    serverId: z.string().uuid(),
    tenantHost: z.string().trim().min(1).max(300),
    servicesHost: z.string().trim().max(300).optional(),
    clientId: z.string().trim().min(1).max(500),
    clientSecret: z.string().max(2000).optional(),
    usePkce: z.boolean().optional(),
  })
  .strict();

function summarize(
  serverId: string,
  connection: WorkdayAdminConnection,
  tenant: string,
): WorkdayAdminConnectionSummary {
  return {
    tenant,
    tenantHost: connection.tenantHost,
    servicesHost: connection.servicesHost ?? deriveWorkdayServicesHost(connection.tenantHost),
    clientId: connection.clientId,
    hasClientSecret: Boolean(connection.clientSecret),
    usePkce: Boolean(connection.usePkce),
    signedIn: Boolean(activeSession(serverId, connection, tenant)),
  };
}

/**
 * Saves a Workday server's admin connection. A blank or masked secret keeps
 * the stored one. Any change signs the admin out and cancels a pending admin
 * sign-in; the MCP server's own sign-in is untouched.
 */
export function saveWorkdayAdminConnection(input: unknown): WorkdayAdminConnectionSummary {
  const fields = WorkdayAdminConnectionSchema.parse(input);
  const { server, tenant } = workdayServer(fields.serverId);
  const tenantHost = normalizeWorkdayHost(fields.tenantHost, "Tenant host");
  const servicesHost = fields.servicesHost?.trim()
    ? normalizeWorkdayHost(fields.servicesHost, "Services host")
    : undefined;
  const secret = fields.clientSecret?.trim();
  const keepSecret = !secret || secret === MASKED_VALUE;
  const next: WorkdayAdminConnection = {
    tenantHost,
    ...(servicesHost && servicesHost !== deriveWorkdayServicesHost(tenantHost)
      ? { servicesHost }
      : {}),
    clientId: fields.clientId,
    ...(keepSecret
      ? server.workdayAdmin?.clientSecret
        ? { clientSecret: server.workdayAdmin.clientSecret }
        : {}
      : { clientSecret: secret }),
    ...(fields.usePkce ? { usePkce: true } : {}),
  };
  const previous = server.workdayAdmin;
  if (!previous || connectionKey(previous, tenant) !== connectionKey(next, tenant)) {
    cancelWorkdayAdminSignIn(fields.serverId);
    adminSessions.delete(fields.serverId);
  }
  if (!MCPSettingsManager.updateServer(fields.serverId, { workdayAdmin: next }))
    throw new Error("MCP server not found");
  return summarize(fields.serverId, next, tenant);
}

export function getWorkdayAdminConnection(serverId: string): WorkdayAdminConnectionSummary | null {
  const { server, tenant } = workdayServer(serverId);
  return server.workdayAdmin ? summarize(serverId, server.workdayAdmin, tenant) : null;
}

// ---------------------------------------------------------------------------
// Admin sign-in (memory-only token)
// ---------------------------------------------------------------------------

interface AdminSession {
  accessToken: string;
  expiresAt?: number;
  connectionKey: string;
}

/** Admin access tokens by server ID. Memory only; never persisted or returned. */
const adminSessions = new Map<string, AdminSession>();
/** Pending admin sign-ins by server ID, so the person can cancel one. */
const pendingAdminSignIns = new Map<string, AbortController>();

function activeSession(
  serverId: string,
  connection: WorkdayAdminConnection,
  tenant: string,
): AdminSession | undefined {
  const session = adminSessions.get(serverId);
  if (!session) return undefined;
  if (
    session.connectionKey !== connectionKey(connection, tenant) ||
    (session.expiresAt !== undefined && session.expiresAt - TOKEN_EXPIRY_MARGIN_MS <= Date.now())
  ) {
    adminSessions.delete(serverId);
    return undefined;
  }
  return session;
}

/** Forgets a server's admin token (for example when the server is removed). */
export function signOutWorkdayAdmin(serverId: string): void {
  adminSessions.delete(serverId);
  cancelWorkdayAdminSignIn(serverId);
}

/**
 * Cancels a pending admin sign-in: its loopback listener closes and the sign-in
 * rejects with McpSignInCancelledError. False when none is pending.
 */
export function cancelWorkdayAdminSignIn(
  serverId: string,
  reason: "cancelled" | "superseded" = "cancelled",
): boolean {
  const controller = pendingAdminSignIns.get(serverId);
  if (!controller) return false;
  pendingAdminSignIns.delete(serverId);
  controller.abort(new McpSignInCancelledError(reason));
  return true;
}

/**
 * Signs in with the admin API client through the tenant's own authorize and
 * token endpoints. The client authenticates with HTTP Basic and the form body
 * together, which Workday accepts; PKCE is sent only when the connection asks
 * for it. The token stays in memory for this server.
 */
export async function signInWorkdayAdmin(
  serverId: string,
  options: {
    openUrl: (url: string) => Promise<void> | void;
    signal?: AbortSignal;
    timeoutMs?: number;
  } & WorkdayAdminTransport,
): Promise<{ expiresAt?: number }> {
  const { server, tenant } = workdayServer(serverId);
  const connection = requireConnection(server);
  if (!connection.clientSecret) throw new Error("Add the admin client secret, then sign in");
  const endpoints = endpointsFor(connection, tenant, options);
  const key = connectionKey(connection, tenant);
  const secret = connection.clientSecret;
  const redirectUri = options.redirectUri ?? WORKDAY_OAUTH_REDIRECT_URI;

  // A second admin sign-in of the same server replaces the first.
  cancelWorkdayAdminSignIn(serverId, "superseded");
  const controller = new AbortController();
  pendingAdminSignIns.set(serverId, controller);
  const forward = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forward();
  else options.signal?.addEventListener("abort", forward, { once: true });
  let token: Awaited<ReturnType<typeof postTokenRequest>>;
  try {
    token = await authorizeCodeFlow({
      request: {
        authorizationUrl: endpoints.authorizationUrl,
        clientId: connection.clientId,
        redirectUri,
      },
      pkce: Boolean(connection.usePkce),
      openUrl: options.openUrl,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
      exchange: (code, verifier, signal) => {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: connection.clientId,
          client_secret: secret,
        });
        if (verifier) body.set("code_verifier", verifier);
        const basic = Buffer.from(
          `${encodeURIComponent(connection.clientId)}:${encodeURIComponent(secret)}`,
        ).toString("base64");
        return postTokenRequest(
          endpoints.tokenUrl,
          body,
          { Authorization: `Basic ${basic}` },
          options.fetchImpl ?? fetch,
          signal,
        );
      },
    });
  } finally {
    options.signal?.removeEventListener("abort", forward);
    if (pendingAdminSignIns.get(serverId) === controller) pendingAdminSignIns.delete(serverId);
  }
  // A connection edited while the person was signing in wins; the token is discarded.
  const current = MCPSettingsManager.getServer(serverId)?.workdayAdmin;
  if (!current || connectionKey(current, tenant) !== key)
    throw new Error("Workday admin connection changed during sign-in; sign in again");
  const expiresAt = token.expiresIn ? Date.now() + token.expiresIn * 1000 : undefined;
  adminSessions.set(serverId, { accessToken: token.accessToken, expiresAt, connectionKey: key });
  return { expiresAt };
}

// ---------------------------------------------------------------------------
// ASOR API
// ---------------------------------------------------------------------------

interface AdminContext {
  serverId: string;
  tenant: string;
  endpoints: WorkdayAdminEndpoints;
  accessToken: string;
  fetchImpl: FetchLike;
}

const SIGN_IN_REQUIRED = "Sign in to Workday with the admin client first";

function adminContext(serverId: string, transport: WorkdayAdminTransport): AdminContext | null {
  const { server, tenant } = workdayServer(serverId);
  const connection = requireConnection(server);
  const session = activeSession(serverId, connection, tenant);
  if (!session) return null;
  return {
    serverId,
    tenant,
    endpoints: endpointsFor(connection, tenant, transport),
    accessToken: session.accessToken,
    fetchImpl: transport.fetchImpl ?? fetch,
  };
}

interface AsorResponse {
  status: number;
  data: unknown;
}

/**
 * One ASOR call with the admin token. Redirects are never followed (the token
 * must not travel to another host); a 401 forgets the token; errors are
 * redacted and bounded.
 */
async function callAsor(
  ctx: AdminContext,
  method: "GET" | "POST",
  path: string,
  body?: { json: unknown } | { form: FormData },
  passStatuses: number[] = [],
): Promise<AsorResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
    Accept: "application/json",
  };
  let payload: string | FormData | undefined;
  if (body && "json" in body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  } else if (body) {
    // fetch sets the multipart boundary itself.
    payload = body.form;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASOR_TIMEOUT_MS);
  let response: Response;
  try {
    response = await ctx.fetchImpl(`${ctx.endpoints.asorBaseUrl}/${path}`, {
      method,
      headers,
      body: payload,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Workday did not answer in time");
    throw new Error(
      `Could not reach Workday: ${redactOAuthText(error instanceof Error ? error.message : String(error))}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (response.status === 401) {
    adminSessions.delete(ctx.serverId);
    throw new Error("Workday admin sign-in expired or was rejected; sign in again");
  }
  if (response.status >= 300 && response.status < 400)
    throw new Error(`Workday redirected the request (${response.status}); check the services host`);
  if (!response.ok && !passStatuses.includes(response.status))
    throw Object.assign(
      new Error(`Workday request failed (${response.status}): ${redactOAuthText(text)}`),
      { status: response.status },
    );
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data };
}

// ---------------------------------------------------------------------------
// Mapping between Workday's JSON and the editable model
// ---------------------------------------------------------------------------

const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Rows of a Workday collection response, whichever key it uses. */
export function collectionRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const body = record(data);
  for (const key of ["data", "results", "items"]) if (Array.isArray(body[key])) return body[key];
  return [];
}

/** Workday's MCP tools have snake_case names; SOAP and REST operations use Title Case. */
export function isMcpToolName(name: string): boolean {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name);
}

const WID = /^[0-9a-f]{32}$/;

const RESOURCE_DESCRIPTION_LIMIT = 400;

/**
 * Catalog rows as resources: a 32-hex WID and a name, deduplicated by WID.
 * Workday's agentResourceSearch returns `wid`, `name`, `description`,
 * `type` ("AGENT_READY" for MCP tools) and `mcpEnabled`; other collections
 * use `id` and `descriptor`. Both shapes are read.
 */
export function parseAgentResources(data: unknown): WorkdayAgentResource[] {
  const seen = new Set<string>();
  const resources: WorkdayAgentResource[] = [];
  for (const raw of collectionRows(data)) {
    const row = record(raw);
    const wid = (str(row.wid) || str(row.id)).trim().toLowerCase();
    const toolName = (str(row.name) || str(row.descriptor) || str(row.tool_name)).trim();
    if (!WID.test(wid) || !toolName || seen.has(wid)) continue;
    seen.add(wid);
    // Workday's own flags win; the snake_case name is the fallback signal.
    const mcp =
      typeof row.mcpEnabled === "boolean"
        ? row.mcpEnabled
        : str(row.type)
          ? str(row.type) === "AGENT_READY"
          : isMcpToolName(toolName);
    const description = str(row.description).trim().slice(0, RESOURCE_DESCRIPTION_LIMIT);
    resources.push({
      wid,
      toolName,
      kind: mcp ? "mcp" : "operation",
      ...(description ? { description } : {}),
    });
  }
  return resources;
}

function executionModeOf(value: unknown): WorkdayAgentExecutionMode {
  const mode = record(value);
  const text = `${str(value)} ${str(mode.id)} ${str(mode.descriptor)}`;
  return /ambient/i.test(text) ? "Ambient" : "Delegate";
}

function configSkillId(config: Record<string, unknown>): string {
  const skill = record(config.skill);
  return (
    str(config.skillId) ||
    str(config.skill_id) ||
    str(skill.id) ||
    str(skill.descriptor)
  ).trim();
}

/** A definition returned by GET agentDefinition, as the editable model. */
export function agentModelFromDefinition(raw: unknown): WorkdayAgentModel {
  const definition = record(raw);
  const configs = list(definition.workdayConfig).map(record);
  const toolsOf = (config: Record<string, unknown> | undefined) =>
    list(config?.workdayResources).map((entry) => {
      const resource = record(entry);
      const agentResource = record(resource.agent_resource ?? resource.agentResource);
      const toolName = (
        str(resource.tool_name) ||
        str(resource.toolName) ||
        str(agentResource.descriptor)
      ).trim();
      return {
        toolName,
        wid: str(agentResource.id).trim().toLowerCase(),
        description: (str(resource.description) || str(agentResource.descriptor)).trim(),
      };
    });
  const skills: WorkdayAgentSkill[] = list(definition.skills).map((entry) => {
    const skill = record(entry);
    const id = (str(skill.id) || str(skill.skillId)).trim();
    const config = configs.find((candidate) => configSkillId(candidate) === id);
    return {
      id,
      name: (str(skill.name) || str(skill.descriptor) || id).trim(),
      description: str(skill.description).trim(),
      executionMode: executionModeOf(config?.executionMode),
      tools: toolsOf(config),
    };
  });
  // Tool grants for a skill the definition does not list still belong to the agent.
  for (const config of configs) {
    const id = configSkillId(config);
    if (!id || skills.some((skill) => skill.id === id)) continue;
    skills.push({
      id,
      name: id,
      description: "",
      executionMode: executionModeOf(config.executionMode),
      tools: toolsOf(config),
    });
  }
  const id = str(definition.id).trim();
  const url = str(definition.url).trim();
  const documentationUrl = str(definition.documentationUrl).trim();
  return {
    ...(id ? { id } : {}),
    name: str(definition.name || definition.descriptor).trim(),
    description: str(definition.description).trim(),
    version: str(definition.version).trim(),
    ...(url ? { url } : {}),
    ...(documentationUrl ? { documentationUrl } : {}),
    skills,
  };
}

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(1000)
  .refine((value) => new URL(value).protocol === "https:", "Must be an https URL");

export const WorkdayAgentToolSchema = z
  .object({
    toolName: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_./-]{1,128}$/, "Tool names use letters, digits, _ . / and -"),
    wid: z.string().trim().toLowerCase().regex(WID, "A tool WID is 32 hexadecimal characters"),
    description: z.string().trim().max(1000),
  })
  .strict();

export const WorkdayAgentSkillSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{1,64}$/, "Skill IDs use lowercase letters, digits and _ (up to 64)"),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000),
    executionMode: z.enum(["Delegate", "Ambient"]),
    tools: z.array(WorkdayAgentToolSchema).max(100),
  })
  .strict();

export const WorkdayAgentModelSchema = z
  .object({
    id: z.string().trim().max(200).optional(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(2000),
    version: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,20}$/, "Version uses letters, digits, . _ and - (up to 20)"),
    url: httpsUrl.optional(),
    documentationUrl: httpsUrl.optional(),
    skills: z.array(WorkdayAgentSkillSchema).min(1).max(50),
  })
  .strict()
  .superRefine((model, ctx) => {
    const ids = new Set<string>();
    let total = 0;
    for (const skill of model.skills) {
      if (ids.has(skill.id))
        ctx.addIssue({ code: "custom", message: `Skill ID ${skill.id} is used twice` });
      ids.add(skill.id);
      const wids = new Set<string>();
      for (const tool of skill.tools) {
        if (wids.has(tool.wid))
          ctx.addIssue({
            code: "custom",
            message: `${tool.toolName} is listed twice in skill ${skill.id}`,
          });
        wids.add(tool.wid);
      }
      total += skill.tools.length;
    }
    if (total > MAX_TOOLS_PER_AGENT)
      ctx.addIssue({
        code: "custom",
        message: `An agent can list at most ${MAX_TOOLS_PER_AGENT} tools`,
      });
  });

/** The ASOR agentDefinition body for a model (POST upserts by name, provider and version). */
export function buildAgentDefinitionBody(model: WorkdayAgentModel): Record<string, unknown> {
  const jsonMode = [{ type: "application/json" }];
  return {
    name: model.name,
    description: model.description,
    version: model.version,
    url: model.url || DEFAULT_AGENT_URL,
    documentationUrl: model.documentationUrl || DEFAULT_AGENT_DOCUMENTATION_URL,
    provider: { id: "Provider=SELF-BUILT" },
    platform: { id: "Platform=OTHER" },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    skills: model.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description || skill.name,
      inputModes: jsonMode,
      outputModes: jsonMode,
    })),
    workdayConfig: model.skills.map((skill) => ({
      skillId: skill.id,
      executionMode: { id: `Mode=${skill.executionMode}` },
      workdayResources: skill.tools.map((tool) => ({
        description: tool.description || tool.toolName,
        tool_name: tool.toolName,
        agent_resource: { id: tool.wid },
      })),
    })),
  };
}

/** The body as multipart/form-data: strings as-is, objects as JSON text. */
export function agentDefinitionFormData(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(body))
    form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  return form;
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ")
    .slice(0, 1000);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function listAgentDefinitions(
  serverId: string,
  transport: WorkdayAdminTransport = {},
): Promise<
  { status: "signed_out" } | { status: "ok"; total: number; agents: WorkdayAgentModel[] }
> {
  const ctx = adminContext(serverId, transport);
  if (!ctx) return { status: "signed_out" };
  const { data } = await callAsor(ctx, "GET", `agentDefinition?limit=${LIST_LIMIT}`);
  const rows = collectionRows(data);
  const total = Number(record(data).total);
  return {
    status: "ok",
    total: Number.isFinite(total) && total >= 0 ? total : rows.length,
    agents: rows.map(agentModelFromDefinition),
  };
}

async function searchCatalogOnce(
  ctx: AdminContext,
  query: string,
): Promise<WorkdayAgentResource[]> {
  const params = new URLSearchParams({ searchString: query, limit: String(SEARCH_LIMIT) });
  const { data } = await callAsor(ctx, "GET", `agentResourceSearch?${params.toString()}`);
  return parseAgentResources(data);
}

/**
 * Fallback queries for a snake_case tool name. Workday's catalog search does
 * not always match a full snake_case name (find_absence_balances matches,
 * find_service_dates_for_worker does not), but it matches its words.
 */
export function catalogQueryFallbacks(query: string): string[] {
  if (!isMcpToolName(query)) return [];
  const words = query.split("_");
  const longest = [...words].sort((a, b) => b.length - a.length)[0];
  return [...new Set([words.join(" "), longest])].filter((q) => q && q !== query);
}

/** Searches the catalog, retrying a snake_case name by its words when it finds nothing. */
async function searchCatalog(ctx: AdminContext, query: string): Promise<WorkdayAgentResource[]> {
  const rows = await searchCatalogOnce(ctx, query);
  if (rows.length > 0) return rows;
  let nearby: WorkdayAgentResource[] = [];
  for (const fallback of catalogQueryFallbacks(query)) {
    const found = await searchCatalogOnce(ctx, fallback);
    const exact = found.filter((row) => row.toolName === query);
    // The named tool first; the rest of the word search stays as nearby results.
    if (exact.length > 0) return [...exact, ...found.filter((row) => row.toolName !== query)];
    if (nearby.length === 0) nearby = found;
  }
  return nearby;
}

const SearchQuerySchema = z.string().trim().min(1).max(200);

/** Searches the tenant's agent resource catalog; MCP tools only unless asked otherwise. */
export async function searchAgentResources(
  serverId: string,
  query: string,
  options: { mcpOnly?: boolean } & WorkdayAdminTransport = {},
): Promise<WorkdayAgentSearchResult> {
  const text = SearchQuerySchema.parse(query);
  const ctx = adminContext(serverId, options);
  if (!ctx) throw new Error(SIGN_IN_REQUIRED);
  const resources = await searchCatalog(ctx, text);
  return {
    resources:
      options.mcpOnly === false ? resources : resources.filter((row) => row.kind === "mcp"),
    matched: resources.length,
  };
}

async function findMissingTools(ctx: AdminContext, model: WorkdayAgentModel) {
  const wanted = new Map<string, Set<string>>();
  for (const skill of model.skills)
    for (const tool of skill.tools) {
      const wids = wanted.get(tool.toolName) ?? new Set<string>();
      wids.add(tool.wid);
      wanted.set(tool.toolName, wids);
    }
  const missing: Array<{
    toolName: string;
    wid: string;
    reason: "not_found" | "name_mismatch";
  }> = [];
  const names = [...wanted.keys()];
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const toolName = names[next++];
      const rows = await searchCatalog(ctx, toolName);
      for (const wid of wanted.get(toolName)!) {
        const row = rows.find((candidate) => candidate.wid === wid);
        if (!row) missing.push({ toolName, wid, reason: "not_found" });
        else if (row.toolName !== toolName)
          missing.push({ toolName, wid, reason: "name_mismatch" });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(VERIFY_CONCURRENCY, names.length) }, () => worker()),
  );
  return missing.sort((a, b) => a.toolName.localeCompare(b.toolName));
}

/**
 * Registers or updates the agent definition. Every tool's WID is checked
 * against the tenant's catalog first; while any is missing nothing is posted.
 * A server that refuses JSON (415) gets the same fields as multipart form data.
 */
export async function saveAgentDefinition(
  serverId: string,
  input: unknown,
  transport: WorkdayAdminTransport = {},
): Promise<WorkdayAgentSaveResult> {
  const parsed = WorkdayAgentModelSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid agent definition: ${zodMessage(parsed.error)}`);
  const model = parsed.data;
  const ctx = adminContext(serverId, transport);
  if (!ctx) throw new Error(SIGN_IN_REQUIRED);

  const missing = await findMissingTools(ctx, model);
  if (missing.length) return { status: "missing_tools", missing };

  const body = buildAgentDefinitionBody(model);
  let response = await callAsor(ctx, "POST", "agentDefinition", { json: body }, [415]);
  if (response.status === 415)
    response = await callAsor(ctx, "POST", "agentDefinition", {
      form: agentDefinitionFormData(body),
    });

  const saved = record(response.data);
  const savedSkills = list(saved.skills)
    .map((skill) => (str(record(skill).id) || str(record(skill).name)).trim())
    .filter(Boolean);
  const savedConfigs = list(saved.workdayConfig);
  const toolCount = savedConfigs.length
    ? savedConfigs.reduce<number>(
        (sum, config) => sum + list(record(config).workdayResources).length,
        0,
      )
    : model.skills.reduce((sum, skill) => sum + skill.tools.length, 0);
  const id = str(saved.id).trim();
  return {
    status: "saved",
    ...(id ? { id } : {}),
    name: str(saved.name).trim() || model.name,
    skills: savedSkills.length ? savedSkills : model.skills.map((skill) => skill.id),
    toolCount,
  };
}
