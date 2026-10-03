import {
  chromium,
  Browser,
  Page,
  BrowserContext,
  ConsoleMessage,
  Dialog,
  Download,
  Locator,
  ElementHandle,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
  Route,
} from "playwright";
import * as path from "path";
import * as fs from "fs/promises";
import { Workspace } from "../../../shared/types";
import { normalizeBrowserUrl, redactBrowserText } from "../../browser/browser-session-manager";
import { evaluateNetworkPolicy } from "../../security/network-policy";
import {
  assertWorkspaceFilesystemAccess,
  evaluateWorkspaceFilesystemAccess,
  isAccessPathWithin,
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
 * a dialog whose text is about cookies/consent and that overlays the page like a consent banner.
 * Anything else on the page is never clicked.
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

/**
 * Runs in the page (via ElementHandle.evaluate, so it must stay self-contained): whether a
 * dialog is laid out like a consent banner rather than marked up as one. It, or an ancestor,
 * must be position fixed or sticky; it must be rendered, visible and intersect the viewport;
 * and it must cover a tenth of the viewport or sit within 48px of a viewport edge (top or
 * bottom bars, corner cards). Role and aria attributes alone are page-supplied claims.
 *
 * The page's element is typed structurally because the daemon and CLI builds have no DOM lib.
 */
interface ConsentOverlayElement {
  ownerDocument: { defaultView: ConsentOverlayView | null };
  parentElement: ConsentOverlayElement | null;
  getBoundingClientRect(): { top: number; left: number; right: number; bottom: number };
}
interface ConsentOverlayView {
  innerWidth: number;
  innerHeight: number;
  getComputedStyle(element: ConsentOverlayElement): {
    visibility: string;
    display: string;
    opacity: string;
    position: string;
  };
}
function isConsentOverlayLayout(pageElement: unknown): boolean {
  const element = pageElement as ConsentOverlayElement;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  if (["hidden", "collapse"].includes(view.getComputedStyle(element).visibility)) return false;
  let pinned = false;
  for (let node: ConsentOverlayElement | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === "none" || Number(style.opacity) === 0) return false;
    if (style.position === "fixed" || style.position === "sticky") pinned = true;
  }
  if (!pinned) return false;
  const rect = element.getBoundingClientRect();
  const width = view.innerWidth;
  const height = view.innerHeight;
  const visibleWidth = Math.min(rect.right, width) - Math.max(rect.left, 0);
  const visibleHeight = Math.min(rect.bottom, height) - Math.max(rect.top, 0);
  if (visibleWidth <= 0 || visibleHeight <= 0) return false;
  const edge = 48;
  return (
    (visibleWidth * visibleHeight) / (width * height) >= 0.1 ||
    rect.top <= edge ||
    rect.left <= edge ||
    height - rect.bottom <= edge ||
    width - rect.right <= edge
  );
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
  /**
   * Switch to a page that an action opened (popup, target=_blank, OAuth window) and report it
   * as switchedToTab. Default: true.
   */
  followPopups?: boolean;
  /**
   * How long a click or key press waits for a page it may have opened, since Playwright can
   * report a popup only after the action itself resolves. Default: POPUP_GRACE_MS.
   */
  popupGraceMs?: number;
}

/** A page of the headless browser context, as reported to the agent. */
export interface BrowserTabInfo {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
  /** Tab whose page opened this one (window.open, target=_blank) */
  openerTabId?: string;
  backend: "playwright-local";
  /** Why the service did not switch to this tab, e.g. its URL is outside the network policy */
  error?: string;
}

/**
 * Side effects of an action that the agent cannot otherwise see, attached to the action's
 * result. Events that happened between actions are reported with the next action.
 */
export interface BrowserActionEvents {
  /** A tab opened by this action that is now the active tab */
  switchedToTab?: BrowserTabInfo;
  /** Tabs opened since the previous action that did not become the active tab */
  newTabs?: BrowserTabInfo[];
  /** The active tab closed (e.g. an OAuth popup finished); actions now target activeTabId */
  activeTabClosed?: { closedTabId: string; activeTabId?: string; url?: string };
  /**
   * A JavaScript dialog (alert/confirm/prompt/beforeunload) the page opened. Dialogs are
   * dismissed unless the agent asked to accept the next one, so a dismissed confirm() means
   * the page's action did not go ahead.
   */
  dialog?: BrowserDialogReport;
  /** Every dialog, when the page opened more than one */
  dialogs?: BrowserDialogReport[];
  /** An accept/dismiss decision for the next dialog lapsed because no dialog opened */
  dialogDecisionExpired?: true;
  /** Downloads the page started, saved into the workspace downloads folder or rejected */
  downloads?: BrowserDownloadEntry[];
}

export interface BrowserDownloadEntry {
  id: string;
  /** pending: still downloading; rejected: the workspace file policy refused it */
  status: "pending" | "saved" | "rejected" | "failed";
  suggestedFilename: string;
  url: string;
  /** Workspace-relative path of the saved file */
  path?: string;
  size?: number;
  error?: string;
  tabId?: string;
  timestamp: number;
}

export interface BrowserConsoleEntry {
  level: string;
  text: string;
  /** "pageerror" for uncaught exceptions */
  source?: string;
  url?: string;
  tabId?: string;
  timestamp: number;
}

export interface BrowserNetworkEntry {
  method?: string;
  url: string;
  status?: number;
  resourceType?: string;
  failed?: boolean;
  errorText?: string;
  tabId?: string;
  timestamp: number;
}

export interface BrowserDiagnosticLog<T> {
  entries: T[];
  /** Older entries that fell out of the bounded buffer */
  dropped: number;
}

export interface BrowserDiagnosticSummary {
  count: number;
  recent: string[];
}

/** Same bound as the visible workbench diagnostics. */
const MAX_DIAGNOSTIC_ENTRIES = 120;

/** Workspace folder (relative) that headless downloads are saved into. */
export const BROWSER_DOWNLOADS_DIR = "downloads";
const MAX_DOWNLOADS_PER_SESSION = 50;
const MAX_DOWNLOAD_ENTRIES = 50;
const MAX_DOWNLOAD_NAME_CHARS = 180;
/** How long an action waits for a download it started before reporting it as pending. */
const DOWNLOAD_REPORT_WAIT_MS = 5_000;
/** Closing the context deletes unsaved downloads, so close waits this long for them. */
const DOWNLOAD_CLOSE_WAIT_MS = 30_000;

/** Thrown when the workspace file policy does not allow saving a download. */
class DownloadRejectedError extends Error {}

/** A site-suggested download name reduced to a single safe, visible file name. */
function sanitizeDownloadFilename(raw: string): string {
  const base =
    String(raw ?? "")
      .split(/[\\/]/)
      .pop() ?? "";
  let cleaned = Array.from(base)
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? "_" : char))
    .join("")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (cleaned.length > MAX_DOWNLOAD_NAME_CHARS) {
    const ext = path.extname(cleaned).slice(0, 16);
    cleaned = cleaned.slice(0, MAX_DOWNLOAD_NAME_CHARS - ext.length) + ext;
  }
  return cleaned || "download";
}

export interface BrowserDialogReport {
  type: string;
  message: string;
  /** Default value of a prompt() */
  defaultValue?: string;
  action: "accepted" | "dismissed";
  tabId?: string;
  timestamp: number;
}

export interface BrowserDialogDecision {
  accept: boolean;
  promptText?: string;
}

/** Grace period for a popup opened by a click or key press to be reported. */
const POPUP_GRACE_MS = 250;
/** Bound on waiting for a followed popup to load before its URL and title are reported. */
const POPUP_LOAD_WAIT_MS = 5_000;
const TAB_TITLE_TIMEOUT_MS = 2_000;
const MAX_ACTION_EVENTS = 50;

interface BrowserTabRecord {
  tabId: string;
  page: Page;
  /** Tabs that existed in an attached real browser before CoWork connected are not closable */
  owned: boolean;
  openerTabId?: string;
  /** Settles once the opener lookup finished */
  openerReady: Promise<void>;
}

type BrowserActionEventInput =
  | { kind: "tab_opened"; tabId: string }
  | { kind: "active_tab_closed"; closedTabId: string; activeTabId?: string }
  | { kind: "dialog"; dialog: BrowserDialogReport }
  | { kind: "download"; downloadId: string };

type BrowserActionEventRecord = BrowserActionEventInput & { seq: number };

export interface ConsentDismissal {
  /** "clicked" a consent button, or "removed" a CMP banner that offered no recognised choice */
  action: "clicked" | "removed";
  /** Accessible name of the clicked button */
  text?: string;
  /** Consent-manager container the action was limited to */
  container: string;
}

export interface NavigateResult extends BrowserActionEvents {
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

export interface PageContentOptions {
  /** Character offset into the page text (use nextOffset from a truncated read) */
  offset?: number;
  /** Maximum characters of page text to return */
  maxChars?: number;
  /** "auto": whole page when it fits, else the main region; "page": always the whole page */
  scope?: "auto" | "page";
}

export interface PageTextWindow {
  offset: number;
  totalChars: number;
  truncated: boolean;
  /** Offset to pass to read the next chunk; present only when truncated */
  nextOffset?: number;
  text: string;
}

export interface PageContent extends PageTextWindow {
  url: string;
  title: string;
  /** Whether text covers the whole page or only its main content region */
  textScope: "page" | "main";
  /** Length of the whole-page text when textScope is "main" */
  pageTextChars?: number;
  /** Visible buttons, inputs, selects and (capped) links with selectors for click/fill/type */
  interactive: InteractiveElement[];
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; method: string; inputs: string[] }>;
}

export const DEFAULT_PAGE_TEXT_CHARS = 10_000;
export const MAX_PAGE_TEXT_CHARS = 25_000;
/** A main/article region shorter than this is not treated as the page's main content. */
const MIN_MAIN_TEXT_CHARS = 200;
const PAGE_INTERACTIVE_LIMIT = 60;
const PAGE_INTERACTIVE_LINK_LIMIT = 20;

/** Returns one window of page text plus what is needed to read the rest. */
export function paginatePageText(
  fullText: string,
  offset?: number,
  maxChars?: number,
): PageTextWindow {
  const totalChars = fullText.length;
  const requestedOffset = Number.isFinite(offset) ? Math.floor(Number(offset)) : 0;
  const start = Math.min(Math.max(0, requestedOffset), totalChars);
  const requestedMax = Number.isFinite(maxChars) ? Math.floor(Number(maxChars)) : NaN;
  const limit =
    requestedMax > 0 ? Math.min(requestedMax, MAX_PAGE_TEXT_CHARS) : DEFAULT_PAGE_TEXT_CHARS;
  const end = Math.min(totalChars, start + limit);
  const truncated = end < totalChars;
  return {
    offset: start,
    totalChars,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
    text: fullText.slice(start, end),
  };
}

/**
 * Page script for getContent. Text comes from the live, rendered innerText (hidden menus and
 * templates are excluded) of the body and of the main content region, if the page has one.
 */
const PAGE_CONTENT_SCRIPT = `
  (() => {
    const MAX_TEXT = 1000000;
    const collapse = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, MAX_TEXT);
    let main = document.querySelector('main, [role="main"]');
    if (!main) {
      const articles = document.querySelectorAll("article");
      if (articles.length === 1) main = articles[0];
    }
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const shown = (el) => el.getClientRects().length > 0;
    const orderedAnchors = anchors.filter(shown).concat(anchors.filter((el) => !shown(el)));
    return {
      bodyText: collapse(document.body ? document.body.innerText : ""),
      mainText: collapse(main ? main.innerText : ""),
      links: orderedAnchors.slice(0, 50).map((a) => ({
        text: (a.textContent || "").trim().slice(0, 100),
        href: a.href,
      })).filter((l) => l.text && l.href),
      forms: Array.from(document.querySelectorAll("form")).slice(0, 10).map((form) => ({
        action: form.action || "",
        method: form.method || "get",
        inputs: Array.from(form.querySelectorAll("input, textarea, select")).slice(0, 20).map((input) => {
          return input.tagName.toLowerCase() + '[name="' + (input.name || "") + '"][type="' + (input.type || "text") + '"]';
        }),
      })),
    };
  })()
`;

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

export interface ClickResult extends BrowserActionEvents {
  success: boolean;
  element?: string;
  error?: string;
  screenshot?: string;
  url?: string;
  content?: string;
  /** When the selector matched nothing: visible elements the caller can target instead */
  candidates?: InteractiveElement[];
}

export interface FillResult extends BrowserActionEvents {
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

export interface UploadResult extends BrowserActionEvents {
  success: boolean;
  selector: string;
  filePath?: string;
  error?: string;
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
  private tabIds = new WeakMap<object, string>();
  /** Open pages of the context in the order they were opened */
  private tabs = new Map<string, BrowserTabRecord>();
  private nextTabNumber = 1;
  private actionEvents: BrowserActionEventRecord[] = [];
  private eventSeq = 0;
  private lastReportedSeq = 0;
  private contextEventsAttached = false;
  private creatingPage = false;
  private closing = false;
  private explicitlyClosedTabs = new Set<string>();
  private tabOpenedWaiters = new Set<() => void>();
  /** The agent's decision for the next dialog; lapses after one action */
  private nextDialogDecision: (BrowserDialogDecision & { actionsLeft: number }) | null = null;
  private lastDialog: BrowserDialogReport | null = null;
  private downloads: BrowserDownloadEntry[] = [];
  private pendingDownloads = new Map<string, Promise<void>>();
  private reservedDownloadPaths = new Set<string>();
  private downloadReservations: Promise<unknown> = Promise.resolve();
  private downloadCount = 0;
  private consoleEntries: BrowserConsoleEntry[] = [];
  private networkEntries: BrowserNetworkEntry[] = [];
  private consoleDropped = 0;
  private networkDropped = 0;

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
      followPopups: options.followPopups ?? true,
      popupGraceMs: options.popupGraceMs ?? POPUP_GRACE_MS,
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

    await page.route("**/*", (route) => this.routeByNetworkPolicy(route));
  }

  /** Lets a request through only when the workspace network policy allows its URL. */
  private async routeByNetworkPolicy(route: Route): Promise<void> {
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
  }

  /**
   * Tracks every page the context opens as a tab. For a browser CoWork launched, the network
   * policy is also installed on the context: a page-level route is only added after the "page"
   * event, so a popup's first requests would otherwise run unchecked. An attached real browser
   * keeps page-level routes only, so the user's own tabs are not filtered.
   */
  private async configureContext(
    context: BrowserContext,
    applyContextRoute: boolean,
  ): Promise<void> {
    if (typeof (context as Any).on === "function") {
      context.on("page", (page: Page) => this.adoptPage(page));
      this.contextEventsAttached = true;
    }
    if (applyContextRoute && typeof (context as Any).route === "function") {
      await context.route("**/*", (route) => this.routeByNetworkPolicy(route));
    }
  }

  /** A page opened in the context: by the site (popup, target=_blank) or by createPage. */
  private adoptPage(page: Page): void {
    if (typeof (page as Any).setDefaultTimeout === "function") this.applyPageTimeouts(page);
    this.registerPage(page, true, !this.creatingPage);
    void this.configurePage(page).catch(() => {
      // Navigation and current-page checks remain authoritative if request
      // interception cannot be installed on a newly opened page.
    });
  }

  /** Opens a page for the service itself; it is not reported as a page the site opened. */
  private async createPage(context: BrowserContext): Promise<Page> {
    this.creatingPage = true;
    try {
      return await context.newPage();
    } finally {
      this.creatingPage = false;
    }
  }

  private registerPage(page: Page, owned: boolean, openedBySite: boolean): string {
    const existing = this.tabIds.get(page as object);
    if (existing) return existing;
    const tabId = `tab-${this.nextTabNumber++}`;
    this.tabIds.set(page as object, tabId);
    const record: BrowserTabRecord = { tabId, page, owned, openerReady: Promise.resolve() };
    this.tabs.set(tabId, record);
    if (typeof (page as Any).opener === "function") {
      record.openerReady = page
        .opener()
        .then((opener) => {
          const openerTabId = opener ? this.tabIds.get(opener as object) : undefined;
          if (openerTabId) record.openerTabId = openerTabId;
        })
        .catch(() => undefined);
    }
    if (typeof (page as Any).on === "function") {
      page.on("close", () => this.handlePageClosed(tabId));
      page.on("dialog", (dialog: Dialog) => this.handleDialog(dialog, tabId));
      page.on("download", (download: Download) => this.handleDownload(download, tabId));
      this.captureDiagnostics(page, tabId);
    }
    if (openedBySite) {
      this.pushActionEvent({ kind: "tab_opened", tabId });
      for (const notify of this.tabOpenedWaiters) notify();
    }
    return tabId;
  }

  /** Records console output, page errors and requests into bounded, redacted buffers. */
  private captureDiagnostics(page: Page, tabId: string): void {
    const pageUrl = () => {
      try {
        return redactBrowserText(page.url(), 300);
      } catch {
        return "";
      }
    };
    const record = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        log.debug("Could not record browser diagnostic:", error);
      }
    };
    page.on("console", (message: ConsoleMessage) =>
      record(() =>
        this.pushConsole({
          level: message.type(),
          text: redactBrowserText(message.text(), 1200),
          url: pageUrl(),
          tabId,
          timestamp: Date.now(),
        }),
      ),
    );
    page.on("pageerror", (error: Error) =>
      record(() =>
        this.pushConsole({
          level: "error",
          source: "pageerror",
          text: redactBrowserText(error?.message || String(error), 1200),
          url: pageUrl(),
          tabId,
          timestamp: Date.now(),
        }),
      ),
    );
    page.on("response", (response: PlaywrightResponse) =>
      record(() => {
        const request = response.request();
        this.pushNetwork({
          method: request.method(),
          url: redactBrowserText(response.url(), 1200),
          status: response.status(),
          resourceType: request.resourceType(),
          tabId,
          timestamp: Date.now(),
        });
      }),
    );
    page.on("requestfailed", (request: PlaywrightRequest) =>
      record(() =>
        this.pushNetwork({
          method: request.method(),
          url: redactBrowserText(request.url(), 1200),
          resourceType: request.resourceType(),
          failed: true,
          errorText: redactBrowserText(request.failure()?.errorText || "", 600),
          tabId,
          timestamp: Date.now(),
        }),
      ),
    );
  }

  private pushConsole(entry: BrowserConsoleEntry): void {
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > MAX_DIAGNOSTIC_ENTRIES) {
      this.consoleDropped += this.consoleEntries.length - MAX_DIAGNOSTIC_ENTRIES;
      this.consoleEntries = this.consoleEntries.slice(-MAX_DIAGNOSTIC_ENTRIES);
    }
  }

  private pushNetwork(entry: BrowserNetworkEntry): void {
    this.networkEntries.push(entry);
    if (this.networkEntries.length > MAX_DIAGNOSTIC_ENTRIES) {
      this.networkDropped += this.networkEntries.length - MAX_DIAGNOSTIC_ENTRIES;
      this.networkEntries = this.networkEntries.slice(-MAX_DIAGNOSTIC_ENTRIES);
    }
  }

  /** Console messages and uncaught page errors of every tab, oldest first. */
  getConsoleLog(): BrowserDiagnosticLog<BrowserConsoleEntry> {
    return {
      entries: this.consoleEntries.map((entry) => ({ ...entry })),
      dropped: this.consoleDropped,
    };
  }

  /** Finished (with status) and failed requests of every tab, oldest first. */
  getNetworkLog(): BrowserDiagnosticLog<BrowserNetworkEntry> {
    return {
      entries: this.networkEntries.map((entry) => ({ ...entry })),
      dropped: this.networkDropped,
    };
  }

  /** Counts and the last few entries, in the visible workbench snapshot's format. */
  getDiagnosticsSummary(): {
    console: BrowserDiagnosticSummary;
    network: BrowserDiagnosticSummary;
  } {
    return {
      console: {
        count: this.consoleEntries.length + this.consoleDropped,
        recent: this.consoleEntries
          .slice(-5)
          .map((entry) => `${entry.level}: ${entry.text}`.slice(0, 220)),
      },
      network: {
        count: this.networkEntries.length + this.networkDropped,
        recent: this.networkEntries
          .slice(-5)
          .map((entry) =>
            `${entry.failed ? `failed ${entry.errorText || ""}` : (entry.status ?? "")} ${entry.url}`
              .trim()
              .slice(0, 220),
          ),
      },
    };
  }

  private pushActionEvent(event: BrowserActionEventInput): void {
    this.eventSeq += 1;
    this.actionEvents.push({ ...event, seq: this.eventSeq });
    if (this.actionEvents.length > MAX_ACTION_EVENTS) {
      this.actionEvents = this.actionEvents.slice(-MAX_ACTION_EVENTS);
    }
  }

  private isPageClosed(page: Page): boolean {
    return typeof (page as Any).isClosed === "function" && page.isClosed();
  }

  /** Removes a closed tab; when it was active, control returns to its opener or the last tab. */
  private handlePageClosed(tabId: string): void {
    const record = this.tabs.get(tabId);
    if (!record) return;
    this.tabs.delete(tabId);
    const explicit = this.explicitlyClosedTabs.delete(tabId);
    if (this.closing || this.page !== record.page) return;
    const openTabs = [...this.tabs.values()].filter((tab) => !this.isPageClosed(tab.page));
    const opener = record.openerTabId ? this.tabs.get(record.openerTabId) : undefined;
    const fallback =
      opener && !this.isPageClosed(opener.page) ? opener : openTabs[openTabs.length - 1];
    this.page = fallback?.page ?? null;
    if (!explicit) {
      this.pushActionEvent({
        kind: "active_tab_closed",
        closedTabId: tabId,
        ...(fallback ? { activeTabId: fallback.tabId } : {}),
      });
    }
  }

  /**
   * A page dialog blocks the page until it is answered, so it is answered at once: dismissed,
   * unless the agent armed an accept for this one dialog with armNextDialog. Never accepting by
   * default keeps a destructive confirm() ("Delete all?") from going ahead unseen; the dialog
   * is reported on the action that caused it so the agent can decide and repeat the action.
   */
  private handleDialog(dialog: Dialog, tabId: string): void {
    const decision = this.nextDialogDecision;
    this.nextDialogDecision = null;
    const accept = decision?.accept === true;
    const type = dialog.type();
    const defaultValue = type === "prompt" ? dialog.defaultValue() : "";
    const report: BrowserDialogReport = {
      type,
      message: redactBrowserText(dialog.message(), 1200),
      ...(defaultValue ? { defaultValue: redactBrowserText(defaultValue, 300) } : {}),
      action: accept ? "accepted" : "dismissed",
      tabId,
      timestamp: Date.now(),
    };
    this.lastDialog = report;
    this.pushActionEvent({ kind: "dialog", dialog: report });
    log.info(`${accept ? "Accepted" : "Dismissed"} ${type} dialog in ${tabId}`);
    const answered = accept ? dialog.accept(decision?.promptText) : dialog.dismiss();
    void answered.catch(() => {
      // The page may have closed or answered the dialog itself.
    });
  }

  /**
   * Accept (or explicitly dismiss) the next dialog the page opens, optionally answering a
   * prompt(). Applies to one dialog during the next action, then lapses.
   */
  armNextDialog(decision: BrowserDialogDecision): {
    nextDialog: { action: "accept" | "dismiss"; promptText?: string };
    lastDialog?: BrowserDialogReport;
  } {
    const promptText = typeof decision.promptText === "string" ? decision.promptText : undefined;
    this.nextDialogDecision = {
      accept: decision.accept,
      ...(promptText !== undefined ? { promptText } : {}),
      actionsLeft: 1,
    };
    return {
      nextDialog: {
        action: decision.accept ? "accept" : "dismiss",
        ...(promptText !== undefined ? { promptText } : {}),
      },
      ...(this.lastDialog ? { lastDialog: this.lastDialog } : {}),
    };
  }

  getLastDialog(): BrowserDialogReport | null {
    return this.lastDialog;
  }

  /**
   * Playwright keeps a download in a temporary folder that is deleted with the context, so
   * each one is saved into the workspace downloads folder as soon as it starts.
   */
  private handleDownload(download: Download, tabId: string): void {
    this.downloadCount += 1;
    const entry: BrowserDownloadEntry = {
      id: `download-${this.downloadCount}`,
      status: "pending",
      suggestedFilename: sanitizeDownloadFilename(download.suggestedFilename()),
      url: redactBrowserText(download.url(), 1200),
      tabId,
      timestamp: Date.now(),
    };
    this.downloads.push(entry);
    if (this.downloads.length > MAX_DOWNLOAD_ENTRIES) {
      this.downloads = this.downloads.slice(-MAX_DOWNLOAD_ENTRIES);
    }
    const saving = this.saveDownload(download, entry, this.downloadCount).finally(() => {
      this.pendingDownloads.delete(entry.id);
    });
    this.pendingDownloads.set(entry.id, saving);
    this.pushActionEvent({ kind: "download", downloadId: entry.id });
  }

  private async saveDownload(
    download: Download,
    entry: BrowserDownloadEntry,
    ordinal: number,
  ): Promise<void> {
    let target: string | undefined;
    try {
      if (ordinal > MAX_DOWNLOADS_PER_SESSION) {
        throw new DownloadRejectedError(
          `Download limit of ${MAX_DOWNLOADS_PER_SESSION} files per browser session reached`,
        );
      }
      // Reserve names one download at a time, in the order the downloads started.
      const reservation = this.downloadReservations.then(() =>
        this.reserveDownloadPath(entry.suggestedFilename),
      );
      this.downloadReservations = reservation.catch(() => undefined);
      target = await reservation;
      await download.saveAs(target);
      const stat = await fs.stat(target);
      entry.path = path.relative(this.workspace.path, target);
      entry.size = stat.size;
      entry.status = "saved";
      log.info(`Saved browser download ${entry.path} (${stat.size} bytes)`);
    } catch (error) {
      entry.status = error instanceof DownloadRejectedError ? "rejected" : "failed";
      entry.error = (error as Error).message;
      log.warn(`Browser download ${entry.suggestedFilename} ${entry.status}: ${entry.error}`);
      await download.cancel().catch(() => {});
      await download.delete().catch(() => {});
    } finally {
      if (target) this.reservedDownloadPaths.delete(target);
    }
  }

  /**
   * A free path for a download inside the workspace downloads folder. The write must be
   * allowed by the workspace file policy (which also refuses protected paths), and downloads
   * are untrusted page content, so the canonical path must stay inside the workspace even
   * where the policy would allow writing elsewhere (unrestricted access, or a downloads
   * folder that is a symlink out of the workspace).
   */
  private async reserveDownloadPath(fileName: string): Promise<string> {
    const checkedPath = (relativePath: string, label: string): string => {
      const access = evaluateWorkspaceFilesystemAccess(this.workspace, relativePath, "write");
      if (access.decision !== "allow") {
        throw new DownloadRejectedError(
          `Access denied for ${label} "${relativePath}": ${access.reason}`,
        );
      }
      if (!isAccessPathWithin(this.workspace.path, access.path)) {
        throw new DownloadRejectedError(
          `${label} "${relativePath}" resolves outside the workspace`,
        );
      }
      return access.path;
    };

    const directory = checkedPath(BROWSER_DOWNLOADS_DIR, "browser download folder");
    await fs.mkdir(directory, { recursive: true });
    const { name, ext } = path.parse(fileName);
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const candidate = attempt === 0 ? fileName : `${name} (${attempt})${ext}`;
      const target = checkedPath(
        path.join(BROWSER_DOWNLOADS_DIR, candidate),
        "browser download path",
      );
      if (this.reservedDownloadPaths.has(target)) continue;
      // Reserve before the existence check so concurrent downloads never share a name.
      this.reservedDownloadPaths.add(target);
      const exists = await fs.lstat(target).then(
        () => true,
        () => false,
      );
      if (!exists) return target;
      this.reservedDownloadPaths.delete(target);
    }
    throw new DownloadRejectedError(`No free file name for download "${fileName}"`);
  }

  /** Downloads seen in this browser session, oldest first. */
  listDownloads(): BrowserDownloadEntry[] {
    return this.downloads.map((entry) => ({ ...entry }));
  }

  private waitForTabOpened(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.tabOpenedWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.tabOpenedWaiters.add(done);
    });
  }

  private async describeTab(record: BrowserTabRecord): Promise<BrowserTabInfo> {
    let title = "";
    await settleWithin(
      record.page.title().then((value) => {
        title = value;
      }),
      TAB_TITLE_TIMEOUT_MS,
    );
    return {
      tabId: record.tabId,
      url: record.page.url(),
      title,
      active: record.page === this.page,
      ...(record.openerTabId ? { openerTabId: record.openerTabId } : {}),
      backend: "playwright-local",
    };
  }

  /**
   * Reports what happened since the previous action: tabs the site opened (switching to one
   * this action opened), and the active tab closing.
   */
  private async collectActionEvents(
    actionStartSeq: number,
    mayOpenPopup: boolean,
  ): Promise<BrowserActionEvents> {
    const popupGraceMs = this.options.popupGraceMs ?? POPUP_GRACE_MS;
    if (
      mayOpenPopup &&
      this.contextEventsAttached &&
      popupGraceMs > 0 &&
      !this.actionEvents.some((event) => event.seq > actionStartSeq && event.kind === "tab_opened")
    ) {
      await this.waitForTabOpened(popupGraceMs);
    }

    const events = this.actionEvents.filter((event) => event.seq > this.lastReportedSeq);
    this.lastReportedSeq = this.eventSeq;
    const report: BrowserActionEvents = {};

    const opened: Array<{ record: BrowserTabRecord; seq: number }> = [];
    for (const event of events) {
      if (event.kind !== "tab_opened") continue;
      const record = this.tabs.get(event.tabId);
      if (record && !this.isPageClosed(record.page)) opened.push({ record, seq: event.seq });
    }
    let switched: BrowserTabRecord | undefined;
    let switchError: { tabId: string; error: string } | undefined;
    const candidate = this.options.followPopups
      ? [...opened].reverse().find((entry) => entry.seq > actionStartSeq)?.record
      : undefined;
    if (candidate) {
      await settleWithin(
        candidate.page.waitForLoadState("domcontentloaded", { timeout: POPUP_LOAD_WAIT_MS }),
        POPUP_LOAD_WAIT_MS,
      );
      await candidate.openerReady;
      try {
        this.assertPageUrlAllowed(candidate.page.url());
        this.page = candidate.page;
        switched = candidate;
        report.switchedToTab = await this.describeTab(candidate);
      } catch (error) {
        switchError = { tabId: candidate.tabId, error: (error as Error).message };
      }
    }
    const others = opened.filter((entry) => entry.record !== switched);
    if (others.length > 0) {
      report.newTabs = await Promise.all(
        others.map(async ({ record }) => ({
          ...(await this.describeTab(record)),
          ...(switchError?.tabId === record.tabId ? { error: switchError.error } : {}),
        })),
      );
    }

    const closed = [...events].reverse().find((event) => event.kind === "active_tab_closed");
    if (closed && closed.kind === "active_tab_closed" && !switched) {
      report.activeTabClosed = {
        closedTabId: closed.closedTabId,
        ...(closed.activeTabId ? { activeTabId: closed.activeTabId } : {}),
        ...(this.page ? { url: this.page.url() } : {}),
      };
    }

    const dialogs: BrowserDialogReport[] = [];
    for (const event of events) {
      if (event.kind === "dialog") dialogs.push(event.dialog);
    }
    const downloadIds = new Set<string>();
    for (const event of events) {
      if (event.kind === "download") downloadIds.add(event.downloadId);
    }
    if (downloadIds.size > 0) {
      const pending = [...downloadIds]
        .map((id) => this.pendingDownloads.get(id))
        .filter((saving): saving is Promise<void> => Boolean(saving));
      if (pending.length > 0) {
        await settleWithin(Promise.allSettled(pending), DOWNLOAD_REPORT_WAIT_MS);
      }
      report.downloads = this.downloads
        .filter((entry) => downloadIds.has(entry.id))
        .map((entry) => ({ ...entry }));
    }

    if (dialogs.length > 0) report.dialog = dialogs[0];
    if (dialogs.length > 1) report.dialogs = dialogs;
    if (this.nextDialogDecision) {
      this.nextDialogDecision.actionsLeft -= 1;
      if (this.nextDialogDecision.actionsLeft <= 0) {
        this.nextDialogDecision = null;
        report.dialogDecisionExpired = true;
      }
    }
    return report;
  }

  /** Runs a page action and attaches what it caused (popups, closed tabs) to its result. */
  private async withActionEvents<T extends object>(
    mayOpenPopup: boolean,
    action: () => Promise<T>,
  ): Promise<T & BrowserActionEvents> {
    const actionStartSeq = this.eventSeq;
    const result = await action();
    const events = await this.collectActionEvents(actionStartSeq, mayOpenPopup);
    return { ...result, ...events };
  }

  /** Tabs of the headless browser context, in the order they were opened. */
  async listTabs(): Promise<BrowserTabInfo[]> {
    if (this.page && !this.tabIds.has(this.page as object)) {
      this.registerPage(this.page, true, false);
    }
    const open = [...this.tabs.values()].filter((record) => !this.isPageClosed(record.page));
    return await Promise.all(open.map((record) => this.describeTab(record)));
  }

  /** Makes a tab the target of later actions. */
  async switchTab(
    tabId: string,
  ): Promise<{ success: boolean; tab?: BrowserTabInfo; error?: string }> {
    const record = this.tabs.get(tabId);
    if (!record || this.isPageClosed(record.page)) {
      return {
        success: false,
        error: `No open tab with id "${tabId}". Call browser_tabs to list open tabs.`,
      };
    }
    try {
      this.assertPageUrlAllowed(record.page.url());
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
    this.page = record.page;
    if (typeof (record.page as Any).bringToFront === "function") {
      await record.page.bringToFront().catch(() => {});
    }
    return { success: true, tab: await this.describeTab(record) };
  }

  /** Closes a tab; when it was active, later actions target its opener or the last tab. */
  async closeTab(
    tabId: string,
  ): Promise<{ success: boolean; closedTabId?: string; activeTabId?: string; error?: string }> {
    const record = this.tabs.get(tabId);
    if (!record) {
      return {
        success: false,
        error: `No open tab with id "${tabId}". Call browser_tabs to list open tabs.`,
      };
    }
    if (!record.owned) {
      return {
        success: false,
        error:
          "This tab was already open in the attached browser before CoWork connected; close it in the browser itself.",
      };
    }
    this.explicitlyClosedTabs.add(tabId);
    await record.page.close().catch(() => {});
    this.handlePageClosed(tabId);
    this.explicitlyClosedTabs.delete(tabId);
    const activeTabId = this.page ? this.tabIds.get(this.page as object) : undefined;
    return { success: true, closedTabId: tabId, ...(activeTabId ? { activeTabId } : {}) };
  }

  /** Whether a browser context exists, even if all of its tabs were closed. */
  hasSession(): boolean {
    return this.context !== null;
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
        await this.configureContext(context, false);
        const existingPage = context.pages()[0];
        const page = existingPage ?? (await this.createPage(context));
        this.applyPageTimeouts(page);
        await this.configurePage(page);
        this.registerPage(page, !existingPage, false);
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
          acceptDownloads: true,
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
          acceptDownloads: true,
        });
      }

      await this.configureContext(context, true);
      const page = context.pages()[0] ?? (await this.createPage(context));
      this.applyPageTimeouts(page);
      await this.configurePage(page);
      this.registerPage(page, true, false);

      // Only assign to instance variables after all operations succeed
      this.browser = browser;
      this.context = context;
      this.page = page;
    } catch (error) {
      // Cleanup partial initialization on error
      this.resetTabState();
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
    return await this.withActionEvents(false, () => this.navigateOnPage(url, waitUntil));
  }

  private async navigateOnPage(
    url: string,
    waitUntil: "load" | "domcontentloaded" | "networkidle",
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
   * consent and overlays the page like a banner, clicks only buttons whose accessible name
   * exactly matches a known consent choice (never links), and prefers reject / necessary-only
   * over accept-all. Any page can label a dialog, so in a dialog that is not a known consent
   * manager only reject / necessary-only choices are clicked. Skipped entirely for an attached
   * real browser or a persistent profile, where the choice would be made on the user's behalf
   * and outlive the task.
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
        if (
          CONSENT_DIALOG_TEXT_PATTERN.test(text) &&
          (await dialog.evaluate(isConsentOverlayLayout).catch(() => false)) === true
        ) {
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
          if (rank < 0 || (!container.isCmp && rank > 0) || (best && best.rank <= rank)) continue;
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
   * Get page content as text, paginated, plus links, forms and interactive elements
   */
  async getContent(options: PageContentOptions = {}): Promise<PageContent> {
    await this.ensurePage();
    this.assertPageUrlAllowed(this.page!.url());

    const url = this.page!.url();
    const title = await this.page!.title();

    const raw = ((await this.page!.evaluate(PAGE_CONTENT_SCRIPT)) || {}) as {
      bodyText?: string;
      mainText?: string;
      links?: Array<{ text: string; href: string }>;
      forms?: Array<{ action: string; method: string; inputs: string[] }>;
    };
    const bodyText = typeof raw.bodyText === "string" ? raw.bodyText : "";
    const mainText = typeof raw.mainText === "string" ? raw.mainText : "";
    // When the whole page does not fit in one default read, start from the main content
    // region so navigation and footer text cannot push it out of view.
    const useMain =
      options.scope !== "page" &&
      bodyText.length > DEFAULT_PAGE_TEXT_CHARS &&
      mainText.length >= MIN_MAIN_TEXT_CHARS;
    const textWindow = paginatePageText(
      useMain ? mainText : bodyText,
      options.offset,
      options.maxChars,
    );
    const interactive = await this.getInteractiveElements(
      PAGE_INTERACTIVE_LIMIT,
      PAGE_INTERACTIVE_LINK_LIMIT,
    ).catch(() => []);

    return {
      url,
      title,
      textScope: useMain ? "main" : "page",
      ...(useMain ? { pageTextChars: bodyText.length } : {}),
      ...textWindow,
      interactive,
      links: Array.isArray(raw.links) ? raw.links : [],
      forms: Array.isArray(raw.forms) ? raw.forms : [],
    };
  }

  /**
   * Click on an element
   */
  async click(selector: string, timeoutMs?: number): Promise<ClickResult> {
    return await this.withActionEvents(true, () => this.clickOnPage(selector, timeoutMs));
  }

  private async clickOnPage(selector: string, timeoutMs?: number): Promise<ClickResult> {
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
    return await this.withActionEvents(false, () => this.fillOnPage(selector, value, timeoutMs));
  }

  private async fillOnPage(
    selector: string,
    value: string,
    timeoutMs?: number,
  ): Promise<FillResult> {
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
    return await this.withActionEvents(false, () =>
      this.typeOnPage(selector, text, delay, timeoutMs),
    );
  }

  private async typeOnPage(
    selector: string,
    text: string,
    delay: number,
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
  async press(key: string): Promise<{ success: boolean; key: string } & BrowserActionEvents> {
    return await this.withActionEvents(true, () => this.pressOnPage(key));
  }

  private async pressOnPage(key: string): Promise<{ success: boolean; key: string }> {
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
  async evaluate(script: string): Promise<EvaluateResult & BrowserActionEvents> {
    return await this.withActionEvents(false, () => this.evaluateOnPage(script));
  }

  private async evaluateOnPage(script: string): Promise<EvaluateResult> {
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
   * Set the file of an input[type=file]. The caller must already have passed filePath through
   * the workspace read checks (and any external-file approval); the page only receives it.
   */
  async uploadFile(selector: string, filePath: string, timeoutMs?: number): Promise<UploadResult> {
    return await this.withActionEvents(false, () =>
      this.uploadFileOnPage(selector, filePath, timeoutMs),
    );
  }

  private async uploadFileOnPage(
    selector: string,
    filePath: string,
    timeoutMs?: number,
  ): Promise<UploadResult> {
    await this.ensurePage();
    const timeout = this.getActionTimeout(timeoutMs);
    // File inputs are often hidden behind a styled button, so wait for the element to exist
    // rather than for it to be visible.
    const locator = this.page!.locator(selector).first();
    try {
      await locator.setInputFiles(filePath, { timeout });
      return { success: true, selector, filePath };
    } catch (error) {
      if (isPlaywrightTimeoutError(error) && (await locator.count().catch(() => -1)) === 0) {
        const notFound = await this.selectorNotFoundError(selector, timeout);
        return {
          success: false,
          selector,
          error: notFound.message,
          candidates: notFound.candidates,
        };
      }
      return { success: false, selector, error: (error as Error).message };
    }
  }

  /**
   * Select option from dropdown
   */
  async select(selector: string, value: string): Promise<FillResult> {
    return await this.withActionEvents(false, () => this.selectOnPage(selector, value));
  }

  private async selectOnPage(selector: string, value: string): Promise<FillResult> {
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
    return await this.withActionEvents(false, () => this.goBackOnPage());
  }

  private async goBackOnPage(): Promise<NavigateResult> {
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
    return await this.withActionEvents(false, () => this.goForwardOnPage());
  }

  private async goForwardOnPage(): Promise<NavigateResult> {
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
    return await this.withActionEvents(false, () => this.reloadOnPage());
  }

  private async reloadOnPage(): Promise<NavigateResult> {
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
    this.closing = true;
    try {
      if (this.pendingDownloads.size > 0) {
        await settleWithin(
          Promise.allSettled(this.pendingDownloads.values()),
          DOWNLOAD_CLOSE_WAIT_MS,
        );
      }
      await this.closeBrowser();
    } finally {
      this.resetTabState();
      this.closing = false;
    }
  }

  private async closeBrowser(): Promise<void> {
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

  private resetTabState(): void {
    this.tabs.clear();
    this.tabIds = new WeakMap<object, string>();
    this.nextTabNumber = 1;
    this.actionEvents = [];
    this.lastReportedSeq = this.eventSeq;
    this.contextEventsAttached = false;
    this.explicitlyClosedTabs.clear();
    this.nextDialogDecision = null;
  }

  /**
   * Ensure page is initialized. When every tab was closed (by the agent or by the site) a
   * fresh page is opened in the existing context rather than launching another browser.
   */
  private async ensurePage(): Promise<void> {
    if (this.page && this.isPageClosed(this.page)) {
      const tabId = this.tabIds.get(this.page as object);
      if (tabId) this.handlePageClosed(tabId);
      if (this.page && this.isPageClosed(this.page)) this.page = null;
    }
    if (!this.page && this.context) {
      const page = await this.createPage(this.context);
      this.applyPageTimeouts(page);
      await this.configurePage(page);
      this.registerPage(page, true, false);
      this.page = page;
    } else if (!this.page) {
      await this.init();
    }
    this.assertPageUrlAllowed(this.page?.url() || "");
  }
}

export const _testUtils = {
  normalizeEvaluateScript,
};
