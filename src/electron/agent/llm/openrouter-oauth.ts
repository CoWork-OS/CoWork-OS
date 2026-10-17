import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { URL, URLSearchParams } from "node:url";
import { OPENROUTER_FREE_MODEL_ID } from "../../../shared/llm-provider-catalog";
import { createLogger } from "../../utils/logger";
import { getOpenRouterAttributionHeaders } from "./openrouter-attribution";
import type { LLMSettings } from "./provider-factory";

const logger = createLogger("OpenRouter OAuth");

/**
 * OpenRouter's PKCE flow for apps (https://openrouter.ai/docs/use-cases/oauth-pkce): send the
 * user to /auth with a callback URL and an S256 challenge, then trade the returned code and the
 * verifier for a user-scoped API key. The key is an ordinary OpenRouter key, so the existing
 * OpenRouter provider uses it unchanged.
 */
export const OPENROUTER_AUTHORIZE_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_KEY_LABEL = "CoWork OS";
/** The callback server only ever listens on loopback. */
const CALLBACK_BIND_HOST = "127.0.0.1";
/** OpenRouter documents localhost callbacks on any port; the name resolves to the bound loopback. */
const CALLBACK_URL_HOST = "localhost";
const CALLBACK_PATH = "/callback";
/** Authorization codes expire after ten minutes; stop waiting well before that. */
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const MAX_KEY_LENGTH = 512;

export interface OpenRouterOAuthResult {
  key: string;
  userId?: string;
}

export interface OpenRouterOAuthOptions {
  openExternal?: (url: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  authorizeUrl?: string;
  exchangeUrl?: string;
}

interface CallbackServer {
  callbackUrl: string;
  waitForCode: Promise<string>;
  close: () => Promise<void>;
}

function getElectronShell(): { openExternal?: (url: string) => Promise<void> | void } | null {
  try {
    // oxlint-disable-next-line typescript/no-require-imports -- electron is absent in the daemon and CLI
    const electron = require("electron") as Any;
    return electron?.shell || null;
  } catch {
    return null;
  }
}

/** RFC 7636 verifier: 43 to 128 characters from the unreserved set. */
export function createOpenRouterCodeVerifier(): string {
  return randomBytes(64).toString("base64url").slice(0, 128);
}

export function createOpenRouterCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildOpenRouterAuthorizeUrl(args: {
  callbackUrl: string;
  codeChallenge: string;
  state: string;
  authorizeUrl?: string;
}): string {
  const params = new URLSearchParams({
    callback_url: args.callbackUrl,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
    state: args.state,
    key_label: OPENROUTER_KEY_LABEL,
  });
  return `${args.authorizeUrl || OPENROUTER_AUTHORIZE_URL}?${params.toString()}`;
}

function writeCallbackPage(res: ServerResponse, ok: boolean): void {
  res.statusCode = ok ? 200 : 400;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    `<!doctype html><html><body style="font-family:-apple-system,system-ui,sans-serif;padding:48px;color:#111">` +
      `<h1 style="font-size:20px;font-weight:600">${ok ? "Signed in to OpenRouter" : "OpenRouter sign-in did not finish"}</h1>` +
      `<p>${ok ? "You can close this tab and return to CoWork OS." : "Return to CoWork OS and try again."}</p>` +
      `</body></html>`,
  );
}

export function startOpenRouterCallbackServer(
  expectedState: string,
  timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
): Promise<CallbackServer> {
  let server: Server | null = null;
  let settled = false;
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Callers may close before awaiting; never surface that as an unhandled rejection.
  waitForCode.catch(() => undefined);

  const close = () =>
    new Promise<void>((resolve) => {
      if (!server || !server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections?.();
    });

  let timer: NodeJS.Timeout | null = null;
  const finish = (outcome: { code: string } | { error: Error }) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    void close().finally(() => {
      if ("code" in outcome) resolveCode(outcome.code);
      else rejectCode(outcome.error);
    });
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url || "/", `http://${CALLBACK_BIND_HOST}`);
    if (req.method !== "GET" || requestUrl.pathname !== CALLBACK_PATH) {
      res.statusCode = 404;
      res.end("Not found.");
      return;
    }
    if (settled) {
      writeCallbackPage(res, false);
      return;
    }
    const error = requestUrl.searchParams.get("error");
    if (error) {
      writeCallbackPage(res, false);
      const detail = requestUrl.searchParams.get("error_description") || error;
      finish({ error: new Error(`OpenRouter sign-in was not completed: ${detail.slice(0, 200)}`) });
      return;
    }
    const code = requestUrl.searchParams.get("code") || "";
    if (!code) {
      writeCallbackPage(res, false);
      finish({ error: new Error("OpenRouter sign-in was cancelled.") });
      return;
    }
    if ((requestUrl.searchParams.get("state") || "") !== expectedState) {
      writeCallbackPage(res, false);
      finish({ error: new Error("OpenRouter sign-in failed: state mismatch.") });
      return;
    }
    writeCallbackPage(res, true);
    finish({ code });
  };

  return new Promise((resolve, reject) => {
    server = createServer(handle);
    server.once("error", (error) => {
      settled = true;
      reject(error);
    });
    server.listen(0, CALLBACK_BIND_HOST, () => {
      const { port } = server!.address() as AddressInfo;
      timer = setTimeout(
        () => finish({ error: new Error("OpenRouter sign-in timed out. Try again.") }),
        timeoutMs,
      );
      resolve({
        callbackUrl: `http://${CALLBACK_URL_HOST}:${port}${CALLBACK_PATH}`,
        waitForCode,
        close: async () => {
          finish({ error: new Error("OpenRouter sign-in was cancelled.") });
          await close();
        },
      });
    });
  });
}

function readErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

export async function exchangeOpenRouterCode(args: {
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
  exchangeUrl?: string;
}): Promise<OpenRouterOAuthResult> {
  const fetchImpl = args.fetchImpl || fetch;
  const response = await fetchImpl(args.exchangeUrl || OPENROUTER_KEY_EXCHANGE_URL, {
    method: "POST",
    headers: {
      ...getOpenRouterAttributionHeaders(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      code: args.code,
      code_verifier: args.codeVerifier,
      code_challenge_method: "S256",
    }),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const detail = readErrorMessage(payload);
    throw new Error(
      `OpenRouter key exchange failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : "."}`,
    );
  }
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const key = typeof record.key === "string" ? record.key.trim() : "";
  if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    throw new Error("OpenRouter key exchange returned no usable key.");
  }
  const userId = typeof record.user_id === "string" ? record.user_id.trim() : "";
  return { key, ...(userId ? { userId } : {}) };
}

let activeFlow: CallbackServer | null = null;

export class OpenRouterOAuth {
  /** Opens OpenRouter in the browser and resolves with a user-scoped key once the user approves. */
  async authenticate(options: OpenRouterOAuthOptions = {}): Promise<OpenRouterOAuthResult> {
    // A second click replaces a sign-in the user abandoned in the browser.
    await OpenRouterOAuth.cancelActive();

    const state = randomUUID().replace(/-/g, "");
    const codeVerifier = createOpenRouterCodeVerifier();
    const callback = await startOpenRouterCallbackServer(state, options.timeoutMs);
    activeFlow = callback;
    try {
      const authorizeUrl = buildOpenRouterAuthorizeUrl({
        callbackUrl: callback.callbackUrl,
        codeChallenge: createOpenRouterCodeChallenge(codeVerifier),
        state,
        authorizeUrl: options.authorizeUrl,
      });
      const openExternal = options.openExternal || getElectronShell()?.openExternal;
      if (!openExternal) {
        throw new Error("Cannot open the browser for OpenRouter sign-in.");
      }
      await openExternal(authorizeUrl);

      const code = await callback.waitForCode;
      const result = await exchangeOpenRouterCode({
        code,
        codeVerifier,
        fetchImpl: options.fetchImpl,
        exchangeUrl: options.exchangeUrl,
      });
      logger.info("OpenRouter sign-in completed");
      return result;
    } finally {
      if (activeFlow === callback) activeFlow = null;
      await callback.close();
    }
  }

  static async cancelActive(): Promise<void> {
    const flow = activeFlow;
    activeFlow = null;
    if (flow) await flow.close();
  }
}

/**
 * Settings after an OpenRouter sign-in. A first sign-in starts on the free-models router so a
 * new account with no credits can run a task; an account that already had a key keeps its model.
 */
export function applyOpenRouterOAuthKey(settings: LLMSettings, key: string): LLMSettings {
  const existing = settings.openrouter;
  const keepModel = Boolean(existing?.apiKey && existing.model);
  const model = keepModel && existing?.model ? existing.model : OPENROUTER_FREE_MODEL_ID;
  return {
    ...settings,
    providerType: "openrouter",
    modelKey: model,
    openrouter: {
      ...existing,
      apiKey: key,
      model,
      ...(keepModel ? {} : { strongModelKey: model, cheapModelKey: model }),
    },
    cachedOpenRouterModels: keepModel ? settings.cachedOpenRouterModels : undefined,
  };
}
