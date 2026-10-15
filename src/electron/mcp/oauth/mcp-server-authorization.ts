/**
 * Adds OAuth-protected remote MCP servers and signs them in. Shared by the
 * desktop IPC handlers and headless entry points; it never runs a browser
 * itself (the caller supplies openUrl, or uses a JWT bearer identity).
 */
import { z } from "zod";
import { credentialFingerprint } from "../../security/oauth-refresh-proof";
import { MCPClientManager } from "../client/MCPClientManager";
import { assertMcpServerNotBlocked } from "../connector-policy";
import { MASKED_VALUE, MCPSettingsManager } from "../settings";
import type { MCPAuthConfig, MCPServerConfig } from "../types";
import {
  authorizeWithoutUser,
  authorizeWithPkce,
  discoverOAuthMetadata,
  McpSignInCancelledError,
  parseLoopbackRedirect,
  workdayEndpoints,
} from "./mcp-oauth";

/** Providers register the redirect exactly; a fixed loopback port keeps it stable. */
export const DEFAULT_OAUTH_REDIRECT_URI = "http://127.0.0.1:18768/oauth/callback";
/**
 * Workday rejects http redirect URIs for authorization-code clients, so its
 * preset uses an https loopback served with an ephemeral self-signed certificate.
 */
export const WORKDAY_OAUTH_REDIRECT_URI = "https://127.0.0.1:18768/oauth/callback";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** https, or http only on this machine's loopback (local development servers). */
const httpsUrl = z
  .string()
  .url()
  .max(1000)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
    );
  }, "Must be an https URL (http is allowed only on localhost)");

/** The add form's fields. Secrets may be blank on an edit (keep the stored value). */
const RemoteOAuthServerFields = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["workday", "custom"]),
    region: z.string().trim().toLowerCase().max(31).optional(),
    tenant: z.string().trim().max(128).optional(),
    url: httpsUrl.optional(),
    authorizationUrl: httpsUrl.optional(),
    tokenUrl: httpsUrl.optional(),
    grant: z.enum(["authorization_code", "jwt_bearer"]),
    clientId: z.string().trim().min(1).max(500),
    clientSecret: z.string().max(2000).optional(),
    // Only a loopback listener on this machine can receive the code.
    redirectUri: z
      .string()
      .url()
      .max(500)
      .refine((value) => {
        try {
          parseLoopbackRedirect(value);
          return true;
        } catch {
          return false;
        }
      }, "Redirect URI must be an http or https loopback address with an explicit port")
      .optional(),
    scopes: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    resource: z.string().url().max(1000).optional(),
    jwtSubject: z.string().trim().max(500).optional(),
    jwtKeyId: z.string().trim().max(200).optional(),
    privateKey: z.string().max(10000).optional(),
  })
  .strict();

type RemoteOAuthServerFieldsInput = z.infer<typeof RemoteOAuthServerFields>;

export const RemoteOAuthServerSchema = RemoteOAuthServerFields.superRefine(
  (value: RemoteOAuthServerFieldsInput, ctx) => {
    if (value.kind === "workday" && (!value.region || !value.tenant))
      ctx.addIssue({ code: "custom", message: "Workday needs a gateway region and tenant" });
    if (value.kind === "custom" && (!value.url || !value.tokenUrl))
      ctx.addIssue({ code: "custom", message: "A custom server needs its MCP URL and token URL" });
    if (value.kind === "custom" && value.grant === "authorization_code" && !value.authorizationUrl)
      ctx.addIssue({
        code: "custom",
        message: "Authorization-code sign-in needs an authorization URL",
      });
    if (value.grant === "jwt_bearer" && (!value.privateKey || !value.jwtSubject))
      ctx.addIssue({ code: "custom", message: "JWT bearer needs a private key and subject" });
  },
);

export type RemoteOAuthServerInput = z.infer<typeof RemoteOAuthServerSchema>;

/** Builds a streamable-http MCP server whose tools sign in with OAuth 2.1. */
export function buildRemoteOAuthServer(input: RemoteOAuthServerInput): Omit<MCPServerConfig, "id"> {
  const endpoints =
    input.kind === "workday"
      ? workdayEndpoints(input.region!, input.tenant!)
      : {
          url: input.url!,
          authorizationUrl: input.authorizationUrl,
          tokenUrl: input.tokenUrl!,
        };
  const auth: MCPAuthConfig = {
    type: "bearer",
    clientId: input.clientId,
    ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
    tokenUrl: endpoints.tokenUrl,
    ...(input.grant === "jwt_bearer" ? { privateKey: input.privateKey } : {}),
    oauth: {
      grant: input.grant,
      ...(input.grant === "authorization_code"
        ? {
            authorizationUrl: endpoints.authorizationUrl,
            redirectUri:
              input.redirectUri ||
              (input.kind === "workday" ? WORKDAY_OAUTH_REDIRECT_URI : DEFAULT_OAUTH_REDIRECT_URI),
          }
        : {
            jwt: {
              subject: input.jwtSubject!,
              ...(input.jwtKeyId ? { keyId: input.jwtKeyId } : {}),
            },
          }),
      ...(input.scopes?.length ? { scopes: input.scopes } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
      ...(input.kind === "workday"
        ? { preset: { kind: "workday" as const, region: input.region!, tenant: input.tenant! } }
        : {}),
    },
  };
  return {
    name: input.name,
    enabled: true,
    transport: "streamable-http",
    url: endpoints.url,
    auth,
    // Reads run without prompts; any tool that can change data asks first.
    defaultToolsApprovalMode: "writes",
  };
}

export function addRemoteOAuthServer(input: unknown): MCPServerConfig {
  const validated = RemoteOAuthServerSchema.parse(input);
  const config = buildRemoteOAuthServer(validated);
  assertMcpServerNotBlocked({ id: "", name: config.name, registryId: undefined });
  return MCPSettingsManager.addServer(config);
}

/** An edit of a Remote (OAuth) server: the add form's fields plus the server ID. */
export const RemoteOAuthServerUpdateSchema = z
  .object({ serverId: z.string().uuid(), server: RemoteOAuthServerFields })
  .strict();

const TOKEN_KEYS = ["token", "refreshToken", "expiresAt", "refreshExpiresAt"] as const;

function withoutTokens(auth: MCPAuthConfig | undefined): MCPAuthConfig | undefined {
  if (!auth) return undefined;
  const rest: MCPAuthConfig = { ...auth };
  for (const key of TOKEN_KEYS) delete rest[key];
  return rest;
}

/** A secret field left blank, or sent back as the display mask, keeps the stored value. */
function keepsStoredSecret(value: string | undefined): boolean {
  return !value?.trim() || value.trim() === MASKED_VALUE;
}

/**
 * Edits a Remote (OAuth) server in place with the same validation and builder
 * as add. Stored secrets the UI never saw are kept when left blank. Any change
 * to the identity, endpoints or client sign the server out: tokens are cleared,
 * a pending sign-in is cancelled and the connection is closed, so the next
 * sign-in uses the new settings. Approvals granted earlier no longer match the
 * stored configuration (see configuration-authority.ts) and are asked again.
 */
export async function updateRemoteOAuthServer(
  input: unknown,
): Promise<{ server: MCPServerConfig; signedOut: boolean }> {
  const { serverId, server: fields } = RemoteOAuthServerUpdateSchema.parse(input);
  const current = MCPSettingsManager.getServer(serverId);
  if (!current) throw new Error("MCP server not found");
  const auth = current.auth;
  if (current.transport !== "streamable-http" || auth?.type !== "bearer" || !auth.oauth)
    throw new Error("Only a Remote (OAuth) server can be edited here");
  const merged = RemoteOAuthServerSchema.parse({
    ...fields,
    clientSecret: keepsStoredSecret(fields.clientSecret) ? auth.clientSecret : fields.clientSecret,
    privateKey: keepsStoredSecret(fields.privateKey) ? auth.privateKey : fields.privateKey,
    // The settings form does not show these; leaving them out keeps the stored value.
    resource: fields.resource ?? auth.oauth.resource,
    jwtKeyId: fields.jwtKeyId ?? auth.oauth.jwt?.keyId,
  });
  const built = buildRemoteOAuthServer(merged);
  assertMcpServerNotBlocked({ id: serverId, name: built.name, registryId: current.registryId });
  const nextOAuth = { ...built.auth!.oauth! };
  // Settings with no form field survive an edit.
  if (auth.oauth.tokenAuthMethod) nextOAuth.tokenAuthMethod = auth.oauth.tokenAuthMethod;
  if (nextOAuth.jwt && auth.oauth.jwt) {
    const { audience, algorithm } = auth.oauth.jwt;
    nextOAuth.jwt = {
      ...nextOAuth.jwt,
      ...(audience ? { audience } : {}),
      ...(algorithm ? { algorithm } : {}),
    };
  }
  const nextAuth: MCPAuthConfig = { ...built.auth!, oauth: nextOAuth };
  const signedOut =
    built.url !== current.url ||
    credentialFingerprint(withoutTokens(auth)) !== credentialFingerprint(nextAuth);
  if (!signedOut && built.name === current.name) return { server: current, signedOut: false };

  let updated: MCPServerConfig | null;
  if (signedOut) {
    cancelMcpServerSignIn(serverId);
    updated = MCPSettingsManager.updateServer(serverId, {
      name: built.name,
      url: built.url,
      auth: nextAuth,
      lastError: undefined,
    });
    const manager = MCPClientManager.getInstance();
    if (manager.getServerStatus(serverId)) await manager.disconnectServer(serverId);
  } else {
    // A rename keeps the sign-in.
    updated = MCPSettingsManager.updateServer(serverId, { name: built.name });
  }
  if (!updated) throw new Error("MCP server not found");
  return { server: updated, signedOut };
}

/** Pending interactive sign-ins by server ID, so the person can cancel one. */
const pendingSignIns = new Map<string, AbortController>();

/**
 * Cancels a server's pending sign-in: its loopback listener closes and the
 * sign-in rejects with McpSignInCancelledError. False when none is pending.
 */
export function cancelMcpServerSignIn(
  serverId: string,
  reason: "cancelled" | "superseded" = "cancelled",
): boolean {
  const controller = pendingSignIns.get(serverId);
  if (!controller) return false;
  pendingSignIns.delete(serverId);
  controller.abort(new McpSignInCancelledError(reason));
  return true;
}

export async function discoverRemoteOAuth(url: unknown) {
  return discoverOAuthMetadata(httpsUrl.parse(url));
}

/**
 * Signs a server in and reconnects it. Authorization-code servers open the
 * provider's sign-in page through openUrl; JWT bearer servers mint a token
 * without a person.
 */
export async function authorizeMcpServer(
  serverId: string,
  options: { openUrl?: (url: string) => Promise<void> | void; timeoutMs?: number } = {},
): Promise<{ expiresAt?: number; grant: "authorization_code" | "jwt_bearer" }> {
  const server = MCPSettingsManager.getServer(serverId);
  if (!server) throw new Error("MCP server not found");
  assertMcpServerNotBlocked(server);
  const auth = server.auth;
  if (auth?.type !== "bearer" || !auth.oauth)
    throw new Error("This MCP server is not configured for OAuth sign-in");
  const before = structuredClone(auth);
  let next: MCPAuthConfig;
  if (auth.oauth.grant === "jwt_bearer") {
    next = await authorizeWithoutUser(before);
  } else {
    if (!options.openUrl)
      throw new Error(
        "Signing in this server needs a browser; use the desktop app, or configure a JWT bearer identity for headless use",
      );
    // A second sign-in of the same server replaces the first.
    cancelMcpServerSignIn(serverId, "superseded");
    const controller = new AbortController();
    pendingSignIns.set(serverId, controller);
    try {
      next = await authorizeWithPkce(before, {
        openUrl: options.openUrl,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
      });
    } finally {
      if (pendingSignIns.get(serverId) === controller) pendingSignIns.delete(serverId);
    }
  }
  // Settings edited while the person was signing in win; the new token is discarded.
  const current = MCPSettingsManager.getServer(serverId)?.auth;
  if (credentialFingerprint(current) !== credentialFingerprint(before))
    throw new Error("MCP server settings changed during sign-in; sign in again");
  MCPSettingsManager.updateServer(serverId, { auth: next, lastError: undefined });

  const manager = MCPClientManager.getInstance();
  if (manager.getServerStatus(serverId)) await manager.disconnectServer(serverId);
  await manager.connectServer(serverId);
  return { expiresAt: next.expiresAt, grant: auth.oauth.grant };
}
