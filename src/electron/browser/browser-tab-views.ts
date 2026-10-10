/**
 * Native tab views for the in-app browser (Settings > Browser > Browser engine:
 * "native"). Each workbench tab is a main-process WebContentsView added to the
 * app window, instead of a <webview> owned by the renderer.
 *
 * - The view is created on the browser partition (prepared first, so its
 *   network guards, permissions and downloads apply), gets the same guest
 *   handling as a webview tab (window-open routing, shortcuts, context menu,
 *   history, unload guard), and is registered with the session manager before
 *   it loads anything: an unregistered webContents is denied every request.
 * - The renderer keeps the tab UI and sends the rectangle the page should fill;
 *   views are hidden while the renderer covers the page (overlays, menus).
 * - Views outlive the renderer's tab components: closing the browser or
 *   switching tasks only hides them, and reopening the tab reattaches the live
 *   page. Views close when their tab closes, or least recently used beyond the cap.
 */

export interface BrowserTabViewKey {
  taskId: string;
  sessionId: string;
  tabId: string;
}

export interface BrowserTabViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTabViewState {
  webContentsId: number;
  /** The view already existed: its page is live and was not reloaded. */
  reused: boolean;
  url: string;
  title: string;
  /** The page's last reported favicon (a reattached tab shows it again). */
  favicon?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/** Page events forwarded to the renderer's tab, mirroring the <webview> DOM events. */
export type BrowserTabViewEvent = BrowserTabViewKey &
  (
    | { type: "navigate"; url: string; inPage: boolean; canGoBack: boolean; canGoForward: boolean }
    | { type: "start-navigation"; isSameDocument: boolean }
    | { type: "title"; title: string }
    | { type: "favicon"; favicons: string[] }
    | { type: "loading"; loading: boolean; canGoBack: boolean; canGoForward: boolean }
    | { type: "fail"; errorCode: number; errorDescription: string; validatedURL: string }
    | { type: "gone"; reason: string }
    | { type: "found"; activeMatchOrdinal: number; matches: number }
    | { type: "media"; audible: boolean }
    | { type: "takeover-click" }
  );

export type BrowserTabViewCommand =
  | "goBack"
  | "goForward"
  | "reload"
  | "stop"
  | "hardReload"
  | "setZoomLevel"
  | "setAudioMuted"
  | "find"
  | "stopFind"
  | "focus";

export interface BrowserTabViewHostDeps {
  /** The window the views live in. */
  getWindow: () => Any | null;
  /** Electron's WebContentsView constructor (injected for tests). */
  WebContentsView: new (options: Any) => Any;
  /** Network guards, permissions, user agent and downloads for the partition; returns its session. */
  prepareSession: (partition: string) => Any;
  /** Window-open routing, shortcuts, context menu, history and unload guard (as for webview tabs). */
  attachGuest: (contents: Any) => void;
  register: (
    input: BrowserTabViewKey & { webContentsId: number; activate: boolean },
  ) => Promise<unknown>;
  unregister: (input: BrowserTabViewKey & { webContentsId: number }) => void;
  updateStatus: (
    input: BrowserTabViewKey & { webContentsId: number; url: string; title: string },
  ) => void;
  /** will-navigate / will-redirect guards for a registered webContents. */
  guard: (contents: Any) => void;
  emit: (event: BrowserTabViewEvent) => void;
  /** CoWork is acting on this session and the user has not taken over. */
  isAgentDriving?: (taskId: string, sessionId: string) => boolean;
  maxLiveViews?: number;
}

interface TabViewRecord {
  key: BrowserTabViewKey;
  view: Any;
  contents: Any;
  /** Read once: a destroyed webContents throws on property access. */
  webContentsId: number;
  favicon?: string;
  lastUsed: number;
  visible: boolean;
}

const DEFAULT_MAX_LIVE_VIEWS = 24;

/** Isolated world for the cursor marker (page scripts never run in it). */
const CURSOR_WORLD_ID = 1970;

/** Runs in the page's isolated world: creates or moves the marker, then hides it. */
const CURSOR_SCRIPT = `function (c) {
  var root = document.documentElement;
  if (!root) return;
  var host = document.getElementById("__cowork_agent_cursor");
  if (!host) {
    host = document.createElement("div");
    host.id = "__cowork_agent_cursor";
    host.setAttribute("style", "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;");
    var shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = '<style>' +
      '.m{position:absolute;left:0;top:0;transition:transform 260ms cubic-bezier(.2,.8,.2,1),opacity 200ms;opacity:0;will-change:transform}' +
      '.m svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}' +
      '.l{position:absolute;left:16px;top:18px;padding:2px 7px;border-radius:999px;background:#2563eb;color:#fff;font:600 11px/1.5 -apple-system,system-ui,sans-serif;white-space:nowrap}' +
      '.p{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #2563eb;opacity:0}' +
      '.p.go{animation:p 520ms ease-out}' +
      '@keyframes p{0%{opacity:.8;transform:scale(.3)}100%{opacity:0;transform:scale(1.4)}}' +
      '</style><div class="m"><div class="p"></div><svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1l15 9.5-6.5 1.6L6.2 20z" fill="#2563eb" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><div class="l"></div></div>';
    root.appendChild(host);
    host.__shadow = shadow;
  }
  var shadow = host.__shadow;
  var marker = shadow.querySelector(".m");
  shadow.querySelector(".l").textContent = c.label || "";
  shadow.querySelector(".l").style.display = c.label ? "" : "none";
  marker.style.transform = "translate(" + c.x + "px," + c.y + "px)";
  marker.style.opacity = "1";
  if (c.pulse) {
    var ring = shadow.querySelector(".p");
    ring.classList.remove("go");
    void ring.offsetWidth;
    ring.classList.add("go");
  }
  clearTimeout(host.__hide);
  host.__hide = setTimeout(function () { marker.style.opacity = "0"; }, 2400);
}`;

function recordKey(key: BrowserTabViewKey): string {
  return `${key.taskId}\u0000${key.sessionId}\u0000${key.tabId}`;
}

function sessionKey(taskId: string, sessionId: string): string {
  return `${taskId}\u0000${sessionId}`;
}

function history(contents: Any): { canGoBack: boolean; canGoForward: boolean } {
  try {
    const nav = contents.navigationHistory;
    return {
      canGoBack: Boolean(nav?.canGoBack?.() ?? contents.canGoBack?.()),
      canGoForward: Boolean(nav?.canGoForward?.() ?? contents.canGoForward?.()),
    };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
}

/** URLs the renderer may ask a tab view to load; the request guards still check each request. */
export function isLoadableTabViewUrl(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}

export class BrowserTabViewHost {
  private readonly records = new Map<string, TabViewRecord>();

  constructor(private readonly deps: BrowserTabViewHostDeps) {}

  get(key: BrowserTabViewKey): TabViewRecord | undefined {
    return this.records.get(recordKey(key));
  }

  /** Whether this webContents is one of the tab views (for IPC ownership checks). */
  ownsWebContents(webContentsId: number): boolean {
    for (const record of this.records.values()) {
      if (record.webContentsId === webContentsId) return true;
    }
    return false;
  }

  /** Create the tab's view, or reattach the live one. Registered before anything loads. */
  async open(
    key: BrowserTabViewKey & { partition: string; activate: boolean },
  ): Promise<BrowserTabViewState> {
    const existing = this.get(key);
    if (existing && !existing.contents.isDestroyed?.()) {
      existing.lastUsed = Date.now();
      this.ensureAttached(existing);
      const state = this.state(existing, true);
      await this.deps.register({
        ...key,
        webContentsId: existing.contents.id,
        activate: key.activate,
      });
      return state;
    }
    const window = this.deps.getWindow();
    if (!window || window.isDestroyed?.()) throw new Error("No window for the browser view");
    const session = this.deps.prepareSession(key.partition);
    const view = new this.deps.WebContentsView({
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const contents = view.webContents;
    if (contents.session !== session) {
      // Outside the guarded partition there is no request guard: never show it.
      contents.close?.();
      throw new Error("Browser view is not on the browser partition");
    }
    view.setVisible?.(false);
    view.setBackgroundColor?.("#ffffff");
    window.contentView.addChildView(view);
    const record: TabViewRecord = {
      key: { taskId: key.taskId, sessionId: key.sessionId, tabId: key.tabId },
      view,
      contents,
      webContentsId: contents.id,
      lastUsed: Date.now(),
      visible: false,
    };
    this.records.set(recordKey(key), record);
    this.deps.attachGuest(contents);
    this.wireEvents(record);
    try {
      await this.deps.register({
        ...record.key,
        webContentsId: contents.id,
        activate: key.activate,
      });
    } catch (error) {
      this.destroy(record);
      throw error;
    }
    this.deps.guard(contents);
    try {
      // Trackpad pinch zoom, as in Chrome.
      void contents.setVisualZoomLevelLimits?.(1, 3);
    } catch {
      // Not supported: keep the default.
    }
    this.evictBeyondCap();
    return this.state(record, false);
  }

  load(key: BrowserTabViewKey, url: string): boolean {
    const record = this.get(key);
    if (!record || !isLoadableTabViewUrl(url)) return false;
    record.lastUsed = Date.now();
    // Aborted loads (a newer navigation, a blocked request) reject; events report the outcome.
    Promise.resolve(record.contents.loadURL(url)).catch(() => undefined);
    return true;
  }

  /**
   * Draw CoWork's cursor inside the page: a native view covers the app's own cursor overlay.
   * The marker lives in an isolated world behind a closed shadow root, ignores the pointer and
   * hides itself, so it never reaches the page's scripts or events. Returns false when the tab
   * has no native view (the renderer draws the cursor then).
   */
  paintCursor(
    key: BrowserTabViewKey,
    cursor: { x: number; y: number; kind?: string; label?: string; pulse?: boolean },
  ): boolean {
    const record = this.get(key);
    if (!record || record.contents.isDestroyed?.()) return false;
    const payload = JSON.stringify({
      x: Math.max(0, Math.round(Number(cursor.x) || 0)),
      y: Math.max(0, Math.round(Number(cursor.y) || 0)),
      kind: String(cursor.kind || "move").slice(0, 16),
      label: String(cursor.label || "").slice(0, 40),
      pulse: cursor.pulse === true,
    });
    void Promise.resolve(
      record.contents.executeJavaScriptInIsolatedWorld?.(CURSOR_WORLD_ID, [
        { code: `(${CURSOR_SCRIPT})(${payload})` },
      ]),
    ).catch(() => undefined);
    return true;
  }

  /** The visible tab view under a screen point (window gestures act on the page under the pointer). */
  viewKeyAtScreenPoint(point: { x: number; y: number }): BrowserTabViewKey | null {
    const window = this.deps.getWindow();
    const content = window?.getContentBounds?.();
    if (!content) return null;
    const zoom = Number(window?.webContents?.getZoomFactor?.()) || 1;
    for (const record of this.records.values()) {
      if (!record.visible) continue;
      const bounds = record.view.getBounds?.();
      if (!bounds) continue;
      const x = (point.x - content.x) * zoom;
      const y = (point.y - content.y) * zoom;
      if (
        x >= bounds.x &&
        x < bounds.x + bounds.width &&
        y >= bounds.y &&
        y < bounds.y + bounds.height
      ) {
        return { ...record.key };
      }
    }
    return null;
  }

  command(key: BrowserTabViewKey, command: BrowserTabViewCommand, args: Any = {}): boolean {
    const record = this.get(key);
    if (!record || record.contents.isDestroyed?.()) return false;
    const contents = record.contents;
    const nav = contents.navigationHistory;
    try {
      switch (command) {
        case "goBack":
          if (nav?.goBack) nav.goBack();
          else contents.goBack?.();
          break;
        case "goForward":
          if (nav?.goForward) nav.goForward();
          else contents.goForward?.();
          break;
        case "reload":
          contents.reload();
          break;
        case "stop":
          contents.stop();
          break;
        case "hardReload":
          contents.reloadIgnoringCache();
          break;
        case "setZoomLevel": {
          const level = Number(args.level);
          contents.setZoomLevel(Number.isFinite(level) ? Math.min(9, Math.max(-8, level)) : 0);
          break;
        }
        case "setAudioMuted":
          contents.setAudioMuted(args.muted === true);
          break;
        case "find":
          if (typeof args.text === "string" && args.text) {
            contents.findInPage(args.text.slice(0, 1000), {
              forward: args.forward !== false,
              findNext: args.findNext === true,
              matchCase: args.matchCase === true,
            });
          }
          break;
        case "stopFind":
          contents.stopFindInPage("clearSelection");
          break;
        case "focus":
          contents.focus();
          break;
      }
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Show one tab of a session at these window-relative bounds (CSS pixels of the
   * app window) and hide the session's other views. Null bounds hide that tab only,
   * or every view of the session when tabId is null too.
   */
  layout(input: {
    taskId: string;
    sessionId: string;
    tabId: string | null;
    bounds: BrowserTabViewBounds | null;
  }): void {
    const window = this.deps.getWindow();
    const zoom = Number(window?.webContents?.getZoomFactor?.()) || 1;
    const prefix = sessionKey(input.taskId, input.sessionId);
    for (const record of this.records.values()) {
      if (sessionKey(record.key.taskId, record.key.sessionId) !== prefix) continue;
      // Hiding one tab (null bounds) leaves the session's other views as they are: a tab
      // that unmounts or gets covered must not hide the one now shown.
      if (input.bounds === null && input.tabId !== null && record.key.tabId !== input.tabId) {
        continue;
      }
      const show = input.bounds !== null && record.key.tabId === input.tabId;
      if (show && input.bounds) {
        this.ensureAttached(record);
        const bounds = {
          x: Math.round(input.bounds.x * zoom),
          y: Math.round(input.bounds.y * zoom),
          width: Math.max(1, Math.round(input.bounds.width * zoom)),
          height: Math.max(1, Math.round(input.bounds.height * zoom)),
        };
        record.view.setBounds(bounds);
        record.lastUsed = Date.now();
      }
      // Always applied (not only on change): the renderer re-sends while shown, so a view
      // whose visibility drifted from what was last recorded is corrected on the next frame.
      if (show) {
        if (!record.visible) record.contents.invalidate?.();
        record.view.setVisible?.(true);
      } else if (record.visible) {
        record.view.setVisible?.(false);
      }
      record.visible = show;
    }
  }

  /** Hide every view of a session (the browser closed or the task switched); pages stay live. */
  hideSession(taskId: string, sessionId: string): void {
    this.layout({ taskId, sessionId, tabId: null, bounds: null });
  }

  /** A still image of the page, shown under renderer overlays while the view is hidden. */
  async capture(key: BrowserTabViewKey): Promise<string | null> {
    const record = this.get(key);
    if (!record || record.contents.isDestroyed?.()) return null;
    try {
      const image = await record.contents.capturePage();
      return image?.isEmpty?.() ? null : image.toDataURL();
    } catch {
      return null;
    }
  }

  close(key: BrowserTabViewKey): void {
    const record = this.get(key);
    if (record) this.destroy(record);
  }

  /** Close every view of a task (the task was deleted). */
  closeTask(taskId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.key.taskId === taskId) this.destroy(record);
    }
  }

  /** Close every view (the window they live in is gone). */
  closeAll(): void {
    for (const record of [...this.records.values()]) this.destroy(record);
  }

  private state(record: TabViewRecord, reused: boolean): BrowserTabViewState {
    const contents = record.contents;
    return {
      webContentsId: contents.id,
      reused,
      url: reused ? String(contents.getURL?.() || "") : "",
      title: reused ? String(contents.getTitle?.() || "") : "",
      loading: reused ? Boolean(contents.isLoading?.()) : false,
      ...(reused && record.favicon ? { favicon: record.favicon } : {}),
      ...history(contents),
    };
  }

  /** Put the view back in the window if it is not a child of it (window replaced, removed). */
  private ensureAttached(record: TabViewRecord): void {
    const contentView = this.deps.getWindow()?.contentView;
    if (!contentView?.children || contentView.children.includes(record.view)) return;
    contentView.addChildView(record.view);
  }

  private evictBeyondCap(): void {
    const max = this.deps.maxLiveViews ?? DEFAULT_MAX_LIVE_VIEWS;
    if (this.records.size <= max) return;
    const hidden = [...this.records.values()]
      .filter((record) => !record.visible)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const record of hidden.slice(0, this.records.size - max)) {
      this.destroy(record);
      // The renderer reloads the tab from its URL when it is shown again.
      this.deps.emit({ ...record.key, type: "gone", reason: "discarded" });
    }
  }

  private destroy(record: TabViewRecord): void {
    this.records.delete(recordKey(record.key));
    const contents = record.contents;
    this.deps.unregister({ ...record.key, webContentsId: record.webContentsId });
    try {
      this.deps.getWindow()?.contentView?.removeChildView?.(record.view);
    } catch {
      // The window is closing.
    }
    try {
      if (!contents.isDestroyed?.()) contents.close?.();
    } catch {
      // Already gone.
    }
  }

  private wireEvents(record: TabViewRecord): void {
    const { contents, key } = record;
    const emit = (event: Any) => this.deps.emit({ ...key, ...event } as BrowserTabViewEvent);
    const status = () => {
      if (contents.isDestroyed?.()) return;
      this.deps.updateStatus({
        ...key,
        webContentsId: contents.id,
        url: String(contents.getURL?.() || ""),
        title: String(contents.getTitle?.() || ""),
      });
    };
    contents.on("did-navigate", (_event: Any, url: string) => {
      emit({ type: "navigate", url, inPage: false, ...history(contents) });
      status();
    });
    contents.on("did-navigate-in-page", (_event: Any, url: string, isMainFrame: boolean) => {
      if (isMainFrame === false) return;
      emit({ type: "navigate", url, inPage: true, ...history(contents) });
      status();
    });
    contents.on("did-start-navigation", (details: Any) => {
      if (details?.isMainFrame === false) return;
      emit({ type: "start-navigation", isSameDocument: details?.isSameDocument === true });
    });
    contents.on("page-title-updated", (_event: Any, title: string) => {
      emit({ type: "title", title: String(title || "") });
      status();
    });
    contents.on("page-favicon-updated", (_event: Any, favicons: string[]) => {
      const list = Array.isArray(favicons) ? favicons.slice(0, 8) : [];
      record.favicon = list.find((value) => /^https?:|^data:image\//.test(String(value)));
      emit({ type: "favicon", favicons: list });
    });
    contents.on("did-start-loading", () =>
      emit({ type: "loading", loading: true, ...history(contents) }),
    );
    contents.on("did-stop-loading", () => {
      emit({ type: "loading", loading: false, ...history(contents) });
      status();
    });
    contents.on(
      "did-fail-load",
      (
        _event: Any,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame === false) return;
        emit({
          type: "fail",
          errorCode: Number(errorCode),
          errorDescription: String(errorDescription || ""),
          validatedURL: String(validatedURL || ""),
        });
      },
    );
    contents.on("render-process-gone", (_event: Any, details: Any) => {
      emit({ type: "gone", reason: String(details?.reason || "crashed") });
    });
    contents.on("found-in-page", (_event: Any, result: Any) => {
      emit({
        type: "found",
        activeMatchOrdinal: Number(result?.activeMatchOrdinal) || 0,
        matches: Number(result?.matches) || 0,
      });
    });
    contents.on("media-started-playing", () => emit({ type: "media", audible: true }));
    contents.on("media-paused", () => emit({ type: "media", audible: false }));
    // While CoWork drives the tab, a click on the page asks to take over instead
    // of reaching the page (the webview engine used a shield over the page).
    contents.on("before-mouse-event", (event: Any, mouse: Any) => {
      // The mouse's back and forward buttons navigate the page they are over, as in any browser.
      if (mouse?.button === "back" || mouse?.button === "forward") {
        event.preventDefault();
        if (mouse.type === "mouseDown") {
          this.command(key, mouse.button === "back" ? "goBack" : "goForward");
        }
        return;
      }
      if (mouse?.type !== "mouseDown") return;
      if (!this.deps.isAgentDriving?.(key.taskId, key.sessionId)) return;
      event.preventDefault();
      emit({ type: "takeover-click" });
    });
    contents.once("destroyed", () => {
      if (this.records.get(recordKey(key))?.contents === contents) {
        this.records.delete(recordKey(key));
        this.deps.unregister({ ...key, webContentsId: record.webContentsId });
      }
    });
  }
}

let currentHost: BrowserTabViewHost | null = null;

/** The app's host, so code outside main.ts (task deletion) can close a task's views. */
export function setBrowserTabViewHost(host: BrowserTabViewHost | null): void {
  currentHost = host;
}

export function closeBrowserTabViewsForTask(taskId: string): void {
  currentHost?.closeTask(taskId);
}
