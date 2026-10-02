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
import {
  BROWSER_ACTION_TIMEOUT_MS,
  BROWSER_FAILURE_CAPTURE_TIMEOUT_MS,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_WAIT_TIMEOUT_MS,
} from "./browser-timeouts";

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
  /** Launch and navigation timeout in ms (default: BROWSER_NAVIGATION_TIMEOUT_MS) */
  timeout?: number;
  /** Default element-action timeout in ms (default: BROWSER_ACTION_TIMEOUT_MS) */
  actionTimeout?: number;
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

/** A visible interactive element and a selector the click/fill/type tools accept for it. */
export interface InteractiveElement {
  role: string;
  name: string;
  selector: string;
  type?: string;
  placeholder?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface ClickResult {
  success: boolean;
  element?: string;
  error?: string;
  screenshot?: string;
  url?: string;
  content?: string;
  /** When the selector matched nothing: visible elements the caller can target instead */
  candidates?: InteractiveElement[];
}

export interface FillResult {
  success: boolean;
  selector: string;
  value: string;
  error?: string;
  screenshot?: string;
  url?: string;
  content?: string;
  /** When the selector matched nothing: visible elements the caller can target instead */
  candidates?: InteractiveElement[];
}

/** Thrown when an action's selector never matched any element within its budget. */
class SelectorNotFoundError extends Error {
  constructor(
    message: string,
    readonly candidates: InteractiveElement[],
  ) {
    super(message);
    this.name = "SelectorNotFoundError";
  }
}

function isPlaywrightTimeoutError(error: unknown): boolean {
  const err = error as Error | undefined;
  return err?.name === "TimeoutError" || /\bTimeout \d+ms exceeded\b/.test(String(err?.message));
}

function formatInteractiveElement(element: InteractiveElement): string {
  const name = element.name ? ` "${element.name}"` : "";
  return `${element.role}${name} -> ${element.selector}`;
}

const SELECTOR_NOISE_TOKENS = new Set(["text", "has", "nth", "type", "child", "not", "role"]);

/**
 * Orders candidates for a selector that matched nothing: elements sharing a word with the
 * requested selector first (e.g. "#submit" -> "#submit-btn"), then non-links, then DOM order.
 */
function rankCandidatesForSelector(
  elements: InteractiveElement[],
  selector: string,
): InteractiveElement[] {
  const tokens = (selector.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(
    (token) => !SELECTOR_NOISE_TOKENS.has(token),
  );
  const score = (element: InteractiveElement) => {
    const haystack =
      `${element.selector} ${element.name} ${element.placeholder || ""}`.toLowerCase();
    return tokens.filter((token) => haystack.includes(token)).length;
  };
  return elements
    .map((element, index) => ({
      element,
      index,
      score: score(element),
      link: element.role === "link",
    }))
    .sort((a, b) => b.score - a.score || Number(a.link) - Number(b.link) || a.index - b.index)
    .map((entry) => entry.element);
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/**
 * Page script listing visible interactive elements in DOM order, each with a selector that is
 * unique on the page (id, name/test-id/label attributes, unique href, or a structural path).
 * Links are capped separately so a large navigation menu cannot crowd out buttons and inputs.
 */
function interactiveElementsScript(limit: number, linkLimit: number): string {
  return `
    (() => {
      const limit = ${Math.max(0, Math.floor(limit))};
      const linkLimit = ${Math.max(0, Math.floor(linkLimit))};
      const clip = (value, max) => {
        const text = String(value || "").replace(/\\s+/g, " ").trim();
        return text.length > max ? text.slice(0, max - 1) + "…" : text;
      };
      const esc = (value) =>
        window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^\\w-]/g, "\\\\$&");
      const quote = (value) => '"' + String(value).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"';
      const unique = (selector) => {
        try {
          return document.querySelectorAll(selector).length === 1;
        } catch {
          return false;
        }
      };
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none";
      };
      const selectorFor = (el) => {
        const tag = el.tagName.toLowerCase();
        if (el.id && unique("#" + esc(el.id))) return "#" + esc(el.id);
        for (const attr of ["data-testid", "data-test", "name", "aria-label", "placeholder"]) {
          const value = el.getAttribute(attr);
          if (value && value.length <= 80 && unique(tag + "[" + attr + "=" + quote(value) + "]")) {
            return tag + "[" + attr + "=" + quote(value) + "]";
          }
        }
        const href = tag === "a" ? el.getAttribute("href") : null;
        if (href && href.length <= 160 && unique("a[href=" + quote(href) + "]")) {
          return "a[href=" + quote(href) + "]";
        }
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
          if (node !== el && node.id && unique("#" + esc(node.id))) {
            parts.unshift("#" + esc(node.id));
            return parts.join(" > ");
          }
          let part = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
            if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
          }
          parts.unshift(part);
          node = parent;
        }
        parts.unshift("body");
        return parts.join(" > ");
      };
      const roleFor = (el) => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (tag === "select") return el.multiple ? "listbox" : "combobox";
        if (tag === "textarea" || el.isContentEditable) return "textbox";
        if (tag === "input") {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (["button", "submit", "reset", "image"].includes(type)) return "button";
          if (type === "checkbox" || type === "radio") return type;
          if (type === "range") return "slider";
          return "textbox";
        }
        return tag;
      };
      const nameFor = (el, role) => {
        const aria = el.getAttribute("aria-label");
        if (aria) return clip(aria, 80);
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
          if (text.trim()) return clip(text, 80);
        }
        if (role === "textbox" || role === "combobox" || role === "listbox" || role === "checkbox" || role === "radio" || role === "slider") {
          const label = el.labels && el.labels[0] ? el.labels[0].innerText : "";
          if (label && label.trim()) return clip(label, 80);
          return clip(el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "", 80);
        }
        const text = el.innerText || el.value || el.getAttribute("title") || el.querySelector("img[alt]")?.getAttribute("alt") || "";
        return clip(text, 80);
      };
      const candidates = document.querySelectorAll(
        'button, [role="button"], input:not([type="hidden"]), textarea, select, [contenteditable="true"], ' +
          '[role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], ' +
          '[role="combobox"], [role="textbox"], [role="link"], a[href]'
      );
      const items = [];
      let links = 0;
      for (let index = 0; index < candidates.length && index < 4000 && items.length < limit; index += 1) {
        const el = candidates[index];
        try {
          if (!isVisible(el)) continue;
          const role = roleFor(el);
          if (role === "link") {
            if (links >= linkLimit) continue;
            links += 1;
          }
          const item = { role, name: nameFor(el, role), selector: selectorFor(el) };
          const tag = el.tagName.toLowerCase();
          if (tag === "input") item.type = (el.getAttribute("type") || "text").toLowerCase();
          if (el.getAttribute("placeholder")) item.placeholder = clip(el.getAttribute("placeholder"), 80);
          if (tag === "a" && el.href) item.href = clip(el.href, 200);
          if (role === "checkbox" || role === "radio" || role === "switch") {
            item.checked = el.checked === true || el.getAttribute("aria-checked") === "true";
          }
          if (el.disabled === true || el.getAttribute("aria-disabled") === "true") item.disabled = true;
          items.push(item);
        } catch {
          // Skip elements that cannot be described.
        }
      }
      return items;
    })()
  `;
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
      timeout: options.timeout ?? BROWSER_NAVIGATION_TIMEOUT_MS,
      actionTimeout: options.actionTimeout ?? BROWSER_ACTION_TIMEOUT_MS,
      viewport: options.viewport ?? { width: 1280, height: 720 },
      userDataDir: options.userDataDir,
      channel: options.channel,
      debuggerUrl: options.debuggerUrl,
    };
  }

  private getActionTimeout(
    timeoutMs?: number,
    fallback = this.options.actionTimeout ?? BROWSER_ACTION_TIMEOUT_MS,
  ): number {
    const normalized = Number(timeoutMs);
    if (!Number.isFinite(normalized) || normalized <= 0) return fallback;
    return Math.round(normalized);
  }

  /** Applies the action default to all page operations, keeping the longer navigation budget. */
  private applyPageTimeouts(page: Page): void {
    page.setDefaultTimeout(this.options.actionTimeout ?? BROWSER_ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(this.options.timeout ?? BROWSER_NAVIGATION_TIMEOUT_MS);
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

  /**
   * Waits for the selector and runs the action within one time budget. Timeouts are never
   * retried (the budget is already spent); a selector that matched nothing fails with a list of
   * visible interactive elements instead. Transient errors (detached, not stable, intercepted)
   * get one more attempt inside the remaining budget.
   */
  private async runLocatorActionWithRetry<T>(
    selector: string,
    timeoutMs: number | undefined,
    operation: (locator: Locator, timeout: number) => Promise<T>,
  ): Promise<T> {
    const budget = this.getActionTimeout(timeoutMs);
    const deadline = Date.now() + budget;
    const remaining = () => Math.max(1_000, deadline - Date.now());
    const attempts = 2;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const locator = this.page!.locator(selector);
      try {
        await locator.waitFor({ state: "visible", timeout: remaining() });
        await locator.scrollIntoViewIfNeeded({ timeout: remaining() });
        if (attempt > 0) {
          await this.page!.waitForTimeout(200).catch(() => {});
        }
        return await operation(locator, remaining());
      } catch (error) {
        lastError = error;
        if (isPlaywrightTimeoutError(error)) {
          const matches = await locator.count().catch(() => undefined);
          if (matches === 0) {
            throw await this.selectorNotFoundError(selector, budget);
          }
          break;
        }
        if (
          attempt === attempts - 1 ||
          Date.now() >= deadline ||
          !this.isRetryableBrowserError(error)
        ) {
          break;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async selectorNotFoundError(
    selector: string,
    waitedMs: number,
  ): Promise<SelectorNotFoundError> {
    const elements = await this.getInteractiveElements(40, 10).catch(() => []);
    const candidates = rankCandidatesForSelector(elements, selector).slice(0, 8);
    const hint =
      candidates.length > 0
        ? ` Visible interactive elements: ${candidates.map(formatInteractiveElement).join("; ")}.` +
          " Retry with one of these selectors, or inspect the page with browser_get_content."
        : " The page has no visible interactive elements; check that it finished loading.";
    return new SelectorNotFoundError(
      `No element matches selector "${selector}" (waited ${waitedMs}ms).${hint}`,
      candidates,
    );
  }

  /**
   * Visible interactive elements (buttons, inputs, selects, links) in DOM order, each with a
   * selector accepted by click/fill/type. Links are capped at `linkLimit`.
   */
  private async getInteractiveElements(
    limit: number,
    linkLimit: number,
  ): Promise<InteractiveElement[]> {
    if (!this.page) return [];
    const items = await this.page.evaluate(interactiveElementsScript(limit, linkLimit));
    return Array.isArray(items) ? (items as InteractiveElement[]) : [];
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

    const page = this.page;
    if (!page) {
      return context;
    }

    // Best effort and bounded: diagnostics must not outlive the tool's own timeout.
    context.url = page.url();
    const capture = (async () => {
      const screenshot = await this.screenshot(
        `browser-${action}-failure-${Date.now()}.png`,
        false,
      );
      context.screenshot = screenshot.path;
      context.content = await page.evaluate(`
        (() => {
          const body = document.body;
          if (!body || !body.innerText) return '';
          return String(body.innerText).replace(/\\s+/g, ' ').trim().slice(0, 2000);
        })()
      `);
    })();
    await settleWithin(capture, BROWSER_FAILURE_CAPTURE_TIMEOUT_MS);

    return { ...context };
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
        this.applyPageTimeouts(page);
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
      this.applyPageTimeouts(page);
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
        ...(error instanceof SelectorNotFoundError ? { candidates: error.candidates } : {}),
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
        ...(error instanceof SelectorNotFoundError ? { candidates: error.candidates } : {}),
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
    // Typing with a per-key delay takes time of its own; budget it on top of the action default.
    const actionTimeout =
      this.getActionTimeout(timeoutMs) + String(text ?? "").length * Math.max(0, delay);

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
        ...(error instanceof SelectorNotFoundError ? { candidates: error.candidates } : {}),
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
      const actionTimeout = this.getActionTimeout(timeout, BROWSER_WAIT_TIMEOUT_MS);
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
      const actionTimeout = this.getActionTimeout(timeout, this.options.timeout);
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
