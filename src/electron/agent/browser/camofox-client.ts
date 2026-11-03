/**
 * Client for a Camofox browser server (github.com/jo-inc/camofox-browser) running on this
 * Mac. Camofox is a Firefox build that drives pages through a small REST API: one browser
 * context per `userId`, tabs inside it, and accessibility snapshots whose refs ("e12") the
 * action routes accept.
 *
 * The client only talks to a loopback origin resolved by camofox-settings.ts, never follows
 * redirects, and keeps bearer tokens out of every error it raises.
 */

import { Agent, fetch as undiciFetch } from "undici";

type FetchLike = typeof fetch;

// The app may install an environment-proxy dispatcher globally; requests to the loopback
// Camofox server (with its keys and cookies) must never go to such a proxy.
let directDispatcher: Agent | null = null;
function getDirectDispatcher(): Agent {
  if (!directDispatcher) directDispatcher = new Agent({ connect: { timeout: 10_000 } });
  return directDispatcher;
}

// The Agent must go to undici's own fetch: Node's global fetch bundles an older undici and
// rejects it ("invalid onRequestStart method"), so every request would fail as unreachable.
const directFetch: FetchLike = (input, init) =>
  undiciFetch(input as string, {
    ...(init as object),
    dispatcher: getDirectDispatcher(),
  }) as unknown as Promise<Response>;

/** Camofox opens only web pages; refuse anything else before it reaches the server. */
function assertWebUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CamofoxApiError("Camofox can only open http:// and https:// pages.", 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CamofoxApiError("Camofox can only open http:// and https:// pages.", 400);
  }
}

export interface CamofoxClientOptions {
  origin: string;
  /** CAMOFOX_ACCESS_KEY, sent on every request when set. */
  accessKey?: string;
  /** CAMOFOX_API_KEY, sent only to the cookie import route. */
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface CamofoxTab {
  tabId: string;
  url: string;
  title?: string;
}

export interface CamofoxNavigation {
  tabId: string;
  url: string;
  httpStatus?: number;
  navigationOk?: boolean;
}

export interface CamofoxSnapshot {
  url: string;
  snapshot: string;
  refsCount: number;
  truncated: boolean;
  totalChars?: number;
  hasMore?: boolean;
  nextOffset?: number;
}

export interface CamofoxCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export class CamofoxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CamofoxApiError";
  }
}

/** Tab-level failures after which the tab is gone and a new one is needed. */
const TAB_GONE_CODES = new Set([
  "browser_restarted",
  "page_crashed",
  "tab_destroyed",
  "tab_unresponsive",
  "session_expired",
]);

export function isCamofoxTabGone(error: unknown): boolean {
  if (!(error instanceof CamofoxApiError)) return false;
  return error.status === 404 || error.status === 410 || TAB_GONE_CODES.has(error.code || "");
}

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Camofox parses JSON bodies with a 100 kB limit. */
export const CAMOFOX_MAX_BODY_BYTES = 90 * 1024;
/** Camofox accepts at most 500 cookies per import request. */
export const CAMOFOX_MAX_COOKIES_PER_REQUEST = 500;

export function redactCamofoxText(value: string, secrets: Array<string | undefined>): string {
  let text = value.replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

export class CamofoxClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: CamofoxClientOptions) {
    this.fetchImpl = options.fetchImpl || directFetch;
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  async health(): Promise<{ ok: boolean; engine?: string; browserRunning?: boolean }> {
    return await this.json("GET", "/health");
  }

  /** True when the server refuses a request that carries no key (CAMOFOX_ACCESS_KEY is set). */
  async requiresAccessKey(): Promise<boolean> {
    try {
      await this.json("GET", "/tabs?userId=cowork-key-check", undefined, "");
      return false;
    } catch (error) {
      if (error instanceof CamofoxApiError && error.status === 401) return true;
      throw error;
    }
  }

  async createTab(userId: string, sessionKey: string, url: string): Promise<CamofoxNavigation> {
    assertWebUrl(url);
    return await this.json("POST", "/tabs", { userId, sessionKey, url });
  }

  async listTabs(userId: string): Promise<CamofoxTab[]> {
    const result = await this.json<{ tabs?: CamofoxTab[] }>(
      "GET",
      `/tabs?userId=${encodeURIComponent(userId)}`,
    );
    return Array.isArray(result.tabs) ? result.tabs : [];
  }

  async closeTab(userId: string, tabId: string): Promise<void> {
    await this.json(
      "DELETE",
      `/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(userId)}`,
    );
  }

  /**
   * Ends an identity and removes what Camofox saved of it. Camofox's persistence plugin writes
   * an identity's cookies to disk on cookie import and again when the session closes, so the
   * identity is reset through the plugin's route; without the plugin (404) nothing was saved.
   */
  async deleteSession(userId: string): Promise<void> {
    const id = encodeURIComponent(userId);
    try {
      await this.json("DELETE", `/sessions/${id}/storage_state`);
    } catch (error) {
      if (!(error instanceof CamofoxApiError) || error.status !== 404) throw error;
      await this.json("DELETE", `/sessions/${id}`);
    }
  }

  async navigate(userId: string, tabId: string, url: string): Promise<CamofoxNavigation> {
    assertWebUrl(url);
    return await this.tabAction(tabId, "navigate", { userId, url });
  }

  async history(
    userId: string,
    tabId: string,
    direction: "back" | "forward" | "refresh",
  ): Promise<{ url?: string }> {
    return await this.tabAction(tabId, direction, { userId });
  }

  async snapshot(userId: string, tabId: string, offset?: number): Promise<CamofoxSnapshot> {
    const query = new URLSearchParams({ userId });
    if (typeof offset === "number" && offset > 0) query.set("offset", String(Math.floor(offset)));
    return await this.json("GET", `/tabs/${encodeURIComponent(tabId)}/snapshot?${query}`);
  }

  async screenshot(userId: string, tabId: string, fullPage: boolean): Promise<Buffer> {
    const query = new URLSearchParams({ userId, fullPage: fullPage ? "true" : "false" });
    const response = await this.send(
      "GET",
      `/tabs/${encodeURIComponent(tabId)}/screenshot?${query}`,
    );
    const type = response.headers.get("content-type") || "";
    if (!type.startsWith("image/png")) {
      throw new CamofoxApiError("Camofox returned a screenshot that is not a PNG.", 502);
    }
    const bytes = await readLimited(response, MAX_SCREENSHOT_BYTES);
    return Buffer.from(bytes);
  }

  async click(
    userId: string,
    tabId: string,
    target: { ref?: string; selector?: string },
  ): Promise<{ url?: string }> {
    return await this.tabAction(tabId, "click", { userId, ...target });
  }

  async type(
    userId: string,
    tabId: string,
    input: {
      ref?: string;
      selector?: string;
      text: string;
      mode: "fill" | "keyboard";
      delay?: number;
      submit?: boolean;
    },
  ): Promise<void> {
    await this.tabAction(tabId, "type", { userId, ...input });
  }

  async press(userId: string, tabId: string, key: string): Promise<void> {
    await this.tabAction(tabId, "press", { userId, key });
  }

  async scroll(
    userId: string,
    tabId: string,
    direction: "up" | "down" | "left" | "right",
    amount: number,
  ): Promise<void> {
    await this.tabAction(tabId, "scroll", { userId, direction, amount });
  }

  async select(
    userId: string,
    tabId: string,
    input: { ref?: string; selector?: string; option: string },
  ): Promise<void> {
    await this.tabAction(tabId, "select", { userId, ...input });
  }

  async wait(userId: string, tabId: string, timeoutMs: number): Promise<{ ready?: boolean }> {
    return await this.tabAction(tabId, "wait", { userId, timeout: timeoutMs });
  }

  async evaluate(userId: string, tabId: string, expression: string): Promise<unknown> {
    const result = await this.tabAction<{ result?: unknown }>(tabId, "evaluate", {
      userId,
      expression,
    });
    return result.result;
  }

  /** Sends cookies in requests Camofox accepts (count and body size); returns how many it took. */
  async importCookies(userId: string, cookies: CamofoxCookie[]): Promise<number> {
    let imported = 0;
    for (const batch of batchCookies(cookies)) {
      let result: { count?: number };
      try {
        result = await this.json<{ count?: number }>(
          "POST",
          `/sessions/${encodeURIComponent(userId)}/cookies`,
          { cookies: batch },
          this.options.apiKey,
        );
      } catch (error) {
        // Camofox may echo a rejected cookie in its error, and the message reaches the model.
        if (error instanceof CamofoxApiError && error.status >= 400 && error.status !== 401) {
          throw new CamofoxApiError(
            `Camofox did not accept the saved cookies (HTTP ${error.status}).`,
            error.status,
            error.code,
            error.retryable,
          );
        }
        throw error;
      }
      imported += typeof result.count === "number" ? result.count : batch.length;
    }
    return imported;
  }

  private async tabAction<T = Record<string, unknown>>(
    tabId: string,
    action: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    return await this.json("POST", `/tabs/${encodeURIComponent(tabId)}/${action}`, body);
  }

  private async json<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    bearer?: string,
  ): Promise<T> {
    const response = await this.send(method, path, body, bearer);
    const text = new TextDecoder().decode(await readLimited(response, MAX_JSON_BYTES));
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CamofoxApiError("Camofox returned a response that is not JSON.", 502);
    }
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    bearer?: string,
  ): Promise<Response> {
    // An empty string sends no key at all (requiresAccessKey).
    const token = bearer === "" ? undefined : (bearer ?? this.options.accessKey);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CamofoxApiError(
        `Camofox is not reachable at ${this.options.origin} (${this.redact(reason)}). ` +
          "Start the Camofox server, or check Settings > Browser > Camofox.",
        0,
        "unreachable",
        true,
      );
    }
    if (response.ok) return response;
    let message = `Camofox request failed with HTTP ${response.status}`;
    let code: string | undefined;
    let retryable = false;
    try {
      const text = new TextDecoder().decode(await readLimited(response, 64 * 1024));
      const parsed = JSON.parse(text) as { error?: unknown; code?: unknown; retryable?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        // Redact first: a key cut in half by the slice would no longer match.
        message = `Camofox: ${this.redact(parsed.error.trim()).slice(0, 400)}`;
      }
      if (typeof parsed.code === "string") code = parsed.code;
      retryable = parsed.retryable === true;
    } catch {
      // Keep the status-only message.
    }
    if (response.status === 401) {
      message = "Camofox refused the request: set its access key in Settings > Browser > Camofox.";
    }
    throw new CamofoxApiError(this.redact(message), response.status, code, retryable);
  }

  private redact(text: string): string {
    return redactCamofoxText(text, [this.options.accessKey, this.options.apiKey]);
  }
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new CamofoxApiError("Camofox response is too large.", 502);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new CamofoxApiError("Camofox response is too large.", 502);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Splits cookies so no request passes Camofox's per-request count or body size. */
export function batchCookies(cookies: CamofoxCookie[]): CamofoxCookie[][] {
  const batches: CamofoxCookie[][] = [];
  let current: CamofoxCookie[] = [];
  let size = 16;
  for (const cookie of cookies) {
    const cookieSize = Buffer.byteLength(JSON.stringify(cookie)) + 1;
    if (cookieSize + 16 > CAMOFOX_MAX_BODY_BYTES) continue;
    if (
      current.length >= CAMOFOX_MAX_COOKIES_PER_REQUEST ||
      size + cookieSize > CAMOFOX_MAX_BODY_BYTES
    ) {
      batches.push(current);
      current = [];
      size = 16;
    }
    current.push(cookie);
    size += cookieSize;
  }
  if (current.length) batches.push(current);
  return batches;
}
