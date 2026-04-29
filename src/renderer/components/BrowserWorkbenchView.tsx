import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowUp,
  ChevronDown,
  Mic,
  Square,
} from "lucide-react";
import type {
  ImageAttachment,
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
} from "../../shared/types";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { ModelDropdown } from "./MainContent";
import type { SpreadsheetTurnContext } from "./SpreadsheetArtifactViewer";

type BrowserWorkbenchMode = "sidebar" | "fullscreen";
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

type BrowserWorkbenchViewProps = {
  taskId: string;
  sessionId: string;
  initialUrl?: string;
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
};

function normalizeUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|::1)(?::\d+)?(?:\/|$)/i.test(value)) {
    return `http://${value}`;
  }
  return `https://${value}`;
}

function getDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url || "Browser";
  }
}

function getPartition(workspaceId?: string): string {
  const safe = (workspaceId || "default").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return `persist:cowork-browser-${safe || "default"}`;
}

const webviewPopupProps = { allowpopups: "true" } as Any;

export function BrowserWorkbenchView({
  taskId,
  sessionId,
  initialUrl,
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
}: BrowserWorkbenchViewProps) {
  const webviewRef = useRef<Any>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const annotationImageRef = useRef<HTMLImageElement | null>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const annotationDrawingRef = useRef(false);
  const webviewDomReadyRef = useRef(false);
  const registeredWebContentsIdRef = useRef<number | null>(null);
  const activeUrlRef = useRef(initialUrl || "");
  const titleRef = useRef("");
  const onStatusChangeRef = useRef(onStatusChange);
  const [urlText, setUrlText] = useState(initialUrl || "");
  const [activeUrl, setActiveUrl] = useState(initialUrl || "");
  const [title, setTitle] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [webviewSize, setWebviewSize] = useState<{ width: number; height: number } | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [toolbarNotice, setToolbarNotice] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [annotationDraft, setAnnotationDraft] = useState<BrowserAnnotationDraft | null>(null);
  const [annotationMessage, setAnnotationMessage] = useState("");
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [annotationError, setAnnotationError] = useState("");
  const [turnContextExpanded, setTurnContextExpanded] = useState(false);
  const [browserCursor, setBrowserCursor] = useState<BrowserCursorState>(null);
  const partition = useMemo(() => getPartition(workspaceId), [workspaceId]);
  const displayTitle = title || getDomain(activeUrl) || "Browser";
  const tabLabel = title || getDomain(activeUrl) || "about:blank";
  const fullscreenLabel = mode === "fullscreen" ? "Exit full screen" : "Open browser workbench in full screen";
  const webviewKey = webviewSize
    ? `${partition}:${webviewSize.width}x${webviewSize.height}`
    : `${partition}:empty`;
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      setVoiceNotice("");
      setMessage((current) => current ? `${current} ${text}` : text);
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
          measuredHeight > 360
            ? measuredHeight
            : Math.max(measuredHeight, availableHeight);
        setWebviewSize((current) => {
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
    if (!initialUrl) return;
    setUrlText(initialUrl);
    setActiveUrl(initialUrl);
    activeUrlRef.current = initialUrl;
  }, [initialUrl]);

  const getReadyWebContentsId = useCallback((webview: Any): number | undefined => {
    if (!webviewDomReadyRef.current) return undefined;
    if (!webview || typeof webview.getWebContentsId !== "function") return undefined;
    try {
      const webContentsId = webview.getWebContentsId();
      return typeof webContentsId === "number" ? webContentsId : undefined;
    } catch {
      return undefined;
    }
  }, []);

  const notifyStatus = useCallback(() => {
    const webview = webviewRef.current;
    const webContentsId = getReadyWebContentsId(webview);
    if (typeof webContentsId !== "number") return;
    const nextUrl =
      typeof webview?.getURL === "function" ? webview.getURL() : activeUrlRef.current;
    const nextTitle =
      typeof webview?.getTitle === "function" ? webview.getTitle() : titleRef.current;
    void window.electronAPI.updateBrowserWorkbenchStatus?.({
      taskId,
      sessionId,
      webContentsId,
      url: nextUrl,
      title: nextTitle,
    });
    onStatusChangeRef.current?.({ url: nextUrl, title: nextTitle });
  }, [getReadyWebContentsId, sessionId, taskId]);

  const registerSession = useCallback(() => {
    const webview = webviewRef.current;
    const webContentsId = getReadyWebContentsId(webview);
    if (typeof webContentsId !== "number") return;
    registeredWebContentsIdRef.current = webContentsId;
    const nextUrl =
      typeof webview?.getURL === "function" ? webview.getURL() : activeUrlRef.current;
    const nextTitle =
      typeof webview?.getTitle === "function" ? webview.getTitle() : titleRef.current;
    void window.electronAPI.registerBrowserWorkbenchSession?.({
      taskId,
      sessionId,
      webContentsId,
      url: nextUrl,
      title: nextTitle,
    });
    onStatusChangeRef.current?.({ url: nextUrl, title: nextTitle });
  }, [getReadyWebContentsId, sessionId, taskId]);

  const applyWebviewBounds = useCallback((size = webviewSize) => {
    const webview = webviewRef.current;
    if (!webview || !size || size.width <= 0 || size.height <= 0) return;
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
  }, [webviewSize]);

  useEffect(() => {
    applyWebviewBounds();
  }, [applyWebviewBounds]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const handleNavigate = (event: Any) => {
      const nextUrl = event?.url || webview.getURL?.() || "";
      activeUrlRef.current = nextUrl;
      setUrlText(nextUrl);
      setActiveUrl(nextUrl);
      notifyStatus();
    };
    const handleTitle = (event: Any) => {
      const nextTitle = event?.title || webview.getTitle?.() || "";
      titleRef.current = nextTitle;
      setTitle(nextTitle);
      notifyStatus();
    };
    const handleLoadingStart = () => setIsLoading(true);
    const handleLoadingStop = () => {
      setIsLoading(false);
      notifyStatus();
    };
    const handleDomReady = () => {
      webviewDomReadyRef.current = true;
      applyWebviewBounds();
      registerSession();
    };
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("page-title-updated", handleTitle);
    webview.addEventListener("did-start-loading", handleLoadingStart);
    webview.addEventListener("did-stop-loading", handleLoadingStop);
    return () => {
      const webContentsId = registeredWebContentsIdRef.current;
      if (typeof webContentsId === "number") {
        void window.electronAPI.unregisterBrowserWorkbenchSession?.({
          taskId,
          sessionId,
          webContentsId,
        });
      }
      registeredWebContentsIdRef.current = null;
      webviewDomReadyRef.current = false;
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("page-title-updated", handleTitle);
      webview.removeEventListener("did-start-loading", handleLoadingStart);
      webview.removeEventListener("did-stop-loading", handleLoadingStop);
    };
  }, [notifyStatus, registerSession, sessionId, taskId]);

  const navigate = useCallback((nextUrl = urlText) => {
    const normalized = normalizeUrl(nextUrl);
    if (!normalized) return;
    activeUrlRef.current = normalized;
    setUrlText(normalized);
    setActiveUrl(normalized);
  }, [urlText]);

  const runWebviewCommand = useCallback((command: "goBack" | "goForward" | "reload") => {
    const webview = webviewRef.current;
    if (!webviewDomReadyRef.current || !webview || typeof webview[command] !== "function") return;
    try {
      webview[command]();
    } catch {
      // The Electron webview throws if commands run during attach/navigation teardown.
    }
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

  const handleAnnotationPointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const context = canvas.getContext("2d");
    if (!context) return;
    annotationDrawingRef.current = true;
    canvas.setPointerCapture?.(event.pointerId);
    const point = getAnnotationPoint(event);
    context.beginPath();
    context.moveTo(point.x, point.y);
  }, [getAnnotationPoint]);

  const handleAnnotationPointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!annotationDrawingRef.current) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const point = getAnnotationPoint(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  }, [getAnnotationPoint]);

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

  const saveAnnotation = useCallback(async (sendToAgent: boolean) => {
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
        await onSendMessage(`${note}\n\nAttached files:\n- ${saved.fileName} (${saved.relativePath})`, [
          {
            filePath: fullPath,
            mimeType: "image/png",
            filename: saved.fileName,
            sizeBytes: saved.size,
          },
        ]);
      }
      setAnnotationDraft(null);
      setAnnotationMessage("");
      setToolbarNotice(sendToAgent ? "Annotation sent" : "Annotation saved");
    } catch (error) {
      setAnnotationError(error instanceof Error ? error.message : "Annotation failed");
    } finally {
      setAnnotationSaving(false);
    }
  }, [
    activeUrl,
    annotationDraft,
    annotationMessage,
    createAnnotatedDataUrl,
    onSendMessage,
    workspaceId,
    workspacePath,
  ]);

  const captureScreenshot = useCallback(async (mode: "screenshot" | "annotation") => {
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
  }, [sessionId, taskId, workspacePath]);

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
    if (!browserCursor) return;
    const cursorAt = browserCursor.at;
    const timer = window.setTimeout(() => {
      setBrowserCursor((current) => current?.at === cursorAt ? null : current);
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [browserCursor]);

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

  return (
    <section className={`browser-workbench browser-workbench-${mode}`}>
      <header className="browser-workbench-header">
        <div className="browser-workbench-tabs">
          <span className="browser-workbench-summary">Summary</span>
          <span className="browser-workbench-tab" title={displayTitle}>
            <span className="browser-workbench-tab-icon" aria-hidden="true" />
            <span>{tabLabel}</span>
          </span>
        </div>
        <div className="browser-workbench-header-actions">
          <button
            type="button"
            className="browser-workbench-icon-btn"
            data-symbol={mode === "fullscreen" ? "↙" : "↗"}
            onClick={mode === "fullscreen" ? onExitFullscreen : onFullscreen}
            title={fullscreenLabel}
            aria-label={fullscreenLabel}
          >
            <span className="browser-workbench-glyph" aria-hidden="true">
              {mode === "fullscreen" ? "↙" : "↗"}
            </span>
          </button>
          <button
            type="button"
            className="browser-workbench-icon-btn"
            data-symbol="×"
            onClick={onClose}
            title="Close browser workbench"
            aria-label="Close browser workbench"
          >
            <span className="browser-workbench-glyph browser-workbench-glyph-close" aria-hidden="true">
              ×
            </span>
          </button>
        </div>
      </header>
      <div className="browser-workbench-toolbar">
        <div className="browser-workbench-nav-controls">
          <button type="button" className="browser-workbench-nav-btn" data-symbol="←" onClick={() => runWebviewCommand("goBack")} title="Back">
            <span className="browser-workbench-glyph" aria-hidden="true">←</span>
          </button>
          <button type="button" className="browser-workbench-nav-btn" data-symbol="→" onClick={() => runWebviewCommand("goForward")} title="Forward">
            <span className="browser-workbench-glyph" aria-hidden="true">→</span>
          </button>
          <button type="button" className="browser-workbench-nav-btn" data-symbol="↻" onClick={() => runWebviewCommand("reload")} title="Reload">
            <span className={`browser-workbench-glyph ${isLoading ? "is-spinning" : ""}`} aria-hidden="true">↻</span>
          </button>
        </div>
        <form
          className="browser-workbench-url-form"
          onSubmit={(event) => {
            event.preventDefault();
            navigate();
          }}
        >
          <input
            value={urlText}
            onChange={(event) => setUrlText(event.target.value)}
            placeholder="Enter a URL"
            aria-label="Browser URL"
          />
        </form>
        <div className="browser-workbench-right-actions">
          {toolbarNotice && <span className="browser-workbench-toolbar-notice">{toolbarNotice}</span>}
          <button
            type="button"
            className="browser-workbench-nav-btn browser-workbench-action-btn"
            data-symbol="▣"
            onClick={() => void captureScreenshot("screenshot")}
            title="Take screenshot"
            aria-label="Take screenshot"
          >
            <span className="browser-workbench-glyph" aria-hidden="true">▣</span>
          </button>
          <button
            type="button"
            className="browser-workbench-nav-btn browser-workbench-action-btn"
            data-symbol="✎"
            onClick={() => void captureScreenshot("annotation")}
            title="Annotate screenshot"
            aria-label="Annotate screenshot"
          >
            <span className="browser-workbench-glyph" aria-hidden="true">✎</span>
          </button>
        </div>
      </div>
      <div className="browser-workbench-surface" ref={surfaceRef}>
        {activeUrl && webviewSize && webviewSize.width > 0 && webviewSize.height > 0 ? (
          <webview
            key={webviewKey}
            ref={webviewRef}
            src={activeUrl}
            className="browser-workbench-webview"
            style={{ width: `${webviewSize.width}px`, height: `${webviewSize.height}px` }}
            width={webviewSize.width}
            height={webviewSize.height}
            autosize="true"
            minwidth={webviewSize.width}
            maxwidth={webviewSize.width}
            minheight={webviewSize.height}
            maxheight={webviewSize.height}
            partition={partition}
            {...webviewPopupProps}
            webpreferences="contextIsolation=yes, nodeIntegration=no"
          />
        ) : activeUrl ? (
          <div className="browser-workbench-empty">Preparing browser viewport...</div>
        ) : (
          <div className="browser-workbench-empty">Enter a URL to open a visible browser session.</div>
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
      {annotationDraft && (
        <div className="browser-annotation-overlay" role="dialog" aria-modal="true" aria-label="Annotate browser screenshot">
          <div className="browser-annotation-panel">
            <div className="browser-annotation-header">
              <div>
                <div className="browser-annotation-title">Annotate screenshot</div>
                <div className="browser-annotation-subtitle">Draw over the capture, then save it or send it to the task.</div>
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
              <span className="shell-toggle shell-toggle-inline enabled">
                Shell
                <span className="goal-mode-switch-track on">
                  <span className="goal-mode-switch-thumb" />
                </span>
              </span>
              <span className="input-status-mode">Execute</span>
              <span className="input-status-mode">Auto</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
