import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { BrowserTabHandle, BrowserFindResult } from "./BrowserTabView";
import type { BrowserTab } from "./browser-tabs-model";
import { readZoomLevel, writeZoomLevel } from "./browser-zoom";

/** How the renderer covers the page: not at all, fully (view hidden), or with a still image. */
export type NativeTabCover = "none" | "hide" | "freeze";

type BrowserTabNativeViewProps = {
  tab: BrowserTab;
  active: boolean;
  taskId: string;
  sessionId: string;
  partition: string;
  cover: NativeTabCover;
  /** Changes when the page changed under a still image: retake it. */
  freezeNonce?: number;
  onUpdate: (tabId: string, patch: Partial<BrowserTab>) => void;
  onStatus?: (tabId: string, status: { url: string; title: string }) => void;
  onGuardFailed?: (tabId: string) => void;
  registerHandle: (tabId: string, handle: BrowserTabHandle | null) => void;
  checkUserNavigation: (tabId: string, url: string, isCurrent?: () => boolean) => Promise<boolean>;
  onFindResult?: (tabId: string, result: BrowserFindResult) => void;
  children?: ReactNode;
};

/** Chromium net errors that are not page failures (aborted, or cancelled by our own guard). */
const IGNORED_LOAD_ERRORS = new Set([-3]);
const BLOCKED_BY_CLIENT = -20;

type Bounds = { x: number; y: number; width: number; height: number };

function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * One workbench tab on the native engine: a main-process WebContentsView that
 * the main process draws over this frame. The frame reports its rectangle; the
 * page's events arrive over IPC and drive the same tab state as a <webview>.
 *
 * A native view always draws above the app's own UI, so while the renderer
 * covers the page (menus, dialogs, annotation) the view is hidden; `freeze`
 * shows a still image of the page in its place.
 *
 * The view outlives this component: unmounting (browser closed, task switched)
 * only hides it, and mounting again reattaches the live page.
 */
export function BrowserTabNativeView({
  tab,
  active,
  taskId,
  sessionId,
  partition,
  cover,
  freezeNonce = 0,
  onUpdate,
  onStatus,
  onGuardFailed,
  registerHandle,
  checkUserNavigation,
  onFindResult,
  children,
}: BrowserTabNativeViewProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const openedRef = useRef(false);
  const pendingUrlRef = useRef("");
  const navigationSeqRef = useRef(0);
  const pageUrlRef = useRef("");
  const tabRef = useRef(tab);
  const activeRef = useRef(active);
  const lastBoundsRef = useRef<Bounds | null>(null);
  const [frozenImage, setFrozenImage] = useState<string | null>(null);
  const coverRef = useRef(cover);
  coverRef.current = cover;
  const [reopenSeq, setReopenSeq] = useState(0);
  tabRef.current = tab;
  activeRef.current = active;
  const key = { taskId, sessionId, tabId: tab.id };
  const keyRef = useRef(key);
  keyRef.current = key;

  const hide = useCallback(() => {
    void window.electronAPI
      .layoutBrowserTabView?.({ ...keyRef.current, bounds: null })
      .catch(() => undefined);
  }, []);

  const command = useCallback(
    (
      name: Parameters<typeof window.electronAPI.commandBrowserTabView>[0]["command"],
      args?: Record<string, unknown>,
    ) => {
      if (!openedRef.current) return;
      void window.electronAPI
        .commandBrowserTabView?.({ ...keyRef.current, command: name, args })
        .catch(() => undefined);
    },
    [],
  );

  const loadUrl = useCallback(
    async (url: string, fromUser: boolean) => {
      if (!url || url === "about:blank") return;
      const seq = ++navigationSeqRef.current;
      const isCurrent = () => navigationSeqRef.current === seq;
      onUpdate(tab.id, { blocked: undefined, loadError: undefined, crashed: undefined });
      if (fromUser && !(await checkUserNavigation(tab.id, url, isCurrent))) return;
      if (!isCurrent()) return;
      if (!openedRef.current) {
        pendingUrlRef.current = url;
        return;
      }
      await window.electronAPI
        .loadBrowserTabView?.({ ...keyRef.current, url })
        .catch(() => undefined);
    },
    [checkUserNavigation, onUpdate, tab.id],
  );

  const applyZoom = useCallback(
    (level: number, url: string, remember: boolean) => {
      if (!openedRef.current) return;
      command("setZoomLevel", { level });
      if (remember) writeZoomLevel(partition, url, level);
      onUpdate(tab.id, { zoomLevel: level });
    },
    [command, onUpdate, partition, tab.id],
  );

  useEffect(() => {
    registerHandle(tab.id, {
      navigate: (url) => void loadUrl(url, true),
      goBack: () => {
        // A blocked navigation added no history entry: Back returns to the page
        // still loaded under the notice instead of skipping past it.
        const loadedUrl =
          tabRef.current.blocked && /^https?:/i.test(pageUrlRef.current) ? pageUrlRef.current : "";
        if (loadedUrl) {
          onUpdate(tab.id, { url: loadedUrl, blocked: undefined });
          return;
        }
        command("goBack");
      },
      goForward: () => command("goForward"),
      reload: () => command("reload"),
      stop: () => command("stop"),
      hardReload: () => command("hardReload"),
      getWebContentsId: () => undefined,
      setZoomLevel: (level) => applyZoom(level, tabRef.current.url, true),
      setAudioMuted: (muted) => {
        command("setAudioMuted", { muted });
        onUpdate(tab.id, { muted });
      },
      find: (text, options) => {
        if (text) command("find", { text, ...options });
      },
      stopFind: () => command("stopFind"),
      focus: () => command("focus"),
    });
    return () => registerHandle(tab.id, null);
  }, [applyZoom, command, loadUrl, onUpdate, registerHandle, tab.id]);

  // Open (or reattach) the view, then load the tab's page.
  useEffect(() => {
    let cancelled = false;
    openedRef.current = false;
    void (async () => {
      let state;
      try {
        if (!window.electronAPI.openBrowserTabView) throw new Error("Native tabs unavailable");
        state = await window.electronAPI.openBrowserTabView({
          ...keyRef.current,
          partition,
          activate: activeRef.current,
        });
      } catch {
        if (!cancelled) onGuardFailed?.(tab.id);
        return;
      }
      if (cancelled) return;
      openedRef.current = true;
      const pendingUrl = pendingUrlRef.current;
      pendingUrlRef.current = "";
      if (state.reused && state.url && state.url !== "about:blank" && !pendingUrl) {
        // The live page is still there: show it as it is.
        pageUrlRef.current = state.url;
        onUpdate(tab.id, {
          url: state.url,
          title: state.title || tabRef.current.title,
          favicon: state.favicon || tabRef.current.favicon,
          canGoBack: state.canGoBack,
          canGoForward: state.canGoForward,
          loading: state.loading,
          crashed: undefined,
        });
        return;
      }
      if (pendingUrl) {
        await window.electronAPI.loadBrowserTabView?.({ ...keyRef.current, url: pendingUrl });
        return;
      }
      const seq = navigationSeqRef.current;
      if (seq > 0) return;
      const isCurrent = () => navigationSeqRef.current === seq;
      const target = tabRef.current.initialUrl || tabRef.current.url;
      if (!target) return;
      const allowed =
        tabRef.current.openedByAgent || (await checkUserNavigation(tab.id, target, isCurrent));
      if (cancelled || !isCurrent() || !allowed) return;
      await window.electronAPI.loadBrowserTabView?.({ ...keyRef.current, url: target });
    })();
    return () => {
      cancelled = true;
      openedRef.current = false;
    };
    // The view is per tab; tab fields are read through tabRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, sessionId, tab.id, partition, reopenSeq]);

  // Page events from the main process.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onBrowserTabViewEvent?.((event) => {
      if (event.taskId !== taskId || event.sessionId !== sessionId || event.tabId !== tab.id) {
        return;
      }
      switch (event.type) {
        case "navigate": {
          if (event.url === "about:blank" && !tabRef.current.url) return;
          pageUrlRef.current = event.url;
          onUpdate(tab.id, {
            url: event.url,
            blocked: undefined,
            loadError: undefined,
            canGoBack: event.canGoBack,
            canGoForward: event.canGoForward,
          });
          // Each site keeps its own zoom level.
          if (!event.inPage) applyZoom(readZoomLevel(partition, event.url), event.url, false);
          onStatus?.(tab.id, { url: event.url, title: tabRef.current.title });
          break;
        }
        case "start-navigation":
          if (!event.isSameDocument) onUpdate(tab.id, { blocked: undefined, loadError: undefined });
          break;
        case "title":
          onUpdate(tab.id, { title: event.title });
          onStatus?.(tab.id, { url: tabRef.current.url, title: event.title });
          break;
        case "favicon":
          onUpdate(tab.id, {
            favicon: event.favicons.find((value) => /^https?:|^data:image\//.test(value)),
          });
          break;
        case "loading":
          onUpdate(tab.id, {
            loading: event.loading,
            canGoBack: event.canGoBack,
            canGoForward: event.canGoForward,
          });
          break;
        case "fail": {
          if (IGNORED_LOAD_ERRORS.has(event.errorCode)) return;
          if (!event.validatedURL || event.validatedURL === "about:blank") return;
          onUpdate(tab.id, {
            loading: false,
            loadError: {
              url: event.validatedURL,
              code: event.errorCode,
              description:
                event.errorCode === BLOCKED_BY_CLIENT
                  ? "ERR_BLOCKED_BY_CLIENT"
                  : event.errorDescription || "ERR_FAILED",
            },
          });
          break;
        }
        case "gone":
          openedRef.current = false;
          if (event.reason === "discarded") {
            // Closed to save memory while hidden: reopen from the tab's URL when shown.
            pendingUrlRef.current = tabRef.current.url;
            if (activeRef.current) setReopenSeq((value) => value + 1);
          } else {
            // A crashed page can't be reused: the next mount creates a new view.
            void window.electronAPI.closeBrowserTabView?.(keyRef.current).catch(() => undefined);
            onUpdate(tab.id, { loading: false, crashed: event.reason });
          }
          break;
        case "found":
          onFindResult?.(tab.id, {
            activeMatchOrdinal: event.activeMatchOrdinal,
            matches: event.matches,
          });
          break;
        case "media":
          onUpdate(tab.id, { audible: event.audible });
          break;
      }
    });
    return () => unsubscribe?.();
  }, [applyZoom, onFindResult, onStatus, onUpdate, partition, sessionId, tab.id, taskId]);

  // A discarded view comes back when its tab is shown again.
  useEffect(() => {
    if (active && !openedRef.current && pendingUrlRef.current) setReopenSeq((value) => value + 1);
  }, [active]);

  // Keep the view over this frame while the tab is active and nothing covers it.
  const showing = active && cover === "none";
  useEffect(() => {
    if (!showing) return;
    let frame = 0;
    let lastSentAt = 0;
    const send = (bounds: Bounds | null) => {
      const now = Date.now();
      // Unchanged bounds are re-sent once a second, so the main process can put back a
      // view whose visibility drifted (it applies every show).
      if (sameBounds(bounds, lastBoundsRef.current) && now - lastSentAt < 1000) return;
      lastSentAt = now;
      lastBoundsRef.current = bounds;
      void window.electronAPI
        .layoutBrowserTabView?.({ ...keyRef.current, bounds })
        .catch(() => undefined);
    };
    const measure = () => {
      const element = frameRef.current;
      if (element) {
        const rect = element.getBoundingClientRect();
        // Clip to the visible surface (a forced page size can be larger than the panel).
        const surface = element.closest(".browser-workbench-surface")?.getBoundingClientRect();
        const left = Math.max(rect.left, surface?.left ?? rect.left);
        const top = Math.max(rect.top, surface?.top ?? rect.top);
        const right = Math.min(rect.right, surface?.right ?? rect.right);
        const bottom = Math.min(rect.bottom, surface?.bottom ?? rect.bottom);
        const width = Math.round(right - left);
        const height = Math.round(bottom - top);
        send(
          width > 0 && height > 0
            ? { x: Math.round(left), y: Math.round(top), width, height }
            : null,
        );
      }
      // The frame moves with the dock, panels and transitions without resizing: follow it.
      frame = window.requestAnimationFrame(measure);
    };
    lastBoundsRef.current = null;
    measure();
    return () => {
      window.cancelAnimationFrame(frame);
      lastBoundsRef.current = null;
      // Freezing captures the live page first and hides the view after that.
      if (activeRef.current && coverRef.current === "freeze") return;
      hide();
    };
  }, [showing, reopenSeq]);

  // Covered by a menu or annotation: a still image of the page replaces the view.
  useEffect(() => {
    if (!active || cover !== "freeze") {
      setFrozenImage(null);
      return;
    }
    let cancelled = false;
    void window.electronAPI
      .captureBrowserTabView?.(keyRef.current)
      .then((image) => {
        if (!cancelled) setFrozenImage(image || null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) hide();
      });
    return () => {
      cancelled = true;
    };
  }, [active, cover, freezeNonce]);

  // Leaving (browser closed, task switched): the view stays alive but out of sight.
  useEffect(() => () => hide(), []);

  // Back is available from a block whenever a page is still loaded under it.
  const blockedUrl = tab.blocked?.url;
  useEffect(() => {
    if (blockedUrl && /^https?:/i.test(pageUrlRef.current)) onUpdate(tab.id, { canGoBack: true });
  }, [blockedUrl, onUpdate, tab.id]);

  return (
    <div
      ref={frameRef}
      className={`browser-workbench-tab-frame is-native ${active ? "is-active" : "is-hidden"}`}
      aria-hidden={active ? undefined : true}
      data-tab-id={tab.id}
    >
      {frozenImage && (
        <img className="browser-workbench-tab-freeze" src={frozenImage} alt="" draggable={false} />
      )}
      {children}
    </div>
  );
}
