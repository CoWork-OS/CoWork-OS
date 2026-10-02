import { chromium, Browser, Page, BrowserContext, Locator, ElementHandle } from "playwright";
import * as path from "path";
import * as fs from "fs/promises";
import { Workspace } from "../../../shared/types";
import { normalizeBrowserUrl } from "../../browser/browser-session-manager";
import { evaluateNetworkPolicy } from "../../security/network-policy";
import {
  assertWorkspaceFilesystemAccess,
  type WorkspaceFilesystemAccessOptions,
} from "../../security/access-profile-paths";
import { createLogger } from "../../utils/logger";

const log = createLogger("BrowserService");

/**
 * Consent auto-dismissal only ever acts inside these consent-manager (CMP) containers, or inside
 * a dialog whose text is about cookies/consent. Anything else on the page is never clicked.
 */
const CONSENT_MANAGER_CONTAINER_SELECTORS = [
  "#onetrust-banner-sdk",
  "#onetrust-consent-sdk",
  "#CybotCookiebotDialog",
  "#didomi-host",
  ".qc-cmp2-container",
  "#usercentrics-root",
  "#truste-consent-track",
  ".cc-window",
];
const CONSENT_DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"]';
const CONSENT_DIALOG_TEXT_PATTERN = /\b(?:cookies?|consent|gdpr)\b|privacy choices/i;
// Buttons only: links inside a banner usually lead to policy pages, never to a consent choice.
const CONSENT_BUTTON_SELECTOR =
  'button, [role="button"], input[type="button"], input[type="submit"]';
// Exact accessible names (case-insensitive, trailing punctuation ignored). Reject or
// necessary-only choices win over accept-all so the agent never grants more than needed.
const CONSENT_REJECT_BUTTON_NAMES = new Set([
  "reject all",
  "reject all cookies",
  "reject",
  "reject cookies",
  "decline",
  "decline all",
  "decline cookies",
  "deny",
  "deny all",
  "refuse all",
  "disagree",
  "disagree and close",
  "continue without accepting",
  "continue without agreeing",
  "only necessary",
  "only necessary cookies",
  "necessary only",
  "necessary cookies only",
  "use necessary cookies only",
  "only essential cookies",
  "essential cookies only",
  "accept only essential cookies",
  "accept necessary cookies",
  "required only",
  "rejeitar tudo",
  "recusar tudo",
  "alle ablehnen",
  "ablehnen",
  "nur notwendige cookies",
  "tout refuser",
  "continuer sans accepter",
  "rechazar todo",
  "rifiuta tutto",
]);
const CONSENT_ACCEPT_BUTTON_NAMES = new Set([
  "accept all",
  "accept all cookies",
  "accept",
  "accept cookies",
  "accept and close",
  "allow all",
  "allow all cookies",
  "allow cookies",
  "i agree",
  "agree",
  "agree and close",
  "i accept",
  "yes, i agree",
  "got it",
  "ok",
  "aceitar tudo",
  "alle akzeptieren",
  "akzeptieren",
  "tout accepter",
  "accepter",
  "aceptar todo",
  "aceptar",
  "accetta tutto",
  "accetto",
]);
const MAX_CONSENT_DIALOGS = 10;
const MAX_CONSENT_BUTTONS_PER_CONTAINER = 40;

function normalizeConsentButtonName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "")
    .toLowerCase();
}

/** 0 = reject / necessary-only, 1 = accept, -1 = not a consent choice. */
function rankConsentButtonName(name: string): number {
  if (CONSENT_REJECT_BUTTON_NAMES.has(name)) return 0;
  if (CONSENT_ACCEPT_BUTTON_NAMES.has(name)) return 1;
  return -1;
}

export interface BrowserOptions {
  headless?: boolean;
  timeout?: number;
  viewport?: { width: number; height: number };
  /**
   * If set, Playwright will use a persistent browser context rooted at this directory
   * (cookies/storage survive across tasks and restarts).
   *
   * WARNING: This can contain sensitive auth state.
   */
  userDataDir?: string;
  /**
   * Which Chromium channel to use. "chromium" uses Playwright's bundled Chromium.
   * "chrome" uses the system-installed Google Chrome (if available).
   * "brave" uses a locally installed Brave executable (auto-discovered or BRAVE_PATH).
   */
  channel?: "chromium" | "chrome" | "brave";
  /**
   * Chrome DevTools Protocol endpoint for attaching to an existing Chrome instance.
   * Use when you want to control a signed-in browser session. Enable remote debugging:
   * - Launch Chrome with --remote-debugging-port=9222
   * - Or visit chrome://inspect/#devices and enable "Discover USB devices" / remote targets
   * - Endpoint is typically http://localhost:9222 or the WebSocket URL from the version endpoint
   */
  debuggerUrl?: string;
}

export interface ConsentDismissal {
  /** "clicked" a consent button, or "removed" a CMP banner that offered no recognised choice */
  action: "clicked" | "removed";
  /** Accessible name of the clicked button */
  text?: string;
  /** Consent-manager container the action was limited to */
  container: string;
}

export interface NavigateResult {
  url: string;
  title: string;
  status: number | null;
  /** True if status code indicates an error (4xx or 5xx) */
  isError?: boolean;
  /** Present when a cookie-consent banner was dismissed after navigation */
  consentDismissed?: ConsentDismissal;
}

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
}

export interface ElementInfo {
  tag: string;
  text: string;
  href?: string;
  src?: string;
  value?: string;
  placeholder?: string;
}

export interface PageContent {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; method: string; inputs: string[] }>;
}

export interface ClickResult {
  success: boolean;
  element?: string;
  error?: string;
  screenshot?: string;
  url?: string;
  content?: string;
}

export interface FillResult {
  success: boolean;
  selector: string;
  value: string;
  error?: string;
  screenshot?: string;
  url?: string;
  content?: string;
}

export interface EvaluateResult {
  success: boolean;
  result: Any;
}

function normalizeEvaluateScript(script: string): string {
  const trimmed = String(script || "").trim();
  if (!trimmed) return "";

  // LLMs frequently send multi-line snippets with top-level "return".
  if (/(?:^|[\n;])\s*return\b/.test(trimmed)) {
    if (/\bawait\b/.test(trimmed)) {
      return `(async () => {\n${trimmed}\n})()`;
    }
    return `(() => {\n${trimmed}\n})()`;
  }

  return trimmed;
}

/**
 * BrowserService provides browser automation capabilities using Playwright
 */
export class BrowserService {
  private static readonly DEFAULT_ACTION_TIMEOUT_MS = 90_000;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private workspace: Workspace;
  private options: BrowserOptions;
  private isAttached = false;
  private configuredPages = new WeakSet<object>();

  constructor(workspace: Workspace, options: BrowserOptions = {}) {
    this.workspace = workspace;
    this.options = {
      headless: options.headless ?? true,
      timeout: options.timeout ?? BrowserService.DEFAULT_ACTION_TIMEOUT_MS,
      viewport: options.viewport ?? { width: 1280, height: 720 },
      userDataDir: options.userDataDir,
      channel: options.channel,
      debuggerUrl: options.debuggerUrl,
    };
  }

  private getActionTimeout(timeoutMs?: number): number {
    const fallback = this.options.timeout ?? BrowserService.DEFAULT_ACTION_TIMEOUT_MS;
    const normalized = Number(timeoutMs);
    if (!Number.isFinite(normalized) || normalized <= 0) return fallback;
    return Math.round(normalized);
  }

  private assertNetworkUrlAllowed(rawUrl: string, toolName = "browser_navigate"): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid browser URL: "${rawUrl}"`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `Browser network policy only permits http:// and https:// targets, not ${parsed.protocol}`,
      );
    }

    const decision = evaluateNetworkPolicy({
      url: parsed.toString(),
      toolName,
      networkEnabled: this.workspace.permissions?.network,
      accessNetworkMode: this.workspace.permissions?.accessNetworkMode,
      profileDomainRules: this.workspace.permissions?.accessDomainRules,
    });
    if (decision.action !== "allow") {
      throw new Error(`Network access denied for "${parsed.toString()}": ${decision.reason}`);
    }
  }

  private assertPageUrlAllowed(url: string): void {
    if (!url || url === "about:blank") return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid current browser URL: "${url}"`);
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      this.assertNetworkUrlAllowed(url, "browser_session");
      return;
    }
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return;
    throw new Error(`Browser access denied for unsupported page scheme ${parsed.protocol}`);
  }

  private async configurePage(page: Page): Promise<void> {
    if (this.configuredPages.has(page as object)) return;
    this.configuredPages.add(page as object);

    // Some unit-test adapters and older Playwright-compatible clients do not
    // expose request interception. Navigation is still checked below; avoid
    // turning that compatibility gap into a runtime crash.
    if (typeof (page as Any).route !== "function") return;

    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      let parsed: URL;
      try {
        parsed = new URL(requestUrl);
      } catch {
        await route.abort("blockedbyclient").catch(() => {});
        return;
      }
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        try {
          this.assertNetworkUrlAllowed(requestUrl, "browser_request");
        } catch {
          await route.abort("blockedbyclient").catch(() => {});
          return;
        }
      } else if (
        parsed.protocol !== "data:" &&
        parsed.protocol !== "blob:" &&
        parsed.protocol !== "about:"
      ) {
        await route.abort("blockedbyclient").catch(() => {});
        return;
      }
      await route.continue().catch(() => {});
    });
  }

  private configureContext(context: BrowserContext): void {
    if (typeof (context as Any).on !== "function") return;
    context.on("page", (page: Page) => {
      void this.configurePage(page).catch(() => {
        // Navigation and current-page checks remain authoritative if request
        // interception cannot be installed on a newly opened page.
      });
    });
  }

  private isRetryableBrowserError(error: unknown): boolean {
    const message = String((error as Error)?.message || error || "").toLowerCase();
    const retryable = [
      "timeout",
      "not visible",
      "not found",
      "detached",
      "stale",
      "element is not attached",
      "not attached",
      "not stable",
      "interception",
      "click",
      "fill",
    ];

    return retryable.some((token) => message.includes(token));
  }

  private async runLocatorActionWithRetry<T>(
    selector: string,
    timeoutMs: number | undefined,
    operation: (locator: Locator, timeout: number) => Promise<T>,
  ): Promise<T> {
    const baseTimeout = this.getActionTimeout(timeoutMs);
    const attempts = 2;
    const perAttemptTimeout = Math.max(5_000, Math.floor(baseTimeout / attempts));
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const locator = this.page!.locator(selector);
        await locator.waitFor({ state: "visible", timeout: perAttemptTimeout });
        await locator.scrollIntoViewIfNeeded();
        if (attempt > 0) {
          await this.page!.waitForTimeout(200).catch(() => {});
        }
        return await operation(locator, perAttemptTimeout);
      } catch (error) {
        lastError = error;
        if (attempt === attempts - 1 || !this.isRetryableBrowserError(error)) {
          break;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async captureFailureContext(
    action: string,
    selector?: string,
  ): Promise<{
    screenshot?: string;
    url?: string;
    content?: string;
    selector?: string;
  }> {
    const context: {
      screenshot?: string;
      url?: string;
      content?: string;
      selector?: string;
    } = { selector };

    if (!this.page) {
      return context;
    }

    try {
      const screenshot = await this.screenshot(
        `browser-${action}-failure-${Date.now()}.png`,
        false,
      );
      context.screenshot = screenshot.path;
      context.url = this.page.url();
      context.content = await this.page.evaluate(`
        () => {
          const body = (globalThis as Any).document?.body;
          if (!body || !body.innerText) return '';
          return String(body.innerText).replace(/\\s+/g, ' ').trim().slice(0, 2000);
        }
      `);
    } catch {
      // Best effort for diagnostics
    }

    return context;
  }

  private async resolveBraveExecutablePath(): Promise<string | undefined> {
    const envPath = process.env.BRAVE_PATH?.trim();
    const candidates = [
      envPath,
      process.platform === "darwin"
        ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
        : undefined,
      process.platform === "linux" ? "/usr/bin/brave-browser" : undefined,
      process.platform === "linux" ? "/usr/bin/brave-browser-stable" : undefined,
      process.platform === "linux" ? "/snap/bin/brave" : undefined,
      process.platform === "win32" && process.env.LOCALAPPDATA
        ? path.join(
            process.env.LOCALAPPDATA,
            "BraveSoftware",
            "Brave-Browser",
            "Application",
            "brave.exe",
          )
        : undefined,
      process.platform === "win32"
        ? "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
        : undefined,
      process.platform === "win32"
        ? "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
        : undefined,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Keep scanning candidates.
      }
    }

    return undefined;
  }

  /**
   * Initialize the browser
   * Uses try-finally to ensure cleanup on errors
   */
  async init(): Promise<void> {
    if (this.context && this.page) return;

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      const debuggerUrl = this.options.debuggerUrl?.trim();
      if (debuggerUrl) {
        // Attach to existing Chrome via Chrome DevTools Protocol
        // Enable with: chrome --remote-debugging-port=9222
        // Or visit chrome://inspect/#devices for WebSocket URL
        const endpoint =
          debuggerUrl.startsWith("ws://") || debuggerUrl.startsWith("wss://")
            ? debuggerUrl
            : debuggerUrl.replace(/\/$/, "");
        browser = await chromium.connectOverCDP(endpoint);
        const contexts = browser.contexts();
        context = contexts[0] ?? (await browser.newContext({ viewport: this.options.viewport }));
        this.configureContext(context);
        const page = context.pages()[0] ?? (await context.newPage());
        page.setDefaultTimeout(this.options.timeout!);
        await this.configurePage(page);
        this.assertPageUrlAllowed(page.url());
        this.browser = browser;
        this.context = context;
        this.page = page;
        this.isAttached = true;
        return;
      }

      const channel = this.options.channel === "chrome" ? "chrome" : undefined;
      const executablePath =
        this.options.channel === "brave" ? await this.resolveBraveExecutablePath() : undefined;

      if (this.options.channel === "brave" && !executablePath) {
        throw new Error(
          "Brave browser was requested but no Brave executable was found. " +
            "Install Brave or set BRAVE_PATH to the Brave binary path.",
        );
      }

      if (this.options.userDataDir) {
        await fs.mkdir(this.options.userDataDir, { recursive: true });

        context = await chromium.launchPersistentContext(this.options.userDataDir, {
          headless: this.options.headless,
          ...(channel ? { channel } : {}),
          ...(executablePath ? { executablePath } : {}),
          viewport: this.options.viewport,
        });
        browser = context.browser();
      } else {
        browser = await chromium.launch({
          headless: this.options.headless,
          ...(channel ? { channel } : {}),
          ...(executablePath ? { executablePath } : {}),
        });

        context = await browser.newContext({
          viewport: this.options.viewport,
        });
      }

      this.configureContext(context);
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(this.options.timeout!);
      await this.configurePage(page);

      // Only assign to instance variables after all operations succeed
      this.browser = browser;
      this.context = context;
      this.page = page;
    } catch (error) {
      // Cleanup partial initialization on error
      if (context) {
        await context.close().catch(() => {});
      }
      if (browser) {
        await browser.close().catch(() => {});
      }
      // Improve error when profile=user (system Chrome) fails — e.g. Chrome not installed or profile locked
      const msg = error instanceof Error ? error.message : String(error);
      const isChromeProfile = this.options.userDataDir && this.options.channel === "chrome";
      const looksLikeNotFound =
        /executable.*not found|browser.*not found|channel.*chrome/i.test(msg) ||
        /ENOENT|does not exist/i.test(msg);
      const looksLikeLocked = /lock|already in use|profile.*in use/i.test(msg);
      if (isChromeProfile && (looksLikeNotFound || looksLikeLocked)) {
        const hint = looksLikeNotFound
          ? "Google Chrome may not be installed, or Playwright cannot find it. Install Chrome or use browser_attach with debugger_url to connect to an existing Chrome instance."
          : "Chrome is likely already running with this profile. Close Chrome or use browser_attach with debugger_url to connect to the running instance.";
        throw new Error(`${msg} ${hint}`);
      }
      throw error;
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(
    url: string,
    waitUntil: "load" | "domcontentloaded" | "networkidle" = "load",
  ): Promise<NavigateResult> {
    const normalizedUrl = normalizeBrowserUrl(url);
    if (!normalizedUrl) throw new Error("url is required");
    this.assertNetworkUrlAllowed(normalizedUrl);

    await this.ensurePage();

    const response = await this.page!.goto(normalizedUrl, { waitUntil });
    const status = response?.status() ?? null;

    // Validate HTTP status code - warn on client/server errors
    if (status && status >= 400) {
      const statusMessage = status >= 500 ? `Server error (${status})` : `Client error (${status})`;
      console.warn(`[BrowserService] Navigation to ${normalizedUrl} returned ${statusMessage}`);
    }

    // Auto-dismiss cookie consent popups
    const consentDismissed = await this.dismissConsentPopups();
    this.assertPageUrlAllowed(this.page!.url());

    return {
      url: this.page!.url(),
      title: await this.page!.title(),
      status,
      // Include error flag for status codes >= 400
      isError: status !== null && status >= 400,
      ...(consentDismissed ? { consentDismissed } : {}),
    };
  }

  /**
   * Dismiss a cookie-consent banner, if one is showing.
   *
   * Only acts inside a known consent-manager container or a dialog that is about cookies or
   * consent, clicks only buttons whose accessible name exactly matches a known consent choice
   * (never links), and prefers reject / necessary-only over accept-all. Skipped entirely for an
   * attached real browser or a persistent profile, where the choice would be made on the user's
   * behalf and outlive the task.
   */
  private async dismissConsentPopups(): Promise<ConsentDismissal | null> {
    if (!this.page) return null;
    if (this.isAttached || this.options.userDataDir) return null;

    try {
      const page = this.page;
      const containers: Array<{ handle: ElementHandle; label: string; isCmp: boolean }> = [];
      for (const selector of CONSENT_MANAGER_CONTAINER_SELECTORS) {
        const handle = await page.$(selector).catch(() => null);
        if (handle) containers.push({ handle, label: selector, isCmp: true });
      }
      const dialogs = await page.$$(CONSENT_DIALOG_SELECTOR).catch(() => []);
      for (const dialog of dialogs.slice(0, MAX_CONSENT_DIALOGS)) {
        const text = (await dialog.textContent().catch(() => null)) || "";
        if (CONSENT_DIALOG_TEXT_PATTERN.test(text)) {
          containers.push({ handle: dialog, label: "cookie consent dialog", isCmp: false });
        }
      }
      if (containers.length === 0) return null;

      let best: { rank: number; button: ElementHandle; text: string; container: string } | null =
        null;
      const unrecognisedCmpBanners: string[] = [];
      for (const container of containers) {
        const buttons = await container.handle.$$(CONSENT_BUTTON_SELECTOR).catch(() => []);
        let sawVisibleButton = false;
        for (const button of buttons.slice(0, MAX_CONSENT_BUTTONS_PER_CONTAINER)) {
          if (!(await button.isVisible().catch(() => false))) continue;
          sawVisibleButton = true;
          const rawName =
            (await button.getAttribute("aria-label").catch(() => null)) ||
            (await button.textContent().catch(() => null)) ||
            (await button.getAttribute("value").catch(() => null)) ||
            "";
          const name = normalizeConsentButtonName(rawName);
          const rank = rankConsentButtonName(name);
          if (rank < 0 || (best && best.rank <= rank)) continue;
          best = {
            rank,
            button,
            text: rawName.replace(/\s+/g, " ").trim(),
            container: container.label,
          };
          if (rank === 0) break;
        }
        if (best?.rank === 0) break;
        if (container.isCmp && sawVisibleButton) unrecognisedCmpBanners.push(container.label);
      }

      if (best) {
        await best.button.click({ timeout: 2_000 });
        log.info(`Dismissed consent banner with "${best.text}" in ${best.container}`);
        await page.waitForTimeout(500).catch(() => {});
        return { action: "clicked", text: best.text, container: best.container };
      }

      // A consent manager is showing choices we do not recognise (e.g. another language).
      // Remove only that banner so the page is usable, without granting or refusing consent.
      if (unrecognisedCmpBanners.length === 0) return null;
      await page.evaluate(`
        (() => {
          for (const selector of ${JSON.stringify(unrecognisedCmpBanners)}) {
            document.querySelectorAll(selector).forEach((el) => el.remove());
          }
          document.body.style.overflow = '';
          document.documentElement.style.overflow = '';
        })()
      `);
      log.info(`Removed unrecognised consent banner ${unrecognisedCmpBanners[0]}`);
      return { action: "removed", container: unrecognisedCmpBanners[0] };
    } catch (error) {
      // Best effort: consent handling must never fail navigation.
      log.debug("Could not dismiss consent popup:", error);
      return null;
    }
  }

  /**
   * Take a screenshot
   */
  async screenshot(
    filename?: string,
    fullPage: boolean = false,
    accessOptions: WorkspaceFilesystemAccessOptions = {},
  ): Promise<ScreenshotResult> {
    await this.ensurePage();

    const screenshotName = filename || `screenshot-${Date.now()}.png`;
    const screenshotPath = assertWorkspaceFilesystemAccess(
      this.workspace,
      screenshotName,
      "write",
      "screenshot path",
      accessOptions,
    );

    await this.page!.screenshot({
      path: screenshotPath,
      fullPage,
    });

    const viewport = this.page!.viewportSize();

    const pageHeight = fullPage
      ? ((await this.page!.evaluate("document.body.scrollHeight")) as number)
      : (viewport?.height ?? this.options.viewport!.height);

    return {
      path: path.relative(this.workspace.path, screenshotPath) || path.basename(screenshotPath),
      width: viewport?.width ?? this.options.viewport!.width,
      height: pageHeight,
    };
  }

  /**
   * Get the current page URL
   */
  async getCurrentUrl(): Promise<string> {
    await this.ensurePage();
    return this.page!.url();
  }

  /**
   * Get page content as text
   */
  async getContent(): Promise<PageContent> {
    await this.ensurePage();
    this.assertPageUrlAllowed(this.page!.url());

    const url = this.page!.url();
    const title = await this.page!.title();

    // Get visible text content
    const text = (await this.page!.evaluate(`
      (() => {
        const body = document.body;
        const clone = body.cloneNode(true);
        clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
        return clone.innerText.replace(/\\s+/g, ' ').trim().slice(0, 10000);
      })()
    `)) as string;

    // Get links
    const links = (await this.page!.evaluate(`
      (() => {
        const anchors = document.querySelectorAll('a[href]');
        return Array.from(anchors).slice(0, 50).map(a => ({
          text: (a.textContent || '').trim().slice(0, 100),
          href: a.href
        })).filter(l => l.text && l.href);
      })()
    `)) as Array<{ text: string; href: string }>;

    // Get forms
    const forms = (await this.page!.evaluate(`
      (() => {
        const formElements = document.querySelectorAll('form');
        return Array.from(formElements).slice(0, 10).map(form => ({
          action: form.action || '',
          method: form.method || 'get',
          inputs: Array.from(form.querySelectorAll('input, textarea, select')).slice(0, 20).map(input => {
            return input.tagName.toLowerCase() + '[name="' + (input.name || '') + '"][type="' + (input.type || 'text') + '"]';
          })
        }));
      })()
    `)) as Array<{ action: string; method: string; inputs: string[] }>;

    return { url, title, text, links, forms };
  }

  /**
   * Click on an element
   */
  async click(selector: string, timeoutMs?: number): Promise<ClickResult> {
    await this.ensurePage();

    const actionTimeout = this.getActionTimeout(timeoutMs);

    try {
      const locator = await this.runLocatorActionWithRetry(
        selector,
        actionTimeout,
        async (candidate, actionTimeoutForAttempt) => {
          await candidate.click({ timeout: actionTimeoutForAttempt });
          return candidate;
        },
      );
      const text = await locator.textContent().catch(() => null);

      return {
        success: true,
        element: text?.trim().slice(0, 100),
      };
    } catch (error) {
      const context = await this.captureFailureContext("click", selector);
      return {
        success: false,
        element: selector,
        error: (error as Error).message,
        ...context,
      };
    }
  }

  /**
   * Fill a form field
   */
  async fill(selector: string, value: string, timeoutMs?: number): Promise<FillResult> {
    await this.ensurePage();
    const actionTimeout = this.getActionTimeout(timeoutMs);

    try {
      const _locator = await this.runLocatorActionWithRetry(
        selector,
        actionTimeout,
        async (candidate, actionTimeoutForAttempt) => {
          await candidate.fill(value, { timeout: actionTimeoutForAttempt });
          return candidate;
        },
      );

      return {
        success: true,
        selector,
        value,
      };
    } catch (error) {
      const context = await this.captureFailureContext("fill", selector);
      return {
        success: false,
        selector,
        value,
        error: (error as Error).message,
        ...context,
      };
    }
  }

  /**
   * Type text (with key events)
   */
  async type(
    selector: string,
    text: string,
    delay: number = 50,
    timeoutMs?: number,
  ): Promise<FillResult> {
    await this.ensurePage();
    const actionTimeout = this.getActionTimeout(timeoutMs);

    try {
      const _locator = await this.runLocatorActionWithRetry(
        selector,
        actionTimeout,
        async (candidate, actionTimeoutForAttempt) => {
          await candidate.click({ timeout: actionTimeoutForAttempt });
          await candidate.type(text, { delay, timeout: actionTimeoutForAttempt });
          return candidate;
        },
      );

      return {
        success: true,
        selector,
        value: text,
      };
    } catch (error) {
      const context = await this.captureFailureContext("type", selector);
      return {
        success: false,
        selector,
        value: text,
        error: (error as Error).message,
        ...context,
      };
    }
  }

  /**
   * Press a key
   */
  async press(key: string): Promise<{ success: boolean; key: string }> {
    await this.ensurePage();

    try {
      await this.page!.keyboard.press(key);
      return { success: true, key };
    } catch (error) {
      return { success: false, key: (error as Error).message };
    }
  }

  /**
   * Wait for an element to appear
   */
  async waitForSelector(
    selector: string,
    timeout?: number,
  ): Promise<{ success: boolean; selector: string }> {
    await this.ensurePage();

    try {
      const actionTimeout = this.getActionTimeout(timeout);
      await this.page!.waitForSelector(selector, { timeout: actionTimeout });
      return { success: true, selector };
    } catch (error) {
      return { success: false, selector: (error as Error).message };
    }
  }

  /**
   * Wait for navigation
   */
  async waitForNavigation(timeout?: number): Promise<{ success: boolean; url: string }> {
    await this.ensurePage();

    try {
      const actionTimeout = this.getActionTimeout(timeout);
      await this.page!.waitForLoadState("load", { timeout: actionTimeout });
      return { success: true, url: this.page!.url() };
    } catch (error) {
      return { success: false, url: (error as Error).message };
    }
  }

  /**
   * Get element text
   */
  async getText(selector: string): Promise<{ success: boolean; text: string }> {
    await this.ensurePage();

    try {
      const element = await this.page!.$(selector);
      if (!element) {
        return { success: false, text: "Element not found" };
      }
      const text = await element.textContent();
      return { success: true, text: text?.trim() ?? "" };
    } catch (error) {
      return { success: false, text: (error as Error).message };
    }
  }

  /**
   * Get element attribute
   */
  async getAttribute(
    selector: string,
    attribute: string,
  ): Promise<{ success: boolean; value: string | null }> {
    await this.ensurePage();

    try {
      const value = await this.page!.getAttribute(selector, attribute);
      return { success: true, value };
    } catch (error) {
      return { success: false, value: (error as Error).message };
    }
  }

  /**
   * Evaluate JavaScript in the page
   */
  async evaluate(script: string): Promise<EvaluateResult> {
    await this.ensurePage();

    const normalizedScript = normalizeEvaluateScript(script);

    try {
      const result = await this.page!.evaluate((code) => {
        return (0, eval)(code);
      }, normalizedScript);

      return { success: true, result };
    } catch (error) {
      return { success: false, result: (error as Error).message };
    }
  }

  /**
   * Select option from dropdown
   */
  async select(selector: string, value: string): Promise<FillResult> {
    await this.ensurePage();

    try {
      await this.page!.selectOption(selector, value);
      return { success: true, selector, value };
    } catch (error) {
      return { success: false, selector, value: (error as Error).message };
    }
  }

  /**
   * Check or uncheck a checkbox
   */
  async check(
    selector: string,
    checked: boolean = true,
  ): Promise<{ success: boolean; selector: string; checked: boolean }> {
    await this.ensurePage();

    try {
      if (checked) {
        await this.page!.check(selector);
      } else {
        await this.page!.uncheck(selector);
      }
      return { success: true, selector, checked };
    } catch {
      return { success: false, selector, checked: false };
    }
  }

  /**
   * Scroll the page
   */
  async scroll(
    direction: "up" | "down" | "top" | "bottom",
    amount?: number,
  ): Promise<{ success: boolean }> {
    await this.ensurePage();

    try {
      const scrollAmount = amount || 500;
      let script: string;

      switch (direction) {
        case "up":
          script = `window.scrollBy(0, -${scrollAmount})`;
          break;
        case "down":
          script = `window.scrollBy(0, ${scrollAmount})`;
          break;
        case "top":
          script = `window.scrollTo(0, 0)`;
          break;
        case "bottom":
          script = `window.scrollTo(0, document.body.scrollHeight)`;
          break;
      }

      await this.page!.evaluate(script);
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  /**
   * Go back in browser history
   */
  async goBack(): Promise<NavigateResult> {
    await this.ensurePage();
    this.assertPageUrlAllowed(this.page!.url());
    await this.page!.goBack();
    this.assertPageUrlAllowed(this.page!.url());

    return {
      url: this.page!.url(),
      title: await this.page!.title(),
      status: null,
    };
  }

  /**
   * Go forward in browser history
   */
  async goForward(): Promise<NavigateResult> {
    await this.ensurePage();
    this.assertPageUrlAllowed(this.page!.url());
    await this.page!.goForward();
    this.assertPageUrlAllowed(this.page!.url());

    return {
      url: this.page!.url(),
      title: await this.page!.title(),
      status: null,
    };
  }

  /**
   * Reload the page
   */
  async reload(): Promise<NavigateResult> {
    await this.ensurePage();
    this.assertPageUrlAllowed(this.page!.url());
    const response = await this.page!.reload();
    this.assertPageUrlAllowed(this.page!.url());

    return {
      url: this.page!.url(),
      title: await this.page!.title(),
      status: response?.status() ?? null,
    };
  }

  /**
   * Get page HTML
   */
  async getHtml(): Promise<string> {
    await this.ensurePage();
    return await this.page!.content();
  }

  /**
   * Save page as PDF
   */
  async savePdf(
    filename?: string,
    accessOptions: WorkspaceFilesystemAccessOptions = {},
  ): Promise<{ path: string }> {
    await this.ensurePage();

    const pdfName = filename || `page-${Date.now()}.pdf`;
    const pdfPath = assertWorkspaceFilesystemAccess(
      this.workspace,
      pdfName,
      "write",
      "PDF path",
      accessOptions,
    );

    await this.page!.pdf({ path: pdfPath, format: "A4" });

    return { path: path.relative(this.workspace.path, pdfPath) || path.basename(pdfPath) };
  }

  /**
   * Get current URL
   */
  getUrl(): string {
    return this.page?.url() ?? "";
  }

  /**
   * Check if browser is open
   */
  isOpen(): boolean {
    return this.context !== null && this.page !== null;
  }

  /**
   * Close the browser (or disconnect when attached to existing Chrome)
   */
  async close(): Promise<void> {
    if (this.isAttached) {
      // Attached mode: only disconnect, do not close user's browser tabs
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
      this.context = null;
      this.page = null;
      this.isAttached = false;
      return;
    }
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  /**
   * Ensure page is initialized
   */
  private async ensurePage(): Promise<void> {
    if (!this.page) {
      await this.init();
    }
    this.assertPageUrlAllowed(this.page?.url() || "");
  }
}

export const _testUtils = {
  normalizeEvaluateScript,
};
