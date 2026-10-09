/**
 * Window-open handling for in-app browser pages.
 *
 * Workbench webviews keep `allowpopups` so pages can open windows, which means
 * every guest must have a window-open handler before it loads anything:
 *
 * - links and plain `window.open(url)` (tab dispositions) are denied here and
 *   reopened as a workbench tab through the renderer;
 * - `window.open` with window features (OAuth and payment popups) becomes a
 *   real popup window on the same partition, so `window.opener` works. The
 *   popup is registered as a "popup" tab of the opener's session synchronously
 *   in `createWindow`, before Chromium issues its first request, so the
 *   fail-closed request guard and the access policy apply from the start.
 *
 * Targets are checked against the opener session's access policy first; a
 * denied target is reported as a blocked navigation on the opener tab.
 */

import { matchBrowserShortcut } from "../../shared/browser-shortcuts";
import { buildBrowserContextMenuTemplate } from "./browser-context-menu";
import type { BrowserSessionManager, BrowserTabOwner } from "./browser-session-manager";
import type { BrowserWorkbenchService } from "./browser-workbench-service";

export interface BrowserGuestAttachDeps {
  service: BrowserWorkbenchService;
  manager: BrowserSessionManager;
  /** Electron's BrowserWindow constructor (injected for tests). */
  BrowserWindow: new (options: Any) => Any;
  getParentWindow: () => Any | null;
  /** Electron's Menu, for the page context menu (omitted in tests). */
  Menu?: { buildFromTemplate: (template: Any[]) => { popup: (options?: Any) => void } };
  writeClipboardText?: (text: string) => void;
  /** Opens an http(s) URL in the system browser. */
  openExternal?: (url: string) => void;
  platform?: string;
  /** Record a committed page load or title change of a workbench tab in browsing history. */
  recordHistory?: (
    owner: BrowserTabOwner,
    page: { url: string; title?: string; faviconUrl?: string; visit: boolean },
  ) => void;
  /** Developer mode (Settings > Browser) adds Inspect Element to the page menu. */
  isDeveloperMode?: () => boolean;
}

export type BrowserWindowOpenRoute = "tab" | "background-tab" | "popup" | "deny";

const TAB_DISPOSITIONS = new Set(["foreground-tab", "default", "other"]);
const POPUP_MIN_SIZE = 320;
const POPUP_DEFAULT_SIZE = { width: 520, height: 680 };
/** Open popup windows per workbench session; more are denied (window.open loops). */
export const MAX_BROWSER_POPUPS_PER_SESSION = 4;

/** How a window.open / target=_blank request from an owner tab is handled. */
export function routeWindowOpen(input: {
  owner: BrowserTabOwner | null;
  url: string;
  disposition: string;
  allowed: boolean;
}): BrowserWindowOpenRoute {
  if (!input.owner || !input.allowed) return "deny";
  if (input.disposition === "background-tab") return "background-tab";
  if (input.disposition === "new-window") return "popup";
  // Tab dispositions open as workbench tabs. An about:blank tab has nothing to
  // show; scripts that write into it need the popup path.
  if (TAB_DISPOSITIONS.has(input.disposition)) {
    return input.url && input.url !== "about:blank" ? "tab" : "popup";
  }
  return "deny";
}

let popupCounter = 0;

function nextPopupId(): string {
  popupCounter += 1;
  return `popup-${Date.now().toString(36)}-${popupCounter}`;
}

function clampSize(value: unknown, fallback: number): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= POPUP_MIN_SIZE ? Math.min(number, 1600) : fallback;
}

/**
 * Browser shortcuts typed while a workbench page has focus run as browser
 * commands (Cmd+T, Cmd+W, Cmd+R ...) instead of reaching the page or the app
 * menu; every other key is left alone.
 */
function attachShortcutForwarding(guest: Any, deps: BrowserGuestAttachDeps): void {
  guest.on?.("before-input-event", (event: Any, input: Any) => {
    if (input?.type !== "keyDown") return;
    const command = matchBrowserShortcut(
      {
        key: String(input.key || ""),
        code: input.code,
        ctrl: input.control === true,
        meta: input.meta === true,
        shift: input.shift === true,
        alt: input.alt === true,
      },
      deps.platform || process.platform,
    );
    if (!command) return;
    const owner = deps.manager.findTabOwner(guest.id);
    if (!owner || owner.kind !== "tab") return;
    event.preventDefault?.();
    deps.service.sendShortcut(owner, command);
  });
}

/** Pages committed in workbench tabs go to browsing history (popups such as sign-in windows do not). */
function attachHistoryRecording(guest: Any, deps: BrowserGuestAttachDeps): void {
  const record = deps.recordHistory;
  if (!record) return;
  const tabOwner = () => {
    const owner = deps.manager.findTabOwner(guest.id);
    return owner && owner.kind === "tab" ? owner : null;
  };
  guest.on?.("did-navigate", (_event: Any, url: string) => {
    const owner = tabOwner();
    if (owner) record(owner, { url, title: guest.getTitle?.() || "", visit: true });
  });
  guest.on?.("page-title-updated", (_event: Any, title: string) => {
    const owner = tabOwner();
    if (owner) record(owner, { url: guest.getURL?.() || "", title, visit: false });
  });
  guest.on?.("page-favicon-updated", (_event: Any, favicons: string[]) => {
    const owner = tabOwner();
    const faviconUrl = Array.isArray(favicons)
      ? favicons.find((icon) => /^https?:/i.test(icon))
      : "";
    if (owner && faviconUrl) {
      record(owner, { url: guest.getURL?.() || "", faviconUrl, visit: false });
    }
  });
}

function attachContextMenu(guest: Any, deps: BrowserGuestAttachDeps, isPopup: boolean): void {
  const Menu = deps.Menu;
  if (!Menu) return;
  // Popup windows are "window" contents and got the app's image menu; this one replaces it.
  if (isPopup) guest.removeAllListeners?.("context-menu");
  guest.on?.("context-menu", (_event: Any, params: Any) => {
    const owner = deps.manager.findTabOwner(guest.id);
    if (!owner) return;
    const template = buildBrowserContextMenuTemplate(params || {}, {
      owner,
      contents: guest,
      writeText: (text) => deps.writeClipboardText?.(text),
      openTab: (url, background) => {
        void deps.service
          .openTab({
            taskId: owner.taskId,
            sessionId: owner.sessionId,
            url,
            background,
            openerTabId: owner.kind === "tab" ? owner.tabId : undefined,
            waitForRegistration: false,
          })
          .catch(() => {
            const block = deps.manager.explainUrlBlock(owner.taskId, url, owner.sessionId);
            if (block) deps.service.notifyNavigationBlocked(owner, url, block);
          });
      },
      openExternal: (url) => deps.openExternal?.(url),
      sendAction: (action) => deps.service.sendContextAction(owner, action),
      developerMode: deps.isDeveloperMode?.() === true,
    });
    if (template.length === 0) return;
    const host = guest.hostWebContents || guest;
    const window = deps.BrowserWindow
      ? (deps.BrowserWindow as Any).fromWebContents?.(host)
      : undefined;
    Menu.buildFromTemplate(template).popup(window ? { window } : undefined);
  });
}

/** Install window-open, shortcut and context-menu handling on a workbench guest (webview or popup). */
export function attachBrowserGuest(
  guest: Any,
  deps: BrowserGuestAttachDeps,
  isPopup = false,
): void {
  if (!guest || typeof guest.setWindowOpenHandler !== "function") return;
  if (!isPopup) {
    attachShortcutForwarding(guest, deps);
    attachHistoryRecording(guest, deps);
  }
  attachContextMenu(guest, deps, isPopup);
  guest.setWindowOpenHandler((details: Any) => {
    const url = String(details?.url || "");
    const disposition = String(details?.disposition || "");
    const owner = deps.manager.findTabOwner(guest.id);
    const block = owner ? deps.manager.explainUrlBlock(owner.taskId, url, owner.sessionId) : null;
    const route = routeWindowOpen({ owner, url, disposition, allowed: !block });

    if (route === "deny") {
      if (owner && block) deps.service.notifyNavigationBlocked(owner, url, block);
      return { action: "deny" };
    }
    if (!owner) return { action: "deny" };

    if (route === "tab" || route === "background-tab") {
      void deps.service
        .openTab({
          taskId: owner.taskId,
          sessionId: owner.sessionId,
          url,
          background: route === "background-tab",
          openerTabId: owner.tabId,
          waitForRegistration: false,
        })
        .catch(() => undefined);
      return { action: "deny" };
    }

    const openPopups = deps.manager
      .getTabs(owner.taskId, owner.sessionId)
      .filter((tab) => tab.kind === "popup").length;
    if (openPopups >= MAX_BROWSER_POPUPS_PER_SESSION) return { action: "deny" };

    const popupId = nextPopupId();
    const parent = deps.getParentWindow();
    return {
      action: "allow",
      outlivesOpener: false,
      // Size comes from the page's window features; createWindow clamps it.
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        ...(parent && !parent.isDestroyed?.() ? { parent } : {}),
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      },
      createWindow: (options: Any) => {
        const popup = new deps.BrowserWindow({
          ...options,
          width: clampSize(options?.width, POPUP_DEFAULT_SIZE.width),
          height: clampSize(options?.height, POPUP_DEFAULT_SIZE.height),
          webPreferences: {
            ...options?.webPreferences,
            // Same partition as the opener: its guards, permissions and user agent apply.
            ...(guest.session ? { session: guest.session } : {}),
            preload: undefined,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        });
        const contents = popup.webContents;
        if (guest.session && contents.session !== guest.session) {
          // A popup outside the guarded partition would have no request guard: never show it.
          popup.destroy?.();
          return contents;
        }
        // Register before returning: Chromium navigates the popup only after this
        // returns, and an unregistered webContents is denied every request.
        void deps.service
          .registerSession({
            taskId: owner.taskId,
            sessionId: owner.sessionId,
            tabId: popupId,
            kind: "popup",
            openerTabId: owner.tabId,
            activate: true,
            webContentsId: contents.id,
            url,
          })
          .catch(() => {
            if (!popup.isDestroyed?.()) popup.close();
          });
        // Registration recorded the tab synchronously; guard navigations right away too.
        deps.manager.guardTabContents?.(contents);
        attachBrowserGuest(contents, deps, true);
        contents.once?.("destroyed", () => {
          deps.service.unregisterSession({
            taskId: owner.taskId,
            sessionId: owner.sessionId,
            tabId: popupId,
          });
        });
        contents.on?.("page-title-updated", (_event: Any, title: string) => {
          deps.service.updateSessionStatus({
            taskId: owner.taskId,
            sessionId: owner.sessionId,
            tabId: popupId,
            title,
          });
        });
        const reportUrl = () =>
          deps.service.updateSessionStatus({
            taskId: owner.taskId,
            sessionId: owner.sessionId,
            tabId: popupId,
            url: contents.getURL?.() || url,
          });
        contents.on?.("did-navigate", reportUrl);
        contents.on?.("did-navigate-in-page", reportUrl);
        return contents;
      },
    };
  });
}
