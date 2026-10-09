import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { BrowserTab } from "./browser-tabs-model";
import { readZoomLevel, writeZoomLevel } from "./browser-zoom";

export type BrowserTabHandle = {
  /** Load a URL in this tab (after the page is registered and guarded). */
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  hardReload: () => void;
  getWebContentsId: () => number | undefined;
  /** Set this tab's zoom; remembered for the page's site. */
  setZoomLevel: (level: number) => void;
  setAudioMuted: (muted: boolean) => void;
  find: (
    text: string,
    options: { forward: boolean; findNext: boolean; matchCase: boolean },
  ) => void;
  stopFind: () => void;
  focus: () => void;
};

export type BrowserFindResult = { activeMatchOrdinal: number; matches: number };

type BrowserTabViewProps = {
  tab: BrowserTab;
  active: boolean;
  taskId: string;
  sessionId: string;
  partition: string;
  size: { width: number; height: number };
  onUpdate: (tabId: string, patch: Partial<BrowserTab>) => void;
  onStatus?: (tabId: string, status: { url: string; title: string }) => void;
  onGuardFailed?: (tabId: string) => void;
  registerHandle: (tabId: string, handle: BrowserTabHandle | null) => void;
  /**
   * Ask the main process whether a URL the user chose may load (and allow local
   * dev servers). A block is shown on the tab only while `isCurrent` holds.
   */
  checkUserNavigation: (tabId: string, url: string, isCurrent?: () => boolean) => Promise<boolean>;
  onFindResult?: (tabId: string, result: BrowserFindResult) => void;
  children?: ReactNode;
};

// Pages may open tabs and popups; the main process routes every window.open.
const webviewPopupProps = { allowpopups: "true" } as Any;

/** Chromium net errors that are not page failures (aborted, or cancelled by our own guard). */
const IGNORED_LOAD_ERRORS = new Set([-3]);
const BLOCKED_BY_CLIENT = -20;

function isMainFrameEvent(event: Any): boolean {
  return event?.isMainFrame !== false;
}

/**
 * One workbench tab: a <webview> that stays mounted while the tab exists, so
 * switching tabs keeps scroll position, form input and history. Inactive tabs
 * are hidden with visibility (display:none would detach the guest).
 *
 * The webview starts at about:blank and only gets its URL after the main
 * process has registered its webContents and installed the access guards.
 */
export function BrowserTabView({
  tab,
  active,
  taskId,
  sessionId,
  partition,
  size,
  onUpdate,
  onStatus,
  onGuardFailed,
  registerHandle,
  checkUserNavigation,
  onFindResult,
  children,
}: BrowserTabViewProps) {
  const webviewRef = useRef<Any>(null);
  const domReadyRef = useRef(false);
  const registeredWebContentsIdRef = useRef<number | null>(null);
  const guardedRef = useRef(false);
  const pendingUrlRef = useRef<string>("");
  /** Bumped by every navigation request, so a slower, older one never overrides it. */
  const navigationSeqRef = useRef(0);
  const activeRef = useRef(active);
  const tabRef = useRef(tab);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);

  activeRef.current = active;
  tabRef.current = tab;

  const getWebContentsId = useCallback((): number | undefined => {
    const webview = webviewRef.current;
    if (!domReadyRef.current || !webview || typeof webview.getWebContentsId !== "function") {
      return undefined;
    }
    try {
      const id = webview.getWebContentsId();
      return typeof id === "number" ? id : undefined;
    } catch {
      return undefined;
    }
  }, []);

  const loadUrl = useCallback(
    async (url: string, fromUser: boolean) => {
      if (!url || url === "about:blank") return;
      const seq = ++navigationSeqRef.current;
      const isCurrent = () => navigationSeqRef.current === seq;
      onUpdate(tab.id, { blocked: undefined, loadError: undefined, crashed: undefined });
      if (fromUser && !(await checkUserNavigation(tab.id, url, isCurrent))) return;
      if (!isCurrent()) return;
      if (!guardedRef.current) {
        pendingUrlRef.current = url;
        return;
      }
      const webview = webviewRef.current;
      if (!webview || typeof webview.loadURL !== "function") return;
      try {
        await webview.loadURL(url);
      } catch {
        // Aborted loads (a newer navigation, a blocked request) reject; events report the outcome.
      }
    },
    [checkUserNavigation, onUpdate, tab.id],
  );

  const applyZoom = useCallback(
    (level: number, url: string, remember: boolean) => {
      const webview = webviewRef.current;
      if (!webview || typeof webview.setZoomLevel !== "function" || !guardedRef.current) return;
      try {
        webview.setZoomLevel(level);
      } catch {
        return;
      }
      if (remember) writeZoomLevel(partition, url, level);
      onUpdate(tab.id, { zoomLevel: level });
    },
    [onUpdate, partition, tab.id],
  );

  const runCommand = useCallback(
    (command: "goBack" | "goForward" | "reload" | "stop" | "reloadIgnoringCache") => {
      const webview = webviewRef.current;
      if (!webview || typeof webview[command] !== "function") return;
      try {
        webview[command]();
      } catch {
        // The webview throws if commands run during attach or teardown.
      }
    },
    [],
  );

  const updateHistory = useCallback(() => {
    const webview = webviewRef.current;
    try {
      onUpdate(tab.id, {
        canGoBack: Boolean(webview?.canGoBack?.()),
        canGoForward: Boolean(webview?.canGoForward?.()),
      });
    } catch {
      // History is unavailable while the guest attaches.
    }
  }, [onUpdate, tab.id]);

  /** The http(s) page the webview has loaded, if any (a blocked navigation never replaces it). */
  const getLoadedPageUrl = useCallback((): string => {
    if (!guardedRef.current) return "";
    try {
      const url = String(webviewRef.current?.getURL?.() || "");
      return /^https?:\/\//i.test(url) ? url : "";
    } catch {
      return "";
    }
  }, []);

  useEffect(() => {
    registerHandle(tab.id, {
      navigate: (url) => void loadUrl(url, true),
      goBack: () => {
        // A blocked navigation added no history entry: Back returns to the page
        // still loaded under the notice instead of skipping past it.
        const loadedUrl = tabRef.current.blocked ? getLoadedPageUrl() : "";
        if (loadedUrl) {
          onUpdate(tab.id, { url: loadedUrl, blocked: undefined });
          updateHistory();
          return;
        }
        runCommand("goBack");
      },
      goForward: () => runCommand("goForward"),
      reload: () => runCommand("reload"),
      stop: () => runCommand("stop"),
      hardReload: () => runCommand("reloadIgnoringCache"),
      getWebContentsId,
      setZoomLevel: (level) => applyZoom(level, tabRef.current.url, true),
      setAudioMuted: (muted) => {
        try {
          webviewRef.current?.setAudioMuted?.(muted);
          onUpdate(tab.id, { muted });
        } catch {
          // Not attached yet.
        }
      },
      find: (text, options) => {
        const webview = webviewRef.current;
        if (!text || !webview || typeof webview.findInPage !== "function") return;
        try {
          webview.findInPage(text, options);
        } catch {
          // Not attached yet.
        }
      },
      stopFind: () => {
        try {
          webviewRef.current?.stopFindInPage?.("clearSelection");
        } catch {
          // Not attached yet.
        }
      },
      focus: () => {
        try {
          webviewRef.current?.focus?.();
        } catch {
          // Not attached yet.
        }
      },
    });
    return () => registerHandle(tab.id, null);
  }, [
    applyZoom,
    getLoadedPageUrl,
    getWebContentsId,
    loadUrl,
    onUpdate,
    registerHandle,
    runCommand,
    tab.id,
    updateHistory,
  ]);

  const reportStatus = useCallback(() => {
    const webview = webviewRef.current;
    const webContentsId = getWebContentsId();
    if (typeof webContentsId !== "number" || !guardedRef.current) return;
    const url = typeof webview?.getURL === "function" ? webview.getURL() : tabRef.current.url;
    const title =
      typeof webview?.getTitle === "function" ? webview.getTitle() : tabRef.current.title;
    void window.electronAPI.updateBrowserWorkbenchStatus?.({
      taskId,
      sessionId,
      tabId: tab.id,
      webContentsId,
      url,
      title,
    });
    onStatus?.(tab.id, { url, title });
  }, [getWebContentsId, onStatus, sessionId, tab.id, taskId]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const register = async () => {
      if (registeredWebContentsIdRef.current !== null) return;
      const webContentsId = getWebContentsId();
      if (typeof webContentsId !== "number") return;
      registeredWebContentsIdRef.current = webContentsId;
      try {
        await window.electronAPI.registerBrowserWorkbenchSession?.({
          taskId,
          sessionId,
          tabId: tab.id,
          activate: activeRef.current,
          webContentsId,
          url: tabRef.current.url,
          title: tabRef.current.title,
        });
      } catch {
        registeredWebContentsIdRef.current = null;
        onGuardFailed?.(tab.id);
        return;
      }
      if (webviewRef.current !== webview) return;
      guardedRef.current = true;
      const pendingUrl = pendingUrlRef.current;
      pendingUrlRef.current = "";
      // A URL chosen while the page registered was checked already and wins.
      if (pendingUrl) {
        setSrcUrl(pendingUrl);
        return;
      }
      // A navigation still being checked now loads by itself once allowed.
      const seq = navigationSeqRef.current;
      if (seq > 0) return;
      const isCurrent = () => navigationSeqRef.current === seq;
      const target = tabRef.current.initialUrl;
      if (!target) {
        setSrcUrl("about:blank");
        return;
      }
      // Agent and page-opened tabs were checked by the main process already.
      const allowed =
        tabRef.current.openedByAgent || (await checkUserNavigation(tab.id, target, isCurrent));
      // The user navigated while the initial URL was checked: keep their page.
      if (!isCurrent()) return;
      setSrcUrl(allowed ? target : "about:blank");
    };

    const handleDomReady = () => {
      domReadyRef.current = true;
      try {
        // Trackpad pinch zoom, as in Chrome.
        void webview.setVisualZoomLevelLimits?.(1, 3);
      } catch {
        // Older guests ignore it.
      }
      void register();
    };
    const handleNavigate = (event: Any) => {
      if (!isMainFrameEvent(event)) return;
      const url = event?.url || webview.getURL?.() || "";
      if (url === "about:blank" && !tabRef.current.url) return;
      if (url === "about:blank" && !guardedRef.current) return;
      onUpdate(tab.id, { url, blocked: undefined, loadError: undefined });
      if (event?.type === "did-navigate") {
        // Each site keeps its own zoom level.
        applyZoom(readZoomLevel(partition, url), url, false);
      }
      updateHistory();
      reportStatus();
    };
    const handleFoundInPage = (event: Any) => {
      const result = event?.result;
      if (!result) return;
      onFindResult?.(tab.id, {
        activeMatchOrdinal: Number(result.activeMatchOrdinal) || 0,
        matches: Number(result.matches) || 0,
      });
    };
    const handleMediaStarted = () => onUpdate(tab.id, { audible: true });
    const handleMediaPaused = () => onUpdate(tab.id, { audible: false });
    const handleStartNavigation = (event: Any) => {
      if (!isMainFrameEvent(event) || event?.isSameDocument) return;
      onUpdate(tab.id, { blocked: undefined, loadError: undefined });
    };
    const handleTitle = (event: Any) => {
      onUpdate(tab.id, { title: event?.title || webview.getTitle?.() || "" });
      reportStatus();
    };
    const handleFavicon = (event: Any) => {
      const favicon = Array.isArray(event?.favicons)
        ? event.favicons.find(
            (value: unknown) => typeof value === "string" && /^https?:|^data:image\//.test(value),
          )
        : undefined;
      onUpdate(tab.id, { favicon });
    };
    const handleLoadingStart = () => onUpdate(tab.id, { loading: true });
    const handleLoadingStop = () => {
      onUpdate(tab.id, { loading: false });
      updateHistory();
      reportStatus();
    };
    const handleFailLoad = (event: Any) => {
      if (!isMainFrameEvent(event)) return;
      const code = Number(event?.errorCode);
      if (!Number.isFinite(code) || IGNORED_LOAD_ERRORS.has(code)) return;
      const url = String(event?.validatedURL || "");
      if (!url || url === "about:blank") return;
      onUpdate(tab.id, {
        loading: false,
        loadError: {
          url,
          code,
          description:
            code === BLOCKED_BY_CLIENT
              ? "ERR_BLOCKED_BY_CLIENT"
              : String(event?.errorDescription || "ERR_FAILED"),
        },
      });
    };
    const handleRenderProcessGone = (event: Any) => {
      const reason = String(event?.reason || event?.details?.reason || "crashed");
      const webContentsId = registeredWebContentsIdRef.current;
      if (typeof webContentsId === "number") {
        void window.electronAPI.unregisterBrowserWorkbenchSession?.({
          taskId,
          sessionId,
          tabId: tab.id,
          webContentsId,
        });
      }
      registeredWebContentsIdRef.current = null;
      guardedRef.current = false;
      domReadyRef.current = false;
      onUpdate(tab.id, { loading: false, crashed: reason });
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("did-start-navigation", handleStartNavigation);
    webview.addEventListener("page-title-updated", handleTitle);
    webview.addEventListener("page-favicon-updated", handleFavicon);
    webview.addEventListener("did-start-loading", handleLoadingStart);
    webview.addEventListener("did-stop-loading", handleLoadingStop);
    webview.addEventListener("did-fail-load", handleFailLoad);
    webview.addEventListener("render-process-gone", handleRenderProcessGone);
    webview.addEventListener("found-in-page", handleFoundInPage);
    webview.addEventListener("media-started-playing", handleMediaStarted);
    webview.addEventListener("media-paused", handleMediaPaused);
    const readyFrame = window.requestAnimationFrame(() => {
      if (domReadyRef.current) return;
      try {
        if (
          typeof webview.getWebContentsId === "function" &&
          typeof webview.getWebContentsId() === "number"
        ) {
          handleDomReady();
        }
      } catch {
        // Not attached yet; dom-ready registers it.
      }
    });
    return () => {
      window.cancelAnimationFrame(readyFrame);
      const webContentsId = registeredWebContentsIdRef.current;
      if (typeof webContentsId === "number") {
        void window.electronAPI.unregisterBrowserWorkbenchSession?.({
          taskId,
          sessionId,
          tabId: tab.id,
          webContentsId,
        });
      }
      registeredWebContentsIdRef.current = null;
      guardedRef.current = false;
      domReadyRef.current = false;
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("did-start-navigation", handleStartNavigation);
      webview.removeEventListener("page-title-updated", handleTitle);
      webview.removeEventListener("page-favicon-updated", handleFavicon);
      webview.removeEventListener("did-start-loading", handleLoadingStart);
      webview.removeEventListener("did-stop-loading", handleLoadingStop);
      webview.removeEventListener("did-fail-load", handleFailLoad);
      webview.removeEventListener("render-process-gone", handleRenderProcessGone);
      webview.removeEventListener("found-in-page", handleFoundInPage);
      webview.removeEventListener("media-started-playing", handleMediaStarted);
      webview.removeEventListener("media-paused", handleMediaPaused);
    };
    // Registration is per mounted webview; tab fields are read through tabRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, sessionId, tab.id]);

  // Back is available from a block whenever a page is still loaded under it.
  const blockedUrl = tab.blocked?.url;
  useEffect(() => {
    if (blockedUrl && getLoadedPageUrl()) onUpdate(tab.id, { canGoBack: true });
  }, [blockedUrl, getLoadedPageUrl, onUpdate, tab.id]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || size.width <= 0 || size.height <= 0) return;
    const width = String(size.width);
    const height = String(size.height);
    webview.style.width = `${width}px`;
    webview.style.height = `${height}px`;
    webview.setAttribute("width", width);
    webview.setAttribute("height", height);
    webview.setAttribute("autosize", "true");
    webview.setAttribute("minwidth", width);
    webview.setAttribute("maxwidth", width);
    webview.setAttribute("minheight", height);
    webview.setAttribute("maxheight", height);
  }, [size.height, size.width]);

  return (
    <div
      className={`browser-workbench-tab-frame ${active ? "is-active" : "is-hidden"}`}
      aria-hidden={active ? undefined : true}
      data-tab-id={tab.id}
    >
      <webview
        ref={webviewRef}
        src={srcUrl || "about:blank"}
        className="browser-workbench-webview"
        style={{ width: "100%", height: "100%" }}
        width={size.width}
        height={size.height}
        autosize="true"
        minwidth={size.width}
        maxwidth={size.width}
        minheight={size.height}
        maxheight={size.height}
        partition={partition}
        {...webviewPopupProps}
        webpreferences="contextIsolation=yes, nodeIntegration=no"
      />
      {children}
    </div>
  );
}
