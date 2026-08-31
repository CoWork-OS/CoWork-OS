import http from "http";
import { createHash, randomBytes } from "crypto";
import { URL } from "url";
import {
  MICROSOFT_EMAIL_DEFAULT_TENANT,
  MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES,
  normalizeMicrosoftEmailReadScopes,
} from "../../shared/microsoft-email";

export interface MicrosoftEmailOAuthRequest {
  clientId: string;
  clientSecret?: string;
  tenant?: string;
  scopes?: string[];
  loginHint?: string;
  prompt?: "select_account" | "consent";
}

export interface MicrosoftEmailOAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scopes?: string[];
}

export interface MicrosoftEmailRefreshRequest {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  tenant?: string;
  scopes?: string[];
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const OAUTH_CALLBACK_PORT = 18767;

function getElectronShell(): Any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const shell = electron?.shell;
    if (shell?.openExternal) return shell;
  } catch {
    // Not running under Electron.
  }
  return null;
}

async function openExternalUrl(url: string): Promise<void> {
  const shell = getElectronShell();
  if (!shell?.openExternal) {
    throw new Error("Electron shell is unavailable outside the Electron runtime");
  }
  await shell.openExternal(url);
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

function createCodeChallenge(verifier: string): string {
  const hash = createHash("sha256").update(verifier).digest();
  return base64Url(hash);
}

function parseJsonSafe(text: string): Any | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parseScopeList(scope?: string): string[] | undefined {
  if (!scope) return undefined;
  return scope
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveTenant(tenant?: string): string {
  const trimmed = tenant?.trim();
  return trimmed || MICROSOFT_EMAIL_DEFAULT_TENANT;
}

function buildAuthorizeUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
}

function buildTokenUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

interface MicrosoftEmailAuthorizeUrlOptions {
  tenant: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  loginHint?: string;
  prompt?: "select_account" | "consent";
}

export function buildMicrosoftEmailAuthorizeUrl(options: MicrosoftEmailAuthorizeUrlOptions): URL {
  const authUrl = new URL(buildAuthorizeUrl(options.tenant));
  authUrl.searchParams.set("client_id", options.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", options.redirectUri);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", options.scopes.join(" "));
  authUrl.searchParams.set("state", options.state);
  authUrl.searchParams.set("code_challenge", options.codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("prompt", options.prompt || "select_account");
  if (options.loginHint) {
    authUrl.searchParams.set("login_hint", options.loginHint);
  }
  return authUrl;
}

async function startOAuthCallbackServer(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{
  redirectUri: string;
  state: string;
  waitForCode: () => Promise<{ code: string; state: string }>;
}> {
  const state = base64Url(randomBytes(16));

  return new Promise((resolve, reject) => {
    const server = http.createServer();

    let resolveCode: (value: { code: string; state: string }) => void = () => {};
    let rejectCode: (error: Error) => void = () => {};

    const codePromise = new Promise<{ code: string; state: string }>(
      (innerResolve, innerReject) => {
        resolveCode = innerResolve;
        rejectCode = innerReject;
      },
    );

    const timeout = setTimeout(() => {
      server.close();
      rejectCode(new Error("OAuth timed out. Please try again."));
    }, timeoutMs);

    server.on("request", (req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Invalid request");
        return;
      }

      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/" && url.pathname !== "/oauth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body style="font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', system-ui, sans-serif; padding: 24px;">
        <h2>Authorization complete</h2>
        <p>You can close this window and return to CoWork OS.</p>
      </body></html>`);

      clearTimeout(timeout);
      server.close();

      if (error) {
        rejectCode(new Error(errorDescription || error));
        return;
      }

      if (!code || !returnedState) {
        rejectCode(new Error("Missing OAuth code or state"));
        return;
      }

      if (returnedState !== state) {
        rejectCode(new Error("OAuth state mismatch"));
        return;
      }

      resolveCode({ code, state: returnedState });
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      const portMessage =
        error.code === "EADDRINUSE"
          ? `Port ${OAUTH_CALLBACK_PORT} is already in use. Close the conflicting app and try again.`
          : error.message;
      reject(new Error(`OAuth callback server failed: ${portMessage}`));
    });

    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        clearTimeout(timeout);
        server.close();
        reject(new Error("Failed to start OAuth callback server"));
        return;
      }

      resolve({
        redirectUri: `http://localhost:${address.port}`,
        state,
        waitForCode: () => codePromise,
      });
    });
  });
}

async function exchangeCodeForTokens(
  params: URLSearchParams,
  tenant: string,
): Promise<MicrosoftEmailOAuthResult> {
  const response = await fetch(buildTokenUrl(tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const rawText = typeof response.text === "function" ? await response.text() : "";
  const data = rawText ? parseJsonSafe(rawText) : undefined;

  if (!response.ok) {
    const message = data?.error_description || data?.error || response.statusText || "OAuth failed";
    throw new Error(`Microsoft email OAuth failed: ${message}`);
  }

  const accessToken = data?.access_token as string | undefined;
  if (!accessToken) {
    throw new Error("Microsoft email OAuth did not return an access_token");
  }

  return {
    accessToken,
    refreshToken: data?.refresh_token as string | undefined,
    expiresIn: typeof data?.expires_in === "number" ? data.expires_in : undefined,
    tokenType: data?.token_type as string | undefined,
    scopes: parseScopeList(data?.scope),
  };
}

export async function startMicrosoftEmailOAuth(
  request: MicrosoftEmailOAuthRequest,
): Promise<MicrosoftEmailOAuthResult> {
  if (!request.clientId) {
    throw new Error("Microsoft email OAuth requires a client ID");
  }

  const tenant = resolveTenant(request.tenant);
  const scopes =
    request.scopes && request.scopes.length > 0
      ? normalizeMicrosoftEmailReadScopes(request.scopes)
      : [...MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES];

  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const authUrl = buildMicrosoftEmailAuthorizeUrl({
    tenant,
    clientId: request.clientId,
    redirectUri,
    scopes,
    state,
    codeChallenge,
    loginHint: request.loginHint,
    prompt: request.prompt,
  });

  await openExternalUrl(authUrl.toString());
  const { code } = await waitForCode();

  const params = new URLSearchParams({
    client_id: request.clientId,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  if (request.clientSecret) {
    params.set("client_secret", request.clientSecret);
  }

  return exchangeCodeForTokens(params, tenant);
}

export async function refreshMicrosoftEmailAccessToken(
  request: MicrosoftEmailRefreshRequest,
): Promise<MicrosoftEmailOAuthResult> {
  if (!request.clientId) {
    throw new Error("Microsoft email OAuth requires a client ID");
  }
  if (!request.refreshToken) {
    throw new Error("Microsoft email refresh token not configured");
  }

  const tenant = resolveTenant(request.tenant);
  const params = new URLSearchParams({
    client_id: request.clientId,
    grant_type: "refresh_token",
    refresh_token: request.refreshToken,
  });
  if (request.scopes && request.scopes.length > 0) {
    params.set("scope", request.scopes.join(" "));
  }

  if (request.clientSecret) {
    params.set("client_secret", request.clientSecret);
  }

  return exchangeCodeForTokens(params, tenant);
}
