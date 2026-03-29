import http from "http";
import { randomBytes, createHash } from "crypto";
import { URL } from "url";
import { GOOGLE_WORKSPACE_DEFAULT_SCOPES } from "../../shared/google-workspace";

export interface GoogleWorkspaceOAuthRequest {
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  /** Email hint to pre-select the correct Google account in the browser */
  loginHint?: string;
}

export interface GoogleWorkspaceOAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scopes?: string[];
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const OAUTH_CALLBACK_PORT = 18766;
const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

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
    .map((s) => s.trim())
    .filter(Boolean);
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

      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback") {
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

      const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
      resolve({
        redirectUri,
        state,
        waitForCode: () => codePromise,
      });
    });
  });
}

/**
 * Tracks whether a copy-link OAuth callback server is already listening so that a second
 * concurrent call does not attempt to bind the same port.
 */
let oauthGetLinkInFlight = false;

/**
 * Builds the Google OAuth authorization URL and starts the local callback server without
 * opening a browser. Returns the URL immediately so the caller can copy it to the clipboard.
 * Tokens are delivered via `onComplete` once the user finishes authorizing in their browser.
 */
export async function startGoogleWorkspaceOAuthGetLink(
  request: GoogleWorkspaceOAuthRequest,
  onComplete: (result: GoogleWorkspaceOAuthResult) => void,
  onError: (error: Error) => void,
): Promise<string> {
  if (oauthGetLinkInFlight) {
    throw new Error(
      "An OAuth link request is already in progress. Wait for the current authorization to complete before starting a new one.",
    );
  }
  if (!request.clientId) {
    throw new Error("Google Workspace OAuth requires a client ID");
  }

  const scopes =
    request.scopes && request.scopes.length > 0
      ? request.scopes
      : GOOGLE_WORKSPACE_DEFAULT_SCOPES;

  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  const authUrl = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", request.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent select_account");
  if (request.loginHint) {
    authUrl.searchParams.set("login_hint", request.loginHint);
  }

  // Wait for the browser callback in the background; caller gets the URL immediately.
  oauthGetLinkInFlight = true;
  waitForCode()
    .then(async ({ code }) => {
      const params = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: request.clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      if (request.clientSecret) {
        params.set("client_secret", request.clientSecret);
      }
      const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const rawText = typeof tokenResponse.text === "function" ? await tokenResponse.text() : "";
      const tokenData = rawText ? parseJsonSafe(rawText) : undefined;
      if (!tokenResponse.ok) {
        const message =
          tokenData?.error_description ||
          tokenData?.error ||
          tokenResponse.statusText ||
          "OAuth failed";
        onError(new Error(`Google Workspace OAuth failed: ${message}`));
        return;
      }
      const accessToken = tokenData?.access_token as string | undefined;
      if (!accessToken) {
        onError(new Error("Google Workspace OAuth did not return an access_token"));
        return;
      }
      const expiresIn =
        typeof tokenData?.expires_in === "number" ? tokenData.expires_in : undefined;
      const scopesGranted = parseScopeList(tokenData?.scope);
      onComplete({
        accessToken,
        refreshToken: tokenData?.refresh_token,
        expiresIn,
        tokenType: tokenData?.token_type,
        scopes: scopesGranted,
      });
    })
    .catch((err: Error) => onError(err))
    .finally(() => {
      oauthGetLinkInFlight = false;
    });

  return authUrl.toString();
}

export async function startGoogleWorkspaceOAuth(
  request: GoogleWorkspaceOAuthRequest,
): Promise<GoogleWorkspaceOAuthResult> {
  if (!request.clientId) {
    throw new Error("Google Workspace OAuth requires a client ID");
  }

  const scopes =
    request.scopes && request.scopes.length > 0
      ? request.scopes
      : GOOGLE_WORKSPACE_DEFAULT_SCOPES;

  const { redirectUri, waitForCode, state } = await startOAuthCallbackServer();
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  const authUrl = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", request.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent select_account");
  if (request.loginHint) {
    authUrl.searchParams.set("login_hint", request.loginHint);
  }

  await openExternalUrl(authUrl.toString());

  const { code } = await waitForCode();

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: request.clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  if (request.clientSecret) {
    params.set("client_secret", request.clientSecret);
  }

  const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const rawText = typeof tokenResponse.text === "function" ? await tokenResponse.text() : "";
  const tokenData = rawText ? parseJsonSafe(rawText) : undefined;

  if (!tokenResponse.ok) {
    const message =
      tokenData?.error_description ||
      tokenData?.error ||
      tokenResponse.statusText ||
      "OAuth failed";
    throw new Error(`Google Workspace OAuth failed: ${message}`);
  }

  const accessToken = tokenData?.access_token as string | undefined;
  if (!accessToken) {
    throw new Error("Google Workspace OAuth did not return an access_token");
  }

  const expiresIn = typeof tokenData?.expires_in === "number" ? tokenData.expires_in : undefined;
  const scopesGranted = parseScopeList(tokenData?.scope);

  return {
    accessToken,
    refreshToken: tokenData?.refresh_token,
    expiresIn,
    tokenType: tokenData?.token_type,
    scopes: scopesGranted,
  };
}
