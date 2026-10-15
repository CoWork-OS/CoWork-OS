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
import * as https from "node:https";
import type { MCPAuthConfig, MCPOAuthSettings } from "../types";
import { createLoopbackTlsCredentials } from "./loopback-tls";

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

export const MCP_SIGN_IN_CANCELLED = "MCP_SIGN_IN_CANCELLED";

/**
 * A pending interactive sign-in ended without an answer from the provider:
 * the person cancelled it, or a newer sign-in on the same redirect port took
 * over. Neither is a failure to report.
 */
export class McpSignInCancelledError extends Error {
  readonly code = MCP_SIGN_IN_CANCELLED;
  constructor(readonly reason: "cancelled" | "superseded") {
    super(
      reason === "superseded" ? "Sign-in was replaced by a newer sign-in" : "Sign-in cancelled",
    );
    this.name = "McpSignInCancelledError";
  }
}

export function isMcpSignInCancelled(error: unknown): error is McpSignInCancelledError {
  return (
    error instanceof McpSignInCancelledError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === MCP_SIGN_IN_CANCELLED)
  );
}

function cancelledBy(signal: AbortSignal): McpSignInCancelledError {
  return isMcpSignInCancelled(signal.reason)
    ? signal.reason
    : new McpSignInCancelledError("cancelled");
}

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_TIMEOUT_MS = 20_000;

/**
 * Redacts credentials from provider text before it reaches an error message:
 * JSON secret fields, secret query parameters and Authorization header values.
 */
export function redactOAuthText(text: string): string {
  return text
    .replace(
      /("(?:client_secret|code|access_token|refresh_token|code_verifier|assertion|id_token)":\s*")([^"]+)(")/gi,
      "$1[REDACTED]$3",
    )
    .replace(/([?&](?:code|client_secret|token|assertion)=)[^&\s"]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [REDACTED]")
    .slice(0, 500);
}

const sanitize = redactOAuthText;

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

/** A successful token endpoint answer. The access token never leaves the caller's process. */
export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Seconds. */
  expiresIn?: number;
  /** Seconds, when the provider says how long the refresh token lasts. */
  refreshExpiresIn?: number;
}

/**
 * Posts a form to a token endpoint: bounded by a timeout, abandoned when the
 * signal aborts, redirects never followed and provider errors redacted.
 */
export async function postTokenRequest(
  tokenUrl: string,
  body: URLSearchParams,
  extraHeaders: Record<string, string>,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<OAuthTokenResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    ...extraHeaders,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  // A cancelled sign-in also abandons a token exchange already in flight.
  const onCancel = () => controller.abort();
  signal?.addEventListener("abort", onCancel, { once: true });
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers,
      body: body.toString(),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw cancelledBy(signal);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCancel);
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
  return {
    accessToken,
    refreshToken,
    expiresIn: parseExpiresIn(data.expires_in),
    refreshExpiresIn: parseExpiresIn(data.refresh_token_expires_in ?? data.refresh_expires_in),
  };
}

async function tokenRequest(
  auth: MCPAuthConfig,
  params: Record<string, string>,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<MCPAuthConfig> {
  if (!auth.tokenUrl || !auth.clientId) throw new Error("OAuth token endpoint is not configured");
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {};
  clientAuth(auth, body, headers);
  if (auth.oauth?.resource) body.set("resource", auth.oauth.resource);
  if (auth.oauth?.scopes?.length && params.grant_type !== "authorization_code")
    body.set("scope", auth.oauth.scopes.join(" "));
  const { accessToken, refreshToken, expiresIn, refreshExpiresIn } = await postTokenRequest(
    auth.tokenUrl,
    body,
    headers,
    fetchImpl,
    signal,
  );
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

/**
 * Only a loopback redirect can be received locally. https is served with an
 * ephemeral self-signed certificate, for providers that reject http redirects.
 */
export function parseLoopbackRedirect(redirectUri: string): URL {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error("OAuth redirect URI is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port
  )
    throw new Error(
      "OAuth redirect URI must be an http or https loopback address with an explicit port, e.g. http://127.0.0.1:18768/oauth/callback or https://127.0.0.1:18768/oauth/callback",
    );
  return url;
}

/** What an authorization-code request carries; the PKCE challenge only when PKCE is on. */
export interface AuthorizationRequest {
  authorizationUrl: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  resource?: string;
}

export function buildAuthorizationRequestUrl(
  request: AuthorizationRequest,
  params: { state: string; challenge?: string },
): string {
  const url = new URL(request.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("state", params.state);
  if (params.challenge) {
    url.searchParams.set("code_challenge", params.challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (request.scopes?.length) url.searchParams.set("scope", request.scopes.join(" "));
  if (request.resource) url.searchParams.set("resource", request.resource);
  return url.toString();
}

export function buildAuthorizeUrl(
  auth: MCPAuthConfig,
  params: { state: string; challenge: string },
): string {
  const oauth = auth.oauth;
  if (!oauth?.authorizationUrl || !oauth.redirectUri || !auth.clientId)
    throw new Error("OAuth authorization URL, redirect URI and client ID are required");
  return buildAuthorizationRequestUrl(
    {
      authorizationUrl: oauth.authorizationUrl,
      clientId: auth.clientId,
      redirectUri: oauth.redirectUri,
      scopes: oauth.scopes,
      resource: oauth.resource,
    },
    params,
  );
}

/**
 * This process's open loopback callback listeners, by port. localhost can
 * resolve to either loopback family, so one port carries at most one pending
 * sign-in: a newer sign-in supersedes the older one instead of failing with
 * "port in use" against CoWork's own listener.
 */
const loopbackListeners = new Map<number, { supersede: () => void; closed: Promise<void> }>();

/** Ports with a pending sign-in in this process (for diagnostics and tests). */
export function activeLoopbackPorts(): number[] {
  return [...loopbackListeners.keys()];
}

interface LoopbackCallback {
  /** Settles with the authorization code, or rejects (timeout, cancel, takeover, provider error). */
  code: Promise<string>;
  close: () => void;
  /** Resolves once the listener has stopped and left the registry. */
  closed: Promise<void>;
}

/**
 * Listens on the registered loopback redirect for the provider's callback.
 * Resolves once listening; rejects with McpSignInCancelledError when the
 * signal aborts or a newer sign-in takes the port first.
 */
async function listenForCallback(
  redirect: URL,
  state: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LoopbackCallback> {
  const port = Number(redirect.port);
  // Take the port over from CoWork's own earlier sign-in, if any. Re-check after
  // each wait: a sign-in started meanwhile may have registered in between.
  for (
    let previous = loopbackListeners.get(port);
    previous;
    previous = loopbackListeners.get(port)
  ) {
    previous.supersede();
    await previous.closed;
  }
  if (signal?.aborted) throw cancelledBy(signal);

  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let failure: Error | undefined;
  let settled = false;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    failure = error;
    rejectCode(error);
  };
  const page = (text: string) =>
    `<!doctype html><meta charset="utf-8"><title>CoWork OS</title><p style="font:16px system-ui;margin:40px">${text}</p>`;
  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || redirect.host}`);
    if (url.pathname !== redirect.pathname) {
      res.writeHead(404).end();
      return;
    }
    // A request with the wrong state is ignored, so a stray page cannot end the flow.
    if (url.searchParams.get("state") !== state || settled) {
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
      fail(new Error(`Authorization failed: ${sanitize(error || "no code returned")}`));
    else {
      settled = true;
      resolveCode(received);
    }
  };
  // An https redirect gets a fresh self-signed certificate per sign-in; the key
  // stays in memory with this listener and is never persisted or logged.
  const server: http.Server | https.Server =
    redirect.protocol === "https:"
      ? https.createServer(createLoopbackTlsCredentials(), handler)
      : http.createServer(handler);
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const entry = { supersede: () => fail(new McpSignInCancelledError("superseded")), closed };
  // Registered before listening, so a sign-in started while this one binds supersedes it.
  loopbackListeners.set(port, entry);
  const onAbort = () => fail(cancelledBy(signal!));
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => fail(new Error("Sign-in timed out. Try again.")), timeoutMs);
  const listening = new Promise<void>((resolve, reject) => {
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
    server.listen(port, redirect.hostname.replace(/^\[|\]$/g, ""), () => resolve());
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    // Wait for the bind to settle, so a listener still binding cannot outlive the flow.
    const finish = () => {
      server.closeAllConnections?.();
      // The callback runs whether or not the server is listening.
      server.close(() => {
        if (loopbackListeners.get(port) === entry) loopbackListeners.delete(port);
        markClosed();
      });
    };
    listening.then(finish, finish);
  };
  // The listener closes as soon as the flow settles, so a takeover never waits
  // on the token exchange that follows.
  code.then(close, close);

  try {
    await Promise.race([listening, code.then(() => undefined)]);
  } catch (error) {
    // Bind failed (a foreign process holds the port) or the flow ended while binding.
    fail(error as Error);
    close();
    await closed;
    throw failure ?? error;
  }
  if (failure) {
    await closed;
    throw failure;
  }
  return { code, close, closed };
}

/**
 * Interactive authorization code flow on a registered loopback redirect, with
 * or without PKCE. The person signs in at the provider in their browser; the
 * code returns to the loopback listener, and exchange turns it into whatever
 * the caller needs (it receives the PKCE verifier when PKCE is on). Aborting
 * the signal (or a newer sign-in on the same port) closes the listener and
 * rejects with McpSignInCancelledError before any token request.
 */
export async function authorizeCodeFlow<T>(options: {
  request: AuthorizationRequest;
  pkce: boolean;
  openUrl: (url: string) => Promise<void> | void;
  exchange: (code: string, verifier: string | undefined, signal?: AbortSignal) => Promise<T>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const redirect = parseLoopbackRedirect(options.request.redirectUri);
  const state = base64Url(randomBytes(24));
  const pkce = options.pkce ? createPkcePair() : undefined;
  const authorizeUrl = buildAuthorizationRequestUrl(options.request, {
    state,
    challenge: pkce?.challenge,
  });
  const callback = await listenForCallback(
    redirect,
    state,
    options.timeoutMs ?? 5 * 60_000,
    options.signal,
  );
  try {
    // Opening the browser can hang (shell.openExternal may never settle), so the
    // flow ends on the callback, a cancel or the timeout regardless; a failure to
    // open still ends it.
    const opened = Promise.resolve().then(() => options.openUrl(authorizeUrl));
    const code = await Promise.race([callback.code, opened.then(() => callback.code)]);
    if (options.signal?.aborted) throw cancelledBy(options.signal);
    return await options.exchange(code, pkce?.verifier, options.signal);
  } finally {
    callback.close();
    // Settle only once the port is released, so a cancelled or finished sign-in
    // never leaves its listener registered behind it.
    await callback.closed;
  }
}

/** Interactive authorization code + PKCE (S256) for a remote MCP server. */
export async function authorizeWithPkce(
  auth: MCPAuthConfig,
  options: {
    openUrl: (url: string) => Promise<void> | void;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
  },
): Promise<MCPAuthConfig> {
  if (auth.type !== "bearer" || auth.oauth?.grant === "jwt_bearer")
    throw new Error("Interactive authorization applies to authorization-code servers");
  const oauth = auth.oauth;
  parseLoopbackRedirect(oauth?.redirectUri || "");
  if (!oauth?.authorizationUrl || !oauth.redirectUri || !auth.clientId)
    throw new Error("OAuth authorization URL, redirect URI and client ID are required");
  const redirectUri = oauth.redirectUri;
  return authorizeCodeFlow({
    request: {
      authorizationUrl: oauth.authorizationUrl,
      clientId: auth.clientId,
      redirectUri,
      scopes: oauth.scopes,
      resource: oauth.resource,
    },
    pkce: true,
    openUrl: options.openUrl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    exchange: (code, verifier, signal) =>
      tokenRequest(
        auth,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier!,
        },
        options.fetchImpl ?? fetch,
        signal,
      ),
  });
}

/** Mints the first token for an ambient (JWT bearer) identity. */
export async function authorizeWithoutUser(
  auth: MCPAuthConfig,
  fetchImpl: FetchLike = fetch,
): Promise<MCPAuthConfig> {
  return renewOAuthToken(auth, fetchImpl);
}

/** A Workday tenant name or similar URL path segment. */
export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

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
  /** RFC 7591 dynamic client registration endpoint, when the server offers one. */
  registrationUrl?: string;
  /** token_endpoint_auth_methods_supported, when the server lists them. */
  tokenAuthMethods?: string[];
}

function parseResourceMetadataUrl(wwwAuthenticate: string | null | undefined): string | undefined {
  const match = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate || "");
  return match?.[1];
}

const METADATA_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

async function getJson(
  url: string,
  fetchImpl: FetchLike,
  options: { allowLoopbackHttp: boolean; signal?: AbortSignal },
): Promise<Record<string, unknown> | null> {
  const parsed = new URL(url);
  // Plain http only on this machine, and only while discovering a server on this machine.
  if (
    parsed.protocol !== "https:" &&
    !(options.allowLoopbackHttp && ["127.0.0.1", "localhost"].includes(parsed.hostname))
  )
    return null;
  const signals = [AbortSignal.timeout(METADATA_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    if (options.signal?.aborted) throw cancelledBy(options.signal);
    return null;
  }
}

function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** The scopes a WWW-Authenticate Bearer challenge asks for, if it names any. */
export function parseChallengeScopes(wwwAuthenticate: string | null | undefined): string[] {
  const match = /\bscope="([^"]*)"/i.exec(wwwAuthenticate || "");
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

/**
 * The WWW-Authenticate challenge of an unauthenticated MCP initialize request:
 * it can name the scopes this server needs and where its resource metadata
 * lives. Null when the server does not answer 401 with a challenge.
 */
export async function fetchAuthChallenge(
  mcpUrl: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<string | null> {
  const url = new URL(mcpUrl);
  if (url.protocol !== "https:" && !isLoopbackUrl(url)) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const signals = [AbortSignal.timeout(METADATA_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  try {
    const response = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "CoWork OS", version: "1" },
        },
      }),
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
    await response.body?.cancel().catch(() => {});
    return response.status === 401 ? response.headers.get("www-authenticate") : null;
  } catch {
    if (options.signal?.aborted) throw cancelledBy(options.signal);
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
  options: { wwwAuthenticate?: string | null; fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<DiscoveredOAuth> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resourceUrl = new URL(mcpUrl);
  const fetchOptions = { allowLoopbackHttp: isLoopbackUrl(resourceUrl), signal: options.signal };
  const candidates = [
    parseResourceMetadataUrl(options.wwwAuthenticate),
    `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname.replace(/\/$/, "")}`,
    `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
  ].filter((value): value is string => Boolean(value));
  let resourceMetadata: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    resourceMetadata = await getJson(candidate, fetchImpl, fetchOptions);
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
    serverMetadata = await getJson(candidate, fetchImpl, fetchOptions);
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
    registrationUrl: str(serverMetadata?.registration_endpoint),
    ...(Array.isArray(serverMetadata?.token_endpoint_auth_methods_supported)
      ? {
          tokenAuthMethods: (
            serverMetadata!.token_endpoint_auth_methods_supported as unknown[]
          ).filter((value): value is string => typeof value === "string"),
        }
      : {}),
    ...(scopes?.length ? { scopes } : {}),
  };
}

const REGISTRATION_TIMEOUT_MS = 20_000;
/** A registration answer is a small JSON object; anything larger is refused. */
const MAX_REGISTRATION_RESPONSE_CHARS = 64 * 1024;

/** Endpoints taken from provider metadata must be https (http only on loopback). */
function requireSecureEndpoint(
  value: string | undefined,
  label: string,
  allowLoopbackHttp: boolean,
): string {
  if (!value) throw new Error(`The MCP server's OAuth metadata has no ${label}`);
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && allowLoopbackHttp && isLoopbackUrl(url))
  )
    throw new Error(`The MCP server's ${label} must use https`);
  return value;
}

/** A public client when the server allows one, else the confidential method it lists. */
function requestedAuthMethod(supported: string[] | undefined): string {
  if (!supported?.length || supported.includes("none")) return "none";
  if (supported.includes("client_secret_basic")) return "client_secret_basic";
  if (supported.includes("client_secret_post")) return "client_secret_post";
  return "none";
}

/**
 * RFC 7591 dynamic client registration: registers this app as a public client
 * with the loopback redirect. Servers that only issue confidential clients
 * answer with a secret and the token endpoint auth method to use with it.
 */
export async function registerOAuthClient(
  registrationUrl: string,
  redirectUri: string,
  options: {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    /** The server's supported methods; a public client ("none") is asked for when allowed. */
    supportedAuthMethods?: string[];
  } = {},
): Promise<{
  clientId: string;
  clientSecret?: string;
  tokenAuthMethod?: MCPOAuthSettings["tokenAuthMethod"];
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRATION_TIMEOUT_MS);
  const onCancel = () => controller.abort();
  options.signal?.addEventListener("abort", onCancel, { once: true });
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(registrationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "CoWork OS",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: requestedAuthMethod(options.supportedAuthMethods),
      }),
      redirect: "manual",
      signal: controller.signal,
    });
    // Read the answer under the same timeout, so a stalled body cannot hang sign-in.
    text = await response.text();
  } catch (error) {
    if (options.signal?.aborted) throw cancelledBy(options.signal);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
  }
  if (text.length > MAX_REGISTRATION_RESPONSE_CHARS)
    throw new Error("OAuth client registration answer is too large");
  if (!response.ok)
    throw new Error(`OAuth client registration failed (${response.status}): ${sanitize(text)}`);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("OAuth client registration returned invalid JSON");
  }
  const clientId = typeof data.client_id === "string" ? data.client_id.trim() : "";
  if (!clientId) throw new Error("OAuth client registration did not return a client_id");
  const clientSecret =
    typeof data.client_secret === "string" && data.client_secret ? data.client_secret : undefined;
  const method = data.token_endpoint_auth_method;
  const tokenAuthMethod =
    method === "none" || method === "client_secret_post" || method === "client_secret_basic"
      ? method
      : clientSecret
        ? "client_secret_basic"
        : "none";
  return { clientId, ...(clientSecret ? { clientSecret } : {}), tokenAuthMethod };
}

/** True when `resource` is the MCP URL itself or a path prefix of it on the same origin. */
function resourceCovers(resource: string, mcpUrl: string): boolean {
  try {
    const target = new URL(resource);
    const server = new URL(mcpUrl);
    if (target.origin !== server.origin) return false;
    const prefix = target.pathname.replace(/\/$/, "");
    const path = server.pathname.replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  } catch {
    return false;
  }
}

/**
 * Fills in the endpoints and client of a server set up for dynamic client
 * registration: discovers the authorization server from the MCP URL and
 * registers a client the first time. A server already registered is returned
 * unchanged, so signing in again reuses its client.
 */
export async function prepareDynamicClient(
  auth: MCPAuthConfig,
  mcpUrl: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<MCPAuthConfig> {
  const oauth = auth.oauth;
  if (auth.type !== "bearer" || !oauth?.dynamicClientRegistration) return auth;
  if (auth.clientId && oauth.authorizationUrl && auth.tokenUrl) return auth;
  if (!oauth.redirectUri) throw new Error("OAuth redirect URI is required");
  const challenge = await fetchAuthChallenge(mcpUrl, options);
  const discovered = await discoverOAuthMetadata(mcpUrl, {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    wwwAuthenticate: challenge,
  });
  // MCP scope selection: the scopes the server's challenge asks for, else
  // everything its resource metadata lists, else none (the server's default).
  const challengeScopes = parseChallengeScopes(challenge);
  const scopes = oauth.scopes?.length
    ? oauth.scopes
    : challengeScopes.length
      ? challengeScopes
      : discovered.scopes;
  const local = isLoopbackUrl(new URL(mcpUrl));
  const authorizationUrl = requireSecureEndpoint(
    discovered.authorizationUrl,
    "authorization endpoint",
    local,
  );
  const tokenUrl = requireSecureEndpoint(discovered.tokenUrl, "token endpoint", local);
  const registrationUrl = requireSecureEndpoint(
    discovered.registrationUrl,
    "client registration endpoint",
    local,
  );
  // RFC 9728 section 3.3: the metadata must describe this server, or a token
  // could be minted for some other resource.
  if (discovered.resource && !resourceCovers(discovered.resource, mcpUrl))
    throw new Error("The MCP server's OAuth metadata names a different resource");
  const client = await registerOAuthClient(registrationUrl, oauth.redirectUri, {
    ...options,
    supportedAuthMethods: discovered.tokenAuthMethods,
  });
  return {
    ...auth,
    clientId: client.clientId,
    ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
    tokenUrl,
    oauth: {
      ...oauth,
      authorizationUrl,
      tokenAuthMethod: client.tokenAuthMethod,
      ...(discovered.resource ? { resource: discovered.resource } : {}),
      ...(scopes?.length ? { scopes } : {}),
    },
  };
}
