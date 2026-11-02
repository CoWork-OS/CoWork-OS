/**
 * One task's use of the Camofox browser provider.
 *
 * BrowserTools hands browser_* calls here once the agent opens a page with
 * `browser_provider: "camofox"`, until browser_close. Every new tab first loads a check page
 * that only CoWork's policy proxy can serve (camofox-policy-proxy.ts); a Camofox server that
 * is not sending its traffic through that proxy is refused before it opens anything else.
 */

import { createHash, randomBytes } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { CookieSetDetails } from "../../browser/credentials/cookie-import";
import {
  CamofoxApiError,
  CamofoxClient,
  isCamofoxTabGone,
  type CamofoxCookie,
} from "./camofox-client";
import { isPrivateOrLocalBrowserTarget } from "./browser-use-cloud-client";
import type { CamofoxPolicyProxy, CamofoxProxyLease } from "./camofox-policy-proxy";
import type { CamofoxSettings } from "./camofox-settings";
import { camofoxStartCommand, type CamofoxConnectionResult } from "../../../shared/camofox";

// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Any = any;

export const CAMOFOX_PROVIDER = "camofox";

/** Browser tools Camofox can carry out; the rest are refused while it is active. */
export const CAMOFOX_SUPPORTED_TOOLS: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_get_content",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_select",
  "browser_wait",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_screenshot",
  "browser_evaluate",
  "browser_tabs",
  "browser_new_tab",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_close",
]);

export interface CamofoxSessionContext {
  taskId: string;
  /** Identity scope: the workspace id, prefixed for a bot so it never shares the user's. */
  identityScope: string;
  /** False for bots: they never receive the user's saved cookies. */
  mayUseSavedCookies: boolean;
  /** Network policy for one request Camofox makes (sync; throws to refuse). */
  assertRequestAllowed: (url: string) => void;
  /** Policy check for a URL the agent asked to open; returns the normalized URL. */
  preflightNavigation: (url: unknown) => Promise<string>;
  /** Saved cookies from the vault that apply to this host (main process only). */
  savedCookiesForHost: (host: string) => CookieSetDetails[];
  /** Asks the user before saved cookies go to Camofox. */
  approveSavedCookies: (host: string, count: number) => Promise<boolean>;
  resolveScreenshotPath: (
    filename: unknown,
  ) => Promise<{ absolutePath: string; relativePath: string }>;
  registerScreenshot: (absolutePath: string, relativePath: string) => Promise<void>;
  logEvent: (payload: Record<string, unknown>) => void;
}

export class CamofoxProxyCheckError extends Error {
  constructor(
    message: string,
    readonly startCommand: string,
  ) {
    super(message);
    this.name = "CamofoxProxyCheckError";
  }
}

function hash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readTarget(input: Any): { ref?: string; selector?: string } | null {
  const ref = readString(input?.ref);
  if (ref) return { ref };
  const selector = readString(input?.selector);
  if (selector) return { selector };
  return null;
}

/** Camofox evaluates an expression; agents often send a function body with `return`. */
function toExpression(script: string): string {
  const trimmed = script.trim();
  if (/(?:^|[\n;])\s*return\b/.test(trimmed)) return `(async () => {\n${trimmed}\n})()`;
  return trimmed;
}

// Second-level labels under which country domains register names (example.co.uk).
const SHARED_SECOND_LEVEL = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "edu",
  "ac",
  "or",
  "ne",
  "go",
]);

/**
 * A rough public-suffix test with no suffix list: a cookie set for "uk" or "co.uk" would
 * sign in to every site under it, and browsers never store one, so it is never sent.
 */
export function looksLikePublicSuffix(domain: string): boolean {
  const labels = domain.replace(/^\./, "").toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 1) return true;
  return labels.length === 2 && labels[1].length === 2 && SHARED_SECOND_LEVEL.has(labels[0]);
}

export function toCamofoxCookie(cookie: CookieSetDetails): CamofoxCookie | null {
  let domain = cookie.domain;
  if (!domain) {
    try {
      domain = new URL(cookie.url).hostname;
    } catch {
      return null;
    }
  }
  const sameSite =
    cookie.sameSite === "lax"
      ? "Lax"
      : cookie.sameSite === "strict"
        ? "Strict"
        : cookie.sameSite === "no_restriction"
          ? "None"
          : undefined;
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: cookie.path || "/",
    expires: typeof cookie.expirationDate === "number" ? Math.floor(cookie.expirationDate) : -1,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(sameSite ? { sameSite } : {}),
  };
}

/**
 * Opens a Camofox tab on a page only CoWork's policy proxy can serve and confirms the page
 * carries the proxy's one-time token. Throws CamofoxProxyCheckError when it does not, after
 * closing the tab. The caller must hold a proxy lease.
 */
export async function openCheckedCamofoxTab(
  client: CamofoxClient,
  proxy: CamofoxPolicyProxy,
  userId: string,
  sessionKey: string,
  startCommand: string,
): Promise<string> {
  const failed = () =>
    new CamofoxProxyCheckError(
      "Camofox is not sending its traffic through CoWork's network-policy proxy, so CoWork " +
        `will not use it. Restart Camofox with: ${startCommand}`,
      startCommand,
    );
  // Without CAMOFOX_ACCESS_KEY any local process could drive the sessions CoWork signs in.
  if (!(await client.requiresAccessKey())) {
    throw new CamofoxProxyCheckError(
      "Camofox is running without an access key, so CoWork will not use it. Restart it " +
        `with CAMOFOX_ACCESS_KEY set to the key saved in Settings > Browser > Camofox: ${startCommand}`,
      startCommand,
    );
  }
  const check = proxy.issueCheck();
  let tabId: string | null = null;
  try {
    let opened;
    try {
      opened = await client.createTab(userId, sessionKey, check.url);
    } catch (error) {
      if (
        error instanceof CamofoxApiError &&
        (error.code === "unreachable" || error.status === 401)
      )
        throw error;
      throw failed();
    }
    tabId = opened.tabId;
    if (!tabId) throw failed();
    const snapshot = await client.snapshot(userId, tabId);
    if (opened.navigationOk === false || !String(snapshot.snapshot || "").includes(check.token)) {
      throw failed();
    }
    return tabId;
  } catch (error) {
    if (tabId) await client.closeTab(userId, tabId).catch(() => {});
    throw error;
  } finally {
    check.done();
  }
}

/**
 * Settings > Browser > Camofox "Check": the server answers, and its traffic goes through
 * CoWork's policy proxy. Uses a throwaway identity that is deleted afterwards.
 */
export async function checkCamofoxConnection(
  settings: CamofoxSettings & { origin: string },
  client: CamofoxClient,
  proxy: CamofoxPolicyProxy,
  assertRequestAllowed: (url: string) => void,
): Promise<CamofoxConnectionResult> {
  const startCommand = camofoxStartCommand(settings.serverUrl, settings.proxyPort);
  try {
    await client.health();
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
      startCommand,
    };
  }
  const userId = `cowork-check-${randomBytes(6).toString("hex")}`;
  let lease: CamofoxProxyLease | null = null;
  try {
    lease = await proxy.acquire(settings.proxyPort, userId, assertRequestAllowed);
    const tabId = await openCheckedCamofoxTab(client, proxy, userId, userId, startCommand);
    await client.closeTab(userId, tabId).catch(() => {});
    return { reachable: true, proxied: true };
  } catch (error) {
    return {
      reachable: true,
      proxied: false,
      error: error instanceof Error ? error.message : String(error),
      startCommand,
    };
  } finally {
    await client.deleteSession(userId).catch(() => {});
    await lease?.release();
  }
}

export class CamofoxBrowserSession {
  private lease: CamofoxProxyLease | null = null;
  private readonly userId: string;
  private readonly sessionKey: string;
  private tabs: string[] = [];
  private activeTabId: string | null = null;
  private lastUrl = "";
  private readonly startCommand: string;
  /** The current call's check, run right before anything that changes the page. */
  private beforeEffect: () => Promise<void> = async () => {};

  constructor(
    private readonly settings: CamofoxSettings & { origin: string },
    private readonly client: CamofoxClient,
    private readonly proxy: CamofoxPolicyProxy,
    private readonly ctx: CamofoxSessionContext,
  ) {
    // A persistent identity is one Camofox context per workspace; otherwise a fresh one per task.
    this.userId = settings.persistentIdentity
      ? `cowork-${hash(ctx.identityScope, 20)}`
      : `cowork-task-${hash(ctx.taskId, 12)}-${randomBytes(4).toString("hex")}`;
    this.sessionKey = `cowork-${hash(ctx.taskId, 12)}`;
    this.startCommand = camofoxStartCommand(settings.serverUrl, settings.proxyPort);
  }

  /** The page Camofox last reported, for keying per-site approvals. */
  get currentUrl(): string {
    return this.lastUrl;
  }

  /** True while this task has Camofox open; browser tools route here until browser_close. */
  get active(): boolean {
    return Boolean(this.lease);
  }

  async execute(
    toolName: string,
    input: Any,
    beforeEffect: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    this.beforeEffect = beforeEffect;
    if (!CAMOFOX_SUPPORTED_TOOLS.has(toolName)) {
      return this.fail(
        `${toolName} is not available while the Camofox browser is in use. Use browser_snapshot ` +
          "refs with browser_click, browser_fill, browser_type, browser_press, browser_scroll or " +
          "browser_select, or call browser_close to go back to the in-app browser.",
      );
    }
    try {
      return await this.run(toolName, input);
    } catch (error) {
      if (error instanceof CamofoxProxyCheckError) {
        return {
          ...this.fail(error.message),
          setupRequired: true,
          startCommand: error.startCommand,
        };
      }
      if (isCamofoxTabGone(error)) {
        // The server may have restarted; every tab is opened (and checked) again.
        this.tabs = [];
        this.activeTabId = null;
        return this.fail(
          `${error instanceof Error ? error.message : String(error)} The Camofox tab is gone; ` +
            "call browser_navigate to open a new one.",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...this.fail(
          /proxy|NS_ERROR_/i.test(message)
            ? `${message} (CoWork's network policy may have refused this address.)`
            : message,
        ),
        ...(error instanceof CamofoxApiError && error.retryable ? { retryable: true } : {}),
      };
    }
  }

  /** Closes this task's tabs, ends a per-task identity and stops proxying for this task. */
  async close(): Promise<void> {
    const tabs = [...this.tabs];
    this.tabs = [];
    this.activeTabId = null;
    try {
      if (!this.settings.persistentIdentity) {
        await this.client.deleteSession(this.userId).catch(() => {});
      } else {
        for (const tabId of tabs) await this.client.closeTab(this.userId, tabId).catch(() => {});
      }
    } finally {
      const lease = this.lease;
      this.lease = null;
      await lease?.release();
    }
  }

  private async run(toolName: string, input: Any): Promise<Record<string, unknown>> {
    switch (toolName) {
      case "browser_navigate": {
        const url = await this.preflightWebUrl(input?.url);
        if (typeof url !== "string") return url;
        await this.ensureLease();
        await this.beforeEffect();
        // Saved cookies only go to a Camofox that has just proved it browses through the
        // policy proxy, so they are loaded into a freshly checked tab.
        const useSavedCookies = input?.use_saved_cookies === true;
        if (useSavedCookies && !this.ctx.mayUseSavedCookies) {
          return this.fail("Saved cookies belong to the user and are not available to a bot.");
        }
        if (!this.activeTabId || useSavedCookies) await this.openTab();
        let cookiesLoaded: number | undefined;
        if (useSavedCookies) {
          const loaded = await this.loadSavedCookies(url);
          if (typeof loaded === "string") return this.fail(loaded);
          cookiesLoaded = loaded;
          await this.beforeEffect();
        }
        const result = await this.client.navigate(this.userId, this.activeTabId!, url);
        this.noteUrl(result.url);
        this.ctx.logEvent({
          action: "navigate",
          url: result.url,
          browserProvider: CAMOFOX_PROVIDER,
        });
        const base = {
          browserProvider: CAMOFOX_PROVIDER,
          tabId: this.activeTabId,
          url: result.url,
          status: result.httpStatus,
          ...(cookiesLoaded !== undefined ? { savedCookiesLoaded: cookiesLoaded } : {}),
        };
        if (result.navigationOk === false) {
          return {
            success: false,
            error: `Navigation failed with ${typeof result.httpStatus === "number" ? `HTTP ${result.httpStatus}` : "an unknown HTTP status"}`,
            ...base,
          };
        }
        return {
          success: true,
          ...base,
          message:
            "Opened in Camofox. Later browser tools use Camofox until browser_close. Call " +
            "browser_snapshot for element refs (like e12).",
        };
      }
      case "browser_new_tab": {
        let url: string | null = null;
        if (readString(input?.url)) {
          const checked = await this.preflightWebUrl(input.url);
          if (typeof checked !== "string") return checked;
          url = checked;
        }
        await this.ensureLease();
        await this.beforeEffect();
        await this.openTab();
        const result = url
          ? await this.client.navigate(this.userId, this.activeTabId!, url)
          : { url: "about:blank" };
        this.noteUrl(result.url);
        return {
          success: true,
          browserProvider: CAMOFOX_PROVIDER,
          tabId: this.activeTabId,
          url: result.url,
        };
      }
      case "browser_tabs": {
        const known = new Set(this.tabs);
        const tabs = (await this.client.listTabs(this.userId)).filter((tab) =>
          known.has(tab.tabId),
        );
        return {
          success: true,
          browserProvider: CAMOFOX_PROVIDER,
          tabs: tabs.map((tab) => ({
            tabId: tab.tabId,
            url: tab.url,
            title: tab.title,
            active: tab.tabId === this.activeTabId,
          })),
        };
      }
      case "browser_switch_tab": {
        const tabId = readString(input?.tab_id);
        if (!this.tabs.includes(tabId))
          return this.fail("Unknown Camofox tab id; call browser_tabs.");
        this.activeTabId = tabId;
        return { success: true, browserProvider: CAMOFOX_PROVIDER, tabId };
      }
      case "browser_close_tab": {
        const tabId = readString(input?.tab_id) || this.activeTabId;
        if (!tabId || !this.tabs.includes(tabId)) return this.fail("No Camofox tab to close.");
        await this.client.closeTab(this.userId, tabId).catch(() => {});
        this.forgetTab(tabId);
        return {
          success: true,
          browserProvider: CAMOFOX_PROVIDER,
          closedTabId: tabId,
          activeTabId: this.activeTabId,
        };
      }
      case "browser_close": {
        await this.close();
        this.ctx.logEvent({ action: "close", browserProvider: CAMOFOX_PROVIDER });
        return { success: true, browserProvider: CAMOFOX_PROVIDER };
      }
    }

    const tabId = this.activeTabId;
    if (!tabId) return this.fail("No Camofox tab is open; call browser_navigate first.");
    switch (toolName) {
      case "browser_snapshot": {
        const snapshot = await this.client.snapshot(
          this.userId,
          tabId,
          typeof input?.offset === "number" ? input.offset : undefined,
        );
        this.noteUrl(snapshot.url);
        return {
          success: true,
          browserProvider: CAMOFOX_PROVIDER,
          tabId,
          url: snapshot.url,
          snapshot: snapshot.snapshot,
          refsCount: snapshot.refsCount,
          truncated: snapshot.truncated === true,
          ...(snapshot.hasMore ? { nextOffset: snapshot.nextOffset } : {}),
          refSupport: true,
          message:
            "Refs look like [e12]. Pass the ref (without brackets) to browser_click, browser_fill, " +
            "browser_type or browser_select. Refs reset after the page changes; snapshot again.",
        };
      }
      case "browser_get_content": {
        const snapshot = await this.client.snapshot(
          this.userId,
          tabId,
          typeof input?.offset === "number" ? input.offset : undefined,
        );
        this.noteUrl(snapshot.url);
        return {
          success: true,
          browserProvider: CAMOFOX_PROVIDER,
          url: snapshot.url,
          text: snapshot.snapshot,
          truncated: snapshot.truncated === true,
          ...(snapshot.hasMore ? { nextOffset: snapshot.nextOffset } : {}),
        };
      }
      case "browser_click": {
        const target = readTarget(input);
        if (!target) return this.fail("ref or selector is required");
        await this.beforeEffect();
        const result = await this.client.click(this.userId, tabId, target);
        this.ctx.logEvent({ action: "click", browserProvider: CAMOFOX_PROVIDER });
        this.noteUrl(result.url);
        return { success: true, browserProvider: CAMOFOX_PROVIDER, url: result.url };
      }
      case "browser_fill": {
        const target = readTarget(input);
        if (!target) return this.fail("ref or selector is required");
        if (typeof input?.value !== "string") return this.fail("value is required");
        await this.beforeEffect();
        await this.client.type(this.userId, tabId, { ...target, text: input.value, mode: "fill" });
        return { success: true, browserProvider: CAMOFOX_PROVIDER };
      }
      case "browser_type": {
        if (typeof input?.text !== "string") return this.fail("text is required");
        const target = readTarget(input);
        await this.beforeEffect();
        // Keyboard mode types into the focused element, so focus the target first.
        if (target) await this.client.click(this.userId, tabId, target);
        await this.client.type(this.userId, tabId, {
          text: input.text,
          mode: "keyboard",
          delay: typeof input?.delay === "number" ? Math.max(0, Math.min(500, input.delay)) : 50,
        });
        return { success: true, browserProvider: CAMOFOX_PROVIDER };
      }
      case "browser_press": {
        const key = readString(input?.key);
        if (!key) return this.fail("key is required");
        await this.beforeEffect();
        await this.client.press(this.userId, tabId, key);
        return { success: true, browserProvider: CAMOFOX_PROVIDER };
      }
      case "browser_scroll": {
        const direction = readString(input?.direction);
        await this.beforeEffect();
        if (direction === "top" || direction === "bottom") {
          await this.client.press(this.userId, tabId, direction === "top" ? "Home" : "End");
        } else if (direction === "up" || direction === "down") {
          const amount =
            typeof input?.amount === "number" && Number.isFinite(input.amount)
              ? Math.max(1, Math.min(10_000, Math.round(input.amount)))
              : 500;
          await this.client.scroll(this.userId, tabId, direction, amount);
        } else {
          return this.fail("direction must be up, down, top or bottom");
        }
        return { success: true, browserProvider: CAMOFOX_PROVIDER };
      }
      case "browser_select": {
        const target = readTarget(input);
        const option = readString(input?.value);
        if (!target || !option) return this.fail("selector (or ref) and value are required");
        await this.beforeEffect();
        await this.client.select(this.userId, tabId, { ...target, option });
        return { success: true, browserProvider: CAMOFOX_PROVIDER };
      }
      case "browser_wait": {
        const timeout =
          typeof input?.timeout === "number" && Number.isFinite(input.timeout)
            ? Math.max(100, Math.min(30_000, Math.round(input.timeout)))
            : 10_000;
        const result = await this.client.wait(this.userId, tabId, timeout);
        return {
          success: true,
          browserProvider: CAMOFOX_PROVIDER,
          ready: result.ready === true,
          message:
            "Camofox waits for the page to settle; it cannot wait for a selector. Call " +
            "browser_snapshot to check for the element.",
        };
      }
      case "browser_back":
      case "browser_forward":
      case "browser_reload": {
        await this.beforeEffect();
        const direction =
          toolName === "browser_back"
            ? "back"
            : toolName === "browser_forward"
              ? "forward"
              : "refresh";
        const result = await this.client.history(this.userId, tabId, direction);
        this.noteUrl(result.url);
        return { success: true, browserProvider: CAMOFOX_PROVIDER, url: result.url };
      }
      case "browser_screenshot": {
        const output = await this.ctx.resolveScreenshotPath(input?.filename);
        await this.beforeEffect();
        const png = await this.client.screenshot(this.userId, tabId, input?.full_page === true);
        await fs.mkdir(path.dirname(output.absolutePath), { recursive: true });
        await fs.writeFile(output.absolutePath, png);
        await this.ctx.registerScreenshot(output.absolutePath, output.relativePath);
        return { success: true, browserProvider: CAMOFOX_PROVIDER, path: output.relativePath };
      }
      case "browser_evaluate": {
        const script = readString(input?.script);
        if (!script) return this.fail("script is required");
        await this.beforeEffect();
        const result = await this.client.evaluate(this.userId, tabId, toExpression(script));
        return { success: true, browserProvider: CAMOFOX_PROVIDER, result };
      }
    }
    throw new Error(`Unknown browser tool: ${toolName}`);
  }

  private async ensureLease(): Promise<void> {
    if (this.lease) return;
    this.lease = await this.proxy.acquire(
      this.settings.proxyPort,
      `${this.ctx.taskId}:${this.userId}`,
      this.ctx.assertRequestAllowed,
    );
  }

  /** Opens a tab that first proves Camofox browses through CoWork's proxy, then goes to `url`. */
  private async openTab(): Promise<void> {
    const tabId = await openCheckedCamofoxTab(
      this.client,
      this.proxy,
      this.userId,
      this.sessionKey,
      this.startCommand,
    );
    this.tabs.push(tabId);
    this.activeTabId = tabId;
  }

  /** The URL as the agent may open it in Camofox, or a failed result saying why not. */
  private async preflightWebUrl(raw: unknown): Promise<string | Record<string, unknown>> {
    const url = await this.ctx.preflightNavigation(raw);
    if (!/^https?:\/\//i.test(url)) {
      return this.fail("Camofox can only open http:// and https:// pages.");
    }
    if (isPrivateOrLocalBrowserTarget(url)) {
      return this.fail(
        "Camofox only opens public websites. Use the in-app browser for local or private addresses.",
      );
    }
    return url;
  }

  private noteUrl(url: unknown): void {
    if (typeof url === "string" && url) this.lastUrl = url;
  }

  private async loadSavedCookies(url: string): Promise<number | string> {
    const host = new URL(url).hostname.toLowerCase();
    const cookies = this.ctx
      .savedCookiesForHost(host)
      .map(toCamofoxCookie)
      .filter(
        (cookie): cookie is CamofoxCookie =>
          Boolean(cookie) && !looksLikePublicSuffix((cookie as CamofoxCookie).domain),
      );
    if (cookies.length === 0) return 0;
    const approved = await this.ctx.approveSavedCookies(host, cookies.length);
    if (!approved) return `The user did not allow loading saved cookies for ${host}.`;
    await this.beforeEffect();
    const imported = await this.client.importCookies(this.userId, cookies);
    for (const cookie of cookies) cookie.value = "";
    this.ctx.logEvent({
      action: "camofox_saved_cookies",
      host,
      count: imported,
      browserProvider: CAMOFOX_PROVIDER,
    });
    return imported;
  }

  private forgetTab(tabId: string | null): void {
    if (!tabId) return;
    this.tabs = this.tabs.filter((id) => id !== tabId);
    if (this.activeTabId === tabId) this.activeTabId = this.tabs[this.tabs.length - 1] ?? null;
  }

  private fail(error: string): Record<string, unknown> {
    return { success: false, error, browserProvider: CAMOFOX_PROVIDER };
  }
}
