import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  ChevronDown,
  ExternalLink,
  Maximize2,
  Mic,
  Minimize2,
  Monitor,
  PencilLine,
  Plus,
  RotateCw,
  ScanLine,
  Search,
  Smartphone,
  Square,
  Tablet,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  ApprovalRequest,
  ApprovalResponseAction,
  ImageAttachment,
  Annotation,
  BrowserAnnotationTargetRef,
  BrowserAnnotationTargetResolveResult,
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
} from "../../shared/types";
import { hasHostMethod } from "../host/browser-capabilities";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { ModelDropdown } from "./MainContent";
import type { SpreadsheetTurnContext } from "./SpreadsheetArtifactViewer";
import { type BrowserShortcutCommand, matchBrowserShortcut } from "../../shared/browser-shortcuts";
import { BrowserTabNotice } from "./BrowserWorkbench/BrowserTabNotice";
import {
  type BrowserFindResult,
  type BrowserTabHandle,
  BrowserTabView,
} from "./BrowserWorkbench/BrowserTabView";
import { browserTabsStorageKey } from "./BrowserWorkbench/browser-tabs-model";
import { stepZoomLevel } from "./BrowserWorkbench/browser-zoom";
import { DiagnosticsDrawer } from "./BrowserWorkbench/DiagnosticsDrawer";
import { FindBar, type FindBarHandle } from "./BrowserWorkbench/FindBar";
import { NewTabPage } from "./BrowserWorkbench/NewTabPage";
import { Omnibox, type OmniboxHandle } from "./BrowserWorkbench/Omnibox";
import { buildSearchUrl } from "./BrowserWorkbench/omnibox-input";
import { SnapshotOverlay } from "./BrowserWorkbench/SnapshotOverlay";
import { TabStrip, type TabMenuCommand } from "./BrowserWorkbench/TabStrip";
import {
  type BrowserPermissionChoice,
  type BrowserPermissionPromptRequest,
  PermissionPrompt,
} from "./BrowserWorkbench/PermissionPrompt";
import { type BrowserPageDialogRequest, PageDialog } from "./BrowserWorkbench/PageDialog";
import { useBrowserTabs } from "./BrowserWorkbench/useBrowserTabs";
import {
  AgentDrivingBanner,
  AgentDrivingShield,
  SignInBanner,
  useAgentDriving,
} from "./BrowserWorkbench/AgentDrivingBanner";
import { BrowserApprovalCard } from "./BrowserWorkbench/BrowserApprovalCard";
import { DownloadShelf } from "./BrowserWorkbench/DownloadShelf";
import { AdjustPanel } from "./BrowserWorkbench/AdjustPanel";
import { type AdjustChanges, describeAdjustChanges } from "./BrowserWorkbench/adjust-changes";
import { ProfileMenu } from "./BrowserWorkbench/ProfileMenu";
import { useBrowserSettings } from "../hooks/useBrowserSettings";
import "./artifact-viewers.css";

type BrowserWorkbenchMode = "sidebar" | "fullscreen";
type BrowserWorkbenchContextActionPayload = {
  tabId: string;
  action:
    | { kind: "search"; text: string }
    | { kind: "ask"; text: string; url: string }
    | { kind: "annotate"; x: number; y: number }
    | { kind: "screenshot" };
};
type BrowserSettingsTab = Any;
type BrowserAnnotationDraft = {
  dataUrl: string;
  sourcePath?: string;
  fullPath?: string;
  width: number;
  height: number;
};
type BrowserCursorState = {
  x: number;
  y: number;
  kind: string;
  label?: string;
  pulse?: boolean;
  at: number;
} | null;
type BrowserViewportOverride = {
  width: number;
  height: number;
  mobile: boolean;
  label: string;
};
type YouTubeAskSource = {
  videoId: string;
  title?: string;
  channel?: string;
  startMs: number;
  endMs?: number;
  text: string;
  url: string;
};
type YouTubeAskState = {
  answer?: string;
  sources?: YouTubeAskSource[];
  suggestedFollowUps?: string[];
  error?: string;
} | null;

type BrowserWorkbenchViewProps = {
  taskId: string;
  sessionId: string;
  initialUrl?: string;
  /** Changes with each open request (agent, link, title bar), so the same URL can reopen. */
  openRequestId?: string;
  workspaceId?: string;
  workspacePath?: string;
  mode: BrowserWorkbenchMode;
  onClose: () => void;
  onFullscreen: () => void;
  onExitFullscreen: () => void;
  onStatusChange?: (status: { url?: string; title?: string }) => void;
  onSendMessage?: (message: string, images?: ImageAttachment[]) => Promise<void>;
  selectedModelLabel?: string;
  selectedModel?: string;
  selectedProvider?: LLMProviderType;
  selectedReasoningEffort?: LLMReasoningEffort;
  availableModels?: LLMModelInfo[];
  availableProviders?: LLMProviderInfo[];
  onModelChange?: (selection: {
    providerType?: LLMProviderType;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => void;
  onOpenSettings?: (tab?: BrowserSettingsTab) => void;
  turnContext?: SpreadsheetTurnContext | null;
  /** The task's pending browser approval, answered over the tab instead of in a dialog. */
  pendingApproval?: ApprovalRequest | null;
  onApprovalRespond?: (approval: ApprovalRequest, action: ApprovalResponseAction) => void;
};

const BROWSER_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);

function normalizeUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return BROWSER_NAVIGATION_PROTOCOLS.has(parsed.protocol) ? value : "";
    } catch {
      return "";
    }
  }
  if (/^(localhost|127\.0\.0\.1|::1)(?::\d+)?(?:\/|$)/i.test(value)) {
    return `http://${value}`;
  }
  return `https://${value}`;
}

function getExternalBrowserUrl(rawUrl: string): string | null {
  const value = rawUrl.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(value) && !/^https?:\/\//i.test(value)) return null;
  const normalized = normalizeUrl(value);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function getAnnotationUrlKey(rawUrl: string): string {
  const value = rawUrl.trim();
  if (!value) return "";
  try {
    const parsed = new URL(normalizeUrl(value));
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return value.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

function annotationViewportMatches(
  target: BrowserAnnotationTargetRef,
  size: { width: number; height: number } | null,
): boolean {
  if (!target.viewport || !size) return false;
  return (
    Math.abs(target.viewport.width - size.width) <= 2 &&
    Math.abs(target.viewport.height - size.height) <= 2
  );
}

function getYouTubeVideoId(rawUrl: string): string | null {
  try {
    const parsed = new URL(normalizeUrl(rawUrl));
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const validId = (value: string | null | undefined) =>
      value && /^[a-zA-Z0-9_-]{11}$/.test(value) ? value : null;
    if (host === "youtu.be") {
      return validId(parsed.pathname.split("/").filter(Boolean)[0]);
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const watchId = validId(parsed.searchParams.get("v"));
      if (watchId) return watchId;
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") {
        return validId(parts[1]);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function formatYouTubeTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getPartition(workspaceId?: string): string {
  const safe = (workspaceId || "default").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return `persist:cowork-browser-${safe || "default"}`;
}

const VIEWPORT_PRESETS = [
  { label: "Desktop", width: 1440, height: 900, mobile: false, icon: Monitor },
  { label: "Tablet", width: 768, height: 1024, mobile: true, icon: Tablet },
  { label: "Mobile", width: 390, height: 844, mobile: true, icon: Smartphone },
] satisfies Array<BrowserViewportOverride & { icon: LucideIcon }>;

export function BrowserWorkbenchView({
  taskId,
  sessionId,
  initialUrl,
  openRequestId,
  workspaceId,
  workspacePath,
  mode,
  onClose,
  onFullscreen,
  onExitFullscreen,
  onStatusChange,
  onSendMessage,
  selectedModelLabel,
  selectedModel,
  selectedProvider,
  selectedReasoningEffort,
  availableModels = [],
  availableProviders = [],
  onModelChange,
  onOpenSettings,
  turnContext,
  pendingApproval,
  onApprovalRespond,
}: BrowserWorkbenchViewProps) {
  const initialNavigationUrl = normalizeUrl(initialUrl || "");
  const {
    settings: browserSettings,
    loaded: browserSettingsLoaded,
    save: saveBrowserSettings,
  } = useBrowserSettings();
  const {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    closeTab,
    activateTab,
    updateTab,
    reloadCrashedTab,
    reopenClosedTab,
    moveTab,
    closeTabs,
    togglePinTab,
    canReopenClosed,
    closedTabs,
  } = useBrowserTabs(
    browserTabsStorageKey(workspaceId, taskId, sessionId),
    initialNavigationUrl,
    // Settings load asynchronously; until then restore (the default).
    !browserSettingsLoaded || browserSettings.restoreTabs,
  );
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // The page's "Leave site?" check runs before a tab the user closes goes away.
  const confirmTabClose = useCallback(
    async (id: string): Promise<boolean> => {
      const before = tabsRef.current.find((tab) => tab.id === id);
      let close = true;
      try {
        const result = await window.electronAPI.checkBrowserWorkbenchTabClose?.({
          taskId,
          sessionId,
          tabId: id,
        });
        close = result?.close !== false;
      } catch {
        close = true;
      }
      // The check navigates the page away; reopening the tab should bring back the page.
      if (close && before) {
        updateTab(id, { url: before.url, title: before.title, favicon: before.favicon });
      }
      return close;
    },
    [sessionId, taskId, updateTab],
  );
  const closeTabChecked = useCallback(
    (id: string) => {
      void confirmTabClose(id).then((close) => {
        if (close) closeTab(id);
      });
    },
    [closeTab, confirmTabClose],
  );
  const closeTabsChecked = useCallback(
    (ids: string[]) => {
      void (async () => {
        const closing: string[] = [];
        for (const id of ids) {
          if (await confirmTabClose(id)) closing.push(id);
        }
        if (closing.length > 0) closeTabs(closing);
      })();
    },
    [closeTabs, confirmTabClose],
  );
  const searchEngine = browserSettings.searchEngine;
  const drivingState = useAgentDriving(taskId, sessionId);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [historyMatches, setHistoryMatches] = useState<Array<{ url: string; title: string }>>([]);
  const [recentHistory, setRecentHistory] = useState<Array<{ url: string; title: string }>>([]);
  const historyQueryRef = useRef(0);
  const tabHandlesRef = useRef(new Map<string, BrowserTabHandle>());
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const annotationImageRef = useRef<HTMLImageElement | null>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const annotationDrawingRef = useRef(false);
  const lastAnnotationInspectAtRef = useRef(0);
  const liveAnnotationInspectRequestIdRef = useRef(0);
  const activeUrl = activeTab?.url || "";
  const title = activeTab?.title || "";
  const isLoading = activeTab?.loading === true;
  const activeUrlRef = useRef(activeUrl);
  const titleRef = useRef(title);
  activeUrlRef.current = activeUrl;
  titleRef.current = title;
  const onStatusChangeRef = useRef(onStatusChange);
  // The address bar text is owned by the Omnibox; other code reads the current URL.
  const urlText = activeUrl;
  const sectionRef = useRef<HTMLElement | null>(null);
  const omniboxRef = useRef<OmniboxHandle | null>(null);
  const findBarRef = useRef<FindBarHandle | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findResult, setFindResult] = useState<BrowserFindResult | null>(null);

  const [permissionRequests, setPermissionRequests] = useState<BrowserPermissionPromptRequest[]>(
    [],
  );
  const [webviewSize, setWebviewSize] = useState<{ width: number; height: number } | null>(null);
  const [controlledViewport, setControlledViewport] = useState<BrowserViewportOverride | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [toolbarNotice, setToolbarNotice] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [annotationDraft, setAnnotationDraft] = useState<BrowserAnnotationDraft | null>(null);
  const [annotationMessage, setAnnotationMessage] = useState("");
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [annotationError, setAnnotationError] = useState("");
  const [liveAnnotationMode, setLiveAnnotationMode] = useState(false);
  const [liveAnnotationHover, setLiveAnnotationHover] = useState<BrowserAnnotationTargetRef | null>(
    null,
  );
  const [liveAnnotationTarget, setLiveAnnotationTarget] =
    useState<BrowserAnnotationTargetRef | null>(null);
  const [liveAnnotationText, setLiveAnnotationText] = useState("");
  const [liveAnnotationSaving, setLiveAnnotationSaving] = useState(false);
  const [liveAnnotationError, setLiveAnnotationError] = useState("");
  const [browserAnnotations, setBrowserAnnotations] = useState<Annotation[]>([]);
  const [turnContextExpanded, setTurnContextExpanded] = useState(false);
  const [browserCursor, setBrowserCursor] = useState<BrowserCursorState>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [snapshotOverlay, setSnapshotOverlay] = useState(false);
  const [youtubeAskOpen, setYoutubeAskOpen] = useState(false);
  const [youtubeQuestion, setYoutubeQuestion] = useState("");
  const [youtubeAskBusy, setYoutubeAskBusy] = useState(false);
  const [youtubeAskResult, setYoutubeAskResult] = useState<YouTubeAskState>(null);
  const partition = useMemo(() => getPartition(workspaceId), [workspaceId]);
  const viewportSize = useMemo(
    () =>
      controlledViewport
        ? { width: controlledViewport.width, height: controlledViewport.height }
        : webviewSize,
    [controlledViewport, webviewSize],
  );
  const fullscreenLabel =
    mode === "fullscreen" ? "Exit full screen" : "Open browser workbench in full screen";
  const visibleWebviewSize =
    viewportSize && viewportSize.width > 0 && viewportSize.height > 0 ? viewportSize : null;
  const liveAnnotationOverlayTarget = liveAnnotationTarget || liveAnnotationHover;
  const activeIsYouTube = Boolean(getYouTubeVideoId(activeUrl || urlText));
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      setVoiceNotice("");
      setMessage((current) => (current ? `${current} ${text}` : text));
    },
    onError: (nextMessage) => setVoiceNotice(nextMessage),
    onNotConfigured: () => {
      setVoiceNotice("Voice input is not configured.");
      onOpenSettings?.("voice");
    },
  });

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let frame = 0;
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = surface.getBoundingClientRect();
        const nextWidth = Math.max(0, Math.floor(surface.clientWidth || rect.width));
        const measuredHeight = Math.max(0, Math.floor(surface.clientHeight || rect.height));
        const availableHeight = Math.max(0, Math.floor(window.innerHeight - rect.top));
        const nextHeight =
          measuredHeight > 360 ? measuredHeight : Math.max(measuredHeight, availableHeight);
        setWebviewSize((current) => {
          // A collapsed surface (dock moving between sidebar and full view) keeps the
          // last size: dropping to null would unmount every tab's webview.
          if (current && (nextWidth <= 0 || nextHeight <= 0)) return current;
          if (current?.width === nextWidth && current.height === nextHeight) return current;
          return { width: nextWidth, height: nextHeight };
        });
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    window.addEventListener("resize", measure);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    onStatusChangeRef.current?.({ url: activeUrl, title });
  }, [activeUrl, title]);

  // Tools act on the tab the user is looking at.
  useEffect(() => {
    void window.electronAPI.activateBrowserWorkbenchTab?.({
      taskId,
      sessionId,
      tabId: activeTabId,
    });
  }, [activeTabId, sessionId, taskId]);

  // An open request (agent, chat link, title bar) brings its URL into view: an
  // existing tab already showing it, the blank active tab, or a new tab.
  const handledOpenRequestRef = useRef<string | null>(null);
  useEffect(() => {
    const requestKey = `${openRequestId || ""}|${initialUrl || ""}`;
    if (handledOpenRequestRef.current === requestKey) return;
    const isFirstRequest = handledOpenRequestRef.current === null;
    handledOpenRequestRef.current = requestKey;
    if (!initialUrl) return;
    const normalized = normalizeUrl(initialUrl);
    if (!normalized) {
      setToolbarNotice("Only http:// and https:// URLs are supported");
      return;
    }
    const existing = tabs.find((tab) => tab.url === normalized || tab.initialUrl === normalized);
    if (existing) {
      activateTab(existing.id);
      return;
    }
    if (isFirstRequest && tabs.length === 1 && !tabs[0].url && !tabs[0].initialUrl) {
      updateTab(tabs[0].id, { url: normalized, initialUrl: normalized });
      return;
    }
    if (!activeTab.url && !activeTab.initialUrl) {
      tabHandlesRef.current.get(activeTab.id)?.navigate(normalized);
      return;
    }
    openTab({ url: normalized });
    // Only a new request should open anything; tab changes must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl, openRequestId]);

  const registerTabHandle = useCallback((tabId: string, handle: BrowserTabHandle | null) => {
    if (handle) tabHandlesRef.current.set(tabId, handle);
    else tabHandlesRef.current.delete(tabId);
  }, []);

  /** User-chosen URLs go through the main process: local dev servers get allowed, blocks get explained. */
  const checkUserNavigation = useCallback(
    async (tabId: string, url: string): Promise<boolean> => {
      const check = window.electronAPI.browserWorkbenchUserNavigate;
      if (!check) return true;
      try {
        const result = await check({ taskId, sessionId, tabId, url });
        if (result.allowed) return true;
        updateTab(tabId, {
          url: result.url || url,
          loading: false,
          blocked: {
            url: result.url || url,
            reason: result.block?.reason || "policy",
            detail: result.block?.detail,
          },
        });
        return false;
      } catch {
        return true;
      }
    },
    [sessionId, taskId, updateTab],
  );

  const handleTabStatus = useCallback(
    (tabId: string, status: { url: string; title: string }) => {
      if (tabId !== activeTabId) return;
      onStatusChangeRef.current?.(status);
    },
    [activeTabId],
  );

  const handleGuardFailed = useCallback((tabId: string) => {
    if (tabId) setToolbarNotice("Browser network guards could not be installed.");
  }, []);

  // Main-process tab commands: tabs opened by pages and tools, tool tab switches and closes.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onBrowserWorkbenchTabCommand?.((command) => {
      if (command.taskId !== taskId || command.sessionId !== sessionId) return;
      if (command.command === "open") {
        openTab({
          id: command.tabId,
          url: command.url ? normalizeUrl(command.url) || command.url : "",
          background: command.background === true,
          openerTabId: command.openerTabId,
          openedByAgent: true,
        });
      } else if (command.command === "activate") {
        activateTab(command.tabId);
      } else if (command.command === "close") {
        closeTab(command.tabId);
      }
    });
    return () => unsubscribe?.();
  }, [activateTab, closeTab, openTab, sessionId, taskId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onBrowserWorkbenchNavigationBlocked?.((event) => {
      if (event.taskId !== taskId || event.sessionId !== sessionId) return;
      updateTab(event.tabId, {
        loading: false,
        loadError: undefined,
        blocked: { url: event.url, reason: event.reason, detail: event.detail },
      });
    });
    return () => unsubscribe?.();
  }, [sessionId, taskId, updateTab]);

  useEffect(() => {
    let cancelled = false;
    const addRequest = (prompt: BrowserPermissionPromptRequest) =>
      setPermissionRequests((current) =>
        current.some((request) => request.requestId === prompt.requestId)
          ? current
          : [...current, prompt],
      );
    void window.electronAPI
      .listBrowserWorkbenchPermissionRequests?.({ taskId, sessionId })
      .then((pending) => {
        if (!cancelled) for (const prompt of pending || []) addRequest(prompt);
      })
      .catch(() => undefined);
    const unsubscribe = window.electronAPI.onBrowserWorkbenchPermissionRequest?.((prompt) => {
      if (prompt.taskId !== taskId || prompt.sessionId !== sessionId) return;
      addRequest(prompt);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [sessionId, taskId]);

  // Page alert/confirm while CoWork's debugger owns the page's dialogs.
  const [pageDialogs, setPageDialogs] = useState<BrowserPageDialogRequest[]>([]);
  useEffect(() => {
    setPageDialogs([]);
    const unsubscribe = window.electronAPI.onBrowserWorkbenchPageDialog?.((event) => {
      if (event.taskId !== taskId || event.sessionId !== sessionId) return;
      if (event.state === "closed") {
        setPageDialogs((current) => current.filter((dialog) => dialog.dialogId !== event.dialogId));
        return;
      }
      setPageDialogs((current) =>
        current.some((dialog) => dialog.dialogId === event.dialogId)
          ? current
          : [...current, event],
      );
      // Like a browser, bring the tab that is waiting for an answer to the front.
      activateTab(event.tabId);
    });
    return () => unsubscribe?.();
  }, [activateTab, sessionId, taskId]);

  const respondToPageDialog = useCallback(
    (dialog: BrowserPageDialogRequest, accept: boolean) => {
      setPageDialogs((current) => current.filter((entry) => entry.dialogId !== dialog.dialogId));
      void window.electronAPI
        .respondBrowserWorkbenchPageDialog?.({
          taskId,
          sessionId,
          tabId: dialog.tabId,
          dialogId: dialog.dialogId,
          accept,
        })
        .catch(() => undefined);
    },
    [sessionId, taskId],
  );

  const respondToPermission = useCallback((requestId: string, choice: BrowserPermissionChoice) => {
    setPermissionRequests((current) =>
      current.filter((request) => request.requestId !== requestId),
    );
    void window.electronAPI
      .respondBrowserWorkbenchPermission?.({ requestId, response: choice })
      .catch(() => undefined);
  }, []);

  const navigate = useCallback(
    (nextUrl = urlText) => {
      const normalized = normalizeUrl(nextUrl);
      if (!normalized) {
        setToolbarNotice("Only http:// and https:// URLs are supported");
        return;
      }
      setToolbarNotice("");
      const handle = tabHandlesRef.current.get(activeTabId);
      if (handle) {
        if (!activeTab.url) updateTab(activeTabId, { url: normalized });
        handle.navigate(normalized);
      } else {
        updateTab(activeTabId, { url: normalized, initialUrl: normalized });
      }
    },
    [activeTab.url, activeTabId, updateTab, urlText],
  );

  const runWebviewCommand = useCallback(
    (command: "goBack" | "goForward" | "reload" | "stop") => {
      tabHandlesRef.current.get(activeTabId)?.[command]();
    },
    [activeTabId],
  );

  const openNewTab = useCallback(
    (url = "", afterTabId?: string) => {
      openTab({ url, afterTabId });
      // A blank tab starts in the address bar, like a browser.
      if (!url) window.requestAnimationFrame(() => omniboxRef.current?.focusAndSelect());
    },
    [openTab],
  );

  const closeFind = useCallback(() => {
    tabHandlesRef.current.get(activeTabId)?.stopFind();
    setFindOpen(false);
    setFindResult(null);
  }, [activeTabId]);

  // Find state belongs to one tab: switching tabs closes it.
  useEffect(() => {
    setFindOpen(false);
    setFindResult(null);
  }, [activeTabId]);

  const handleFindResult = useCallback((tabId: string, result: BrowserFindResult) => {
    setFindResult((current) =>
      current?.activeMatchOrdinal === result.activeMatchOrdinal &&
      current.matches === result.matches
        ? current
        : result,
    );
    void tabId;
  }, []);

  const handleTabMenuCommand = useCallback(
    (tabId: string, command: TabMenuCommand) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      const index = tabs.indexOf(tab);
      switch (command) {
        case "new-tab-right":
          openNewTab("", tabId);
          break;
        case "reload":
          tabHandlesRef.current.get(tabId)?.reload();
          break;
        case "duplicate":
          if (tab.url) openTab({ url: tab.url, afterTabId: tabId });
          break;
        case "toggle-pin":
          togglePinTab(tabId);
          break;
        case "toggle-mute":
          tabHandlesRef.current.get(tabId)?.setAudioMuted(!tab.muted);
          break;
        case "close":
          closeTabChecked(tabId);
          break;
        case "close-others":
          closeTabsChecked(
            tabs
              .filter((candidate) => candidate.id !== tabId && !candidate.pinned)
              .map((candidate) => candidate.id),
          );
          break;
        case "close-right":
          closeTabsChecked(
            tabs
              .slice(index + 1)
              .filter((candidate) => !candidate.pinned)
              .map((candidate) => candidate.id),
          );
          break;
        case "reopen-closed":
          reopenClosedTab();
          break;
      }
    },
    [closeTabChecked, closeTabsChecked, openNewTab, openTab, reopenClosedTab, tabs, togglePinTab],
  );

  const runShortcut = useCallback(
    (command: BrowserShortcutCommand) => {
      const handle = tabHandlesRef.current.get(activeTabId);
      const selectIndex = (index: number) => {
        const target = tabs[index];
        if (target) activateTab(target.id);
      };
      const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
      switch (command) {
        case "new-tab":
          openNewTab();
          break;
        case "close-tab":
          closeTabChecked(activeTabId);
          break;
        case "reopen-tab":
          reopenClosedTab();
          break;
        case "next-tab":
          selectIndex((activeIndex + 1) % tabs.length);
          break;
        case "previous-tab":
          selectIndex((activeIndex - 1 + tabs.length) % tabs.length);
          break;
        case "select-last-tab":
          selectIndex(tabs.length - 1);
          break;
        case "focus-address":
          omniboxRef.current?.focusAndSelect();
          break;
        case "reload":
          handle?.reload();
          break;
        case "hard-reload":
          handle?.hardReload();
          break;
        case "back":
          handle?.goBack();
          break;
        case "forward":
          handle?.goForward();
          break;
        case "find":
          // Leave the address bar first so typing goes to the find field.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          setFindOpen(true);
          window.requestAnimationFrame(() => findBarRef.current?.focus());
          break;
        case "find-next":
        case "find-previous":
          if (findOpen) findBarRef.current?.findNext(command === "find-next");
          else setFindOpen(true);
          break;
        case "zoom-in":
          handle?.setZoomLevel(stepZoomLevel(activeTab.zoomLevel, 1));
          break;
        case "zoom-out":
          handle?.setZoomLevel(stepZoomLevel(activeTab.zoomLevel, -1));
          break;
        case "zoom-reset":
          handle?.setZoomLevel(0);
          break;
        case "toggle-full-view":
          if (mode === "fullscreen") onExitFullscreen();
          else onFullscreen();
          break;
        default: {
          const digit = /^select-tab-(\d)$/.exec(command)?.[1];
          if (digit) selectIndex(Number(digit) - 1);
        }
      }
    },
    [
      activateTab,
      activeTab.zoomLevel,
      activeTabId,
      closeTabChecked,
      findOpen,
      mode,
      onExitFullscreen,
      onFullscreen,
      openNewTab,
      reopenClosedTab,
      tabs,
    ],
  );

  const runShortcutRef = useRef(runShortcut);
  runShortcutRef.current = runShortcut;
  const pointerInsideRef = useRef(false);

  // Shortcuts come from the main process: pressed in a page of this workbench, or
  // in the workbench chrome (main intercepts them there before the app menu).
  useEffect(() => {
    const unsubscribe = window.electronAPI.onBrowserWorkbenchShortcut?.((event) => {
      if (event.taskId) {
        if (event.taskId !== taskId || event.sessionId !== sessionId) return;
      } else {
        const section = sectionRef.current;
        const focused = Boolean(section && section.contains(document.activeElement));
        if (!focused && !(event.gesture && pointerInsideRef.current)) return;
      }
      runShortcutRef.current(event.command);
    });
    return () => unsubscribe?.();
  }, [sessionId, taskId]);

  // Fallback for chrome shortcuts the main process did not intercept (focus
  // reported late, or input that bypasses before-input-event). When main does
  // intercept, the key never reaches the renderer, so nothing runs twice.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const platform = /mac/i.test(navigator.platform) ? "darwin" : "other";
    const onKeyDown = (event: KeyboardEvent) => {
      const command = matchBrowserShortcut(
        {
          key: event.key,
          code: event.code,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          shift: event.shiftKey,
          alt: event.altKey,
        },
        platform,
      );
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      runShortcutRef.current(command);
    };
    section.addEventListener("keydown", onKeyDown, true);
    return () => section.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Tell the main process when keyboard focus is in the workbench chrome.
  useEffect(() => {
    const section = sectionRef.current;
    const setFocus = window.electronAPI.setBrowserWorkbenchFocus;
    if (!section || !setFocus) return;
    let focused = false;
    const update = () => {
      const next = section.contains(document.activeElement);
      if (next === focused) return;
      focused = next;
      void setFocus(next).catch(() => undefined);
    };
    const onFocusOut = () => window.setTimeout(update, 0);
    section.addEventListener("focusin", update);
    section.addEventListener("focusout", onFocusOut);
    return () => {
      section.removeEventListener("focusin", update);
      section.removeEventListener("focusout", onFocusOut);
      if (focused) void setFocus(false).catch(() => undefined);
    };
  }, []);

  const omniboxSource = useMemo(
    () => ({
      tabs: tabs
        .filter((tab) => tab.id !== activeTabId && tab.url)
        .map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })),
      // History matches first, then recently closed tabs.
      pages: [
        ...historyMatches,
        ...[...closedTabs].reverse().map((page) => ({ url: page.url, title: page.title })),
      ],
    }),
    [activeTabId, closedTabs, historyMatches, tabs],
  );

  const handleOmniboxQuery = useCallback(
    (text: string) => {
      const query = text.trim();
      const requestId = historyQueryRef.current + 1;
      historyQueryRef.current = requestId;
      if (!query || !workspaceId || !window.electronAPI.searchBrowserHistory) {
        setHistoryMatches([]);
        return;
      }
      window.setTimeout(() => {
        if (historyQueryRef.current !== requestId) return;
        void window.electronAPI
          .searchBrowserHistory({ workspaceId, query, limit: 6 })
          .then((entries) => {
            if (historyQueryRef.current !== requestId) return;
            setHistoryMatches(
              (entries || []).map((entry) => ({ url: entry.url, title: entry.title })),
            );
          })
          .catch(() => undefined);
      }, 120);
    },
    [workspaceId],
  );

  // The new-tab page lists recent pages from history.
  useEffect(() => {
    if (activeUrl || !workspaceId || !window.electronAPI.listBrowserHistory) return;
    let cancelled = false;
    void window.electronAPI
      .listBrowserHistory({ workspaceId, limit: 8 })
      .then((entries) => {
        if (!cancelled) {
          setRecentHistory(
            (entries || []).map((entry) => ({ url: entry.url, title: entry.title })),
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeTabId, activeUrl, workspaceId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onBrowserWorkbenchSignInRequired?.((event) => {
      if (event.taskId !== taskId || event.sessionId !== sessionId) return;
      if (event.tabId) activateTab(event.tabId);
      setSignInUrl(event.url);
    });
    return () => unsubscribe?.();
  }, [activateTab, sessionId, taskId]);

  const copySnapshotRef = useCallback((ref: string) => {
    void navigator.clipboard
      ?.writeText(ref)
      .then(() => setToolbarNotice(`Copied ${ref}`))
      .catch(() => setToolbarNotice("Copy failed"));
  }, []);

  const retryActiveTab = useCallback(() => {
    const failedUrl = activeTab.blocked?.url || activeTab.loadError?.url || activeTab.url;
    if (failedUrl) tabHandlesRef.current.get(activeTabId)?.navigate(failedUrl);
  }, [activeTab, activeTabId]);

  const openUrlExternal = useCallback(async (url: string) => {
    const externalUrl = getExternalBrowserUrl(url);
    if (!externalUrl) {
      setToolbarNotice("No external page");
      return;
    }
    try {
      await window.electronAPI.openExternal(externalUrl);
      setToolbarNotice("Opened externally");
    } catch (error) {
      setToolbarNotice(error instanceof Error ? error.message : "Open failed");
    }
  }, []);

  const openCurrentPageExternal = useCallback(async () => {
    const currentUrl = activeUrlRef.current || activeUrl || urlText;
    const externalUrl =
      getExternalBrowserUrl(currentUrl || "") ||
      getExternalBrowserUrl(activeUrl || "") ||
      getExternalBrowserUrl(urlText);
    if (!externalUrl) {
      setToolbarNotice("No external page");
      return;
    }
    try {
      await window.electronAPI.openExternal(externalUrl);
      setToolbarNotice("Opened externally");
    } catch (error) {
      setToolbarNotice(error instanceof Error ? error.message : "Open failed");
    }
  }, [activeUrl, urlText]);

  const applyViewportPreset = useCallback((preset: BrowserViewportOverride) => {
    setControlledViewport(preset);
    setToolbarNotice(preset.label);
  }, []);

  const resizeAnnotationCanvas = useCallback(() => {
    const image = annotationImageRef.current;
    const canvas = annotationCanvasRef.current;
    if (!image || !canvas) return;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 4;
    context.strokeStyle = "#2563eb";
  }, []);

  const clearAnnotationCanvas = useCallback(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  }, []);

  const getAnnotationPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }, []);

  const handleAnnotationPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = event.currentTarget;
      const context = canvas.getContext("2d");
      if (!context) return;
      annotationDrawingRef.current = true;
      canvas.setPointerCapture?.(event.pointerId);
      const point = getAnnotationPoint(event);
      context.beginPath();
      context.moveTo(point.x, point.y);
    },
    [getAnnotationPoint],
  );

  const handleAnnotationPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!annotationDrawingRef.current) return;
      const context = event.currentTarget.getContext("2d");
      if (!context) return;
      const point = getAnnotationPoint(event);
      context.lineTo(point.x, point.y);
      context.stroke();
    },
    [getAnnotationPoint],
  );

  const stopAnnotationDrawing = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    annotationDrawingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  useEffect(() => {
    if (!annotationDraft) return;
    const image = annotationImageRef.current;
    if (!image) return;
    let frame = window.requestAnimationFrame(resizeAnnotationCanvas);
    const observer = new ResizeObserver(resizeAnnotationCanvas);
    observer.observe(image);
    window.addEventListener("resize", resizeAnnotationCanvas);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resizeAnnotationCanvas);
    };
  }, [annotationDraft, resizeAnnotationCanvas]);

  const createAnnotatedDataUrl = useCallback(async (): Promise<string> => {
    if (!annotationDraft) throw new Error("No annotation is open.");
    const image = annotationImageRef.current;
    const overlay = annotationCanvasRef.current;
    if (!image || !overlay) throw new Error("Annotation surface is not ready.");
    const output = document.createElement("canvas");
    output.width = image.naturalWidth || annotationDraft.width || overlay.width;
    output.height = image.naturalHeight || annotationDraft.height || overlay.height;
    const context = output.getContext("2d");
    if (!context) throw new Error("Annotation export is not available.");
    context.drawImage(image, 0, 0, output.width, output.height);
    context.drawImage(overlay, 0, 0, output.width, output.height);
    return output.toDataURL("image/png");
  }, [annotationDraft]);

  const saveAnnotation = useCallback(
    async (sendToAgent: boolean) => {
      if (!annotationDraft || !workspaceId || !workspacePath) {
        setAnnotationError("Open a writable workspace to save an annotation.");
        return;
      }
      setAnnotationSaving(true);
      setAnnotationError("");
      try {
        const dataUrl = await createAnnotatedDataUrl();
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        const imported = await window.electronAPI.importDataToWorkspace({
          workspaceId,
          files: [
            {
              name: `browser-annotation-${Date.now()}.png`,
              data: base64,
              mimeType: "image/png",
            },
          ],
        });
        const saved = imported?.[0];
        if (!saved) throw new Error("Annotation could not be saved.");
        const fullPath = `${workspacePath.replace(/\/$/, "")}/${saved.relativePath}`;
        if (sendToAgent && onSendMessage) {
          const note =
            annotationMessage.trim() ||
            `Please inspect this annotated browser screenshot from ${activeUrlRef.current || activeUrl || "the current page"}.`;
          await onSendMessage(
            `${note}\n\nAttached files:\n- ${saved.fileName} (${saved.relativePath})`,
            [
              {
                filePath: fullPath,
                mimeType: "image/png",
                filename: saved.fileName,
                sizeBytes: saved.size,
              },
            ],
          );
        }
        setAnnotationDraft(null);
        setAnnotationMessage("");
        setToolbarNotice(sendToAgent ? "Annotation sent" : "Annotation saved");
      } catch (error) {
        setAnnotationError(error instanceof Error ? error.message : "Annotation failed");
      } finally {
        setAnnotationSaving(false);
      }
    },
    [
      activeUrl,
      annotationDraft,
      annotationMessage,
      createAnnotatedDataUrl,
      onSendMessage,
      workspaceId,
      workspacePath,
    ],
  );

  const captureScreenshot = useCallback(
    async (mode: "screenshot" | "annotation") => {
      if (!workspacePath) {
        setToolbarNotice("Open a workspace to capture");
        return;
      }
      const prefix = mode === "annotation" ? "browser-annotation-source" : "browser-screenshot";
      setToolbarNotice(mode === "annotation" ? "Capturing..." : "Saving...");
      const result = await window.electronAPI.captureBrowserWorkbenchScreenshot?.({
        taskId,
        sessionId,
        workspacePath,
        filename: `${prefix}-${Date.now()}.png`,
        includeDataUrl: mode === "annotation",
      });
      if (result?.success) {
        if (mode === "annotation") {
          if (!result.dataUrl) {
            setToolbarNotice("Capture failed");
            return;
          }
          setAnnotationDraft({
            dataUrl: result.dataUrl,
            sourcePath: result.path,
            fullPath: result.fullPath,
            width: result.width || 1,
            height: result.height || 1,
          });
          setAnnotationMessage("");
          setAnnotationError("");
          setToolbarNotice("");
        } else {
          setToolbarNotice("Screenshot saved");
        }
      } else {
        setToolbarNotice(result?.error || "Capture failed");
      }
    },
    [sessionId, taskId, workspacePath],
  );

  const loadBrowserAnnotations = useCallback(async () => {
    if (!hasHostMethod("listAnnotations")) {
      setBrowserAnnotations([]);
      return;
    }
    const currentUrl = activeUrlRef.current || activeUrl;
    const currentUrlKey = getAnnotationUrlKey(currentUrl);
    const annotations = await window.electronAPI.listAnnotations({
      taskId,
      surfaceType: "browser",
      statuses: ["open", "addressing"],
      limit: 100,
    });
    const matchingAnnotations = annotations.filter((annotation) => {
      const target = annotation.targetRef as BrowserAnnotationTargetRef;
      return (
        target.surfaceType === "browser" &&
        (!currentUrlKey || getAnnotationUrlKey(target.url) === currentUrlKey)
      );
    });
    if (
      !window.electronAPI.resolveBrowserWorkbenchAnnotationTargets ||
      matchingAnnotations.length === 0
    ) {
      setBrowserAnnotations(
        matchingAnnotations.filter((annotation) =>
          annotationViewportMatches(
            annotation.targetRef as BrowserAnnotationTargetRef,
            visibleWebviewSize,
          ),
        ),
      );
      return;
    }
    const resolved = await window.electronAPI.resolveBrowserWorkbenchAnnotationTargets({
      taskId,
      sessionId,
      targets: matchingAnnotations.map(
        (annotation) => annotation.targetRef as BrowserAnnotationTargetRef,
      ),
    });
    const resolvedByIndex = new Map<number, BrowserAnnotationTargetResolveResult>(
      (resolved.targets || []).map((result) => [result.index, result]),
    );
    setBrowserAnnotations(
      matchingAnnotations.flatMap((annotation, index) => {
        const target = annotation.targetRef as BrowserAnnotationTargetRef;
        const resolvedTarget = resolvedByIndex.get(index);
        if (resolvedTarget?.resolved && resolvedTarget.target?.rect) {
          return [
            {
              ...annotation,
              targetRef: {
                ...target,
                ...resolvedTarget.target,
                surfaceType: "browser",
                url: target.url,
                title: target.title,
                viewport: visibleWebviewSize
                  ? {
                      width: visibleWebviewSize.width,
                      height: visibleWebviewSize.height,
                      mobile: controlledViewport?.mobile,
                      label: controlledViewport?.label,
                    }
                  : target.viewport,
              } satisfies BrowserAnnotationTargetRef,
            },
          ];
        }
        return annotationViewportMatches(target, visibleWebviewSize) ? [annotation] : [];
      }),
    );
  }, [activeUrl, controlledViewport, sessionId, taskId, visibleWebviewSize]);

  useEffect(() => {
    void loadBrowserAnnotations();
  }, [loadBrowserAnnotations]);

  useEffect(() => {
    if (!activeUrl || browserAnnotations.length === 0) return;
    const timer = window.setInterval(() => {
      void loadBrowserAnnotations();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeUrl, browserAnnotations.length, loadBrowserAnnotations]);

  const buildBrowserAnnotationTarget = useCallback(
    (target: Partial<BrowserAnnotationTargetRef>): BrowserAnnotationTargetRef => ({
      surfaceType: "browser",
      url: activeUrlRef.current || activeUrl || urlText,
      title: titleRef.current || title || undefined,
      viewport: visibleWebviewSize
        ? {
            width: visibleWebviewSize.width,
            height: visibleWebviewSize.height,
            mobile: controlledViewport?.mobile,
            label: controlledViewport?.label,
          }
        : undefined,
      ...target,
    }),
    [activeUrl, controlledViewport, title, urlText, visibleWebviewSize],
  );

  const inspectLiveAnnotationPoint = useCallback(
    async (
      event: ReactPointerEvent<HTMLDivElement>,
      force = false,
    ): Promise<BrowserAnnotationTargetRef | null> => {
      if (!liveAnnotationMode || liveAnnotationTarget) return null;
      const now = Date.now();
      if (!force && now - lastAnnotationInspectAtRef.current < 120) return liveAnnotationHover;
      lastAnnotationInspectAtRef.current = now;
      const requestId = liveAnnotationInspectRequestIdRef.current + 1;
      liveAnnotationInspectRequestIdRef.current = requestId;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = clampNumber(event.clientX - rect.left, 0, rect.width);
      const y = clampNumber(event.clientY - rect.top, 0, rect.height);
      try {
        const result = await window.electronAPI.inspectBrowserWorkbenchPoint?.({
          taskId,
          sessionId,
          x,
          y,
        });
        if (!result?.success || !result.target) return null;
        const nextTarget = buildBrowserAnnotationTarget(result.target);
        if (requestId !== liveAnnotationInspectRequestIdRef.current) return null;
        setLiveAnnotationHover(nextTarget);
        return nextTarget;
      } catch (error) {
        setLiveAnnotationError(error instanceof Error ? error.message : "Inspection failed.");
        return null;
      }
    },
    [
      buildBrowserAnnotationTarget,
      liveAnnotationHover,
      liveAnnotationMode,
      liveAnnotationTarget,
      sessionId,
      taskId,
    ],
  );

  const selectLiveAnnotationTarget = useCallback(
    async (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!liveAnnotationMode || liveAnnotationTarget) return;
      event.preventDefault();
      const target = liveAnnotationHover || (await inspectLiveAnnotationPoint(event, true));
      if (!target) return;
      setLiveAnnotationTarget(target);
      setLiveAnnotationHover(null);
      setLiveAnnotationText("");
      setLiveAnnotationError("");
    },
    [inspectLiveAnnotationPoint, liveAnnotationHover, liveAnnotationMode, liveAnnotationTarget],
  );

  const cancelLiveAnnotationTarget = useCallback(() => {
    setLiveAnnotationTarget(null);
    setLiveAnnotationHover(null);
    setLiveAnnotationText("");
    setLiveAnnotationError("");
    setAdjustOpen(false);
    setAdjustChanges(null);
    adjustBeforePathRef.current = undefined;
  }, []);

  // Annotate an area: drag on the annotation layer instead of clicking an element.
  const annotationDragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [annotationArea, setAnnotationArea] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustChanges, setAdjustChanges] = useState<AdjustChanges | null>(null);
  const adjustBeforePathRef = useRef<string | undefined>(undefined);

  const layerPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const finishAnnotationArea = useCallback(
    async (area: { x: number; y: number; width: number; height: number }) => {
      const result = await window.electronAPI
        .inspectBrowserWorkbenchArea?.({ taskId, sessionId, rect: area })
        .catch(() => null);
      setAnnotationArea(null);
      if (!result?.success || !result.area) {
        setLiveAnnotationError("Nothing to annotate in that area.");
        return;
      }
      const elements = result.area.elements || [];
      setLiveAnnotationTarget(
        buildBrowserAnnotationTarget({
          rect: result.area.rect,
          scroll: result.area.scroll,
          tagName: "area",
          selector: elements[0]?.selector,
          textQuote: elements
            .map((element) => element.textQuote)
            .filter(Boolean)
            .join(" · ")
            .slice(0, 300),
          elements: elements.map((element) => ({
            selector: element.selector,
            tagName: element.tagName,
            role: element.role,
            accessibleName: element.accessibleName,
            textQuote: element.textQuote,
          })),
        }),
      );
      setLiveAnnotationHover(null);
      setLiveAnnotationText("");
      setLiveAnnotationError("");
    },
    [buildBrowserAnnotationTarget, sessionId, taskId],
  );

  const openAdjust = useCallback(async () => {
    setAdjustOpen(true);
    setAdjustChanges(null);
    // A "before" screenshot, so CoWork sees the change it is asked to make.
    if (workspacePath && window.electronAPI.captureBrowserWorkbenchScreenshot) {
      const capture = await window.electronAPI
        .captureBrowserWorkbenchScreenshot({
          taskId,
          sessionId,
          workspacePath,
          filename: `browser-adjust-before-${Date.now()}.png`,
        })
        .catch(() => null);
      adjustBeforePathRef.current = capture?.success ? capture.fullPath || capture.path : undefined;
    }
  }, [sessionId, taskId, workspacePath]);

  const saveLiveBrowserAnnotation = useCallback(
    async (sendToAgent: boolean) => {
      const body = liveAnnotationText.trim();
      if (!liveAnnotationTarget || !body) {
        setLiveAnnotationError("Add a note for this annotation.");
        return;
      }
      if (!window.electronAPI.createAnnotation) {
        setLiveAnnotationError("Annotations are not available in this build.");
        return;
      }
      setLiveAnnotationSaving(true);
      setLiveAnnotationError("");
      try {
        let screenshotPath: string | undefined;
        const adjusted =
          adjustOpen &&
          adjustChanges &&
          (Object.keys(adjustChanges.styles).length > 0 || adjustChanges.text);
        let afterPath: string | undefined;
        if (adjusted && workspacePath && window.electronAPI.captureBrowserWorkbenchScreenshot) {
          const after = await window.electronAPI.captureBrowserWorkbenchScreenshot({
            taskId,
            sessionId,
            workspacePath,
            filename: `browser-adjust-after-${Date.now()}.png`,
          });
          afterPath = after?.success ? after.fullPath || after.path : undefined;
          screenshotPath = adjustBeforePathRef.current;
        } else if (workspacePath && window.electronAPI.captureBrowserWorkbenchScreenshot) {
          const capture = await window.electronAPI.captureBrowserWorkbenchScreenshot({
            taskId,
            sessionId,
            workspacePath,
            filename: `browser-annotation-context-${Date.now()}.png`,
            includeDataUrl: false,
          });
          if (capture?.success) {
            screenshotPath = capture.fullPath || capture.path;
          }
        }
        const changeList = adjusted && adjustChanges ? describeAdjustChanges(adjustChanges) : "";
        const fullBody = changeList
          ? `${body}\n\nRequested changes (previewed live):\n${changeList}${
              afterPath
                ? `\n\nBefore: ${screenshotPath || "(no screenshot)"}\nAfter: ${afterPath}`
                : ""
            }`
          : body;
        const stylePatch =
          adjusted && adjustChanges
            ? {
                ...(adjustChanges.text ? { text: adjustChanges.text.to } : {}),
                ...(adjustChanges.styles.color ? { color: adjustChanges.styles.color.to } : {}),
                ...(adjustChanges.styles.backgroundColor
                  ? { backgroundColor: adjustChanges.styles.backgroundColor.to }
                  : {}),
                ...(adjustChanges.styles.fontFamily
                  ? { fontFamily: adjustChanges.styles.fontFamily.to }
                  : {}),
                ...(adjustChanges.styles.fontSize
                  ? { fontSize: adjustChanges.styles.fontSize.to }
                  : {}),
                ...(adjustChanges.styles.fontWeight
                  ? { fontWeight: adjustChanges.styles.fontWeight.to }
                  : {}),
                ...(adjustChanges.styles.lineHeight
                  ? { lineHeight: adjustChanges.styles.lineHeight.to }
                  : {}),
                ...(adjustChanges.styles.margin ? { margin: adjustChanges.styles.margin.to } : {}),
                ...(adjustChanges.styles.padding
                  ? { padding: adjustChanges.styles.padding.to }
                  : {}),
                ...(adjustChanges.styles.textAlign
                  ? { alignment: adjustChanges.styles.textAlign.to }
                  : {}),
                ...(adjustChanges.styles.borderRadius
                  ? { borderRadius: adjustChanges.styles.borderRadius.to }
                  : {}),
                ...(afterPath ? { notes: `After screenshot: ${afterPath}` } : {}),
              }
            : undefined;
        const created = await window.electronAPI.createAnnotation({
          taskId,
          workspaceId,
          surfaceType: "browser",
          surfaceId: liveAnnotationTarget.url,
          body: fullBody,
          targetRef: liveAnnotationTarget,
          screenshotPath,
          ...(stylePatch ? { stylePatch } : {}),
        });
        await loadBrowserAnnotations();
        cancelLiveAnnotationTarget();
        setToolbarNotice(sendToAgent ? "Annotation sent" : "Annotation saved");
        if (sendToAgent && onSendMessage) {
          await onSendMessage(
            `Address annotation ${created.id}: ${body}${changeList ? `\n${changeList}` : ""}`,
          );
        }
      } catch (error) {
        setLiveAnnotationError(error instanceof Error ? error.message : "Annotation failed.");
      } finally {
        setLiveAnnotationSaving(false);
      }
    },
    [
      adjustChanges,
      adjustOpen,
      cancelLiveAnnotationTarget,
      liveAnnotationTarget,
      liveAnnotationText,
      loadBrowserAnnotations,
      onSendMessage,
      sessionId,
      taskId,
      workspaceId,
      workspacePath,
    ],
  );

  useEffect(() => {
    if (!toolbarNotice) return;
    const timer = window.setTimeout(() => setToolbarNotice(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toolbarNotice]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onBrowserWorkbenchCursor?.((event) => {
      if (event.taskId !== taskId || event.sessionId !== sessionId) return;
      setBrowserCursor({
        x: event.x,
        y: event.y,
        kind: event.kind,
        label: event.label,
        pulse: event.pulse,
        at: event.at,
      });
    });
    return () => {
      unsubscribe?.();
    };
  }, [sessionId, taskId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onBrowserWorkbenchViewport?.((event) => {
      if (event.taskId !== taskId || event.sessionId !== sessionId) return;
      const width = Math.max(320, Math.round(event.width || 0));
      const height = Math.max(320, Math.round(event.height || 0));
      const label = event.label || `${event.mobile ? "Mobile" : "Desktop"} ${width}x${height}`;
      setControlledViewport({
        width,
        height,
        mobile: event.mobile === true,
        label,
      });
      setToolbarNotice(label);
    });
    return () => {
      unsubscribe?.();
    };
  }, [sessionId, taskId]);

  useEffect(() => {
    if (!browserCursor) return;
    const cursorAt = browserCursor.at;
    const timer = window.setTimeout(() => {
      setBrowserCursor((current) => (current?.at === cursorAt ? null : current));
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [browserCursor]);

  const contextActionRef = useRef<(event: BrowserWorkbenchContextActionPayload) => void>(() => {});
  contextActionRef.current = (event) => {
    const { action } = event;
    if (action.kind === "search") {
      openTab({ url: buildSearchUrl(action.text, searchEngine), afterTabId: event.tabId });
    } else if (action.kind === "ask") {
      const prompt = `About this text from ${action.url || "the page"}:\n\n> ${action.text
        .split("\n")
        .join("\n> ")}\n\n`;
      if (mode === "fullscreen") {
        setMessage((current) => (current ? `${current}\n\n${prompt}` : prompt));
      } else if (onSendMessage) {
        void onSendMessage(`${prompt}Explain this and tell me what matters here.`);
      }
    } else if (action.kind === "screenshot") {
      void captureScreenshot("screenshot");
    } else if (action.kind === "annotate") {
      setLiveAnnotationMode(true);
      void window.electronAPI
        .inspectBrowserWorkbenchPoint?.({ taskId, sessionId, x: action.x, y: action.y })
        .then((result) => {
          if (!result?.success || !result.target) return;
          setLiveAnnotationTarget(buildBrowserAnnotationTarget(result.target));
          setLiveAnnotationHover(null);
          setLiveAnnotationText("");
          setLiveAnnotationError("");
        })
        .catch(() => undefined);
    }
  };

  useEffect(() => {
    const unsubscribe = window.electronAPI.onBrowserWorkbenchContextAction?.((event) => {
      if (event.taskId !== taskId || event.sessionId !== sessionId) return;
      contextActionRef.current(event);
    });
    return () => unsubscribe?.();
  }, [sessionId, taskId]);

  const handleSend = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed || !onSendMessage || sending) return;
    setMessage("");
    setVoiceNotice("");
    setSending(true);
    try {
      await onSendMessage(trimmed);
    } finally {
      setSending(false);
    }
  }, [message, onSendMessage, sending]);

  const askCurrentYouTubeVideo = useCallback(
    async (questionOverride?: string) => {
      const question = (questionOverride || youtubeQuestion).trim();
      const currentUrl = activeUrlRef.current || activeUrl || urlText;
      if (!workspaceId) {
        setYoutubeAskResult({ error: "Open a workspace first." });
        return;
      }
      if (!currentUrl || !getYouTubeVideoId(currentUrl)) {
        setYoutubeAskResult({ error: "Open a YouTube video first." });
        return;
      }
      if (!question) {
        setYoutubeAskResult({ error: "Ask a question first." });
        return;
      }
      setYoutubeAskBusy(true);
      setYoutubeAskResult(null);
      try {
        const result = await window.electronAPI.askYouTubeVideo?.({
          workspaceId,
          url: currentUrl,
          question,
          limit: 8,
        });
        setYoutubeAskResult(result || { error: "No result returned." });
      } catch (error) {
        setYoutubeAskResult({ error: error instanceof Error ? error.message : "Ask failed." });
      } finally {
        setYoutubeAskBusy(false);
      }
    },
    [activeUrl, urlText, workspaceId, youtubeQuestion],
  );

  const sendYouTubeAnswerToChat = useCallback(async () => {
    if (!onSendMessage || !youtubeAskResult?.answer) return;
    const sources = (youtubeAskResult.sources || [])
      .slice(0, 6)
      .map((source) => `- ${formatYouTubeTimestamp(source.startMs)} ${source.url}`)
      .join("\n");
    await onSendMessage(`${youtubeAskResult.answer}${sources ? `\n\nSources:\n${sources}` : ""}`);
  }, [onSendMessage, youtubeAskResult]);

  return (
    <section
      ref={sectionRef}
      onPointerEnter={() => {
        pointerInsideRef.current = true;
      }}
      onPointerLeave={() => {
        pointerInsideRef.current = false;
      }}
      className={`browser-workbench browser-workbench-${mode}${
        !activeUrl ? " browser-workbench-newtab-mode" : ""
      }`}
    >
      <header className="browser-workbench-header">
        <TabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          canReopenClosed={canReopenClosed}
          onActivate={activateTab}
          onClose={closeTabChecked}
          onNewTab={() => openNewTab()}
          onMove={moveTab}
          onMenuCommand={handleTabMenuCommand}
        />
        <div className="browser-workbench-header-actions">
          <ProfileMenu
            workspaceId={workspaceId}
            currentUrl={activeUrl}
            onOpenExternal={(url) => void openUrlExternal(url)}
            onOpenSettings={onOpenSettings ? () => onOpenSettings("browser") : undefined}
            onNotice={setToolbarNotice}
          />
          <button
            type="button"
            className="browser-workbench-icon-btn"
            onClick={mode === "fullscreen" ? onExitFullscreen : onFullscreen}
            title={fullscreenLabel}
            aria-label={fullscreenLabel}
          >
            {mode === "fullscreen" ? (
              <Minimize2 size={16} strokeWidth={2.2} aria-hidden="true" />
            ) : (
              <Maximize2 size={16} strokeWidth={2.2} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="browser-workbench-icon-btn"
            onClick={onClose}
            title="Close browser workbench"
            aria-label="Close browser workbench"
          >
            <X size={17} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="browser-workbench-toolbar">
        <div className="browser-workbench-nav-controls">
          <button
            type="button"
            className="browser-workbench-nav-btn"
            onClick={() => runWebviewCommand("goBack")}
            disabled={!activeTab.canGoBack}
            title="Back"
            aria-label="Back"
          >
            <ArrowLeft size={16} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="browser-workbench-nav-btn"
            onClick={() => runWebviewCommand("goForward")}
            disabled={!activeTab.canGoForward}
            title="Forward"
            aria-label="Forward"
          >
            <ArrowRight size={16} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="browser-workbench-nav-btn"
            onClick={() => runWebviewCommand(isLoading ? "stop" : "reload")}
            title={isLoading ? "Stop" : "Reload"}
            aria-label={isLoading ? "Stop" : "Reload"}
            disabled={!activeUrl}
          >
            {isLoading ? (
              <X size={16} strokeWidth={2.2} aria-hidden="true" />
            ) : (
              <RotateCw size={15} strokeWidth={2.2} aria-hidden="true" />
            )}
          </button>
        </div>
        <Omnibox
          ref={omniboxRef}
          url={activeUrl}
          blocked={Boolean(activeTab.blocked)}
          zoomLevel={activeTab.zoomLevel}
          engine={searchEngine}
          source={omniboxSource}
          onNavigate={(url) => navigate(url)}
          onSwitchTab={activateTab}
          onUnsupported={(scheme) =>
            setToolbarNotice(`"${scheme}:" addresses can't open in the in-app browser`)
          }
          onResetZoom={() => tabHandlesRef.current.get(activeTabId)?.setZoomLevel(0)}
          onEngineChange={(engine) => void saveBrowserSettings({ searchEngine: engine })}
          onQueryChange={handleOmniboxQuery}
          onNotice={setToolbarNotice}
        />
        <div className="browser-workbench-device-toolbar" aria-label="Viewport presets">
          {VIEWPORT_PRESETS.map((preset) => {
            const Icon = preset.icon;
            const active =
              controlledViewport?.width === preset.width &&
              controlledViewport.height === preset.height;
            return (
              <button
                key={preset.label}
                type="button"
                className={`browser-workbench-device-btn ${active ? "is-active" : ""}`}
                onClick={() => applyViewportPreset(preset)}
                title={`${preset.label} ${preset.width} x ${preset.height}`}
                aria-label={`${preset.label} viewport`}
              >
                <Icon size={14} strokeWidth={2.2} aria-hidden="true" />
              </button>
            );
          })}
          {controlledViewport && (
            <>
              <span className="browser-workbench-device-size" title={controlledViewport.label}>
                {controlledViewport.width}x{controlledViewport.height}
              </span>
              <button
                type="button"
                className="browser-workbench-device-btn"
                onClick={() => {
                  setControlledViewport(null);
                  setToolbarNotice("Auto viewport");
                }}
                title="Return to automatic viewport"
                aria-label="Return to automatic viewport"
              >
                <X size={13} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
        <div className="browser-workbench-right-actions">
          {activeUrl && (
            <span className="browser-workbench-profile" title={activeTab?.url || activeUrl}>
              {activeUrl.startsWith("https://") ? "https" : "http"}
            </span>
          )}
          {toolbarNotice && (
            <span className="browser-workbench-toolbar-notice">{toolbarNotice}</span>
          )}
          {activeIsYouTube && (
            <button
              type="button"
              className={`browser-workbench-nav-btn browser-workbench-action-btn ${youtubeAskOpen ? "is-active" : ""}`}
              onClick={() => setYoutubeAskOpen((current) => !current)}
              title="Ask video"
              aria-label="Ask video"
            >
              <Search
                className="browser-workbench-lucide-icon"
                size={16}
                strokeWidth={2.2}
                aria-hidden="true"
              />
            </button>
          )}
          <button
            type="button"
            className="browser-workbench-nav-btn browser-workbench-action-btn"
            onClick={() => void openCurrentPageExternal()}
            title="Open current page in external browser"
            aria-label="Open current page in external browser"
          >
            <ExternalLink
              className="browser-workbench-lucide-icon"
              size={16}
              strokeWidth={2.2}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className={`browser-workbench-nav-btn browser-workbench-action-btn ${snapshotOverlay ? "is-active" : ""}`}
            onClick={() => setSnapshotOverlay((current) => !current)}
            title="Snapshot overlay"
            aria-label="Snapshot overlay"
          >
            <ScanLine
              className="browser-workbench-lucide-icon"
              size={16}
              strokeWidth={2.2}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className={`browser-workbench-nav-btn browser-workbench-action-btn ${diagnosticsOpen ? "is-active" : ""}`}
            onClick={() => setDiagnosticsOpen((current) => !current)}
            title="Diagnostics"
            aria-label="Diagnostics"
          >
            <Activity
              className="browser-workbench-lucide-icon"
              size={16}
              strokeWidth={2.2}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="browser-workbench-nav-btn browser-workbench-action-btn"
            onClick={() => void captureScreenshot("screenshot")}
            title="Take screenshot"
            aria-label="Take screenshot"
          >
            <Camera
              className="browser-workbench-lucide-icon"
              size={16}
              strokeWidth={2.2}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className={`browser-workbench-nav-btn browser-workbench-action-btn ${liveAnnotationMode ? "is-active" : ""}`}
            onClick={() => {
              setLiveAnnotationMode((current) => !current);
              cancelLiveAnnotationTarget();
              setToolbarNotice(liveAnnotationMode ? "Annotation mode off" : "Annotating");
            }}
            title="Annotate page element"
            aria-label="Annotate page element"
          >
            <PencilLine
              className="browser-workbench-lucide-icon"
              size={16}
              strokeWidth={2.2}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="browser-workbench-nav-btn browser-workbench-action-btn"
            onClick={() => void captureScreenshot("annotation")}
            title="Annotate screenshot"
            aria-label="Annotate screenshot"
          >
            <Plus
              className="browser-workbench-lucide-icon"
              size={16}
              strokeWidth={2.2}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
      {isLoading && <div className="browser-workbench-progress" aria-hidden="true" />}
      <AgentDrivingBanner taskId={taskId} sessionId={sessionId} state={drivingState} />
      {pendingApproval && onApprovalRespond && (
        <BrowserApprovalCard approval={pendingApproval} onRespond={onApprovalRespond} />
      )}
      {signInUrl && (
        <SignInBanner
          url={signInUrl}
          onDismiss={() => setSignInUrl(null)}
          onDone={() => {
            setSignInUrl(null);
            void onSendMessage?.("I've signed in. Please continue.");
          }}
        />
      )}
      {findOpen && (
        <FindBar
          ref={findBarRef}
          result={findResult}
          onFind={(text, options) => tabHandlesRef.current.get(activeTabId)?.find(text, options)}
          onClose={closeFind}
        />
      )}
      {activeIsYouTube && youtubeAskOpen && (
        <div className="browser-workbench-youtube-ask">
          <form
            className="browser-workbench-youtube-form"
            onSubmit={(event) => {
              event.preventDefault();
              void askCurrentYouTubeVideo();
            }}
          >
            <input
              value={youtubeQuestion}
              onChange={(event) => setYoutubeQuestion(event.target.value)}
              placeholder="Ask this video"
              aria-label="Ask this video"
            />
            <button
              type="submit"
              className="browser-workbench-youtube-submit"
              disabled={youtubeAskBusy || !youtubeQuestion.trim()}
              title="Ask"
              aria-label="Ask"
            >
              <ArrowUp size={15} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </form>
          {youtubeAskBusy && (
            <div className="browser-workbench-youtube-status">Reading transcript...</div>
          )}
          {youtubeAskResult?.error && (
            <div className="browser-workbench-youtube-error">{youtubeAskResult.error}</div>
          )}
          {youtubeAskResult?.answer && (
            <div className="browser-workbench-youtube-answer">
              <p>{youtubeAskResult.answer}</p>
              {onSendMessage && (
                <button
                  type="button"
                  className="browser-workbench-youtube-secondary"
                  onClick={() => void sendYouTubeAnswerToChat()}
                >
                  Send to chat
                </button>
              )}
            </div>
          )}
          {!!youtubeAskResult?.sources?.length && (
            <div className="browser-workbench-youtube-sources">
              {youtubeAskResult.sources.slice(0, 6).map((source) => (
                <button
                  key={`${source.videoId}-${source.startMs}-${source.text.slice(0, 16)}`}
                  type="button"
                  className="browser-workbench-youtube-source"
                  onClick={() => openTab({ url: normalizeUrl(source.url) })}
                  title={source.url}
                >
                  <span className="browser-workbench-youtube-source-time">
                    {formatYouTubeTimestamp(source.startMs)}
                  </span>
                  <span className="browser-workbench-youtube-source-text">{source.text}</span>
                </button>
              ))}
            </div>
          )}
          {!!youtubeAskResult?.suggestedFollowUps?.length && (
            <div className="browser-workbench-youtube-followups">
              {youtubeAskResult.suggestedFollowUps.slice(0, 3).map((followUp) => (
                <button
                  key={followUp}
                  type="button"
                  onClick={() => {
                    setYoutubeQuestion(followUp);
                    void askCurrentYouTubeVideo(followUp);
                  }}
                >
                  {followUp}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div
        className={`browser-workbench-surface ${controlledViewport ? "has-controlled-viewport" : ""}`}
        ref={surfaceRef}
      >
        {visibleWebviewSize ? (
          <div
            className={`browser-workbench-webview-frame ${controlledViewport ? "" : "is-fill"}`}
            // A fixed viewport preset may scroll inside the surface. In automatic mode the
            // frame fills the surface without sizing it, so it can never add the scrollbar
            // that would shrink the surface and re-trigger measurement.
            style={
              controlledViewport
                ? {
                    width: `${visibleWebviewSize.width}px`,
                    height: `${visibleWebviewSize.height}px`,
                  }
                : undefined
            }
          >
            {tabs.map((tab) =>
              tab.discarded ? null : (
                <BrowserTabView
                  key={`${tab.id}:${tab.generation}`}
                  tab={tab}
                  active={tab.id === activeTabId}
                  taskId={taskId}
                  sessionId={sessionId}
                  partition={partition}
                  size={visibleWebviewSize}
                  onUpdate={updateTab}
                  onStatus={handleTabStatus}
                  onGuardFailed={handleGuardFailed}
                  registerHandle={registerTabHandle}
                  checkUserNavigation={checkUserNavigation}
                  onFindResult={handleFindResult}
                >
                  <BrowserTabNotice
                    tab={tab}
                    onRetry={retryActiveTab}
                    onReloadCrashed={() => reloadCrashedTab(tab.id)}
                    onGoBack={() => runWebviewCommand("goBack")}
                    onOpenExternal={(url) => void openUrlExternal(url)}
                    onOpenAccessSettings={
                      onOpenSettings ? () => onOpenSettings("access") : undefined
                    }
                  />
                </BrowserTabView>
              ),
            )}
            {pageDialogs
              .filter((dialog) => dialog.tabId === activeTabId)
              .slice(0, 1)
              .map((dialog) => (
                <PageDialog key={dialog.dialogId} dialog={dialog} onRespond={respondToPageDialog} />
              ))}
            {permissionRequests
              .filter((request) => request.tabId === activeTabId)
              .slice(0, 1)
              .map((request) => (
                <PermissionPrompt
                  key={request.requestId}
                  request={request}
                  onRespond={respondToPermission}
                />
              ))}
            {!activeUrl && !activeTab.blocked && (
              <div className="browser-workbench-newtab-layer">
                <NewTabPage
                  onSendMessage={onSendMessage}
                  onNotice={setToolbarNotice}
                  openTabs={tabs.filter((tab) => tab.id !== activeTabId && tab.url)}
                  recentlyClosed={[...closedTabs].reverse()}
                  recentHistory={recentHistory}
                  onSwitchTab={activateTab}
                  onOpenUrl={(url) => navigate(url)}
                />
              </div>
            )}
            {drivingState.driving && !drivingState.pausedByUser && (
              <AgentDrivingShield taskId={taskId} sessionId={sessionId} />
            )}
            {snapshotOverlay && activeUrl && (
              <SnapshotOverlay
                key={activeTabId}
                taskId={taskId}
                sessionId={sessionId}
                tabId={activeTabId}
                onCopyRef={copySnapshotRef}
              />
            )}
            {activeUrl &&
              browserAnnotations.map((annotation, index) => {
                const target = annotation.targetRef as BrowserAnnotationTargetRef;
                if (target.surfaceType !== "browser" || !target.rect) return null;
                return (
                  <button
                    key={annotation.id}
                    type="button"
                    className={`browser-live-annotation-pin status-${annotation.status}`}
                    style={{
                      left: `${clampNumber(target.rect.x + target.rect.width - 12, 2, visibleWebviewSize.width - 24)}px`,
                      top: `${clampNumber(target.rect.y - 12, 2, visibleWebviewSize.height - 24)}px`,
                    }}
                    title={annotation.body}
                    aria-label={`Annotation ${index + 1}: ${annotation.body}`}
                  >
                    {index + 1}
                  </button>
                );
              })}
            {liveAnnotationMode && activeUrl && (
              <div
                className="browser-live-annotation-layer"
                onPointerMove={(event) => {
                  const drag = annotationDragRef.current;
                  if (drag && !liveAnnotationTarget) {
                    const point = layerPoint(event);
                    if (drag.moved || Math.hypot(point.x - drag.x, point.y - drag.y) > 6) {
                      drag.moved = true;
                      setLiveAnnotationHover(null);
                      setAnnotationArea({
                        x: Math.min(drag.x, point.x),
                        y: Math.min(drag.y, point.y),
                        width: Math.abs(point.x - drag.x),
                        height: Math.abs(point.y - drag.y),
                      });
                      return;
                    }
                  }
                  void inspectLiveAnnotationPoint(event);
                }}
                onPointerDown={(event) => {
                  if (liveAnnotationTarget || event.button !== 0) return;
                  annotationDragRef.current = { ...layerPoint(event), moved: false };
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                }}
                onPointerUp={(event) => {
                  const drag = annotationDragRef.current;
                  annotationDragRef.current = null;
                  if (!drag) return;
                  if (
                    drag.moved &&
                    annotationArea &&
                    annotationArea.width > 6 &&
                    annotationArea.height > 6
                  ) {
                    void finishAnnotationArea(annotationArea);
                    return;
                  }
                  setAnnotationArea(null);
                  void selectLiveAnnotationTarget(event);
                }}
              >
                {annotationArea && (
                  <div
                    className="browser-live-annotation-box is-area"
                    style={{
                      left: `${annotationArea.x}px`,
                      top: `${annotationArea.y}px`,
                      width: `${annotationArea.width}px`,
                      height: `${annotationArea.height}px`,
                    }}
                    aria-hidden="true"
                  />
                )}
                {liveAnnotationOverlayTarget?.rect && (
                  <div
                    className={`browser-live-annotation-box ${
                      liveAnnotationTarget ? "is-selected" : ""
                    }`}
                    style={{
                      left: `${liveAnnotationOverlayTarget.rect.x}px`,
                      top: `${liveAnnotationOverlayTarget.rect.y}px`,
                      width: `${liveAnnotationOverlayTarget.rect.width}px`,
                      height: `${liveAnnotationOverlayTarget.rect.height}px`,
                    }}
                    aria-hidden="true"
                  />
                )}
                {liveAnnotationHover && !liveAnnotationTarget && (
                  <div
                    className="browser-live-annotation-inspector"
                    style={{
                      left: `${clampNumber(
                        (liveAnnotationHover.rect?.x || 0) + 8,
                        8,
                        visibleWebviewSize.width - 170,
                      )}px`,
                      top: `${clampNumber(
                        (liveAnnotationHover.rect?.y || 0) - 38,
                        8,
                        visibleWebviewSize.height - 32,
                      )}px`,
                    }}
                  >
                    <span>{liveAnnotationHover.tagName || "element"}</span>
                    {liveAnnotationHover.computedStyle?.fontSize && (
                      <span>{liveAnnotationHover.computedStyle.fontSize}</span>
                    )}
                  </div>
                )}
                {liveAnnotationTarget?.rect && (
                  <div
                    className="browser-live-annotation-composer"
                    style={{
                      left: `${clampNumber(
                        liveAnnotationTarget.rect.x + liveAnnotationTarget.rect.width + 14,
                        12,
                        visibleWebviewSize.width - 340,
                      )}px`,
                      top: `${clampNumber(
                        liveAnnotationTarget.rect.y,
                        12,
                        visibleWebviewSize.height - 210,
                      )}px`,
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <div className="browser-live-annotation-meta">
                      <span>
                        {liveAnnotationTarget.tagName === "area"
                          ? `Area · ${liveAnnotationTarget.elements?.length || 0} elements`
                          : liveAnnotationTarget.tagName || "element"}
                      </span>
                      {liveAnnotationTarget.selector && liveAnnotationTarget.tagName !== "area" && (
                        <code>{liveAnnotationTarget.selector}</code>
                      )}
                      {liveAnnotationTarget.tagName !== "area" && liveAnnotationTarget.selector && (
                        <button
                          type="button"
                          className={`browser-annotation-adjust-toggle ${adjustOpen ? "is-active" : ""}`}
                          onClick={() => {
                            if (adjustOpen) {
                              setAdjustOpen(false);
                              setAdjustChanges(null);
                            } else {
                              void openAdjust();
                            }
                          }}
                        >
                          Adjust
                        </button>
                      )}
                    </div>
                    {adjustOpen && liveAnnotationTarget.selector && (
                      <AdjustPanel
                        taskId={taskId}
                        sessionId={sessionId}
                        selector={liveAnnotationTarget.selector}
                        computedStyle={liveAnnotationTarget.computedStyle || {}}
                        textQuote={liveAnnotationTarget.textQuote || ""}
                        canEditText={Boolean(
                          liveAnnotationTarget.textQuote &&
                          liveAnnotationTarget.textQuote.length < 300 &&
                          [
                            "a",
                            "button",
                            "h1",
                            "h2",
                            "h3",
                            "h4",
                            "h5",
                            "h6",
                            "p",
                            "span",
                            "label",
                            "li",
                            "strong",
                            "em",
                            "small",
                            "td",
                            "th",
                          ].includes(liveAnnotationTarget.tagName || ""),
                        )}
                        onChange={setAdjustChanges}
                      />
                    )}
                    <textarea
                      value={liveAnnotationText}
                      onChange={(event) => setLiveAnnotationText(event.target.value)}
                      placeholder="What should CoWork OS change here?"
                      rows={3}
                      autoFocus
                    />
                    {liveAnnotationError && (
                      <div className="browser-live-annotation-error">{liveAnnotationError}</div>
                    )}
                    <div className="browser-live-annotation-actions">
                      <button
                        type="button"
                        className="browser-annotation-secondary"
                        onClick={cancelLiveAnnotationTarget}
                        disabled={liveAnnotationSaving}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="browser-annotation-secondary"
                        onClick={() => void saveLiveBrowserAnnotation(false)}
                        disabled={liveAnnotationSaving || !liveAnnotationText.trim()}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="browser-annotation-primary browser-live-annotation-send"
                        onClick={() => void saveLiveBrowserAnnotation(true)}
                        disabled={
                          liveAnnotationSaving || !liveAnnotationText.trim() || !onSendMessage
                        }
                        title="Send annotation to CoWork OS"
                        aria-label="Send annotation to CoWork OS"
                      >
                        <ArrowUp size={15} strokeWidth={2.4} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="browser-workbench-empty">Preparing browser viewport...</div>
        )}
        {controlledViewport && activeUrl && (
          <div className="browser-workbench-viewport-badge" aria-hidden="true">
            {controlledViewport.label}
          </div>
        )}
        {browserCursor && (
          <div
            key={`${browserCursor.at}-${browserCursor.kind}`}
            className={`browser-workbench-cursor ${browserCursor.pulse ? "is-pulsing" : ""}`}
            style={{ transform: `translate3d(${browserCursor.x}px, ${browserCursor.y}px, 0)` }}
            aria-hidden="true"
          >
            <span className="browser-workbench-cursor-pointer" />
            {browserCursor.label && (
              <span className="browser-workbench-cursor-label">{browserCursor.label}</span>
            )}
          </div>
        )}
      </div>
      <DownloadShelf taskId={taskId} sessionId={sessionId} />
      {diagnosticsOpen && (
        <DiagnosticsDrawer
          key={activeTabId}
          taskId={taskId}
          sessionId={sessionId}
          tabId={activeTabId}
          onSendToAgent={onSendMessage ? (message) => void onSendMessage(message) : undefined}
        />
      )}
      {annotationDraft && (
        <div
          className="browser-annotation-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Annotate browser screenshot"
        >
          <div className="browser-annotation-panel">
            <div className="browser-annotation-header">
              <div>
                <div className="browser-annotation-title">Annotate screenshot</div>
                <div className="browser-annotation-subtitle">
                  Draw over the capture, then save it or send it to the task.
                </div>
              </div>
              <button
                type="button"
                className="browser-annotation-close"
                onClick={() => {
                  setAnnotationDraft(null);
                  setAnnotationError("");
                  setAnnotationMessage("");
                }}
                aria-label="Close annotation"
              >
                ×
              </button>
            </div>
            <div className="browser-annotation-stage">
              <div className="browser-annotation-canvas-wrap">
                <img
                  ref={annotationImageRef}
                  src={annotationDraft.dataUrl}
                  alt="Browser screenshot to annotate"
                  onLoad={resizeAnnotationCanvas}
                />
                <canvas
                  ref={annotationCanvasRef}
                  className="browser-annotation-canvas"
                  onPointerDown={handleAnnotationPointerDown}
                  onPointerMove={handleAnnotationPointerMove}
                  onPointerUp={stopAnnotationDrawing}
                  onPointerCancel={stopAnnotationDrawing}
                  onPointerLeave={() => {
                    annotationDrawingRef.current = false;
                  }}
                  aria-label="Draw annotation"
                />
              </div>
            </div>
            <div className="browser-annotation-footer">
              <textarea
                value={annotationMessage}
                onChange={(event) => setAnnotationMessage(event.target.value)}
                placeholder="What should the agent notice or change?"
                rows={2}
              />
              {annotationError && <div className="browser-annotation-error">{annotationError}</div>}
              <div className="browser-annotation-actions">
                <button
                  type="button"
                  className="browser-annotation-secondary"
                  onClick={clearAnnotationCanvas}
                  disabled={annotationSaving}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="browser-annotation-secondary"
                  onClick={() => void saveAnnotation(false)}
                  disabled={annotationSaving}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="browser-annotation-primary"
                  onClick={() => void saveAnnotation(true)}
                  disabled={annotationSaving || !onSendMessage}
                >
                  {annotationSaving ? "Sending..." : "Send to agent"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {mode === "fullscreen" && onSendMessage && (
        <div className="spreadsheet-viewer-fullscreen-controls">
          {turnContext && (
            <div
              className={`spreadsheet-viewer-turn-frame ${
                turnContextExpanded ? "is-expanded" : ""
              }`}
            >
              <button
                type="button"
                className="spreadsheet-viewer-turn-header"
                onClick={() => setTurnContextExpanded((current) => !current)}
              >
                <span>{turnContext.statusLabel}</span>
                <ChevronDown size={18} aria-hidden="true" />
              </button>
              {turnContextExpanded && (
                <div className="spreadsheet-viewer-turn-body">
                  <p>{turnContext.summary}</p>
                  {turnContext.secondaryText && (
                    <p className="spreadsheet-viewer-turn-secondary">{turnContext.secondaryText}</p>
                  )}
                  {turnContext.events && turnContext.events.length > 0 && (
                    <div className="spreadsheet-viewer-turn-events">
                      {turnContext.events.map((event) => (
                        <div
                          key={event.id}
                          className={`spreadsheet-viewer-turn-event kind-${event.kind} ${
                            event.tone ? `tone-${event.tone}` : ""
                          }`}
                        >
                          <span className="spreadsheet-viewer-turn-event-text">{event.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="spreadsheet-viewer-composer">
            {voiceNotice && (
              <div className="attachment-panel spreadsheet-viewer-attachment-panel">
                <div className="attachment-error">{voiceNotice}</div>
              </div>
            )}
            <div className="input-container spreadsheet-viewer-composer-input">
              <div className="input-row">
                <div className="mention-autocomplete-wrapper">
                  <textarea
                    className="input-field input-textarea"
                    placeholder="Ask for follow-up changes"
                    value={message}
                    rows={1}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void handleSend();
                      }
                    }}
                  />
                </div>
                <div className="input-actions">
                  {selectedModel &&
                  selectedProvider &&
                  onModelChange &&
                  availableModels.length > 0 ? (
                    <ModelDropdown
                      models={availableModels}
                      selectedModel={selectedModel}
                      selectedProvider={selectedProvider}
                      selectedReasoningEffort={selectedReasoningEffort}
                      providers={availableProviders}
                      onModelChange={onModelChange}
                      onOpenSettings={onOpenSettings}
                      variant="label"
                      align="right"
                    />
                  ) : selectedModelLabel ? (
                    <span className="spreadsheet-viewer-composer-model">{selectedModelLabel}</span>
                  ) : null}
                  <button
                    type="button"
                    className={`voice-input-btn ${voiceInput.state}`}
                    onClick={() => void voiceInput.toggleRecording()}
                    disabled={voiceInput.state === "processing" || sending}
                    title="Voice input"
                  >
                    {voiceInput.state === "recording" ? (
                      <Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                    ) : (
                      <Mic size={16} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="lets-go-btn lets-go-btn-sm"
                    onClick={() => void handleSend()}
                    disabled={!message.trim() || sending}
                    title="Send message"
                  >
                    <ArrowUp size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
            <div className="input-below-actions spreadsheet-viewer-composer-actions">
              <span className="input-status-workspace">Work in a folder</span>
              <span className="input-status-mode">Execute</span>
              <span className="input-status-mode">Auto</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
