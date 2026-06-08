import type { OAuthAuthInfo, OAuthCredentials, OAuthPrompt } from "@mariozechner/pi-ai";
import { loadPiAiOAuthModule } from "./pi-ai-loader";
import { createLogger } from "../../utils/logger";

const logger = createLogger("OpenAI OAuth");

const MANUAL_CALLBACK_HELPER_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Finish ChatGPT Sign-In</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f8fafc; }
    main { padding: 28px; max-width: 680px; margin: 0 auto; }
    h1 { font-size: 22px; margin: 0 0 10px; }
    p { color: #4b5563; line-height: 1.45; }
    code { background: #e5e7eb; padding: 2px 5px; border-radius: 5px; }
    textarea { width: 100%; min-height: 132px; box-sizing: border-box; margin-top: 12px; padding: 12px; border-radius: 8px; border: 1px solid #cbd5e1; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
    .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; }
    button { border: 0; border-radius: 8px; padding: 10px 16px; font-size: 14px; cursor: pointer; }
    button.primary { background: #111827; color: white; }
    button.secondary { background: #e5e7eb; color: #111827; }
    .hint { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 12px; margin: 16px 0; }
    .error { color: #b91c1c; min-height: 20px; margin-top: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>Finish ChatGPT Sign-In</h1>
    <p>Continue signing in with passkey in your normal browser. After OpenAI redirects to a page starting with <code>http://localhost:1455/auth/callback</code>, copy the full URL from the browser address bar and paste it here.</p>
    <div class="hint">This fallback is needed because another app is already using localhost port 1455, so CoWork cannot receive the callback directly.</div>
    <textarea id="callbackUrl" autofocus placeholder="http://localhost:1455/auth/callback?code=...&state=..."></textarea>
    <div class="error" id="error"></div>
    <div class="actions">
      <button class="secondary" id="cancel">Cancel</button>
      <button class="primary" id="continue">Continue</button>
    </div>
  </main>
  <script>
    window.__coworkOAuthResult = null;
    const input = document.getElementById("callbackUrl");
    const error = document.getElementById("error");
    document.getElementById("continue").addEventListener("click", () => {
      const value = input.value.trim();
      if (!value.includes("code=")) {
        error.textContent = "Paste the full callback URL that contains code=...";
        return;
      }
      window.__coworkOAuthResult = { type: "submit", value };
    });
    document.getElementById("cancel").addEventListener("click", () => {
      window.__coworkOAuthResult = { type: "cancel" };
    });
  </script>
</body>
</html>`)}`;

let proxyBootstrapPromise: Promise<void> | null = null;
let electronOAuthFetchFallbackInstalled = false;

const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

function ensureNodeFetchProxySupport(): void {
  if (proxyBootstrapPromise || typeof process === "undefined" || !process.versions?.node) {
    return;
  }

  // pi-ai <= 0.55.x set up Undici's env-based proxy agent as an OAuth import side effect.
  proxyBootstrapPromise = import("undici")
    .then(({ EnvHttpProxyAgent, setGlobalDispatcher }) => {
      setGlobalDispatcher(new EnvHttpProxyAgent());
    })
    .catch((error) => {
      logger.warn("Failed to initialize HTTP proxy support:", error);
    });
}

ensureNodeFetchProxySupport();

function getFetchUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  const url = (input as Any)?.url;
  return typeof url === "string" ? url : undefined;
}

function shouldUseElectronOAuthFetch(input: Parameters<typeof fetch>[0]): boolean {
  const rawUrl = getFetchUrl(input);
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return url.origin + url.pathname === OPENAI_OAUTH_TOKEN_URL;
  } catch {
    return false;
  }
}

function getElectronNetFetch(): typeof fetch | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const netFetch = electron?.net?.fetch;
    return typeof netFetch === "function" ? netFetch.bind(electron.net) : null;
  } catch {
    return null;
  }
}

function installElectronOAuthFetchFallback(): void {
  if (electronOAuthFetchFallbackInstalled || typeof globalThis.fetch !== "function") {
    return;
  }

  const electronFetch = getElectronNetFetch();
  if (!electronFetch) return;

  const nodeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (shouldUseElectronOAuthFetch(input)) {
      try {
        return await electronFetch(input, init);
      } catch (error: Any) {
        logger.warn(
          "Electron net.fetch failed for OpenAI OAuth token request; retrying Node fetch:",
          error?.message || error,
        );
      }
    }
    return nodeFetch(input, init);
  }) as typeof fetch;

  electronOAuthFetchFallbackInstalled = true;
  logger.info("Installed Electron network fallback for OpenAI OAuth token exchange.");
}

installElectronOAuthFetchFallback();

function getElectronShell(): Any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const shell = electron?.shell;
    if (shell) return shell;
  } catch {
    // Not running under Electron.
  }
  return null;
}

function getElectronBrowserWindow(): Any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    return electron?.BrowserWindow || null;
  } catch {
    return null;
  }
}

async function canBindOpenAICodexCallbackPort(): Promise<boolean> {
  try {
    const net = await import("node:net");
    return await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(1455, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
  } catch {
    return false;
  }
}

function promptForOpenAICodexRedirectUrl(): Promise<string> {
  const BrowserWindow = getElectronBrowserWindow();
  if (!BrowserWindow) return Promise.resolve("");

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const promptWindow = new BrowserWindow({
      width: 720,
      height: 520,
      title: "Finish ChatGPT Sign-In",
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const settle = (value: string, isCancel = false) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      if (!promptWindow.isDestroyed()) promptWindow.close();
      if (isCancel) {
        reject(new Error("OpenAI OAuth was cancelled"));
      } else {
        resolve(value);
      }
    };

    const pollTimer = setInterval(() => {
      if (promptWindow.isDestroyed()) {
        settle("", true);
        return;
      }
      void promptWindow.webContents
        .executeJavaScript("window.__coworkOAuthResult", true)
        .then((result: Any) => {
          if (!result) return;
          if (result.type === "cancel") {
            settle("", true);
          } else if (result.type === "submit" && typeof result.value === "string") {
            settle(result.value);
          }
        })
        .catch(() => undefined);
    }, 250);

    promptWindow.on("closed", () => {
      settle("", true);
    });

    void promptWindow.loadURL(MANUAL_CALLBACK_HELPER_HTML).catch((error: Error) => {
      clearInterval(pollTimer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

/**
 * OpenAI OAuth tokens compatible with pi-ai SDK
 */
export interface OpenAIOAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  email?: string;
  accountId?: string;
}

export function extractChatGPTAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Any;
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert pi-ai OAuthCredentials to our token format
 */
function credentialsToTokens(credentials: OAuthCredentials): OpenAIOAuthTokens {
  const email = typeof credentials.email === "string" ? credentials.email : undefined;
  return {
    access_token: credentials.access,
    refresh_token: credentials.refresh,
    expires_at: credentials.expires,
    email,
    accountId: extractChatGPTAccountId(credentials.access),
  };
}

/**
 * Convert our token format to pi-ai OAuthCredentials
 */
export function tokensToCredentials(tokens: OpenAIOAuthTokens): OAuthCredentials {
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: tokens.expires_at,
    email: tokens.email,
  };
}

/**
 * OpenAI OAuth handler using pi-ai SDK
 * Uses the ChatGPT OAuth flow for users with ChatGPT subscriptions
 */
export class OpenAIOAuth {
  /**
   * Start the OAuth flow using pi-ai SDK
   * Opens browser for authentication and waits for callback
   */
  async authenticate(): Promise<OpenAIOAuthTokens> {
    logger.info("Starting authentication flow with pi-ai SDK...");
    const { loginOpenAICodex } = await loadPiAiOAuthModule();
    const useSystemBrowser = await canBindOpenAICodexCallbackPort();
    let manualRedirectPromise: Promise<string> | null = null;
    if (!useSystemBrowser) {
      logger.warn(
        "localhost:1455 is already in use. Using system browser with manual redirect paste so macOS passkeys still work.",
      );
    }

    let credentials: OAuthCredentials;
    try {
      credentials = await loginOpenAICodex({
        onAuth: (info: OAuthAuthInfo) => {
          logger.info("Opening browser for authentication...");
          if (!useSystemBrowser && !manualRedirectPromise) {
            manualRedirectPromise = promptForOpenAICodexRedirectUrl();
          }
          const shell = getElectronShell();
          if (shell?.openExternal) {
            shell.openExternal(info.url);
          } else {
            logger.info("Browser open is unavailable in this runtime. Open this URL manually:");
            logger.info(info.url);
          }
          if (info.instructions) {
            logger.info("Instructions:", info.instructions);
          }
        },
        ...(!useSystemBrowser
          ? {
              onManualCodeInput: () => {
                manualRedirectPromise ||= promptForOpenAICodexRedirectUrl();
                return manualRedirectPromise;
              },
            }
          : {}),
        onPrompt: async (prompt: OAuthPrompt) => {
          logger.info("Prompt:", prompt.message);
          if (useSystemBrowser) return "";
          manualRedirectPromise ||= promptForOpenAICodexRedirectUrl();
          return manualRedirectPromise;
        },
        onProgress: (message: string) => {
          logger.info("Progress:", message);
        },
        originator: "cowork-os",
      });
    } finally {
      // The manual helper closes itself when submitted or cancelled.
    }

    logger.info("Authentication successful!");
    if (credentials.email) {
      logger.info("Logged in as:", credentials.email);
    }

    return credentialsToTokens(credentials);
  }

  /**
   * Refresh an expired access token using pi-ai SDK
   */
  static async refreshTokens(tokens: OpenAIOAuthTokens): Promise<OpenAIOAuthTokens> {
    logger.info("Refreshing tokens...");
    const { refreshOpenAICodexToken } = await loadPiAiOAuthModule();

    // refreshOpenAICodexToken expects the refresh token string, not the full credentials
    const newCredentials = await refreshOpenAICodexToken(tokens.refresh_token);

    logger.info("Tokens refreshed successfully!");
    return credentialsToTokens(newCredentials);
  }

  /**
   * Get an API key from OAuth credentials (with auto-refresh)
   * This is used for making API calls with the ChatGPT backend
   */
  static async getApiKeyFromTokens(
    tokens: OpenAIOAuthTokens,
  ): Promise<{ apiKey: string; newTokens?: OpenAIOAuthTokens }> {
    if (!this.isTokenExpired(tokens)) {
      return { apiKey: tokens.access_token };
    }

    const newTokens = await this.refreshTokens(tokens);
    return {
      apiKey: newTokens.access_token,
      newTokens,
    };
  }

  /**
   * Check if tokens are expired or about to expire
   */
  static isTokenExpired(tokens: OpenAIOAuthTokens): boolean {
    if (!tokens.expires_at) {
      return false; // If no expiration, assume valid
    }
    // Consider expired if less than 5 minutes remaining
    return Date.now() > tokens.expires_at - 5 * 60 * 1000;
  }
}
