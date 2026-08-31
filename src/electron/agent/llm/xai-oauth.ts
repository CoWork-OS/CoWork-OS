import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, Server } from "node:http";
import { URL, URLSearchParams } from "node:url";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
const XAI_OAUTH_REDIRECT_PORT = 56121;
const XAI_OAUTH_REDIRECT_PATH = "/callback";
const XAI_OAUTH_REFERRER = "hermes-agent";
const XAI_ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;
export const DEFAULT_XAI_OAUTH_BASE_URL = "https://api.x.ai/v1";

export interface XAIOAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  token_endpoint?: string;
  id_token?: string;
}

interface DiscoveryResult {
  authorization_endpoint: string;
  token_endpoint: string;
}

function getElectronShell(): { openExternal?: (url: string) => Promise<void> | void } | null {
  try {
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    return electron?.shell || null;
  } catch {
    return null;
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function createCodeVerifier(): string {
  return base64Url(randomBytes(64)).slice(0, 128);
}

function createCodeChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function validateXAIEndpoint(value: string, field: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error(`xAI OAuth discovery returned a non-HTTPS ${field}.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`xAI OAuth discovery returned a ${field} outside xAI.`);
  }
  return value;
}

async function discoverXAIEndpoints(): Promise<DiscoveryResult> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`xAI OAuth discovery failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as Any;
  const authorizationEndpoint = String(payload?.authorization_endpoint || "").trim();
  const tokenEndpoint = String(payload?.token_endpoint || "").trim();
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("xAI OAuth discovery response was missing required endpoints.");
  }
  return {
    authorization_endpoint: validateXAIEndpoint(authorizationEndpoint, "authorization_endpoint"),
    token_endpoint: validateXAIEndpoint(tokenEndpoint, "token_endpoint"),
  };
}

function parseTokenExpiry(accessToken: string, fallbackExpiresIn?: unknown): number | undefined {
  const parts = accessToken.split(".");
  if (parts.length >= 2) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Any;
      if (typeof payload?.exp === "number" && Number.isFinite(payload.exp)) {
        return payload.exp * 1000;
      }
    } catch {
      // Fall through to expires_in.
    }
  }
  const expiresIn = Number(fallbackExpiresIn);
  return Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined;
}

export function isXAIAccessTokenExpiring(accessToken?: string, expiresAt?: number): boolean {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return Date.now() + XAI_ACCESS_TOKEN_REFRESH_SKEW_MS >= expiresAt;
  }
  const parsedExpiry = accessToken ? parseTokenExpiry(accessToken) : undefined;
  return typeof parsedExpiry === "number"
    ? Date.now() + XAI_ACCESS_TOKEN_REFRESH_SKEW_MS >= parsedExpiry
    : false;
}

function buildAuthorizeUrl(
  discovery: DiscoveryResult,
  redirectUri: string,
  codeChallenge: string,
  state: string,
  nonce: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
    plan: "generic",
    referrer: XAI_OAUTH_REFERRER,
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

function writeCallbackResponse(res: Any, ok: boolean): void {
  res.statusCode = ok ? 200 : 400;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<html><body><h1>xAI authorization ${ok ? "received" : "failed"}.</h1>You can close this tab.</body></html>`,
  );
}

function startCallbackServer(
  expectedState: string,
  timeoutMs = 180_000,
): Promise<{
  redirectUri: string;
  waitForCode: Promise<string>;
  close: () => Promise<void>;
}> {
  let server: Server | null = null;

  const close = () =>
    new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });

  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void = () => undefined;
    let rejectCode: (error: Error) => void = () => undefined;
    const waitForCode = new Promise<string>((innerResolve, innerReject) => {
      resolveCode = innerResolve;
      rejectCode = innerReject;
    });
    const timer = setTimeout(() => {
      const error = new Error("xAI authorization timed out.");
      void close().finally(() => rejectCode(error));
    }, timeoutMs);

    const settle = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };

    const callbackState = { error: "" };
    server = createServer((req, res) => {
      const origin = req.headers.origin;
      if (origin === "https://accounts.x.ai" || origin === "https://auth.x.ai") {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      const callbackUrl = new URL(req.url || "/", `http://${XAI_OAUTH_REDIRECT_HOST}`);
      if (callbackUrl.pathname !== XAI_OAUTH_REDIRECT_PATH) {
        res.statusCode = 404;
        res.end("Not found.");
        return;
      }
      const error = callbackUrl.searchParams.get("error");
      if (error) {
        callbackState.error = callbackUrl.searchParams.get("error_description") || error;
        writeCallbackResponse(res, false);
        settle(() => {
          void close().finally(() =>
            rejectCode(new Error(`xAI authorization failed: ${callbackState.error}`)),
          );
        });
        return;
      }
      const returnedState = callbackUrl.searchParams.get("state") || "";
      if (returnedState !== expectedState) {
        writeCallbackResponse(res, false);
        settle(() => {
          void close().finally(() =>
            rejectCode(new Error("xAI authorization failed: state mismatch.")),
          );
        });
        return;
      }
      const code = callbackUrl.searchParams.get("code") || "";
      if (!code) {
        writeCallbackResponse(res, false);
        settle(() => {
          void close().finally(() =>
            rejectCode(new Error("xAI authorization failed: missing authorization code.")),
          );
        });
        return;
      }
      writeCallbackResponse(res, true);
      settle(() => {
        void close().finally(() => resolveCode(code));
      });
    });

    let triedFallbackPort = false;
    const listen = (port: number) => {
      server!.listen(port, XAI_OAUTH_REDIRECT_HOST, () => {
        const address = server!.address() as Any;
        resolve({
          redirectUri: `http://${XAI_OAUTH_REDIRECT_HOST}:${address.port}${XAI_OAUTH_REDIRECT_PATH}`,
          waitForCode,
          close: async () => {
            callbackState.error = "__closed__";
            await close();
          },
        });
      });
    };

    const onListenError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && !triedFallbackPort) {
        triedFallbackPort = true;
        server!.once("error", onListenError);
        listen(0);
        return;
      }
      clearTimeout(timer);
      reject(error);
    };
    server.once("error", onListenError);
    listen(XAI_OAUTH_REDIRECT_PORT);
  });
}

async function exchangeXAIToken(
  tokenEndpoint: string,
  body: Record<string, string>,
): Promise<XAIOAuthTokens> {
  validateXAIEndpoint(tokenEndpoint, "token_endpoint");
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `xAI token exchange failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
    );
  }
  const payload = (await response.json()) as Any;
  const accessToken = String(payload?.access_token || "").trim();
  const refreshToken = String(payload?.refresh_token || body.refresh_token || "").trim();
  if (!accessToken) throw new Error("xAI token response was missing access_token.");
  if (!refreshToken) throw new Error("xAI token response was missing refresh_token.");
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: parseTokenExpiry(accessToken, payload?.expires_in),
    token_endpoint: tokenEndpoint,
    id_token: String(payload?.id_token || "").trim() || undefined,
  };
}

export class XAIOAuth {
  async authenticate(): Promise<XAIOAuthTokens> {
    const discovery = await discoverXAIEndpoints();
    const state = randomUUID().replace(/-/g, "");
    const callback = await startCallbackServer(state);
    const codeVerifier = createCodeVerifier();
    const authorizeUrl = buildAuthorizeUrl(
      discovery,
      callback.redirectUri,
      createCodeChallenge(codeVerifier),
      state,
      randomUUID().replace(/-/g, ""),
    );

    const shell = getElectronShell();
    if (shell?.openExternal) {
      await shell.openExternal(authorizeUrl);
    } else {
      console.log("[xAI OAuth] Open this URL to authorize CoWork OS with xAI:");
      console.log(authorizeUrl);
    }

    const code = await callback.waitForCode;

    return exchangeXAIToken(discovery.token_endpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: callback.redirectUri,
      client_id: XAI_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    });
  }

  static async refreshTokens(tokens: XAIOAuthTokens): Promise<XAIOAuthTokens> {
    const tokenEndpoint = tokens.token_endpoint || (await discoverXAIEndpoints()).token_endpoint;
    return exchangeXAIToken(tokenEndpoint, {
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: tokens.refresh_token,
    });
  }
}
