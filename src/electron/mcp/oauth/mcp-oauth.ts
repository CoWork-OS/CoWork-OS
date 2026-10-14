/**
 * OAuth 2.1 for remote MCP servers (for example Workday Agent-Ready Tools).
 *
 * - Interactive authorization code + PKCE (S256) with a registered loopback
 *   redirect, for delegate identities: a person signs in once.
 * - Refresh-token renewal for public and confidential clients.
 * - JWT bearer assertion (RFC 7523) for ambient identities: fully headless.
 * - Optional discovery from RFC 9728 protected-resource and RFC 8414 / OIDC
 *   authorization-server metadata.
 *
 * Pure Node: no Electron imports, so renewal runs in the desktop main process,
 * the headless app and the Node daemon alike.
 */
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import * as http from "node:http";
import type { MCPAuthConfig, MCPOAuthSettings } from "../types";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const MCP_AUTH_REQUIRED = "MCP_AUTH_REQUIRED";

/** Authorization is missing or can no longer be renewed without a person. */
export class McpAuthorizationRequiredError extends Error {
  readonly code = MCP_AUTH_REQUIRED;
  constructor(message: string) {
    super(message);
    this.name = "McpAuthorizationRequiredError";
  }
}

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_TIMEOUT_MS = 20_000;

function sanitize(text: string): string {
  return text
    .replace(
      /("(?:client_secret|code|access_token|refresh_token|code_verifier|assertion|id_token)":\s*")([^"]+)(")/gi,
      "$1[REDACTED]$3",
    )
    .replace(/([?&](?:code|client_secret|token|assertion)=)[^&\s"]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

/** Workday documents that expires_in may arrive as an integer or a string. */
export function parseExpiresIn(value: unknown): number | undefined {
  const seconds = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.floor(seconds)
    : undefined;
}

export function oauthSettings(auth: MCPAuthConfig | undefined): MCPOAuthSettings | undefined {
  return auth?.type === "bearer" ? auth.oauth : undefined;
}

/** True when the transport can obtain a new access token without a person. */
export function canRenewWithoutUser(auth: MCPAuthConfig | undefined): boolean {
  if (auth?.type !== "bearer" || !auth.tokenUrl || !auth.clientId) return false;
  const oauth = auth.oauth;
  if (oauth?.grant === "jwt_bearer") return Boolean(auth.privateKey && oauth.jwt?.subject);
  if (!auth.refreshToken) return false;
  // A refresh token known to have expired needs a fresh interactive sign-in.
  return !(auth.refreshExpiresAt && auth.refreshExpiresAt <= Date.now());
}

function clientAuth(
  auth: MCPAuthConfig,
  body: URLSearchParams,
  headers: Record<string, string>,
): void {
  const method = auth.oauth?.tokenAuthMethod ?? (auth.clientSecret ? "client_secret_post" : "none");
  if (method === "client_secret_basic" && auth.clientSecret) {
    const credentials = `${encodeURIComponent(auth.clientId!)}:${encodeURIComponent(auth.clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    return;
  }
  body.set("client_id", auth.clientId!);
  if (method === "client_secret_post" && auth.clientSecret)
    body.set("client_secret", auth.clientSecret);
}

async function tokenRequest(
  auth: MCPAuthConfig,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<MCPAuthConfig> {
  if (!auth.tokenUrl || !auth.clientId) throw new Error("OAuth token endpoint is not configured");
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  clientAuth(auth, body, headers);
  if (auth.oauth?.resource) body.set("resource", auth.oauth.resource);
  if (auth.oauth?.scopes?.length && params.grant_type !== "authorization_code")
    body.set("scope", auth.oauth.scopes.join(" "));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(auth.tokenUrl, {
      method: "POST",
      headers,
      body: body.toString(),
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    const failure = `OAuth token request failed (${response.status}): ${sanitize(text)}`;
    // invalid_grant means the refresh token or assertion was rejected: a person must sign in again.
    if (response.status === 400 && /invalid_grant/i.test(text))
      throw new McpAuthorizationRequiredError(failure);
    throw Object.assign(new Error(failure), { status: response.status });
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("OAuth token endpoint returned invalid JSON");
  }
  const accessToken = typeof data.access_token === "string" ? data.access_token.trim() : "";
  if (!accessToken) throw new Error("OAuth token endpoint did not return an access_token");
  if (
    data.token_type !== undefined &&
    (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer")
  )
    throw new Error(`Unsupported OAuth token_type: ${String(data.token_type).slice(0, 40)}`);
  const refreshToken =
    typeof data.refresh_token === "string" && data.refresh_token.trim()
      ? data.refresh_token
      : undefined;
  const expiresIn = parseExpiresIn(data.expires_in);
  const refreshExpiresIn = parseExpiresIn(data.refresh_token_expires_in ?? data.refresh_expires_in);
  const now = Date.now();
  const next: MCPAuthConfig = {
    ...auth,
    type: "bearer",
    token: accessToken,
    expiresAt: expiresIn ? now + expiresIn * 1000 : undefined,
  };
  if (refreshToken) {
    next.refreshToken = refreshToken;
    next.refreshExpiresAt = refreshExpiresIn ? now + refreshExpiresIn * 1000 : undefined;
  } else if (params.grant_type === "authorization_code") {
    delete next.refreshToken;
    delete next.refreshExpiresAt;
  }
  return next;
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/** RFC 7523 client assertion signed with the agent's private key. */
export function buildJwtAssertion(auth: MCPAuthConfig, now = Date.now()): string {
  const jwt = auth.oauth?.jwt;
  if (!auth.privateKey || !jwt?.subject || !auth.clientId || !auth.tokenUrl)
    throw new McpAuthorizationRequiredError(
      "JWT bearer authorization needs a client ID, subject, private key and token endpoint",
    );
  const algorithm = jwt.algorithm ?? "RS256";
  const header = { alg: algorithm, typ: "JWT", ...(jwt.keyId ? { kid: jwt.keyId } : {}) };
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    iss: auth.clientId,
    sub: jwt.subject,
    aud: jwt.audience || auth.tokenUrl,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + 300,
    jti: randomUUID(),
  };
  const input = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const key = createPrivateKey(auth.privateKey);
  const signature =
    algorithm === "ES256"
      ? sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" })
      : sign("sha256", Buffer.from(input), key);
  return `${input}.${base64Url(signature)}`;
}

/** New access token without user interaction (refresh token or JWT assertion). */
export async function renewOAuthToken(
  auth: MCPAuthConfig,
  fetchImpl: FetchLike = fetch,
): Promise<MCPAuthConfig> {
  if (!canRenewWithoutUser(auth))
    throw new McpAuthorizationRequiredError(
      "MCP server needs authorization: sign in again from Settings > MCP Servers",
    );
  if (auth.oauth?.grant === "jwt_bearer")
    return tokenRequest(
      auth,
      { grant_type: JWT_BEARER_GRANT, assertion: buildJwtAssertion(auth) },
      fetchImpl,
    );
  return tokenRequest(
    auth,
    { grant_type: "refresh_token", refresh_token: auth.refreshToken! },
    fetchImpl,
  );
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(48));
  return { verifier, challenge: base64Url(createHash("sha256").update(verifier).digest()) };
}

/** Only an http loopback redirect can be received locally. */
export function parseLoopbackRedirect(redirectUri: string): URL {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error("OAuth redirect URI is invalid");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port
  )
    throw new Error(
      "OAuth redirect URI must be an http loopback address with an explicit port, e.g. http://127.0.0.1:18768/oauth/callback",
    );
  return url;
}

export function buildAuthorizeUrl(
  auth: MCPAuthConfig,
  params: { state: string; challenge: string },
): string {
  const oauth = auth.oauth;
  if (!oauth?.authorizationUrl || !oauth.redirectUri || !auth.clientId)
    throw new Error("OAuth authorization URL, redirect URI and client ID are required");
  const url = new URL(oauth.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", auth.clientId);
  url.searchParams.set("redirect_uri", oauth.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (oauth.scopes?.length) url.searchParams.set("scope", oauth.scopes.join(" "));
  if (oauth.resource) url.searchParams.set("resource", oauth.resource);
  return url.toString();
}

function waitForCallback(
  redirect: URL,
  state: string,
  timeoutMs: number,
): { ready: Promise<void>; code: Promise<string>; close: () => void } {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const page = (text: string) =>
    `<!doctype html><meta charset="utf-8"><title>CoWork OS</title><p style="font:16px system-ui;margin:40px">${text}</p>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || redirect.host}`);
    if (url.pathname !== redirect.pathname) {
      res.writeHead(404).end();
      return;
    }
    // A request with the wrong state is ignored, so a stray page cannot end the flow.
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(page("This sign-in link does not match the current request."));
      return;
    }
    const error = url.searchParams.get("error");
    const received = url.searchParams.get("code");
    res.writeHead(error || !received ? 400 : 200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
    });
    res.end(
      page(
        error || !received
          ? "Authorization was not completed. You can close this window."
          : "Authorization complete. You can close this window and return to CoWork OS.",
      ),
    );
    if (error || !received)
      rejectCode(new Error(`Authorization failed: ${sanitize(error || "no code returned")}`));
    else resolveCode(received);
  });
  const timer = setTimeout(() => rejectCode(new Error("Authorization timed out")), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close();
  };
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `OAuth redirect port ${redirect.port} is in use; close the other app or register another port`,
            )
          : error,
      ),
    );
    // The redirect is registered with the provider, so it must be exactly this host and port.
    server.listen(Number(redirect.port), redirect.hostname.replace(/^\[|\]$/g, ""), () =>
      resolve(),
    );
  });
  code.catch(() => undefined).finally(close);
  return { ready, code, close };
}

/**
 * Interactive authorization code + PKCE. The person signs in at the provider in
 * their browser; the code returns to the registered loopback redirect.
 */
export async function authorizeWithPkce(
  auth: MCPAuthConfig,
  options: {
    openUrl: (url: string) => Promise<void> | void;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
  },
): Promise<MCPAuthConfig> {
  if (auth.type !== "bearer" || auth.oauth?.grant === "jwt_bearer")
    throw new Error("Interactive authorization applies to authorization-code servers");
  const redirect = parseLoopbackRedirect(auth.oauth?.redirectUri || "");
  const state = base64Url(randomBytes(24));
  const { verifier, challenge } = createPkcePair();
  const authorizeUrl = buildAuthorizeUrl(auth, { state, challenge });
  const callback = waitForCallback(redirect, state, options.timeoutMs ?? 5 * 60_000);
  try {
    await callback.ready;
    await options.openUrl(authorizeUrl);
    const code = await callback.code;
    return await tokenRequest(
      auth,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: auth.oauth!.redirectUri!,
        code_verifier: verifier,
      },
      options.fetchImpl ?? fetch,
    );
  } finally {
    callback.close();
  }
}

/** Mints the first token for an ambient (JWT bearer) identity. */
export async function authorizeWithoutUser(
  auth: MCPAuthConfig,
  fetchImpl: FetchLike = fetch,
): Promise<MCPAuthConfig> {
  return renewOAuthToken(auth, fetchImpl);
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * Workday Agent-Ready MCP Tools: https://{region}.agent.workday.com/{tenant}/mcp,
 * authorize at /auth/authorize/{tenant}, tokens at /auth/oauth2/{tenant}/token.
 */
export function workdayEndpoints(
  region: string,
  tenant: string,
): {
  url: string;
  authorizationUrl: string;
  tokenUrl: string;
} {
  const host = region.trim().toLowerCase();
  const name = tenant.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(host))
    throw new Error("Invalid Workday agent gateway region");
  if (!SAFE_SEGMENT.test(name)) throw new Error("Invalid Workday tenant name");
  const base = `https://${host}.agent.workday.com`;
  const tenantPath = encodeURIComponent(name);
  return {
    url: `${base}/${tenantPath}/mcp`,
    authorizationUrl: `${base}/auth/authorize/${tenantPath}`,
    tokenUrl: `${base}/auth/oauth2/${tenantPath}/token`,
  };
}

export interface DiscoveredOAuth {
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  resource?: string;
  issuer?: string;
}

function parseResourceMetadataUrl(wwwAuthenticate: string | null | undefined): string | undefined {
  const match = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate || "");
  return match?.[1];
}

async function getJson(url: string, fetchImpl: FetchLike): Promise<Record<string, unknown> | null> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(parsed.hostname))
    return null;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * MCP authorization discovery: RFC 9728 protected-resource metadata (from the
 * 401 WWW-Authenticate header or the well-known path), then the authorization
 * server's RFC 8414 or OpenID metadata. Servers without metadata (Workday
 * documents fixed endpoints instead) return an empty result.
 */
export async function discoverOAuthMetadata(
  mcpUrl: string,
  options: { wwwAuthenticate?: string | null; fetchImpl?: FetchLike } = {},
): Promise<DiscoveredOAuth> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resourceUrl = new URL(mcpUrl);
  const candidates = [
    parseResourceMetadataUrl(options.wwwAuthenticate),
    `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname.replace(/\/$/, "")}`,
    `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
  ].filter((value): value is string => Boolean(value));
  let resourceMetadata: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    resourceMetadata = await getJson(candidate, fetchImpl);
    if (resourceMetadata) break;
  }
  const servers = Array.isArray(resourceMetadata?.authorization_servers)
    ? (resourceMetadata!.authorization_servers as unknown[]).filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const issuer = servers[0] || resourceUrl.origin;
  const issuerUrl = new URL(issuer);
  const issuerPath = issuerUrl.pathname.replace(/\/$/, "");
  let serverMetadata: Record<string, unknown> | null = null;
  for (const candidate of [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
    `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
  ]) {
    serverMetadata = await getJson(candidate, fetchImpl);
    if (serverMetadata) break;
  }
  const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const scopes = Array.isArray(resourceMetadata?.scopes_supported)
    ? (resourceMetadata!.scopes_supported as unknown[]).filter(
        (value): value is string => typeof value === "string",
      )
    : undefined;
  return {
    authorizationUrl: str(serverMetadata?.authorization_endpoint),
    tokenUrl: str(serverMetadata?.token_endpoint),
    issuer: str(serverMetadata?.issuer),
    resource: str(resourceMetadata?.resource),
    ...(scopes?.length ? { scopes } : {}),
  };
}
