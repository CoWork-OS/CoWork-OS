import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ExternalLink } from "lucide-react";
import type { FileViewerResult } from "../../electron/preload";
import { htmlSurfaceKey } from "../../shared/answer-surfaces/blocks";
import {
  HtmlSurfaceStateSchema,
  summarizeHtmlSurfaceState,
  type HtmlSurfaceState,
} from "../../shared/answer-surfaces/html-bridge";
import {
  applyRichFrameDesignLanguage,
  buildRichFrameDesignCss,
  type RichFrameDesignOptions,
  type RichFrameTheme,
} from "../../shared/rich-frame-design-language";
import { loadSurfaceState, saveSurfaceState } from "../hooks/useAnswerSurfaceState";
import { useLiveFrameSlot } from "../hooks/useLiveFrameSlot";
import { toSurfaceActionRequest } from "../../shared/answer-surfaces/actions";
import { useSurfaceActions } from "./AnswerSurface/SurfaceActions";
import { HtmlSurfaceBridgeHost, createSurfaceNonce } from "../utils/html-surface-bridge";

type InlineHtmlPreviewVariant = "default" | "frame";

type InlineHtmlPreviewProps = {
  filePath: string;
  /** Saves the surface's inputs for this task, so they survive restarts and reach the model. */
  taskId?: string;
  workspacePath: string;
  title?: string;
  className?: string;
  variant?: InlineHtmlPreviewVariant;
  frameHeight?: string;
  aspectRatio?: string;
  showChrome?: boolean;
  onOpenViewer?: (path: string) => void;
};

type InlineHtmlSourcePreviewProps = {
  htmlContent: string;
  taskId?: string;
  title?: string;
  className?: string;
  variant?: InlineHtmlPreviewVariant;
  frameHeight?: string;
  aspectRatio?: string;
  showChrome?: boolean;
};

/** Requests a page may make while it is mounted, and cancels after which it may make none. */
const MAX_PAGE_ACTIONS = 5;
const MAX_DECLINED_ACTIONS = 3;
/** Quiet time after a page's request is settled, so it cannot chain dialogs under a click. */
const PAGE_ACTION_COOLDOWN_MS = 1500;

/**
 * Whether the user is interacting with the page right now. A click inside a child frame
 * gives the app window transient activation (a few seconds), which page code cannot fake;
 * focus alone is not enough, because the frame keeps it long after the click.
 */
function userJustClickedInside(frame: HTMLIFrameElement | null): boolean {
  if (typeof document === "undefined" || !frame || document.activeElement !== frame) return false;
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation;
  return activation ? activation.isActive : false;
}

const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
};

function extractHtmlTitle(htmlContent: string): string {
  const titleMatch = htmlContent.match(/<title\b[^>]{0,2000}>([\s\S]{0,2000}?)<\/title>/i);
  const title = titleMatch?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (title) return title;

  const headingMatch = htmlContent.match(/<h1\b[^>]{0,2000}>([\s\S]{0,2000}?)<\/h1>/i);
  const heading = headingMatch?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return heading || "Interactive HTML";
}

function normalizeCssLength(value?: string): string | undefined {
  const trimmed = String(value || "").trim();
  if (!trimmed) return undefined;
  if (/^\d{2,4}$/.test(trimmed)) return `${trimmed}px`;
  if (/^\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)$/.test(trimmed)) return trimmed;
  if (/^clamp\([a-z0-9.,\s%()+\-*/]{1,120}\)$/i.test(trimmed)) return trimmed;
  return undefined;
}

function normalizeAspectRatio(value?: string): string | undefined {
  const trimmed = String(value || "").trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  return undefined;
}

function getCurrentRichFrameTheme(): RichFrameTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("theme-light") ? "light" : "dark";
}

function getCurrentRichFrameHostBackground(): string {
  return "transparent";
}

function useRichFrameDesignOptions(enabled: boolean): RichFrameDesignOptions {
  const [options, setOptions] = useState<RichFrameDesignOptions>(() => ({
    theme: getCurrentRichFrameTheme(),
    hostBackground: getCurrentRichFrameHostBackground(),
  }));

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    const root = document.documentElement;
    const updateOptions = () =>
      setOptions({
        theme: getCurrentRichFrameTheme(),
        hostBackground: getCurrentRichFrameHostBackground(),
      });
    updateOptions();

    const observer = new MutationObserver(updateOptions);
    observer.observe(root, { attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [enabled]);

  return options;
}

function buildFrameStyle({
  frameHeight,
  aspectRatio,
}: {
  frameHeight?: string;
  aspectRatio?: string;
}): CSSProperties | undefined {
  const height = normalizeCssLength(frameHeight);
  const ratio = normalizeAspectRatio(aspectRatio);
  if (!height && !ratio) return undefined;
  return {
    ...(height || ratio
      ? ({ "--inline-html-frame-height": height || "auto" } as CSSProperties)
      : {}),
    ...(ratio ? ({ "--inline-html-frame-aspect-ratio": ratio } as CSSProperties) : {}),
  };
}

const SAVE_DELAY_MS = 500;
const STATE_LOAD_TIMEOUT_MS = 400;
/** If a frame never reports a height, it falls back to the fixed CSS size. */
const SIZE_FALLBACK_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * One inline HTML surface. On the desktop the document is registered with main, which
 * injects the design tokens and the bridge, and is framed from `cowork-preview://` so its
 * scripts run on an opaque origin with no network. The bridge sizes the frame to its
 * content, follows theme changes without a reload, and saves the user's inputs. Where
 * registration is unavailable (the browser host) it falls back to a static srcdoc frame.
 * Only a few frames are loaded at once (see LiveFrameSlots); a parked one keeps its size
 * and its saved inputs, and loads again when it is back on screen or clicked.
 */
function HtmlSurfaceFrame({
  html,
  title,
  designLanguage,
  designOptions,
  autosize,
  taskId,
  onSizeChange,
  live,
  onResume,
}: {
  html: string;
  title: string;
  designLanguage: boolean;
  designOptions: RichFrameDesignOptions;
  autosize: boolean;
  taskId?: string;
  onSizeChange: (height: number | null) => void;
  live: boolean;
  onResume: () => void;
}) {
  const register =
    typeof window === "undefined" ? undefined : window.electronAPI?.registerHtmlSurface;
  const [url, setUrl] = useState<string | null>(null);
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const optionsRef = useRef(designOptions);
  optionsRef.current = designOptions;
  const initializedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<(() => void) | null>(null);
  const actions = useSurfaceActions();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  // Kept for the frame's whole mount: a reload of its document does not reset it.
  const actionGuardRef = useRef({ pending: false, asked: 0, declined: 0, quietUntil: 0 });
  const surfaceKey = useMemo(() => htmlSurfaceKey(html), [html]);

  useEffect(() => {
    if (!register) return;
    let cancelled = false;
    setUrl(null);
    setRegistrationFailed(false);
    if (!live) return;
    // The document is themed for the theme at mount; later changes go over the bridge.
    const { theme, hostBackground } = optionsRef.current;
    register({ html, theme: theme ?? "light", hostBackground, designLanguage })
      .then((result) => {
        if (!cancelled) setUrl(result.url);
      })
      .catch(() => {
        if (!cancelled) setRegistrationFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [designLanguage, html, live, register]);

  const bridge = useMemo(() => {
    if (!url) return null;
    const persist = (state: HtmlSurfaceState) => {
      if (!taskId) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const save = () => {
        saveTimerRef.current = null;
        pendingSaveRef.current = null;
        saveSurfaceState(taskId, surfaceKey, state, summarizeHtmlSurfaceState(state));
      };
      pendingSaveRef.current = save;
      saveTimerRef.current = setTimeout(save, SAVE_DELAY_MS);
    };
    const host: HtmlSurfaceBridgeHost = new HtmlSurfaceBridgeHost(
      () => iframeRef.current?.contentWindow,
      createSurfaceNonce(),
      {
        onResize: (height) => autosize && onSizeChange(height),
        onState: persist,
        onAction: (id, action) => {
          const guard = actionGuardRef.current;
          const request = toSurfaceActionRequest(action);
          const ask = actionsRef.current;
          // Only right after a real click inside this frame, one at a time, a few per
          // mount, with a pause between them, and not after the user kept cancelling.
          if (
            !request ||
            !ask ||
            guard.pending ||
            Date.now() < guard.quietUntil ||
            guard.asked >= MAX_PAGE_ACTIONS ||
            guard.declined >= MAX_DECLINED_ACTIONS ||
            !userJustClickedInside(iframeRef.current)
          ) {
            host.actionResult(id, false);
            return;
          }
          guard.pending = true;
          guard.asked += 1;
          void ask(request, "page").then((ok) => {
            guard.pending = false;
            guard.quietUntil = Date.now() + PAGE_ACTION_COOLDOWN_MS;
            if (!ok) guard.declined += 1;
            host.actionResult(id, ok);
          });
        },
      },
    );
    return host;
  }, [autosize, onSizeChange, surfaceKey, taskId, url]);

  useEffect(() => {
    if (!bridge) return;
    const listener = (event: MessageEvent) => bridge.handle(event);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [bridge]);

  // A frame that is parked or removed saves its last inputs now rather than dropping them.
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      pendingSaveRef.current?.();
    },
    [bridge],
  );

  useEffect(() => {
    if (!bridge || !initializedRef.current) return;
    const theme = designOptions.theme ?? "light";
    bridge.setTheme({
      theme,
      css: designLanguage ? buildRichFrameDesignCss(theme, designOptions.hostBackground) : null,
    });
  }, [bridge, designLanguage, designOptions]);

  const handleLoad = async () => {
    if (!bridge) return;
    initializedRef.current = false;
    const saved = taskId
      ? await withTimeout(loadSurfaceState(taskId, surfaceKey), STATE_LOAD_TIMEOUT_MS, null)
      : null;
    const parsed = HtmlSurfaceStateSchema.safeParse(saved ?? {});
    const { theme = "light", hostBackground } = optionsRef.current;
    bridge.init({
      state: parsed.success ? parsed.data : {},
      theme,
      css: designLanguage ? buildRichFrameDesignCss(theme, hostBackground) : null,
      autosize,
    });
    initializedRef.current = true;
  };

  useEffect(() => {
    if (!url || !autosize) return;
    const timer = setTimeout(() => onSizeChange(null), SIZE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [autosize, onSizeChange, url]);

  if (!live) {
    return (
      <button
        type="button"
        className="inline-html-frame inline-html-frame-parked"
        onClick={onResume}
        aria-label={`Load ${title}`}
      >
        <span className="inline-html-frame-parked-title">{title}</span>
        <span className="inline-html-frame-parked-note">Paused to save memory · click to load</span>
      </button>
    );
  }
  if (!register || registrationFailed) {
    const fallbackHtml = designLanguage ? applyRichFrameDesignLanguage(html, designOptions) : html;
    return (
      <iframe
        className="inline-html-frame"
        srcDoc={fallbackHtml}
        sandbox="allow-scripts allow-forms"
        title={title}
      />
    );
  }
  if (!url) return <div className="inline-html-frame inline-html-frame-pending" />;
  return (
    <>
      <iframe
        ref={iframeRef}
        className="inline-html-frame"
        src={url}
        // No allow-same-origin: the document stays on an opaque origin with no app access.
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        title={title}
        // Chromium paints an opaque backdrop behind a frame whose color scheme differs
        // from its element's, which shows as square corners behind rounded cards.
        style={{ colorScheme: designOptions.theme ?? "light" }}
        onLoad={() => void handleLoad()}
      />
      {/* Drawn by the app, outside the frame, so generated content can't pass as app UI. */}
      <div className="inline-html-surface-badge">
        Interactive content · runs offline in a sandbox
      </div>
    </>
  );
}

/**
 * The frame's measured height: null until it reports one (or gives up), so the wrapper
 * keeps its fixed CSS size for frames that never talk to the bridge.
 */
function useSurfaceSize(autosize: boolean) {
  const [height, setHeight] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);
  const onSizeChange = useMemo(
    () => (next: number | null) => {
      setSettled(true);
      if (next !== null) setHeight(next);
    },
    [],
  );
  const sizing = autosize && !settled;
  const sized = autosize && height !== null;
  const style: CSSProperties | undefined = sized
    ? ({ "--inline-html-frame-auto-height": `${height}px` } as CSSProperties)
    : undefined;
  const className = sized
    ? "inline-html-preview-autosized"
    : sizing
      ? "inline-html-preview-sizing"
      : "";
  return { onSizeChange, style, className };
}

function InlineHtmlHeader({
  displayTitle,
  subtitle,
  onOpen,
}: {
  displayTitle: string;
  subtitle?: string;
  onOpen?: () => void;
}) {
  return (
    <div className="inline-html-header">
      <div className="inline-html-header-left">
        <div className="inline-html-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M4 4h16v16H4z" stroke="currentColor" strokeWidth="2" />
            <path
              d="m9 10-2 2 2 2M15 10l2 2-2 2M13 8l-2 8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="inline-html-name-wrap">
          <div className="inline-html-filename" title={displayTitle}>
            {displayTitle}
          </div>
          {subtitle && <div className="inline-html-subtitle">{subtitle}</div>}
        </div>
      </div>
      {onOpen && (
        <div className="inline-html-header-actions">
          <button
            className="inline-html-action-btn"
            type="button"
            onClick={onOpen}
            title="Open preview"
            aria-label="Open HTML preview"
          >
            <ExternalLink size={16} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

export function InlineHtmlSourcePreview({
  htmlContent,
  taskId,
  title,
  className = "",
  variant = "default",
  frameHeight,
  aspectRatio,
  showChrome = false,
}: InlineHtmlSourcePreviewProps) {
  const displayTitle = title || extractHtmlTitle(htmlContent);
  const isFrame = variant === "frame";
  const hideChrome = isFrame && !showChrome;
  const style = buildFrameStyle({ frameHeight, aspectRatio });
  const frameDesignOptions = useRichFrameDesignOptions(true);
  const autosize = !style;
  const size = useSurfaceSize(autosize);
  const [frameWrap, setFrameWrap] = useState<HTMLDivElement | null>(null);
  const slot = useLiveFrameSlot(frameWrap);

  return (
    <div
      className={`inline-html-preview inline-html-preview-source ${isFrame ? "inline-html-preview-frame" : ""} ${size.className} ${className}`.trim()}
      style={{ ...style, ...size.style }}
    >
      {!hideChrome && (
        <InlineHtmlHeader displayTitle={displayTitle} subtitle={isFrame ? "Frame" : "HTML form"} />
      )}
      <div
        className="inline-html-frame-wrap"
        ref={setFrameWrap}
        onPointerEnter={slot.live ? slot.activate : undefined}
      >
        <HtmlSurfaceFrame
          html={htmlContent}
          title={displayTitle}
          designLanguage={isFrame}
          designOptions={frameDesignOptions}
          autosize={autosize}
          taskId={taskId}
          onSizeChange={size.onSizeChange}
          live={slot.live}
          onResume={slot.activate}
        />
      </div>
    </div>
  );
}

export function InlineHtmlPreview({
  filePath,
  workspacePath,
  taskId,
  title,
  className = "",
  variant = "default",
  frameHeight,
  aspectRatio,
  showChrome = false,
  onOpenViewer,
}: InlineHtmlPreviewProps) {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<FileViewerResult["data"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const subtitle = useMemo(() => {
    if (!result) return "";
    return ["HTML", formatFileSize(result.size)].filter(Boolean).join(" • ");
  }, [result]);

  const displayTitle = title || result?.fileName || filePath.split("/").pop() || filePath;
  const isFrame = variant === "frame";
  const hideChrome = isFrame && !showChrome;
  const style = buildFrameStyle({ frameHeight, aspectRatio });
  const frameDesignOptions = useRichFrameDesignOptions(true);
  const previewHtmlContent = result?.htmlContent || "";
  const autosize = !style;
  const size = useSurfaceSize(autosize);
  const [frameWrap, setFrameWrap] = useState<HTMLDivElement | null>(null);
  const slot = useLiveFrameSlot(frameWrap);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      setResult(null);

      try {
        const response = await window.electronAPI.readFileForViewer(filePath, workspacePath);
        if (cancelled) return;
        if (!response.success || !response.data) {
          setError(response.error || "Failed to load HTML preview");
          return;
        }
        if (response.data.fileType !== "html" || !response.data.htmlContent) {
          setError("File is not a previewable HTML document.");
          return;
        }
        setResult(response.data);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load HTML preview");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (filePath && workspacePath) {
      void run();
    } else {
      setLoading(false);
    }

    return () => {
      cancelled = true;
    };
  }, [filePath, workspacePath]);

  const handleOpen = async () => {
    if (onOpenViewer) {
      onOpenViewer(filePath);
      return;
    }
    try {
      await window.electronAPI.openFile(filePath, workspacePath);
    } catch (e) {
      console.error("Failed to open HTML preview:", e);
    }
  };

  return (
    <div
      className={`inline-html-preview ${isFrame ? "inline-html-preview-frame" : ""} ${size.className} ${className}`.trim()}
      style={{ ...style, ...size.style }}
    >
      {loading && <div className="inline-html-loading">Loading HTML preview…</div>}

      {!loading && error && <div className="inline-html-error">{error}</div>}

      {!loading && !error && previewHtmlContent && (
        <>
          {!hideChrome && (
            <InlineHtmlHeader displayTitle={displayTitle} subtitle={subtitle} onOpen={handleOpen} />
          )}

          <div
            className="inline-html-frame-wrap"
            ref={setFrameWrap}
            onPointerEnter={slot.live ? slot.activate : undefined}
          >
            <HtmlSurfaceFrame
              html={previewHtmlContent}
              title={displayTitle}
              designLanguage={isFrame}
              designOptions={frameDesignOptions}
              autosize={autosize}
              taskId={taskId}
              onSizeChange={size.onSizeChange}
              live={slot.live}
              onResume={slot.activate}
            />
          </div>
        </>
      )}
    </div>
  );
}
