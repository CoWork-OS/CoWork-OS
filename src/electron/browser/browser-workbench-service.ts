import * as fs from "fs/promises";
import * as path from "path";
import type { AccessDomainRule } from "../../shared/access-profiles";
import type { WorkspacePermissions } from "../../shared/types";
import { IPC_CHANNELS } from "../../shared/types";
import type { BrowserShortcutCommand } from "../../shared/browser-shortcuts";
import type { BrowserContextAction } from "./browser-context-menu";
import {
  BrowserSessionManager,
  type BrowserNavigationBlockedEvent,
  type BrowserPageDialogEvent,
  type BrowserSnapshotOptions,
  type BrowserTabKind,
  DEFAULT_BROWSER_TAB_ID,
  getBrowserSessionManager,
} from "./browser-session-manager";
import {
  BrowserPermissionManager,
  type BrowserPermissionPrompt,
  type BrowserPermissionResponse,
} from "./browser-permissions";
import { isLocalHtmlFileUrl, isLoopbackHttpUrl, normalizeWebviewUrl } from "./webview-url-policy";
import { assertWorkspaceFilesystemAccess } from "../security/access-profile-paths";
import {
  buildSelectOptionExpression,
  buildSelectorResolverExpression,
} from "./browser-page-scripts";

type AnyRecord = Record<string, unknown>;

export interface BrowserWorkbenchOpenRequest {
  requestId: string;
  taskId: string;
  sessionId: string;
  url?: string;
}

export interface BrowserWorkbenchSessionRegistration {
  taskId: string;
  sessionId: string;
  /** Workbench tab this webContents renders (omitted by single-tab callers). */
  tabId?: string;
  kind?: BrowserTabKind;
  openerTabId?: string;
  /** Make this the tab tools act on. */
  activate?: boolean;
  webContentsId: number;
  url?: string;
  title?: string;
}

export interface BrowserWorkbenchShortcutEvent {
  taskId?: string;
  sessionId?: string;
  tabId?: string;
  command: BrowserShortcutCommand;
  /** From a trackpad swipe or mouse button rather than the keyboard. */
  gesture?: boolean;
  at: number;
}

/** Main -> renderer: CoWork is (or stopped) acting in the workbench, and whether the user paused it. */
export interface BrowserWorkbenchDrivingEvent {
  taskId: string;
  sessionId: string;
  tabId?: string;
  driving: { toolName: string; label: string; startedAt: number } | null;
  pausedByUser: boolean;
  at: number;
}

/** Main -> renderer: a download in a workbench tab started, progressed or finished. */
export interface BrowserWorkbenchDownloadEvent {
  id: string;
  taskId: string;
  sessionId: string;
  tabId: string;
  url: string;
  filename: string;
  savePath?: string;
  state: "progressing" | "paused" | "completed" | "cancelled" | "interrupted" | "blocked";
  receivedBytes: number;
  totalBytes: number;
  dangerous: boolean;
  agentInitiated: boolean;
  startedAt: number;
  error?: string;
  at: number;
}

/** Main -> renderer: an agent navigation landed on a sign-in page the user should complete. */
export interface BrowserWorkbenchSignInEvent {
  taskId: string;
  sessionId: string;
  tabId?: string;
  url: string;
  at: number;
}

export interface BrowserWorkbenchContextActionEvent {
  taskId: string;
  sessionId: string;
  tabId: string;
  action: BrowserContextAction;
  at: number;
}

/** Main -> renderer: open, show or close a workbench tab. */
export interface BrowserWorkbenchTabCommand {
  taskId: string;
  sessionId: string;
  command: "open" | "activate" | "close";
  tabId: string;
  url?: string;
  /** Open without switching the visible tab (middle-click, background-tab disposition). */
  background?: boolean;
  openerTabId?: string;
  at: number;
}

export interface BrowserWorkbenchCursorEvent {
  taskId: string;
  sessionId: string;
  x: number;
  y: number;
  kind:
    | "move"
    | "click"
    | "fill"
    | "type"
    | "press"
    | "scroll"
    | "wait"
    | "select"
    | "read"
    | "navigate";
  label?: string;
  pulse?: boolean;
  at: number;
}

export interface BrowserWorkbenchViewportEvent {
  taskId: string;
  sessionId: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  label: string;
  at: number;
}

/** A workbench session as seen by tools: identity plus its active tab. */
type BrowserWorkbenchSession = {
  taskId: string;
  sessionId: string;
  /** The active tab tools act on. */
  tabId?: string;
  webContentsId: number;
  url?: string;
  title?: string;
  registeredAt: number;
};

const TAB_OPEN_TIMEOUT_MS = 12_000;

function normalizeSessionId(sessionId?: unknown): string {
  const value = typeof sessionId === "string" ? sessionId.trim() : "";
  return value || "default";
}

function sessionKey(taskId: string, sessionId?: unknown): string {
  return `${taskId}:${normalizeSessionId(sessionId)}`;
}

function normalizeUrl(rawUrl?: unknown): string {
  const value = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!value) return "";
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|::1)(?::\d+)?(?:\/|$)/i.test(value)) {
    return `http://${value}`;
  }
  return `https://${value}`;
}

const AUTH_HOSTS =
  /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|auth0\.com|okta\.com|onelogin\.com|login\.salesforce\.com)$/i;
const AUTH_PATH = /\/(login|log-in|signin|sign-in|sign_in|auth|sso|oauth2?|session\/new)(\/|$|\?)/i;

/**
 * A page that wants the user to sign in: a known identity provider, or a
 * login-looking path showing a password field. Agents must hand these back.
 */
export async function detectSignInWall(contents: Any, url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (AUTH_HOSTS.test(parsed.hostname)) return true;
  const hasPassword = await contents
    .executeJavaScript?.(
      `(() => Array.from(document.querySelectorAll('input[type="password"]')).some((el) => {
        const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
      }))()`,
    )
    .catch(() => false);
  return hasPassword === true && (AUTH_PATH.test(parsed.pathname) || parsed.pathname === "/");
}

/** CSS properties annotation "Adjust" may preview. */
export const ADJUSTABLE_STYLE_PROPERTIES = [
  "color",
  "backgroundColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "textAlign",
  "margin",
  "padding",
  "borderRadius",
] as const;

/** Page-side helpers shared by the inspect expressions: CSS path, XPath and a description. */
const PAGE_DESCRIBE_HELPERS = `
  const cssEscape = (value) =>
    window.CSS && typeof window.CSS.escape === "function"
      ? window.CSS.escape(value)
      : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  const selectorFor = (node) => {
    if (!(node instanceof Element)) return "";
    const parts = [];
    let current = node;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = current.localName.toLowerCase();
      if (current.id) {
        parts.unshift(part + "#" + cssEscape(current.id));
        break;
      }
      const classNames = Array.from(current.classList || []).slice(0, 3);
      if (classNames.length > 0) part += "." + classNames.map(cssEscape).join(".");
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.localName === current.localName);
        if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const describe = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      selector: selectorFor(el),
      tagName: el.tagName ? el.tagName.toLowerCase() : "",
      role: el.getAttribute("role") || "",
      accessibleName: el.getAttribute("aria-label") || el.getAttribute("title") || "",
      textQuote: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 160),
    };
  };
`;

/** Banner text for what CoWork is doing in the tab. */
function drivingLabel(toolName: string): string {
  const labels: Record<string, string> = {
    browser_navigate: "Opening a page",
    browser_click: "Clicking",
    browser_fill: "Filling in a field",
    browser_type: "Typing",
    browser_press: "Pressing a key",
    browser_scroll: "Scrolling",
    browser_select: "Choosing an option",
    browser_snapshot: "Reading the page",
    browser_get_content: "Reading the page",
    browser_get_text: "Reading the page",
    browser_screenshot: "Taking a screenshot",
    browser_upload_file: "Uploading a file",
    browser_hover: "Hovering",
    browser_drag: "Dragging",
    browser_wait: "Waiting for the page",
    browser_act_batch: "Working in the page",
  };
  return labels[toolName] || "Working in the page";
}

/**
 * Page expression: resolve `selector` with the shared resolver and run `body`
 * with `el` bound to the element. Selector errors become `{ success: false }`.
 */
function withResolvedElementScript(selector: string, body: string): string {
  return `
    (() => {
      const selector = ${JSON.stringify(selector)};
      const el = ${buildSelectorResolverExpression(selector)};
      if (typeof el === "string") {
        return { success: false, selector, error: el.startsWith("invalid:") ? "Invalid selector: " + el.slice(8) : "Element not found: " + selector };
      }
      ${body}
    })()
  `;
}

export class BrowserWorkbenchService {
  private mainWindow: Any | null = null;
  private sessions = new Map<string, BrowserWorkbenchSession>();
  private waiters = new Map<string, Array<(session: BrowserWorkbenchSession | null) => void>>();
  private tabWaiters = new Map<string, Array<(registered: boolean) => void>>();
  private allowedLocalPreviewUrls = new Map<string, number>();
  private permissionManager: BrowserPermissionManager | null = null;
  private driving = new Map<
    string,
    { toolName: string; label: string; startedAt: number; depth: number }
  >();
  private lastDrivenAt = new Map<string, number>();
  private pausedByUser = new Set<string>();

  constructor(private browserSessionManager: BrowserSessionManager = getBrowserSessionManager()) {
    // Tests pass partial managers; the listener is optional there.
    this.browserSessionManager.setNavigationBlockedListener?.((event) =>
      this.sendToRenderer(IPC_CHANNELS.BROWSER_WORKBENCH_NAVIGATION_BLOCKED, event),
    );
    // Tabs show page dialogs in the workbench; popup windows have no workbench UI.
    this.browserSessionManager.setPageDialogListener?.((event) => {
      if (event.kind === "popup") {
        if (event.state === "open") this.popupDialogHandler?.(event);
        return;
      }
      this.sendToRenderer(IPC_CHANNELS.BROWSER_WORKBENCH_PAGE_DIALOG, event);
    });
  }

  private popupDialogHandler: ((event: BrowserPageDialogEvent) => void) | null = null;

  /** Shows a popup window's alert/confirm (main process, native dialog). */
  setPopupDialogHandler(handler: ((event: BrowserPageDialogEvent) => void) | null): void {
    this.popupDialogHandler = handler;
  }

  respondToPageDialog(input: {
    taskId: string;
    sessionId: string;
    tabId: string;
    dialogId: string;
    accept: boolean;
  }): Promise<boolean> {
    return this.browserSessionManager.respondToPageDialog(input).catch(() => false);
  }

  /** Site permission handling for the browser partitions (one instance per app). */
  getPermissionManager(): BrowserPermissionManager {
    if (!this.permissionManager) {
      this.permissionManager = new BrowserPermissionManager({
        resolveOwner: (webContentsId) => {
          const owner = this.browserSessionManager.findTabOwner(webContentsId);
          return owner
            ? { taskId: owner.taskId, sessionId: owner.sessionId, tabId: owner.tabId }
            : null;
        },
        sendPrompt: (prompt: BrowserPermissionPrompt) =>
          this.sendToRenderer(IPC_CHANNELS.BROWSER_WORKBENCH_PERMISSION_REQUEST, prompt),
      });
    }
    return this.permissionManager;
  }

  respondToPermission(requestId: string, response: BrowserPermissionResponse): boolean {
    return this.getPermissionManager().respond(requestId, response);
  }

  listPendingPermissions(taskId: string, sessionId?: unknown): BrowserPermissionPrompt[] {
    return this.getPermissionManager().listPending({
      taskId,
      sessionId: normalizeSessionId(sessionId),
    });
  }

  setAccessPolicy(input: {
    taskId: string;
    sessionId?: unknown;
    networkEnabled: boolean;
    accessNetworkMode?: "disabled" | "on-request" | "enabled";
    profileDomainRules?: AccessDomainRule[];
  }): void {
    this.browserSessionManager.setAccessPolicy(
      input.taskId,
      {
        networkEnabled: input.networkEnabled,
        accessNetworkMode: input.accessNetworkMode,
        profileDomainRules: input.profileDomainRules,
      },
      input.sessionId,
    );
  }

  clearAccessPolicy(taskId: string, sessionId?: unknown): void {
    this.browserSessionManager.clearAccessPolicy(taskId, sessionId);
  }

  setMainWindow(window: Any | null): void {
    this.mainWindow = window;
  }

  async registerSession(
    registration: BrowserWorkbenchSessionRegistration,
  ): Promise<BrowserWorkbenchSession> {
    const sessionId = normalizeSessionId(registration.sessionId);
    const key = sessionKey(registration.taskId, sessionId);
    const tabId = registration.tabId?.trim() || DEFAULT_BROWSER_TAB_ID;
    const existing = this.sessions.get(key);
    const becomesActive =
      !existing || registration.activate === true || existing.tabId === tabId || !existing.tabId;
    const session: BrowserWorkbenchSession =
      existing && !becomesActive
        ? existing
        : {
            taskId: registration.taskId,
            sessionId,
            tabId,
            webContentsId: registration.webContentsId,
            url: registration.url,
            title: registration.title,
            registeredAt: existing?.registeredAt || Date.now(),
          };
    this.sessions.set(key, session);
    await this.browserSessionManager.registerElectronWorkbenchSession({
      ...registration,
      sessionId,
      tabId,
    });
    const activeTabId = this.browserSessionManager.getActiveTabId?.(registration.taskId, sessionId);
    if (activeTabId) this.syncActiveTab(key, activeTabId);
    const current = this.sessions.get(key) || session;
    const waiters = this.waiters.get(key);
    if (waiters) {
      this.waiters.delete(key);
      for (const resolve of waiters) resolve(current);
    }
    const tabKey = `${key}|${tabId}`;
    const tabWaiters = this.tabWaiters.get(tabKey);
    if (tabWaiters) {
      this.tabWaiters.delete(tabKey);
      for (const resolve of tabWaiters) resolve(true);
    }
    return current;
  }

  unregisterSession(input: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
    webContentsId?: number;
  }): { activeTabClosed: boolean; activeTabId?: string } {
    const sessionId = normalizeSessionId(input.sessionId);
    const key = sessionKey(input.taskId, sessionId);
    const existing = this.sessions.get(key);
    if (!existing) return { activeTabClosed: false };
    // The manager matches tabId/webContentsId, so a stale unregister from a
    // replaced webContents removes nothing.
    const result = this.browserSessionManager.unregisterSession({ ...input, sessionId }) || {
      activeTabClosed: true,
    };
    const tabs = this.browserSessionManager.getTabs?.(input.taskId, sessionId) || [];
    if (tabs.length === 0) {
      this.sessions.delete(key);
      return result;
    }
    if (result.activeTabClosed && result.activeTabId) {
      this.syncActiveTab(key, result.activeTabId);
      // Show the tab tools moved to (the opener of a closed popup, or the last used tab).
      this.sendTabCommand(existing, { command: "activate", tabId: result.activeTabId });
    }
    return result;
  }

  updateSessionStatus(input: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
    webContentsId?: number;
    url?: string;
    title?: string;
  }): void {
    const key = sessionKey(input.taskId, input.sessionId);
    const existing = this.sessions.get(key);
    if (!existing) return;
    const isActive = input.tabId
      ? input.tabId === existing.tabId
      : typeof input.webContentsId !== "number" || existing.webContentsId === input.webContentsId;
    if (isActive) {
      this.sessions.set(key, {
        ...existing,
        url: input.url ?? existing.url,
        title: input.title ?? existing.title,
      });
    }
    this.browserSessionManager.updateSession(input);
  }

  /**
   * Make a tab the one tools act on. The renderer calls this when the user
   * switches tabs; tools call it with `notifyRenderer` to show the tab.
   */
  activateTab(input: {
    taskId: string;
    sessionId?: unknown;
    tabId: string;
    notifyRenderer?: boolean;
  }): boolean {
    const sessionId = normalizeSessionId(input.sessionId);
    if (!this.browserSessionManager.activateTab(input.taskId, input.tabId, sessionId)) return false;
    const key = sessionKey(input.taskId, sessionId);
    this.syncActiveTab(key, input.tabId);
    const session = this.sessions.get(key);
    if (input.notifyRenderer && session) {
      this.sendTabCommand(session, { command: "activate", tabId: input.tabId });
    }
    return true;
  }

  /**
   * Open a new workbench tab and wait until its page is registered and guarded.
   * Returns the new tab id, or null when no workbench window shows it in time.
   */
  async openTab(input: {
    taskId: string;
    sessionId?: unknown;
    url?: string;
    background?: boolean;
    openerTabId?: string;
    tabId?: string;
    waitForRegistration?: boolean;
  }): Promise<string | null> {
    const sessionId = normalizeSessionId(input.sessionId);
    const session = this.getSession(input.taskId, sessionId);
    if (!session) return null;
    const url = input.url ? normalizeUrl(input.url) : "";
    if (url) this.browserSessionManager.assertUrlAllowed(input.taskId, url, sessionId);
    const tabId =
      input.tabId || `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const registered =
      input.waitForRegistration === false
        ? Promise.resolve(true)
        : this.waitForTab(input.taskId, sessionId, tabId, TAB_OPEN_TIMEOUT_MS);
    if (
      !this.sendTabCommand(session, {
        command: "open",
        tabId,
        url: url || undefined,
        background: input.background === true,
        openerTabId: input.openerTabId,
      })
    ) {
      return null;
    }
    return (await registered) ? tabId : null;
  }

  /** Ask the renderer to close a workbench tab (popups close their own window). */
  async closeTab(input: { taskId: string; sessionId?: unknown; tabId: string }): Promise<boolean> {
    const session = this.getSession(input.taskId, input.sessionId);
    if (!session) return false;
    const tab = this.browserSessionManager
      .getTabs(input.taskId, session.sessionId)
      .find((candidate) => candidate.tabId === input.tabId);
    if (!tab) return false;
    if (tab.kind === "popup") {
      // Popup windows are not renderer tabs: close the window as if the page called window.close().
      const webContentsId = this.browserSessionManager.getTabWebContentsId(
        input.taskId,
        input.tabId,
        session.sessionId,
      );
      const electron = await import("electron");
      const contents =
        typeof webContentsId === "number"
          ? (electron as Any).webContents?.fromId?.(webContentsId)
          : null;
      if (!contents || contents.isDestroyed?.()) return false;
      contents.close?.();
      return true;
    }
    return this.sendTabCommand(session, { command: "close", tabId: input.tabId });
  }

  /**
   * CoWork started a tool call on the visible workbench. Calls nest (a batch
   * runs several); the session counts as driving until the last one ends.
   */
  beginDriving(taskId: string, sessionId: unknown, toolName: string): void {
    const key = sessionKey(taskId, sessionId);
    const current = this.driving.get(key);
    this.driving.set(key, {
      toolName,
      label: drivingLabel(toolName),
      startedAt: current?.startedAt || Date.now(),
      depth: (current?.depth || 0) + 1,
    });
    this.emitDriving(taskId, sessionId);
  }

  endDriving(taskId: string, sessionId: unknown): void {
    const key = sessionKey(taskId, sessionId);
    const current = this.driving.get(key);
    this.lastDrivenAt.set(key, Date.now());
    if (!current) return;
    if (current.depth > 1) {
      this.driving.set(key, { ...current, depth: current.depth - 1 });
      return;
    }
    this.driving.delete(key);
    this.emitDriving(taskId, sessionId);
  }

  isDriving(taskId: string, sessionId?: unknown): boolean {
    return this.driving.has(sessionKey(taskId, sessionId));
  }

  /** CoWork acted on the session within the last few seconds (a download it caused, for example). */
  wasRecentlyDriven(taskId: string, sessionId?: unknown, withinMs = 5_000): boolean {
    const key = sessionKey(taskId, sessionId);
    if (this.driving.has(key)) return true;
    const last = this.lastDrivenAt.get(key);
    return typeof last === "number" && Date.now() - last <= withinMs;
  }

  /** The user took over the tab: CoWork's next workbench tool calls report paused_by_user. */
  setPausedByUser(taskId: string, sessionId: unknown, paused: boolean): void {
    const key = sessionKey(taskId, sessionId);
    if (paused) this.pausedByUser.add(key);
    else this.pausedByUser.delete(key);
    this.emitDriving(taskId, sessionId);
  }

  isPausedByUser(taskId: string, sessionId?: unknown): boolean {
    return this.pausedByUser.has(sessionKey(taskId, sessionId));
  }

  emitDownload(event: Omit<BrowserWorkbenchDownloadEvent, "at">): void {
    this.sendToRenderer(IPC_CHANNELS.BROWSER_WORKBENCH_DOWNLOAD_EVENT, {
      ...event,
      at: Date.now(),
    });
  }

  emitSignInRequired(taskId: string, sessionId: unknown, url: string): void {
    const session = this.getSession(taskId, sessionId);
    this.sendToRenderer(IPC_CHANNELS.BROWSER_WORKBENCH_SIGN_IN_REQUIRED, {
      taskId,
      sessionId: normalizeSessionId(sessionId),
      tabId: session?.tabId,
      url,
      at: Date.now(),
    });
  }

  private emitDriving(taskId: string, sessionId: unknown): void {
    const key = sessionKey(taskId, sessionId);
    const current = this.driving.get(key);
    this.sendToRenderer(IPC_CHANNELS.BROWSER_WORKBENCH_DRIVING, {
      taskId,
      sessionId: normalizeSessionId(sessionId),
      tabId: this.getSession(taskId, sessionId)?.tabId,
      driving: current
        ? { toolName: current.toolName, label: current.label, startedAt: current.startedAt }
        : null,
      pausedByUser: this.pausedByUser.has(key),
      at: Date.now(),
    });
  }

  /**
   * A browser shortcut, run by the renderer. With an owner it came from that
   * tab's page; without one from the workbench chrome or a window gesture, and
   * the visible workbench handles it (`gesture` ones only when it is focused).
   */
  sendShortcut(
    owner: { taskId: string; sessionId: string; tabId: string } | undefined,
    command: BrowserShortcutCommand,
    gesture = false,
  ): boolean {
    return this.sendToRenderer(IPC_CHANNELS.BROWSER_WORKBENCH_SHORTCUT, {
      ...(owner ? { taskId: owner.taskId, sessionId: owner.sessionId, tabId: owner.tabId } : {}),
      command,
      ...(gesture ? { gesture: true } : {}),
      at: Date.now(),
    } satisfies BrowserWorkbenchShortcutEvent);
  }

  /** A page context-menu action that the renderer performs (search, ask, annotate, screenshot). */
  sendContextAction(
    owner: { taskId: string; sessionId: string; tabId: string },
    action: BrowserContextAction,
  ): boolean {
    return this.sendToRenderer(IPC_CHANNELS.BROWSER_WORKBENCH_CONTEXT_ACTION, {
      taskId: owner.taskId,
      sessionId: owner.sessionId,
      tabId: owner.tabId,
      action,
      at: Date.now(),
    } satisfies BrowserWorkbenchContextActionEvent);
  }

  /** Show a blocked-page notice on a tab for a navigation that was refused before it started. */
  notifyNavigationBlocked(
    owner: { taskId: string; sessionId: string; tabId: string },
    url: string,
    block: { reason: BrowserNavigationBlockedEvent["reason"]; detail?: string },
  ): void {
    this.sendToRenderer(IPC_CHANNELS.BROWSER_WORKBENCH_NAVIGATION_BLOCKED, {
      taskId: owner.taskId,
      sessionId: owner.sessionId,
      tabId: owner.tabId,
      url,
      reason: block.reason,
      ...(block.detail ? { detail: block.detail } : {}),
      at: Date.now(),
    } satisfies BrowserNavigationBlockedEvent);
  }

  /**
   * A navigation the user started from the workbench (address bar, new tab).
   * Loopback dev servers become reachable for this session without the agent
   * TTL; every other URL is checked against the session's access policy.
   */
  userNavigate(input: { taskId: string; sessionId?: unknown; url: unknown }): {
    allowed: boolean;
    url: string;
    block?: { reason: string; detail?: string };
  } {
    const sessionId = normalizeSessionId(input.sessionId);
    const url = normalizeUrl(input.url);
    if (!url) return { allowed: false, url: "", block: { reason: "scheme", detail: "empty" } };
    if (isLoopbackHttpUrl(url)) {
      this.browserSessionManager.allowUserLocalPreviewUrl(input.taskId, url, sessionId);
    }
    const block = this.browserSessionManager.explainUrlBlock(input.taskId, url, sessionId);
    return block ? { allowed: false, url, block } : { allowed: true, url };
  }

  getSession(taskId: string, sessionId?: unknown): BrowserWorkbenchSession | null {
    const session = this.sessions.get(sessionKey(taskId, sessionId));
    if (!session) return null;
    return session;
  }

  allowLocalPreviewUrl(rawUrl: string): void {
    if (!isLocalHtmlFileUrl(rawUrl) && !isLoopbackHttpUrl(rawUrl)) return;
    const normalized = normalizeWebviewUrl(rawUrl);
    if (!normalized) return;
    this.allowedLocalPreviewUrls.set(normalized, Date.now() + 5 * 60_000);
    this.browserSessionManager.allowLocalPreviewUrl(normalized);
  }

  revokeLocalPreviewUrl(rawUrl: string): void {
    const normalized = normalizeWebviewUrl(rawUrl);
    if (!normalized) return;
    this.allowedLocalPreviewUrls.delete(normalized);
    this.browserSessionManager.revokeLocalPreviewUrl(normalized);
  }

  isAllowedLocalPreviewUrl(rawUrl: string): boolean {
    const normalized = normalizeWebviewUrl(rawUrl);
    if (!normalized) return false;
    const expiresAt = this.allowedLocalPreviewUrls.get(normalized);
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
      this.allowedLocalPreviewUrls.delete(normalized);
      return false;
    }
    this.allowedLocalPreviewUrls.set(normalized, Date.now() + 5 * 60_000);
    return true;
  }

  async requestOpen(input: {
    taskId: string;
    sessionId?: unknown;
    url?: unknown;
  }): Promise<BrowserWorkbenchSession | null> {
    const sessionId = normalizeSessionId(input.sessionId);
    const existing = this.getSession(input.taskId, sessionId);
    if (existing) return existing;
    if (!this.mainWindow || this.mainWindow.isDestroyed?.()) return null;

    const request: BrowserWorkbenchOpenRequest = {
      requestId: `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId: input.taskId,
      sessionId,
      url: normalizeUrl(input.url),
    };
    if (request.url) {
      this.allowLocalPreviewUrl(request.url);
    }
    this.mainWindow.webContents.send(IPC_CHANNELS.BROWSER_WORKBENCH_OPEN_REQUEST, request);
    return await this.waitForSession(input.taskId, sessionId, 12_000);
  }

  async navigate(input: {
    taskId: string;
    sessionId?: unknown;
    url: unknown;
    waitUntil?: string;
  }): Promise<AnyRecord | null> {
    const url = normalizeUrl(input.url);
    if (!url) return null;
    // Agent navigation to a loopback dev server gets the TTL allowance up front;
    // the tool already applied the network policy to it.
    if (isLoopbackHttpUrl(url)) this.allowLocalPreviewUrl(url);
    this.browserSessionManager.assertUrlAllowed(input.taskId, url, input.sessionId);
    const session =
      this.getSession(input.taskId, input.sessionId) ||
      (await this.requestOpen({ taskId: input.taskId, sessionId: input.sessionId, url }));
    this.browserSessionManager.assertUrlAllowed(input.taskId, url, input.sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    this.allowLocalPreviewUrl(url);
    this.emitCursor(session, { x: 32, y: 32, kind: "navigate", label: "Navigate", pulse: true });
    const loadPromise = this.waitForLoad(contents, 45_000);
    try {
      await contents.loadURL(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_ABORTED")) {
        throw error;
      }
    }
    await loadPromise.catch(() => undefined);
    const landedUrl = contents.getURL?.() || url;
    const signIn = await detectSignInWall(contents, landedUrl).catch(() => false);
    if (signIn) this.emitSignInRequired(input.taskId, input.sessionId, landedUrl);
    return {
      success: true,
      url: landedUrl,
      title: contents.getTitle?.() || "",
      status: null,
      visible: true,
      ...(signIn
        ? {
            needs_user_sign_in: true,
            hint:
              "This page asks the user to sign in. Do not type credentials. Tell the user to sign " +
              "in in the visible browser; they will reply when done, then continue on this tab.",
          }
        : {}),
    };
  }

  async getContent(taskId: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const contents = await this.getWebContents(this.getSession(taskId, sessionId));
    if (!contents) return null;
    return await contents.executeJavaScript(`
      (() => ({
        url: location.href,
        title: document.title || "",
        text: (document.body?.innerText || "").replace(/\\s+/g, " ").trim(),
        links: Array.from(document.links).slice(0, 200).map((link) => ({ text: (link.innerText || link.textContent || "").trim(), href: link.href })),
        forms: Array.from(document.forms).map((form) => ({
          action: form.action || "",
          method: form.method || "get",
          inputs: Array.from(form.elements).map((el) => el.getAttribute("name") || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.tagName.toLowerCase()).filter(Boolean),
        })),
      }))()
    `);
  }

  async snapshot(
    taskId: string,
    sessionId?: unknown,
    options: BrowserSnapshotOptions = {},
  ): Promise<AnyRecord | null> {
    return (await this.browserSessionManager.snapshot({
      taskId,
      sessionId,
      ...options,
    })) as AnyRecord | null;
  }

  async clickRef(taskId: string, ref: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const result = await this.browserSessionManager.clickRef({ taskId, sessionId, ref });
    if (session && result?.success) {
      this.emitCursor(session, { x: 42, y: 42, kind: "click", label: "Click", pulse: true });
    }
    return result;
  }

  async hoverRef(taskId: string, ref: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const result = await this.browserSessionManager.hoverRef({ taskId, sessionId, ref });
    if (session && result?.success) {
      this.emitCursor(session, { x: 42, y: 42, kind: "move", label: "Hover" });
    }
    return result;
  }

  async dragRef(
    taskId: string,
    fromRef: string,
    toRef: string,
    sessionId?: unknown,
  ): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const result = await this.browserSessionManager.dragRef({ taskId, sessionId, fromRef, toRef });
    if (session && result?.success) {
      this.emitCursor(session, { x: 42, y: 42, kind: "click", label: "Drag", pulse: true });
    }
    return result;
  }

  async fillRef(
    taskId: string,
    ref: string,
    value: string,
    sessionId?: unknown,
  ): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const result = await this.browserSessionManager.fillRef({ taskId, sessionId, ref, value });
    if (session && result?.success) {
      this.emitCursor(session, { x: 42, y: 42, kind: "fill", label: "Fill" });
    }
    return result;
  }

  async typeRef(
    taskId: string,
    ref: string,
    text: string,
    sessionId?: unknown,
  ): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const result = await this.browserSessionManager.typeRef({ taskId, sessionId, ref, text });
    if (session && result?.success) {
      this.emitCursor(session, { x: 42, y: 42, kind: "type", label: "Type" });
    }
    return result;
  }

  async getTextRef(taskId: string, ref: string, sessionId?: unknown): Promise<AnyRecord | null> {
    return await this.browserSessionManager.getTextRef({ taskId, sessionId, ref });
  }

  async uploadFile(input: {
    taskId: string;
    sessionId?: unknown;
    filePath: string;
    ref?: string;
    selector?: string;
  }): Promise<AnyRecord | null> {
    return await this.browserSessionManager.uploadFile(input);
  }

  async handleDialog(input: {
    taskId: string;
    sessionId?: unknown;
    accept?: boolean;
    promptText?: string;
  }): Promise<AnyRecord | null> {
    return await this.browserSessionManager.handleDialog(input);
  }

  getTabs(taskId: string, sessionId?: unknown): AnyRecord[] {
    return this.browserSessionManager.getTabs(taskId, sessionId) as unknown as AnyRecord[];
  }

  getConsole(taskId: string, sessionId?: unknown): AnyRecord | null {
    return this.browserSessionManager.getConsole(taskId, sessionId);
  }

  getNetwork(taskId: string, sessionId?: unknown): AnyRecord | null {
    return this.browserSessionManager.getNetwork(taskId, sessionId);
  }

  getDownloads(taskId: string, sessionId?: unknown): AnyRecord | null {
    return this.browserSessionManager.getDownloads(taskId, sessionId);
  }

  async getStorage(taskId: string, sessionId?: unknown): Promise<AnyRecord | null> {
    return await this.browserSessionManager.getStorage(taskId, sessionId);
  }

  async emulate(input: {
    taskId: string;
    sessionId?: unknown;
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
  }): Promise<AnyRecord | null> {
    const result = await this.browserSessionManager.emulate(input);
    if (result?.success) {
      const session = this.getSession(input.taskId, input.sessionId);
      const width =
        typeof result.width === "number"
          ? result.width
          : Math.max(320, Math.round(input.width || 1280));
      const height =
        typeof result.height === "number"
          ? result.height
          : Math.max(320, Math.round(input.height || 720));
      const deviceScaleFactor =
        typeof result.deviceScaleFactor === "number"
          ? result.deviceScaleFactor
          : Math.max(1, input.deviceScaleFactor || 1);
      const mobile = result.mobile === true;
      this.emitViewport(session, {
        width,
        height,
        deviceScaleFactor,
        mobile,
        label: `${mobile ? "Mobile" : "Desktop"} ${width}x${height}`,
      });
    }
    return result;
  }

  async traceStart(taskId: string, sessionId?: unknown): Promise<AnyRecord | null> {
    return await this.browserSessionManager.traceStart(taskId, sessionId);
  }

  async traceStop(taskId: string, sessionId?: unknown): Promise<AnyRecord | null> {
    return await this.browserSessionManager.traceStop(taskId, sessionId);
  }

  /**
   * Click by selector through the same CDP path as ref clicks: resolve the
   * element, scroll it into view, hit-test the point, dispatch real mouse
   * events and confirm the element received them.
   */
  async click(taskId: string, selector: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    await this.moveCursorToElement(session, contents, selector, "click", "Click");
    const result = await this.browserSessionManager.clickSelector({ taskId, sessionId, selector });
    if (result?.success && typeof result.x === "number" && typeof result.y === "number") {
      this.emitCursor(session, {
        x: result.x,
        y: result.y,
        kind: "click",
        label: "Click",
        pulse: true,
      });
    }
    return result;
  }

  async hover(taskId: string, selector: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    const result = await this.browserSessionManager.hoverSelector({ taskId, sessionId, selector });
    if (result?.success && typeof result.x === "number" && typeof result.y === "number") {
      this.emitCursor(session, { x: result.x, y: result.y, kind: "move", label: "Hover" });
    }
    return result;
  }

  /** Fill by selector: select-all + trusted text insertion, then read the value back. */
  async fill(
    taskId: string,
    selector: string,
    value: string,
    sessionId?: unknown,
  ): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    await this.moveCursorToElement(session, contents, selector, "fill", "Fill");
    const result = await this.browserSessionManager.fillSelector({
      taskId,
      sessionId,
      selector,
      value: String(value ?? ""),
    });
    return result ? { selector, ...result } : result;
  }

  async type(
    taskId: string,
    selector: string,
    text: string,
    sessionId?: unknown,
  ): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    await this.moveCursorToElement(session, contents, selector, "type", "Type");
    const result = await this.browserSessionManager.typeSelector({
      taskId,
      sessionId,
      selector,
      text: String(text ?? ""),
    });
    return result ? { selector, ...result } : result;
  }

  async press(taskId: string, key: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    const keyName = String(key || "");
    this.emitCursor(session, { x: 42, y: 42, kind: "press", label: keyName || "Key", pulse: true });
    return await this.browserSessionManager.pressKey({ taskId, sessionId, key: keyName });
  }

  async scroll(
    taskId: string,
    direction: string,
    amount?: number,
    sessionId?: unknown,
  ): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    const viewport = await this.getViewportCenter(contents);
    this.emitCursor(session, {
      x: viewport.x,
      y: viewport.y,
      kind: "scroll",
      label:
        direction === "up"
          ? "Scroll up"
          : direction === "top"
            ? "Top"
            : direction === "bottom"
              ? "Bottom"
              : "Scroll",
      pulse: true,
    });
    return await contents.executeJavaScript(`
      (() => {
        const direction = ${JSON.stringify(direction)};
        const amount = ${Number.isFinite(amount) ? Number(amount) : 500};
        if (direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
        else if (direction === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
        else window.scrollBy({ top: direction === "up" ? -amount : amount, behavior: "smooth" });
        return { success: true, scrollY: window.scrollY, url: location.href };
      })()
    `);
  }

  async waitForSelector(
    taskId: string,
    selector: string,
    timeoutMs?: number,
    sessionId?: unknown,
  ): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    const result = await contents.executeJavaScript(`
      new Promise((resolve) => {
        const selector = ${JSON.stringify(selector)};
        const deadline = Date.now() + ${Math.max(1000, Number(timeoutMs) || 30000)};
        const tick = () => {
          const el = ${buildSelectorResolverExpression(selector)};
          if (typeof el === "string" && el.startsWith("invalid:")) {
            return resolve({ success: false, selector, error: "Invalid selector: " + el.slice(8) });
          }
          if (typeof el !== "string") return resolve({ success: true, selector, url: location.href });
          if (Date.now() > deadline) return resolve({ success: false, selector, error: "Timed out waiting for selector" });
          setTimeout(tick, 250);
        };
        tick();
      })
    `);
    if (result?.success) {
      await this.moveCursorToElement(session, contents, selector, "wait", "Found");
    }
    return result;
  }

  async select(
    taskId: string,
    selector: string,
    value: string,
    sessionId?: unknown,
  ): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    await this.moveCursorToElement(session, contents, selector, "select", "Select");
    const result = await contents.executeJavaScript(buildSelectOptionExpression(selector, value));
    return result && typeof result === "object" ? { selector, ...result } : result;
  }

  async getText(taskId: string, selector: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    const point = await this.moveCursorToElement(session, contents, selector, "read", "Read");
    const result = await contents.executeJavaScript(
      withResolvedElementScript(
        selector,
        `return { success: true, text: (el.innerText || el.textContent || el.value || "").trim(), selector };`,
      ),
    );
    if (point && result?.success) {
      this.emitCursor(session, { ...point, kind: "read", label: "Read" });
    }
    return result;
  }

  async evaluate(taskId: string, script: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const contents = await this.getWebContents(this.getSession(taskId, sessionId));
    if (!contents) return null;
    const result = await contents.executeJavaScript(String(script || ""));
    return { success: true, result };
  }

  async goBack(taskId: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    this.emitCursor(session, { x: 24, y: 24, kind: "navigate", label: "Back", pulse: true });
    if (contents.canGoBack?.()) contents.goBack();
    return { success: true, url: contents.getURL?.() || "" };
  }

  async goForward(taskId: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    this.emitCursor(session, { x: 56, y: 24, kind: "navigate", label: "Forward", pulse: true });
    if (contents.canGoForward?.()) contents.goForward();
    return { success: true, url: contents.getURL?.() || "" };
  }

  async reload(taskId: string, sessionId?: unknown): Promise<AnyRecord | null> {
    const session = this.getSession(taskId, sessionId);
    const contents = await this.getWebContents(session);
    if (!contents) return null;
    this.emitCursor(session, { x: 88, y: 24, kind: "navigate", label: "Reload", pulse: true });
    contents.reload();
    return { success: true, url: contents.getURL?.() || "" };
  }

  async screenshot(input: {
    taskId: string;
    sessionId?: unknown;
    workspacePath: string;
    workspacePermissions?: WorkspacePermissions;
    filename?: string;
    includeDataUrl?: boolean;
    fullPage?: boolean;
  }): Promise<{
    path: string;
    fullPath: string;
    width: number;
    height: number;
    dataUrl?: string;
  } | null> {
    const contents = await this.getWebContents(this.getSession(input.taskId, input.sessionId));
    if (!contents) return null;
    const capture =
      input.fullPage === true ? await this.captureFullPage(contents).catch(() => null) : null;
    const image = capture ? null : await contents.capturePage();
    const size = capture?.size || image.getSize();
    const png = capture?.png || image.toPNG();
    const safeName =
      typeof input.filename === "string" && input.filename.trim()
        ? path.basename(input.filename.trim())
        : `browser-screenshot-${Date.now()}.png`;
    const relativePath = path.join(
      "artifacts",
      safeName.endsWith(".png") ? safeName : `${safeName}.png`,
    );
    const fullPath = input.workspacePermissions
      ? assertWorkspaceFilesystemAccess(
          { path: input.workspacePath, permissions: input.workspacePermissions },
          relativePath,
          "write",
          "browser screenshot path",
        )
      : path.join(input.workspacePath, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, png);
    return {
      path: relativePath,
      fullPath,
      width: size.width,
      height: size.height,
      dataUrl: input.includeDataUrl ? `data:image/png;base64,${png.toString("base64")}` : undefined,
    };
  }

  async inspectPoint(input: {
    taskId: string;
    sessionId?: unknown;
    x: number;
    y: number;
  }): Promise<AnyRecord | null> {
    const contents = await this.getWebContents(this.getSession(input.taskId, input.sessionId));
    if (!contents) return null;
    const x = Number.isFinite(input.x) ? Math.max(0, Math.round(input.x)) : 0;
    const y = Number.isFinite(input.y) ? Math.max(0, Math.round(input.y)) : 0;
    const debug = contents.debugger;
    if (!debug) return null;
    try {
      if (!debug.isAttached()) debug.attach("1.3");
      await debug.sendCommand("Runtime.enable").catch(() => undefined);
    } catch {
      return null;
    }
    const expression = `
      (() => {
        const pointX = ${JSON.stringify(x)};
        const pointY = ${JSON.stringify(y)};
        const el = document.elementFromPoint(pointX, pointY);
        if (!el) return null;
        const cssEscape = (value) => {
          if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
          return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
        };
        const selectorFor = (node) => {
          if (!(node instanceof Element)) return "";
          const parts = [];
          let current = node;
          while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
            let part = current.localName.toLowerCase();
            if (current.id) {
              parts.unshift(part + "#" + cssEscape(current.id));
              break;
            }
            const classNames = Array.from(current.classList || []).slice(0, 3);
            if (classNames.length > 0) part += "." + classNames.map(cssEscape).join(".");
            const parent = current.parentElement;
            if (parent) {
              const sameTag = Array.from(parent.children).filter((child) => child.localName === current.localName);
              if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(current) + 1) + ")";
            }
            parts.unshift(part);
            current = parent;
          }
          return parts.join(" > ");
        };
        const xpathFor = (node) => {
          if (!(node instanceof Element)) return "";
          const parts = [];
          let current = node;
          while (current && current.nodeType === Node.ELEMENT_NODE) {
            let index = 1;
            let sibling = current.previousElementSibling;
            while (sibling) {
              if (sibling.localName === current.localName) index += 1;
              sibling = sibling.previousElementSibling;
            }
            parts.unshift(current.localName.toLowerCase() + "[" + index + "]");
            current = current.parentElement;
          }
          return "/" + parts.join("/");
        };
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
          selector: selectorFor(el),
          xpath: xpathFor(el),
          tagName: el.tagName ? el.tagName.toLowerCase() : "",
          role: el.getAttribute("role") || "",
          accessibleName: el.getAttribute("aria-label") || el.getAttribute("title") || "",
          textQuote: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 300),
          computedStyle: {
            color: style.color,
            backgroundColor: style.backgroundColor,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            margin: style.margin,
            padding: style.padding,
            borderRadius: style.borderRadius,
          },
        };
      })()
    `;
    const evaluated = await debug.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return (evaluated?.result?.value || null) as AnyRecord | null;
  }

  /**
   * Elements inside a dragged area of the page (annotate an area): the
   * outermost elements that mostly fall inside it, with the area itself.
   */
  async inspectArea(input: {
    taskId: string;
    sessionId?: unknown;
    rect: { x: number; y: number; width: number; height: number };
  }): Promise<AnyRecord | null> {
    const contents = await this.getWebContents(this.getSession(input.taskId, input.sessionId));
    if (!contents) return null;
    const clamp = (value: unknown) =>
      Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
    const area = {
      x: Math.max(0, clamp(input.rect?.x)),
      y: Math.max(0, clamp(input.rect?.y)),
      width: Math.max(1, clamp(input.rect?.width)),
      height: Math.max(1, clamp(input.rect?.height)),
    };
    const expression = `
      (() => {
        const area = ${JSON.stringify(area)};
        ${PAGE_DESCRIBE_HELPERS}
        const inside = (rect) => {
          const left = Math.max(rect.left, area.x);
          const top = Math.max(rect.top, area.y);
          const right = Math.min(rect.right, area.x + area.width);
          const bottom = Math.min(rect.bottom, area.y + area.height);
          const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
          return rect.width * rect.height > 0 ? overlap / (rect.width * rect.height) : 0;
        };
        const picked = [];
        const all = Array.from(document.body ? document.body.querySelectorAll("*") : []).slice(0, 4000);
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4 || inside(rect) < 0.75) continue;
          if (picked.some((other) => other.contains(el))) continue;
          const style = window.getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          picked.push(el);
          if (picked.length >= 12) break;
        }
        return {
          rect: area,
          scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
          elements: picked.map((el) => describe(el)),
        };
      })()
    `;
    const debug = contents.debugger;
    if (!debug) return null;
    try {
      if (!debug.isAttached()) debug.attach("1.3");
    } catch {
      return null;
    }
    const evaluated = await debug
      .sendCommand("Runtime.evaluate", { expression, returnByValue: true })
      .catch(() => null);
    return (evaluated?.result?.value || null) as AnyRecord | null;
  }

  /**
   * Live preview for annotation "Adjust": apply inline styles (and text) to one
   * element, or put back what it had. Previews are temporary edits in the page;
   * reloading drops them.
   */
  async previewStyle(input: {
    taskId: string;
    sessionId?: unknown;
    selector: string;
    action: "apply" | "revert";
    styles?: Record<string, string>;
    text?: string;
  }): Promise<AnyRecord | null> {
    const contents = await this.getWebContents(this.getSession(input.taskId, input.sessionId));
    if (!contents) return null;
    const allowed = new Set<string>(ADJUSTABLE_STYLE_PROPERTIES);
    const styles: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.styles || {})) {
      if (allowed.has(key) && typeof value === "string" && value.length <= 200) {
        // Values only: no declarations smuggled in with ';' or url(...) loads.
        if (/[;{}]|url\s*\(|expression\s*\(/i.test(value)) continue;
        styles[key] = value;
      }
    }
    const expression = `
      (() => {
        const selector = ${JSON.stringify(String(input.selector || "").slice(0, 2000))};
        let el = null;
        try { el = document.querySelector(selector); } catch { return { success: false, error: "Invalid selector" }; }
        if (!el) return { success: false, error: "Element not found" };
        const store = (window.__coworkAdjust = window.__coworkAdjust || new WeakMap());
        if (!store.has(el)) {
          store.set(el, { style: el.getAttribute("style"), text: el.childElementCount === 0 ? el.textContent : null });
        }
        const original = store.get(el);
        if (${JSON.stringify(input.action)} === "revert") {
          if (original.style === null) el.removeAttribute("style"); else el.setAttribute("style", original.style);
          if (original.text !== null) el.textContent = original.text;
          store.delete(el);
          return { success: true, reverted: true };
        }
        if (original.style === null) el.removeAttribute("style"); else el.setAttribute("style", original.style);
        const styles = ${JSON.stringify(styles)};
        for (const [property, value] of Object.entries(styles)) {
          el.style.setProperty(property.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), value, "important");
        }
        const text = ${JSON.stringify(typeof input.text === "string" ? input.text.slice(0, 2000) : null)};
        if (text !== null && original.text !== null) el.textContent = text;
        const rect = el.getBoundingClientRect();
        return { success: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      })()
    `;
    return (await contents.executeJavaScript(expression).catch(() => null)) as AnyRecord | null;
  }

  async resolveAnnotationTargets(input: {
    taskId: string;
    sessionId?: unknown;
    targets: AnyRecord[];
  }): Promise<AnyRecord[]> {
    const contents = await this.getWebContents(this.getSession(input.taskId, input.sessionId));
    if (!contents) return [];
    const targets = Array.isArray(input.targets) ? input.targets.slice(0, 100) : [];
    if (targets.length === 0) return [];
    const debug = contents.debugger;
    if (!debug) return [];
    try {
      if (!debug.isAttached()) debug.attach("1.3");
      await debug.sendCommand("Runtime.enable").catch(() => undefined);
    } catch {
      return targets.map((_, index) => ({
        index,
        resolved: false,
        error: "Browser debugger is unavailable",
      }));
    }
    const expression = `
      (() => {
        const targets = ${JSON.stringify(targets)};
        const byXPath = (xpath) => {
          if (!xpath) return null;
          try {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
          } catch {
            return null;
          }
        };
        const byText = (textQuote) => {
          const needle = String(textQuote || "").trim().replace(/\\s+/g, " ").slice(0, 160);
          if (!needle) return null;
          const all = Array.from(document.body?.querySelectorAll("*") || []).slice(0, 2500);
          return all.find((node) => {
            const text = (node.innerText || node.textContent || "").trim().replace(/\\s+/g, " ");
            return text && text.includes(needle);
          }) || null;
        };
        const describe = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
            tagName: el.tagName ? el.tagName.toLowerCase() : "",
            role: el.getAttribute("role") || "",
            accessibleName: el.getAttribute("aria-label") || el.getAttribute("title") || "",
            textQuote: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 300),
            computedStyle: {
              color: style.color,
              backgroundColor: style.backgroundColor,
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              lineHeight: style.lineHeight,
              margin: style.margin,
              padding: style.padding,
              borderRadius: style.borderRadius,
            },
          };
        };
        return targets.map((target, index) => {
          let el = null;
          if (target.selector) {
            try {
              el = document.querySelector(target.selector);
            } catch {
              el = null;
            }
          }
          if (!el) el = byXPath(target.xpath);
          if (!el) el = byText(target.textQuote);
          if (!el) return { index, resolved: false };
          return { index, resolved: true, target: describe(el) };
        });
      })()
    `;
    const evaluated = await debug
      .sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      .catch(() => null);
    return Array.isArray(evaluated?.result?.value) ? (evaluated.result.value as AnyRecord[]) : [];
  }

  private async captureFullPage(
    contents: Any,
  ): Promise<{ png: Buffer; size: { width: number; height: number } }> {
    const debug = contents.debugger;
    if (!debug) throw new Error("Browser debugger is not available for full-page capture");
    if (!debug.isAttached()) debug.attach("1.3");
    await debug.sendCommand("Page.enable").catch(() => undefined);
    const metrics = await debug.sendCommand("Page.getLayoutMetrics");
    const contentSize = metrics?.contentSize || {};
    const width = Math.max(1, Math.ceil(contentSize.width || 0));
    const height = Math.max(1, Math.ceil(contentSize.height || 0));
    const screenshot = await debug.sendCommand("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const data = typeof screenshot?.data === "string" ? screenshot.data : "";
    if (!data) throw new Error("Full-page screenshot returned empty data");
    return {
      png: Buffer.from(data, "base64"),
      size: { width, height },
    };
  }

  private waitForSession(
    taskId: string,
    sessionId: string,
    timeoutMs: number,
  ): Promise<BrowserWorkbenchSession | null> {
    const existing = this.getSession(taskId, sessionId);
    if (existing) return Promise.resolve(existing);
    const key = sessionKey(taskId, sessionId);
    return new Promise((resolve) => {
      let wrapped: ((session: BrowserWorkbenchSession | null) => void) | null = null;
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(key) || [];
        const nextWaiters = waiters.filter((waiter) => waiter !== wrapped);
        if (nextWaiters.length > 0) this.waiters.set(key, nextWaiters);
        else this.waiters.delete(key);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      wrapped = (session: BrowserWorkbenchSession | null) => {
        clearTimeout(timer);
        resolve(session);
      };
      const waiters = this.waiters.get(key) || [];
      waiters.push(wrapped);
      this.waiters.set(key, waiters);
    });
  }

  private waitForTab(
    taskId: string,
    sessionId: string,
    tabId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.browserSessionManager.hasTab(taskId, tabId, sessionId)) return Promise.resolve(true);
    const key = `${sessionKey(taskId, sessionId)}|${tabId}`;
    return new Promise((resolve) => {
      let wrapped: ((registered: boolean) => void) | null = null;
      const timer = setTimeout(() => {
        const waiters = (this.tabWaiters.get(key) || []).filter((waiter) => waiter !== wrapped);
        if (waiters.length > 0) this.tabWaiters.set(key, waiters);
        else this.tabWaiters.delete(key);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      wrapped = (registered: boolean) => {
        clearTimeout(timer);
        resolve(registered);
      };
      const waiters = this.tabWaiters.get(key) || [];
      waiters.push(wrapped);
      this.tabWaiters.set(key, waiters);
    });
  }

  /** Point the session's tool view at the manager's active tab. */
  private syncActiveTab(key: string, tabId: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    const tab = (
      this.browserSessionManager.getTabs?.(session.taskId, session.sessionId) || []
    ).find((candidate) => candidate.tabId === tabId);
    const owner = this.browserSessionManager.getActiveWebContentsId?.(
      session.taskId,
      session.sessionId,
    );
    this.sessions.set(key, {
      ...session,
      tabId,
      webContentsId: typeof owner === "number" ? owner : session.webContentsId,
      url: tab?.url ?? session.url,
      title: tab?.title ?? session.title,
    });
  }

  private sendTabCommand(
    session: { taskId: string; sessionId: string },
    command: Omit<BrowserWorkbenchTabCommand, "taskId" | "sessionId" | "at">,
  ): boolean {
    return this.sendToRenderer(IPC_CHANNELS.BROWSER_WORKBENCH_TAB_COMMAND, {
      taskId: session.taskId,
      sessionId: session.sessionId,
      ...command,
      at: Date.now(),
    } satisfies BrowserWorkbenchTabCommand);
  }

  private sendToRenderer(
    channel: string,
    payload:
      | BrowserNavigationBlockedEvent
      | BrowserPageDialogEvent
      | BrowserPermissionPrompt
      | BrowserWorkbenchTabCommand
      | BrowserWorkbenchShortcutEvent
      | BrowserWorkbenchContextActionEvent
      | BrowserWorkbenchDrivingEvent
      | BrowserWorkbenchDownloadEvent
      | BrowserWorkbenchSignInEvent,
  ): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed?.()) return false;
    try {
      this.mainWindow.webContents.send(channel, payload);
      return true;
    } catch {
      return false;
    }
  }

  private waitForLoad(contents: Any, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      const finish = () => {
        clearTimeout(timer);
        contents.removeListener?.("did-finish-load", finish);
        contents.removeListener?.("did-fail-load", finish);
        resolve();
      };
      contents.once?.("did-finish-load", finish);
      contents.once?.("did-fail-load", finish);
    });
  }

  private emitCursor(
    session: BrowserWorkbenchSession | null,
    event: Omit<BrowserWorkbenchCursorEvent, "taskId" | "sessionId" | "at">,
  ): void {
    if (!session || !this.mainWindow || this.mainWindow.isDestroyed?.()) return;
    this.mainWindow.webContents.send(IPC_CHANNELS.BROWSER_WORKBENCH_CURSOR, {
      taskId: session.taskId,
      sessionId: session.sessionId,
      x: Math.max(0, Math.round(event.x)),
      y: Math.max(0, Math.round(event.y)),
      kind: event.kind,
      label: event.label,
      pulse: event.pulse,
      at: Date.now(),
    } satisfies BrowserWorkbenchCursorEvent);
  }

  private emitViewport(
    session: BrowserWorkbenchSession | null,
    event: Omit<BrowserWorkbenchViewportEvent, "taskId" | "sessionId" | "at">,
  ): void {
    if (!session || !this.mainWindow || this.mainWindow.isDestroyed?.()) return;
    this.mainWindow.webContents.send(IPC_CHANNELS.BROWSER_WORKBENCH_VIEWPORT, {
      taskId: session.taskId,
      sessionId: session.sessionId,
      width: Math.max(320, Math.round(event.width)),
      height: Math.max(320, Math.round(event.height)),
      deviceScaleFactor: Math.max(1, Number(event.deviceScaleFactor) || 1),
      mobile: event.mobile === true,
      label: event.label,
      at: Date.now(),
    } satisfies BrowserWorkbenchViewportEvent);
  }

  private async moveCursorToElement(
    session: BrowserWorkbenchSession | null,
    contents: Any,
    selector: string,
    kind: BrowserWorkbenchCursorEvent["kind"],
    label: string,
  ): Promise<{ x: number; y: number } | null> {
    const point = await this.getElementPoint(contents, selector).catch(() => null);
    if (!point) return null;
    this.emitCursor(session, { x: point.x, y: point.y, kind, label });
    await this.sleep(140);
    return point;
  }

  private async getElementPoint(
    contents: Any,
    selector: string,
  ): Promise<{ x: number; y: number } | null> {
    const result = await contents.executeJavaScript(`
      (() => {
        const el = ${buildSelectorResolverExpression(selector)};
        if (!el || typeof el === "string") return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const rect = el.getBoundingClientRect();
        if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
        const x = Math.max(0, Math.min(window.innerWidth || rect.right, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight || rect.bottom, rect.top + Math.min(rect.height / 2, 24)));
        return { x, y };
      })()
    `);
    if (!result || typeof result.x !== "number" || typeof result.y !== "number") return null;
    return { x: result.x, y: result.y };
  }

  private async getViewportCenter(contents: Any): Promise<{ x: number; y: number }> {
    const result = await contents
      .executeJavaScript(`
      (() => ({
        x: Math.max(24, Math.round((window.innerWidth || 800) / 2)),
        y: Math.max(24, Math.round((window.innerHeight || 600) / 2)),
      }))()
    `)
      .catch(() => null);
    if (!result || typeof result.x !== "number" || typeof result.y !== "number") {
      return { x: 120, y: 120 };
    }
    return { x: result.x, y: result.y };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private async getWebContents(session: BrowserWorkbenchSession | null): Promise<Any | null> {
    if (!session) return null;
    const contents = await this.browserSessionManager.getGuardedWebContents(
      session.taskId,
      session.sessionId,
    );
    if (!contents) {
      this.unregisterSession({
        taskId: session.taskId,
        sessionId: session.sessionId,
        tabId: session.tabId,
        webContentsId: session.webContentsId,
      });
    }
    return contents;
  }
}

const browserWorkbenchService = new BrowserWorkbenchService();

export function getBrowserWorkbenchService(): BrowserWorkbenchService {
  return browserWorkbenchService;
}
