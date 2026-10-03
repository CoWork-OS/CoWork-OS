/**
 * Official "Sign in with ChatGPT" (SIWC) for open-source, locally hosted apps.
 *
 * Unlike the legacy Codex-client flow in openai-oauth.ts, CoWork registers its own
 * OAuth client per host on first sign-in (`client_id=dynamic_agent_client`) and
 * then uses the issued `oaiapp_...` client ID for every later authorization and
 * refresh. Inference goes to the public Responses API with the access token.
 *
 * Spec: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { createServer, Server } from "node:http";
import { URL, URLSearchParams } from "node:url";
import type { LLMSettingsData } from "../../../shared/types";
import { createLogger } from "../../utils/logger";

const logger = createLogger("OpenAI SIWC");

export const SIWC_ISSUER = "https://auth.openai.com";
export const SIWC_AUTHORIZE_URL = `${SIWC_ISSUER}/api/accounts/authorize`;
export const SIWC_TOKEN_URL = `${SIWC_ISSUER}/api/accounts/oauth/token`;
const SIWC_DISCOVERY_URL = `${SIWC_ISSUER}/.well-known/openid-configuration`;
export const SIWC_RESOURCE = "https://api.openai.com/v1";
export const SIWC_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const SIWC_AGENT_NAME = "CoWork OS";
export const SIWC_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const SIWC_REDIRECT_HOST = "127.0.0.1";
const SIWC_REDIRECT_PORT = 1455;
const SIWC_REDIRECT_PATH = "/auth/callback";
const SIWC_CALLBACK_TIMEOUT_MS = 10 * 60_000;
const SIWC_REFRESH_SKEW_MS = 5 * 60_000;
const SIWC_FETCH_TIMEOUT_MS = 30_000;
const ID_TOKEN_CLOCK_SKEW_SECONDS = 120;
const ISSUED_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** Refresh-grant error codes that mean the stored session is unusable. */
const REAUTH_REQUIRED_ERROR_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export interface OpenAISiwcRegistration {
  /** Issued client ID (`oaiapp_...`). Never `dynamic_agent_client`. */
  clientId: string;
  /** Validated ID-token `sub`, the account identity bound to `clientId`. */
  subject?: string;
  email?: string;
  /** Last ID token, sent back as `id_token_hint` on reauthorization. */
  idToken?: string;
}

export interface OpenAISiwcTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  id_token?: string;
  scope?: string;
}

export interface OpenAISiwcSession extends OpenAISiwcTokens {
  clientId: string;
  subject: string;
  email?: string;
  planType?: string;
}

export class OpenAISiwcError extends Error {
  code?: string;
  status?: number;
  /** The stored credentials can no longer be used; the user must sign in again. */
  requiresReauth: boolean;

  constructor(
    message: string,
    options: { code?: string; status?: number; requiresReauth?: boolean } = {},
  ) {
    super(message);
    this.name = "OpenAISiwcError";
    this.code = options.code;
    this.status = options.status;
    this.requiresReauth = options.requiresReauth === true;
  }
}

/**
 * Returns the issued SIWC client ID when the stored OpenAI OAuth tokens came from
 * Sign in with ChatGPT; undefined for API keys and legacy Codex-client tokens.
 */
export function getOpenAISiwcClientId(settings: {
  openai?: { authMethod?: string; oauthVariant?: string; siwcClientId?: string };
}): string | undefined {
  const openai = settings.openai;
  if (openai?.authMethod !== "oauth" || openai.oauthVariant !== "siwc") return undefined;
  return openai.siwcClientId?.trim() || undefined;
}

type StoredOpenAISettings = NonNullable<LLMSettingsData["openai"]>;

/**
 * Clears the signed-in OpenAI OAuth session. The SIWC host ID and client
 * registration are kept so the next sign-in reauthorizes the same registration
 * instead of creating a new one.
 */
export function clearOpenAIOAuthSession(
  openai: LLMSettingsData["openai"],
): StoredOpenAISettings {
  return {
    ...openai,
    accessToken: undefined,
    refreshToken: undefined,
    tokenExpiresAt: undefined,
    accountId: undefined,
    email: undefined,
    authMethod: undefined,
    oauthVariant: undefined,
  };
}

/** Best-effort revocation of a stored SIWC refresh token before sign-out. */
export async function revokeStoredSiwcSession(openai: LLMSettingsData["openai"]): Promise<void> {
  const clientId = getOpenAISiwcClientId({ openai });
  const refreshToken = openai?.refreshToken?.trim();
  if (!clientId || !refreshToken) return;
  try {
    await OpenAISiwcOAuth.revoke(clientId, refreshToken);
  } catch (error: Any) {
    logger.warn("ChatGPT token revocation failed; clearing the local session anyway:", {
      message: error?.message,
    });
  }
}

/** Generates the stable, opaque per-host identifier required by SIWC. */
export function createSiwcHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}

export function isSiwcHostId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(urn:uuid:[0-9a-f-]{36}|urn:ietf:params:oauth:jwk-thumbprint:.+|did:key:.+)$/i.test(value)
  );
}

function getElectron(): Any | null {
  try {
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    return require("electron") as Any;
  } catch {
    return null;
  }
}

/**
 * Prefer Electron's network stack (system proxy + certificate store), matching the
 * legacy OpenAI OAuth flow, and fall back to Node fetch outside Electron.
 */
export async function siwcFetch(url: string, init?: RequestInit): Promise<Response> {
  // Every attempt is bounded so a stalled request surfaces as an error instead of
  // leaving sign-in pending forever.
  const withTimeout = (): RequestInit => ({
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(SIWC_FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(SIWC_FETCH_TIMEOUT_MS),
  });
  const target = new URL(url);
  const label = `${target.host}${target.pathname}`;
  const netFetch = getElectron()?.net?.fetch;
  if (typeof netFetch === "function") {
    try {
      return await netFetch.call(getElectron().net, url, withTimeout());
    } catch (error: Any) {
      if (init?.signal?.aborted) throw error;
      logger.warn(`Electron net.fetch failed for ${label}; retrying Node fetch:`, {
        message: error?.message,
      });
    }
  }
  try {
    return await fetch(url, withTimeout());
  } catch (error: Any) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new OpenAISiwcError(
      timedOut
        ? `OpenAI did not respond in time (${label}). Check your network or proxy and try again.`
        : `Could not reach OpenAI (${label}): ${error?.message || error}`,
    );
  }
}

function assertOpenAIAuthUrl(value: string, field: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "auth.openai.com") {
    throw new OpenAISiwcError(`OpenAI sign-in discovery returned an unexpected ${field}.`);
  }
  return parsed.toString();
}

interface SiwcDiscovery {
  jwks_uri: string;
  revocation_endpoint?: string;
}

let discoveryPromise: Promise<SiwcDiscovery> | null = null;

async function discover(): Promise<SiwcDiscovery> {
  discoveryPromise ||= (async () => {
    const response = await siwcFetch(SIWC_DISCOVERY_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new OpenAISiwcError(`OpenAI sign-in discovery failed (${response.status}).`, {
        status: response.status,
      });
    }
    const payload = (await response.json()) as Any;
    const jwksUri = String(payload?.jwks_uri || "").trim();
    if (!jwksUri) throw new OpenAISiwcError("OpenAI sign-in discovery is missing jwks_uri.");
    const revocation = String(payload?.revocation_endpoint || "").trim();
    return {
      jwks_uri: assertOpenAIAuthUrl(jwksUri, "jwks_uri"),
      ...(revocation
        ? { revocation_endpoint: assertOpenAIAuthUrl(revocation, "revocation_endpoint") }
        : {}),
    };
  })().catch((error) => {
    discoveryPromise = null;
    throw error;
  });
  return discoveryPromise;
}

function base64UrlRandom(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlRandom(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildSiwcAuthorizeUrl(args: {
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  registration?: OpenAISiwcRegistration;
}): string {
  const params = new URLSearchParams();
  if (args.registration?.clientId) {
    params.set("client_id", args.registration.clientId);
  } else {
    params.set("client_id", SIWC_DYNAMIC_CLIENT_ID);
    // Only sent on first registration; reauthorization must omit it.
    params.set("agent_name_hint", SIWC_AGENT_NAME);
  }
  params.set("ext_agent_host_id", args.hostId);
  params.set("response_type", "code");
  params.set("redirect_uri", args.redirectUri);
  params.set("scope", SIWC_SCOPE);
  params.set("resource", SIWC_RESOURCE);
  params.set("state", args.state);
  params.set("nonce", args.nonce);
  params.set("code_challenge_method", "S256");
  params.set("code_challenge", args.codeChallenge);
  if (args.registration?.idToken) {
    // Skips the account selector for the saved account. Never log this URL.
    params.set("id_token_hint", args.registration.idToken);
  }
  return `${SIWC_AUTHORIZE_URL}?${params.toString()}`;
}

interface CallbackResult {
  code: string;
  issuedClientId?: string;
}

function writeCallbackPage(res: Any, ok: boolean, message: string): void {
  res.statusCode = ok ? 200 : 400;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>CoWork OS</title></head>` +
      `<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:32px">` +
      `<h2>${ok ? "Signed in to CoWork OS" : "Sign-in failed"}</h2><p>${message}</p></body></html>`,
  );
}

/**
 * Starts the loopback callback server. Tries the documented example port first and
 * falls back to an ephemeral loopback port when it is taken (for example by the
 * Codex CLI), as loopback redirect URIs may use any port.
 */
export function startSiwcCallbackServer(
  expectedState: string,
  timeoutMs = SIWC_CALLBACK_TIMEOUT_MS,
  preferredPort = SIWC_REDIRECT_PORT,
): Promise<{ redirectUri: string; result: Promise<CallbackResult>; close: () => Promise<void> }> {
  let server: Server | null = null;
  const close = () =>
    new Promise<void>((resolve) => {
      if (!server?.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      // Browsers keep the callback connection alive; without this, close() waits
      // for the keep-alive timeout before its callback fires.
      server.closeAllConnections();
    });

  return new Promise((resolveServer, rejectServer) => {
    let resolveResult!: (value: CallbackResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<CallbackResult>((yes, no) => {
      resolveResult = yes;
      rejectResult = no;
    });
    // Callers may close before awaiting; avoid an unobserved rejection.
    void result.catch(() => undefined);

    const timer = setTimeout(() => {
      void close().finally(() =>
        rejectResult(new OpenAISiwcError("ChatGPT sign-in timed out. Start again.")),
      );
    }, timeoutMs);
    timer.unref?.();

    const finish = (fn: () => void) => {
      clearTimeout(timer);
      // Settle first: sign-in must not wait on the browser's socket shutting down.
      fn();
      // Let the response flush before tearing the connection down.
      setImmediate(() => void close());
    };

    server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${SIWC_REDIRECT_HOST}`);
      if (req.method !== "GET" || url.pathname !== SIWC_REDIRECT_PATH) {
        res.statusCode = 404;
        res.end("Not found.");
        return;
      }
      // Ignore stray requests that do not belong to this attempt (CSRF guard).
      if ((url.searchParams.get("state") || "") !== expectedState) {
        writeCallbackPage(res, false, "This sign-in link is not active. Start again in CoWork OS.");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        writeCallbackPage(res, false, "You can close this tab and return to CoWork OS.");
        finish(() =>
          rejectResult(
            new OpenAISiwcError(
              error === "access_denied"
                ? "ChatGPT sign-in was cancelled."
                : `ChatGPT sign-in failed: ${error}`,
              { code: error },
            ),
          ),
        );
        return;
      }
      const code = url.searchParams.get("code") || "";
      if (!code) {
        writeCallbackPage(res, false, "The authorization code was missing. Start again.");
        finish(() => rejectResult(new OpenAISiwcError("ChatGPT sign-in returned no code.")));
        return;
      }
      const issuedClientId = url.searchParams.get("client_id")?.trim() || undefined;
      writeCallbackPage(res, true, "You can close this tab and return to CoWork OS.");
      finish(() => resolveResult({ code, issuedClientId }));
    });

    let triedFallback = false;
    const listen = (port: number) => {
      server!.listen(port, SIWC_REDIRECT_HOST, () => {
        const address = server!.address() as Any;
        resolveServer({
          redirectUri: `http://${SIWC_REDIRECT_HOST}:${address.port}${SIWC_REDIRECT_PATH}`,
          result,
          close: async () => {
            clearTimeout(timer);
            await close();
          },
        });
      });
    };
    const onListenError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && !triedFallback) {
        triedFallback = true;
        server!.once("error", onListenError);
        listen(0);
        return;
      }
      clearTimeout(timer);
      rejectServer(error);
    };
    server.once("error", onListenError);
    listen(preferredPort);
  });
}

function decodeJwtSegment(segment: string): Any {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function readJwtPayload(token: string): Any | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    return decodeJwtSegment(parts[1]);
  } catch {
    return undefined;
  }
}

function readPlanType(...tokens: Array<string | undefined>): string | undefined {
  for (const token of tokens) {
    if (!token) continue;
    const value = readJwtPayload(token)?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return undefined;
}

const JWT_VERIFY_ALGORITHMS: Record<string, { digest: string; dsaEncoding?: "ieee-p1363" }> = {
  RS256: { digest: "sha256" },
  RS384: { digest: "sha384" },
  RS512: { digest: "sha512" },
  ES256: { digest: "sha256", dsaEncoding: "ieee-p1363" },
  ES384: { digest: "sha384", dsaEncoding: "ieee-p1363" },
};

export type JwksFetcher = () => Promise<Array<Record<string, unknown>>>;

async function fetchJwks(): Promise<Array<Record<string, unknown>>> {
  const { jwks_uri } = await discover();
  const response = await siwcFetch(jwks_uri, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new OpenAISiwcError(`Could not load OpenAI signing keys (${response.status}).`);
  }
  const payload = (await response.json()) as Any;
  return Array.isArray(payload?.keys) ? payload.keys : [];
}

/**
 * Verifies the ID token signature against OpenAI's JWKS and checks iss, aud,
 * nonce and expiry as required before trusting `sub`.
 */
export async function verifySiwcIdToken(
  idToken: string,
  expected: { clientId: string; nonce?: string; nowSeconds?: number },
  jwksFetcher: JwksFetcher = fetchJwks,
): Promise<{ subject: string; email?: string; payload: Any }> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OpenAISiwcError("OpenAI returned a malformed ID token.");
  let header: Any;
  let payload: Any;
  try {
    header = decodeJwtSegment(parts[0]);
    payload = decodeJwtSegment(parts[1]);
  } catch {
    throw new OpenAISiwcError("OpenAI returned a malformed ID token.");
  }

  const algorithm = JWT_VERIFY_ALGORITHMS[String(header?.alg || "")];
  if (!algorithm) {
    throw new OpenAISiwcError(`Unsupported ID token algorithm: ${String(header?.alg)}`);
  }
  const expectedKty = algorithm.dsaEncoding ? "EC" : "RSA";
  const candidates = (await jwksFetcher()).filter(
    (key) =>
      key.kty === expectedKty &&
      (key.use === undefined || key.use === "sig") &&
      (!header.kid || key.kid === header.kid),
  );
  if (candidates.length === 0) {
    throw new OpenAISiwcError("No OpenAI signing key matches the ID token.");
  }

  // Without a kid, try every compatible signing key so key rotation cannot break sign-in.
  const signedInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], "base64url");
  const valid = candidates.some((jwk) => {
    try {
      return verify(
        algorithm.digest,
        signedInput,
        {
          key: createPublicKey({ key: jwk as Any, format: "jwk" }),
          ...(algorithm.dsaEncoding ? { dsaEncoding: algorithm.dsaEncoding } : {}),
        },
        signature,
      );
    } catch {
      return false;
    }
  });
  if (!valid) throw new OpenAISiwcError("OpenAI ID token signature is invalid.");

  if (payload?.iss !== SIWC_ISSUER) {
    throw new OpenAISiwcError("OpenAI ID token has an unexpected issuer.");
  }
  const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
  if (!audiences.includes(expected.clientId)) {
    throw new OpenAISiwcError("OpenAI ID token was issued for a different client.");
  }
  if (expected.nonce !== undefined && payload?.nonce !== expected.nonce) {
    throw new OpenAISiwcError("OpenAI ID token nonce does not match this sign-in.");
  }
  const now = expected.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload?.exp !== "number" || payload.exp + ID_TOKEN_CLOCK_SKEW_SECONDS < now) {
    throw new OpenAISiwcError("OpenAI ID token has expired.");
  }
  const subject = typeof payload?.sub === "string" ? payload.sub.trim() : "";
  if (!subject) throw new OpenAISiwcError("OpenAI ID token is missing the account subject.");
  const email = typeof payload?.email === "string" ? payload.email : undefined;
  return { subject, email, payload };
}

async function readTokenError(response: Response): Promise<OpenAISiwcError> {
  const text = await response.text().catch(() => "");
  let code: string | undefined;
  let description: string | undefined;
  try {
    const body = JSON.parse(text) as Any;
    code = String(body?.error?.code || body?.error || "").trim() || undefined;
    description =
      String(body?.error_description || body?.error?.message || body?.detail || "").trim() ||
      undefined;
  } catch {
    // Non-JSON error body; fall through with the HTTP status only.
  }
  const requiresReauth = Boolean(code && REAUTH_REQUIRED_ERROR_CODES.has(code));
  const message = requiresReauth
    ? "Your ChatGPT sign-in has expired. Sign in with ChatGPT again in Settings."
    : code === "invalid_client"
      ? "OpenAI rejected CoWork's client registration (invalid_client). Sign in with ChatGPT again."
      : `ChatGPT token request failed (${response.status}${code ? ` ${code}` : ""})${
          description ? `: ${description}` : ""
        }`;
  return new OpenAISiwcError(message, {
    code,
    status: response.status,
    requiresReauth: requiresReauth || code === "invalid_client",
  });
}

async function postTokenRequest(body: Record<string, string>): Promise<OpenAISiwcTokens> {
  const response = await siwcFetch(SIWC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) throw await readTokenError(response);
  const payload = (await response.json()) as Any;
  const accessToken = String(payload?.access_token || "").trim();
  const refreshToken = String(payload?.refresh_token || "").trim();
  if (!accessToken) throw new OpenAISiwcError("OpenAI token response is missing access_token.");
  if (!refreshToken) throw new OpenAISiwcError("OpenAI token response is missing refresh_token.");
  const expiresIn = Number(payload?.expires_in);
  const accessExp = readJwtPayload(accessToken)?.exp;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : typeof accessExp === "number"
          ? accessExp * 1000
          : Date.now() + 3600_000,
    id_token: String(payload?.id_token || "").trim() || undefined,
    scope: String(payload?.scope || "").trim() || undefined,
  };
}

const inflightRefreshes = new Map<string, Promise<OpenAISiwcTokens>>();

export class OpenAISiwcOAuth {
  /**
   * Runs the browser sign-in. Pass the saved registration to reauthorize the same
   * account; omit it to register a new client for this host.
   */
  async authenticate(args: {
    hostId: string;
    registration?: OpenAISiwcRegistration;
    openUrl?: (url: string) => void | Promise<void>;
  }): Promise<OpenAISiwcSession> {
    if (!isSiwcHostId(args.hostId)) {
      throw new OpenAISiwcError("Invalid SIWC host identifier.");
    }
    const registration =
      args.registration?.clientId && ISSUED_CLIENT_ID_PATTERN.test(args.registration.clientId)
        ? args.registration
        : undefined;
    const state = base64UrlRandom(32);
    const nonce = base64UrlRandom(32);
    const pkce = createPkcePair();
    const callback = await startSiwcCallbackServer(state);

    try {
      const authorizeUrl = buildSiwcAuthorizeUrl({
        hostId: args.hostId,
        redirectUri: callback.redirectUri,
        state,
        nonce,
        codeChallenge: pkce.challenge,
        registration,
      });
      logger.info(
        registration ? "Reauthorizing saved ChatGPT registration." : "Registering with ChatGPT.",
      );
      if (args.openUrl) {
        await args.openUrl(authorizeUrl);
      } else {
        const shell = getElectron()?.shell;
        if (!shell?.openExternal) {
          throw new OpenAISiwcError("Cannot open a browser for ChatGPT sign-in in this runtime.");
        }
        await shell.openExternal(authorizeUrl);
      }

      const { code, issuedClientId } = await callback.result;
      logger.info(
        issuedClientId
          ? "ChatGPT callback received with a newly issued client ID."
          : "ChatGPT callback received.",
      );
      const clientId = issuedClientId || registration?.clientId;
      if (!clientId || clientId === SIWC_DYNAMIC_CLIENT_ID) {
        throw new OpenAISiwcError("OpenAI did not return a client ID for this registration.");
      }
      if (!ISSUED_CLIENT_ID_PATTERN.test(clientId)) {
        throw new OpenAISiwcError("OpenAI returned an invalid client ID.");
      }

      const tokens = await postTokenRequest({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: callback.redirectUri,
        resource: SIWC_RESOURCE,
      });
      if (!tokens.id_token) {
        throw new OpenAISiwcError("OpenAI token response is missing id_token.");
      }
      logger.info("ChatGPT tokens received; verifying ID token.");
      const identity = await verifySiwcIdToken(tokens.id_token, { clientId, nonce });
      logger.info("ChatGPT sign-in completed.");
      return {
        ...tokens,
        clientId,
        subject: identity.subject,
        email: identity.email,
        planType: readPlanType(tokens.id_token, tokens.access_token),
      };
    } finally {
      await callback.close();
    }
  }

  /**
   * Refreshes the access token. Concurrent callers for the same session share one
   * request, because refresh tokens rotate and a reused token is invalidated.
   */
  static refreshTokens(clientId: string, tokens: OpenAISiwcTokens): Promise<OpenAISiwcTokens> {
    const key = `${clientId}:${tokens.refresh_token}`;
    const existing = inflightRefreshes.get(key);
    if (existing) return existing;
    const request = postTokenRequest({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      resource: SIWC_RESOURCE,
    })
      .then((next) => ({ ...next, id_token: next.id_token || tokens.id_token }))
      .finally(() => inflightRefreshes.delete(key));
    inflightRefreshes.set(key, request);
    return request;
  }

  static isTokenExpiring(tokens: Pick<OpenAISiwcTokens, "expires_at">): boolean {
    return Boolean(tokens.expires_at) && Date.now() > tokens.expires_at - SIWC_REFRESH_SKEW_MS;
  }

  /** Returns a usable access token, refreshing first when it is about to expire. */
  static async getAccessToken(
    clientId: string,
    tokens: OpenAISiwcTokens,
  ): Promise<{ accessToken: string; newTokens?: OpenAISiwcTokens }> {
    if (!this.isTokenExpiring(tokens)) return { accessToken: tokens.access_token };
    const newTokens = await this.refreshTokens(clientId, tokens);
    return { accessToken: newTokens.access_token, newTokens };
  }

  /** Revokes the refresh token. The client registration is kept for the next sign-in. */
  static async revoke(clientId: string, refreshToken: string): Promise<void> {
    const { revocation_endpoint } = await discover();
    if (!revocation_endpoint) {
      logger.warn("OpenAI discovery has no revocation_endpoint; skipping token revocation.");
      return;
    }
    const body = new URLSearchParams({
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: clientId,
    }).toString();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await siwcFetch(revocation_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (response.ok) return;
      if (response.status < 500) {
        throw new OpenAISiwcError(`ChatGPT sign-out failed (${response.status}).`, {
          status: response.status,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    throw new OpenAISiwcError("ChatGPT sign-out failed: OpenAI is unavailable.");
  }
}
