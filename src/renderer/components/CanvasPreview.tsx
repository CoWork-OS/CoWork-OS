import { useRef, useEffect, useState, useCallback, useMemo, memo } from "react";
import {
  AppWindow,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FileCode2,
  FolderDown,
  FolderOpen,
  Globe,
  History,
  Image as ImageIcon,
  LoaderCircle,
  MousePointer2,
  Pause,
  Play,
  RotateCw,
  SquareTerminal,
  X,
} from "lucide-react";
import type { CanvasSession } from "../../shared/types";
import { useAgentContext } from "../hooks/useAgentContext";
import { ResizableDividerHandle } from "./ResizableDividerHandle";

interface CanvasPreviewProps {
  session: CanvasSession;
  onClose?: () => void;
  forceSnapshot?: boolean;
  onOpenBrowser?: (url?: string) => void;
}

interface SnapshotHistoryEntry {
  imageData: string;
  timestamp: number;
  dimensions: { width: number; height: number };
}

interface ConsoleLogEntry {
  type: "log" | "warn" | "error" | "info";
  message: string;
  timestamp: number;
}

// Refresh rate options
type RefreshRate = 1000 | 2000 | 5000 | 0; // 0 = manual only
const REFRESH_RATE_OPTIONS: { value: RefreshRate; label: string }[] = [
  { value: 1000, label: "1s" },
  { value: 2000, label: "2s" },
  { value: 5000, label: "5s" },
  { value: 0, label: "Manual" },
];

// Number of times to retry initial snapshot before showing error
const MAX_INITIAL_RETRIES = 3;
const RETRY_DELAY_MS = 500;
// Timeout for snapshot requests (ms)
const SNAPSHOT_TIMEOUT_MS = 10000;
// Debounce delay for rapid snapshot requests (ms)
const DEBOUNCE_DELAY_MS = 300;
// Maximum number of snapshots to keep in history
const MAX_HISTORY_SIZE = 20;
// Minimum height for the preview
const MIN_PREVIEW_HEIGHT = 188;
// Maximum height for the preview
const MAX_PREVIEW_HEIGHT = 2500;
// Default preview height (taller for better interactive mode experience)
const DEFAULT_PREVIEW_HEIGHT = 600;

// Helper to create a timeout promise
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
  });
}

// Simple hash function for change detection
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

// Memoized image component to prevent re-renders when only image changes
interface CanvasImageProps {
  src: string;
  dimensions: { width: number; height: number };
  isLoading: boolean;
  historyIndex: number;
  historyTimestamp?: number;
  onOpenWindow: () => void;
}

const CanvasImage = memo(function CanvasImage({
  src,
  dimensions,
  isLoading,
  historyIndex,
  historyTimestamp,
  onOpenWindow,
}: CanvasImageProps) {
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  return (
    <div
      className="canvas-preview-image-wrapper"
      onClick={onOpenWindow}
      title="Click to open in window (O)"
    >
      <img src={src} alt="Canvas Preview" className="canvas-preview-image" />
      {dimensions.width > 0 && (
        <div className="canvas-preview-dimensions">
          {dimensions.width} × {dimensions.height}
          {historyIndex >= 0 && historyTimestamp && (
            <span className="canvas-history-time"> · {formatTime(historyTimestamp)}</span>
          )}
        </div>
      )}
      {isLoading && historyIndex < 0 && (
        <div className="canvas-preview-updating" aria-label="Updating">
          <LoaderCircle className="spinner" size={14} strokeWidth={2} />
        </div>
      )}
    </div>
  );
});

export function CanvasPreview({
  session,
  onClose,
  forceSnapshot = false,
  onOpenBrowser,
}: CanvasPreviewProps) {
  const isBrowserCanvas = session.mode === "browser";
  const agentContext = useAgentContext();
  const [imageData, setImageData] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isPaused, setIsPaused] = useState(isBrowserCanvas ? false : true);
  const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 });
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState(session.status);

  // New feature states
  const [refreshRate, setRefreshRate] = useState<RefreshRate>(forceSnapshot ? 0 : 2000);
  const [previewHeight, setPreviewHeight] = useState(DEFAULT_PREVIEW_HEIGHT);
  const [isResizing, setIsResizing] = useState(false);
  const [snapshotHistory, setSnapshotHistory] = useState<SnapshotHistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 means live view
  const [showHistory, setShowHistory] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [isInteractiveMode, setIsInteractiveMode] = useState(!isBrowserCanvas && !forceSnapshot);
  const [showBrowserUrlInput, setShowBrowserUrlInput] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");

  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const browserInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const snapshotInProgressRef = useRef(false);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastSnapshotTimeRef = useRef(0);
  const lastImageHashRef = useRef<string | null>(null);
  const resizeStartYRef = useRef(0);
  const resizeStartHeightRef = useRef(0);

  // Update local status when prop changes
  useEffect(() => {
    setSessionStatus(session.status);
  }, [session.status]);

  useEffect(() => {
    if (isBrowserCanvas) {
      setIsInteractiveMode(false);
      setIsPaused(false);
    }
  }, [isBrowserCanvas]);

  // Force snapshot mode for archived/previous canvases
  useEffect(() => {
    if (!forceSnapshot) return;
    setIsInteractiveMode(false);
    setIsPaused(true);
    setRefreshRate(0);
  }, [forceSnapshot]);

  // Add snapshot to history
  const addToHistory = useCallback(
    (newImageData: string, dimensions: { width: number; height: number }) => {
      setSnapshotHistory((prev) => {
        const newEntry: SnapshotHistoryEntry = {
          imageData: newImageData,
          timestamp: Date.now(),
          dimensions,
        };
        const updated = [...prev, newEntry];
        // Keep only the last MAX_HISTORY_SIZE entries
        if (updated.length > MAX_HISTORY_SIZE) {
          return updated.slice(-MAX_HISTORY_SIZE);
        }
        return updated;
      });
    },
    [],
  );

  // Take a snapshot of the canvas with timeout and debouncing
  const takeSnapshot = useCallback(
    async (isRetry = false, isManual = false) => {
      if (!mountedRef.current) return;

      // Check if session is closed
      if (sessionStatus === "closed") {
        setError("Canvas session closed");
        setErrorDetails("The canvas session has been terminated");
        setInitialLoadComplete(true);
        return;
      }

      // Prevent overlapping snapshot requests
      if (snapshotInProgressRef.current && !isRetry) {
        return;
      }

      // For automatic refreshes, enforce minimum interval based on refresh rate
      const effectiveMinInterval = refreshRate > 0 ? refreshRate : 2000;
      if (!isManual && !isRetry) {
        const now = Date.now();
        const timeSinceLastSnapshot = now - lastSnapshotTimeRef.current;
        if (timeSinceLastSnapshot < effectiveMinInterval) {
          return;
        }
      }

      try {
        snapshotInProgressRef.current = true;

        if (!isRetry) {
          setIsLoading(true);
        }

        // Wrap snapshot call with timeout
        const snapshot = await withTimeout(
          window.electronAPI.canvasSnapshot(session.id),
          SNAPSHOT_TIMEOUT_MS,
          "Snapshot request timed out",
        );

        if (!mountedRef.current) return;

        if (snapshot && snapshot.imageBase64) {
          const newImageData = `data:image/png;base64,${snapshot.imageBase64}`;
          const newHash = simpleHash(snapshot.imageBase64);

          // Smart change detection - only update if content changed
          const hasChanged = lastImageHashRef.current !== newHash;

          if (hasChanged || isManual) {
            lastImageHashRef.current = newHash;

            // Directly update image data without clearing first to avoid flicker
            // React will batch these updates efficiently
            setImageData(newImageData);
            setImageDimensions({ width: snapshot.width, height: snapshot.height });
            setError(null);
            setErrorDetails(null);
            setInitialLoadComplete(true);
            lastSnapshotTimeRef.current = Date.now();

            // Add to history (only when content changed)
            if (hasChanged) {
              addToHistory(newImageData, { width: snapshot.width, height: snapshot.height });
            }
          } else {
            // Content didn't change, just update timestamp
            lastSnapshotTimeRef.current = Date.now();
            setIsLoading(false);
          }
          retryCountRef.current = 0;
        } else {
          throw new Error("Empty snapshot received");
        }
      } catch (err) {
        if (!mountedRef.current) return;

        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        console.error("Failed to take canvas snapshot:", errorMessage);

        // If we haven't successfully loaded yet, retry a few times
        if (!initialLoadComplete && retryCountRef.current < MAX_INITIAL_RETRIES) {
          retryCountRef.current++;
          if (retryTimeoutRef.current) {
            clearTimeout(retryTimeoutRef.current);
          }
          retryTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) {
              takeSnapshot(true, isManual);
            }
          }, RETRY_DELAY_MS);
          return;
        }

        // Parse error for better user feedback
        let userError = "Failed to capture canvas";
        let details = errorMessage;

        if (errorMessage.includes("not found") || errorMessage.includes("not open")) {
          userError = "Canvas window not available";
          details = "The canvas window may have been closed or not yet created";
        } else if (errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
          userError = "Snapshot timed out";
          details = "The canvas took too long to respond. Try refreshing.";
        } else if (errorMessage.includes("destroyed")) {
          userError = "Canvas window destroyed";
          details = "The canvas window has been closed";
          setSessionStatus("closed");
        } else if (errorMessage.includes("closed")) {
          userError = "Canvas session closed";
          details = "The canvas session is no longer available";
          setSessionStatus("closed");
        }

        if (initialLoadComplete || retryCountRef.current >= MAX_INITIAL_RETRIES) {
          setError(userError);
          setErrorDetails(details);
          setInitialLoadComplete(true);
        }
      } finally {
        if (mountedRef.current) {
          setIsLoading(false);
          snapshotInProgressRef.current = false;
        }
      }
    },
    [session.id, sessionStatus, initialLoadComplete, refreshRate, addToHistory],
  );

  // Debounced version of takeSnapshot for manual refreshes
  const debouncedTakeSnapshot = useCallback(
    (isManual = true) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          takeSnapshot(false, isManual);
        }
      }, DEBOUNCE_DELAY_MS);
    },
    [takeSnapshot],
  );

  // Track mounted state and cleanup all timers on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, []);

  // Listen for canvas session events from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI.onCanvasEvent((event) => {
      if (event.sessionId !== session.id || !mountedRef.current) {
        return;
      }

      switch (event.type) {
        case "session_closed":
          setSessionStatus("closed");
          setError("Canvas session closed");
          setErrorDetails("The canvas session has been terminated");
          if (refreshIntervalRef.current) {
            clearInterval(refreshIntervalRef.current);
            refreshIntervalRef.current = null;
          }
          break;

        case "content_pushed":
        case "checkpoint_restored":
          // Always refresh on explicit agent actions, even when auto-refresh is paused
          if (!isMinimized) {
            setTimeout(() => {
              if (mountedRef.current && !snapshotInProgressRef.current) {
                takeSnapshot(false, false);
              }
            }, 500);
          }
          break;

        case "session_updated":
          if (event.session && event.session.status !== sessionStatus) {
            setSessionStatus(event.session.status);
          }
          break;

        case "console_message":
          if (event.console) {
            setConsoleLogs((prev) => [
              ...prev,
              {
                type: event.console!.level,
                message: event.console!.message,
                timestamp: event.timestamp,
              },
            ]);
          }
          break;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [session.id, isPaused, isMinimized, takeSnapshot, sessionStatus]);

  // Initial snapshot and periodic refresh
  useEffect(() => {
    takeSnapshot(false, false);

    // Refresh snapshot based on refresh rate when not minimized, not paused, and session is active
    if (!isMinimized && !isPaused && sessionStatus === "active" && refreshRate > 0) {
      refreshIntervalRef.current = setInterval(() => {
        if (mountedRef.current && !snapshotInProgressRef.current) {
          takeSnapshot(false, false);
        }
      }, refreshRate);
    }

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
  }, [takeSnapshot, isMinimized, isPaused, sessionStatus, refreshRate]);

  // Resize handlers
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      resizeStartYRef.current = e.clientY;
      resizeStartHeightRef.current = previewHeight;
    },
    [previewHeight],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - resizeStartYRef.current;
      const newHeight = Math.min(
        MAX_PREVIEW_HEIGHT,
        Math.max(MIN_PREVIEW_HEIGHT, resizeStartHeightRef.current + deltaY),
      );
      setPreviewHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  // Open the canvas in its own window
  const handleOpenWindow = useCallback(async () => {
    try {
      await window.electronAPI.canvasShow(session.id);
    } catch (err) {
      console.error("Failed to show canvas window:", err);
    }
  }, [session.id]);

  // Close the canvas session
  const handleClose = useCallback(async () => {
    try {
      await window.electronAPI.canvasClose(session.id);
      onClose?.();
    } catch (err) {
      console.error("Failed to close canvas:", err);
    }
  }, [session.id, onClose]);

  // Toggle minimize state
  const handleMinimize = useCallback(() => {
    setIsMinimized((prev) => !prev);
  }, []);

  // Toggle pause state
  const handleTogglePause = useCallback(() => {
    setIsPaused((prev) => !prev);
  }, []);

  // Refresh the snapshot manually (debounced)
  const handleRefresh = useCallback(() => {
    debouncedTakeSnapshot(true);
  }, [debouncedTakeSnapshot]);

  // Copy snapshot to clipboard
  const handleCopyToClipboard = useCallback(async () => {
    const currentImage = historyIndex >= 0 ? snapshotHistory[historyIndex]?.imageData : imageData;
    if (!currentImage) return;

    try {
      const response = await fetch(currentImage);
      const blob = await response.blob();

      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);

      setCopyFeedback("Copied!");
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
      setCopyFeedback("Failed to copy");
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [imageData, historyIndex, snapshotHistory]);

  // Save snapshot as PNG
  const handleSaveSnapshot = useCallback(() => {
    const currentImage = historyIndex >= 0 ? snapshotHistory[historyIndex]?.imageData : imageData;
    if (!currentImage) return;

    try {
      const link = document.createElement("a");
      link.download = `canvas-${session.id.slice(0, 8)}-${Date.now()}.png`;
      link.href = currentImage;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setCopyFeedback("Saved!");
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error("Failed to save snapshot:", err);
      setCopyFeedback("Failed to save");
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [imageData, session.id, historyIndex, snapshotHistory]);

  // Handle refresh rate change
  const handleRefreshRateChange = useCallback((rate: RefreshRate) => {
    setRefreshRate(rate);
    // If switching to manual, pause auto-refresh
    if (rate === 0) {
      setIsPaused(true);
    } else {
      setIsPaused(false);
    }
  }, []);

  // Export as standalone HTML file
  const handleExportHTML = useCallback(async () => {
    setShowMoreMenu(false);
    try {
      const result = await window.electronAPI.canvasExportHTML(session.id);
      // Create and download the file
      const blob = new Blob([result.content], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setCopyFeedback("Exported!");
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error("Failed to export HTML:", err);
      setCopyFeedback("Export failed");
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [session.id]);

  // Export page + assets/ to a folder picked in the native dialog
  const handleExportFolder = useCallback(async () => {
    setShowMoreMenu(false);
    try {
      const result = await window.electronAPI.canvasExportToFolder({ sessionId: session.id });
      if (!result) return;
      setCopyFeedback(`Exported ${result.files.length} files`);
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error("Failed to export canvas folder:", err);
      setCopyFeedback("Export failed");
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [session.id]);

  // Open canvas in system browser
  const handleOpenInBrowser = useCallback(async () => {
    setShowMoreMenu(false);
    try {
      await window.electronAPI.canvasOpenInBrowser(session.id);
      setCopyFeedback("Opened in browser");
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error("Failed to open in browser:", err);
      setCopyFeedback("Failed to open");
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [session.id]);

  // Open canvas content (or remote URL) inside the in-app browser view
  const handleOpenBrowserCanvas = useCallback(() => {
    setShowMoreMenu(false);
    if (!onOpenBrowser) {
      setCopyFeedback("Browser view unavailable");
      setTimeout(() => setCopyFeedback(null), 2000);
      return;
    }
    // For browser-mode sessions use the remote URL; for HTML-mode use the canvas:// protocol
    const targetUrl = session.url || `canvas://${session.id}/index.html`;
    onOpenBrowser(targetUrl);
  }, [onOpenBrowser, session.url, session.id]);

  // Submit URL from browser input
  const handleSubmitBrowserUrl = useCallback(() => {
    if (!browserUrl.trim()) return;
    setShowBrowserUrlInput(false);
    if (onOpenBrowser) {
      onOpenBrowser(browserUrl.trim());
    }
    setBrowserUrl("");
  }, [browserUrl, onOpenBrowser]);

  // Open session folder in Finder
  const handleOpenFolder = useCallback(async () => {
    setShowMoreMenu(false);
    try {
      const sessionDir = await window.electronAPI.canvasGetSessionDir(session.id);
      if (sessionDir) {
        await window.electronAPI.showInFinder(sessionDir);
        setCopyFeedback("Opened folder");
        setTimeout(() => setCopyFeedback(null), 2000);
      }
    } catch (err) {
      console.error("Failed to open folder:", err);
      setCopyFeedback("Failed to open");
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [session.id]);

  // Navigate history
  const handleHistoryChange = useCallback((index: number) => {
    setHistoryIndex(index);
  }, []);

  // Go to live view
  const handleGoLive = useCallback(() => {
    setHistoryIndex(-1);
  }, []);

  // Clear console logs
  const handleClearConsole = useCallback(() => {
    setConsoleLogs([]);
  }, []);

  // Toggle interactive mode
  const handleToggleInteractiveMode = useCallback(() => {
    if (isBrowserCanvas) {
      setIsInteractiveMode(false);
      setIsPaused(false);
      return;
    }
    setIsInteractiveMode((prev) => !prev);
    // Toggle pause state based on mode
    if (!isInteractiveMode) {
      // Switching to interactive mode - pause snapshots to save resources
      setIsPaused(true);
    } else {
      // Switching to snapshot mode - resume snapshots
      setIsPaused(false);
    }
  }, [isInteractiveMode, isBrowserCanvas]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        !containerRef.current?.contains(document.activeElement) &&
        document.activeElement !== containerRef.current
      ) {
        return;
      }

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case "r":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            debouncedTakeSnapshot(true);
          }
          break;
        case "m":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setIsMinimized((prev) => !prev);
          }
          break;
        case "o":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleOpenWindow();
          }
          break;
        case "p":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setIsPaused((prev) => !prev);
          }
          break;
        case "c":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleCopyToClipboard();
          }
          break;
        case "s":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleSaveSnapshot();
          }
          break;
        case "h":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setShowHistory((prev) => !prev);
          }
          break;
        case "l":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setShowConsole((prev) => !prev);
          }
          break;
        case "e":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setShowMoreMenu((prev) => !prev);
          }
          break;
        case "b":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleOpenInBrowser();
          }
          break;
        case "i":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleToggleInteractiveMode();
          }
          break;
        case "arrowleft":
          if (showHistory && historyIndex < snapshotHistory.length - 1) {
            e.preventDefault();
            setHistoryIndex((prev) =>
              prev === -1
                ? snapshotHistory.length - 1
                : Math.min(prev + 1, snapshotHistory.length - 1),
            );
          }
          break;
        case "arrowright":
          if (showHistory && historyIndex >= 0) {
            e.preventDefault();
            setHistoryIndex((prev) => prev - 1);
          }
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    debouncedTakeSnapshot,
    handleCopyToClipboard,
    handleSaveSnapshot,
    handleOpenWindow,
    handleOpenInBrowser,
    handleToggleInteractiveMode,
    showHistory,
    historyIndex,
    snapshotHistory.length,
  ]);

  // Close the overflow menu on an outside click or Escape
  useEffect(() => {
    if (!showMoreMenu) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (!moreMenuRef.current?.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowMoreMenu(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [showMoreMenu]);

  // One quiet status label: a tone dot plus a word. Interactive mode pauses
  // snapshots, so it reads as "Interactive" rather than "Paused".
  const getStatusIndicator = () => {
    let tone: "live" | "paused" | "history" | "closed";
    let label: string;
    if (historyIndex >= 0) {
      tone = "history";
      label = "History";
    } else if (sessionStatus === "closed") {
      tone = "closed";
      label = "Closed";
    } else if (sessionStatus === "active" && isInteractiveMode) {
      tone = "live";
      label = "Interactive";
    } else if (sessionStatus === "active" && !isPaused) {
      tone = "live";
      label = "Live";
    } else if (sessionStatus === "active" || sessionStatus === "paused") {
      tone = "paused";
      label = "Paused";
    } else {
      return null;
    }
    return (
      <span className={`canvas-status ${tone}`}>
        <span className="canvas-status-dot" aria-hidden="true" />
        {label}
      </span>
    );
  };

  // Get current display image (live or from history)
  const currentDisplayImage = useMemo(() => {
    if (historyIndex >= 0 && snapshotHistory[historyIndex]) {
      return snapshotHistory[historyIndex].imageData;
    }
    return imageData;
  }, [historyIndex, snapshotHistory, imageData]);

  const currentDisplayDimensions = useMemo(() => {
    if (historyIndex >= 0 && snapshotHistory[historyIndex]) {
      return snapshotHistory[historyIndex].dimensions;
    }
    return imageDimensions;
  }, [historyIndex, snapshotHistory, imageDimensions]);

  // Format timestamp for history
  const formatHistoryTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  // Loading skeleton component
  const LoadingSkeleton = () => (
    <div className="canvas-preview-skeleton">
      <div className="skeleton-header">
        <div className="skeleton-title"></div>
        <div className="skeleton-actions">
          <div className="skeleton-btn"></div>
          <div className="skeleton-btn"></div>
          <div className="skeleton-btn"></div>
        </div>
      </div>
      <div className="skeleton-content">
        <div className="skeleton-image"></div>
      </div>
    </div>
  );

  // Show skeleton during initial load
  if (!initialLoadComplete && isLoading) {
    return <LoadingSkeleton />;
  }

  // Don't render if no content and no error
  if (!initialLoadComplete || (!imageData && !error)) {
    return null;
  }

  return (
    <div
      className={`canvas-preview-container ${isMinimized ? "minimized" : ""} ${isResizing ? "resizing" : ""}`}
      ref={containerRef}
      tabIndex={0}
      style={
        !isMinimized
          ? ({ "--preview-height": `${previewHeight}px` } as React.CSSProperties)
          : undefined
      }
    >
      <div className="canvas-preview-header">
        <div className="canvas-preview-title">
          <span className="canvas-title-icon" aria-hidden="true">
            <ImageIcon size={14} strokeWidth={1.75} />
          </span>
          <span className="canvas-title-text">{session.title || "Live Canvas"}</span>
          {getStatusIndicator()}
        </div>
        <div className="canvas-preview-actions">
          {copyFeedback && (
            <span className="canvas-copy-feedback" role="status">
              {copyFeedback}
            </span>
          )}
          {historyIndex >= 0 && (
            <button className="canvas-go-live-btn" onClick={handleGoLive}>
              Back to live
            </button>
          )}
          {!isMinimized && currentDisplayImage && (
            <button
              className={`canvas-action-btn ${isInteractiveMode ? "active" : ""}`}
              onClick={handleToggleInteractiveMode}
              disabled={isBrowserCanvas || forceSnapshot}
              aria-pressed={isInteractiveMode}
              title={
                isBrowserCanvas
                  ? "Interactive preview unavailable for browser pages. Use Open in window."
                  : forceSnapshot
                    ? "Snapshot locked for previous canvases"
                    : isInteractiveMode
                      ? "Switch to snapshot view (I)"
                      : "Interact with the page (I)"
              }
            >
              <MousePointer2 size={15} strokeWidth={1.75} />
            </button>
          )}
          {!isMinimized && sessionStatus === "active" && !isInteractiveMode && (
            <>
              <button
                className="canvas-action-btn"
                onClick={handleTogglePause}
                title={isPaused ? "Resume auto-refresh (P)" : "Pause auto-refresh (P)"}
              >
                {isPaused ? (
                  <Play size={15} strokeWidth={1.75} />
                ) : (
                  <Pause size={15} strokeWidth={1.75} />
                )}
              </button>
              <button
                className="canvas-action-btn"
                onClick={handleRefresh}
                title="Refresh snapshot (R)"
              >
                <RotateCw size={15} strokeWidth={1.75} />
              </button>
            </>
          )}
          <button
            className="canvas-action-btn"
            onClick={handleOpenWindow}
            title="Open in window (O)"
          >
            <ExternalLink size={15} strokeWidth={1.75} />
          </button>
          {!isMinimized && (
            <div className="canvas-more-menu-container" ref={moreMenuRef}>
              <button
                className={`canvas-action-btn ${showMoreMenu ? "active" : ""}`}
                onClick={() => setShowMoreMenu((prev) => !prev)}
                aria-haspopup="menu"
                aria-expanded={showMoreMenu}
                title="More (E)"
              >
                <Ellipsis size={15} strokeWidth={1.75} />
              </button>
              {showMoreMenu && (
                <div className="canvas-more-menu" role="menu">
                  {currentDisplayImage && (
                    <>
                      <button
                        className="canvas-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setShowMoreMenu(false);
                          handleCopyToClipboard();
                        }}
                      >
                        <Copy size={14} strokeWidth={1.75} />
                        <span className="canvas-menu-label">Copy image</span>
                        <kbd className="canvas-menu-kbd">C</kbd>
                      </button>
                      <button
                        className="canvas-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setShowMoreMenu(false);
                          handleSaveSnapshot();
                        }}
                      >
                        <Download size={14} strokeWidth={1.75} />
                        <span className="canvas-menu-label">Save as PNG</span>
                        <kbd className="canvas-menu-kbd">S</kbd>
                      </button>
                      <div className="canvas-menu-separator" role="separator" />
                    </>
                  )}
                  <button className="canvas-menu-item" role="menuitem" onClick={handleExportHTML}>
                    <FileCode2 size={14} strokeWidth={1.75} />
                    <span className="canvas-menu-label">Export HTML</span>
                  </button>
                  <button className="canvas-menu-item" role="menuitem" onClick={handleExportFolder}>
                    <FolderDown size={14} strokeWidth={1.75} />
                    <span className="canvas-menu-label">Export folder with media</span>
                  </button>
                  <button className="canvas-menu-item" role="menuitem" onClick={handleOpenFolder}>
                    <FolderOpen size={14} strokeWidth={1.75} />
                    <span className="canvas-menu-label">Show in Finder</span>
                  </button>
                  <div className="canvas-menu-separator" role="separator" />
                  <button
                    className="canvas-menu-item"
                    role="menuitem"
                    onClick={handleOpenInBrowser}
                  >
                    <Globe size={14} strokeWidth={1.75} />
                    <span className="canvas-menu-label">Open in default browser</span>
                    <kbd className="canvas-menu-kbd">B</kbd>
                  </button>
                  <button
                    className="canvas-menu-item"
                    role="menuitem"
                    onClick={handleOpenBrowserCanvas}
                  >
                    <AppWindow size={14} strokeWidth={1.75} />
                    <span className="canvas-menu-label">Open in browser view</span>
                  </button>
                  <div className="canvas-menu-separator" role="separator" />
                  <button
                    className="canvas-menu-item"
                    role="menuitemcheckbox"
                    aria-checked={showHistory}
                    onClick={() => {
                      setShowMoreMenu(false);
                      setShowHistory((prev) => !prev);
                    }}
                  >
                    <History size={14} strokeWidth={1.75} />
                    <span className="canvas-menu-label">Snapshot history</span>
                    {showHistory ? (
                      <Check className="canvas-menu-check" size={14} strokeWidth={2} />
                    ) : (
                      <kbd className="canvas-menu-kbd">H</kbd>
                    )}
                  </button>
                  <button
                    className="canvas-menu-item"
                    role="menuitemcheckbox"
                    aria-checked={showConsole}
                    onClick={() => {
                      setShowMoreMenu(false);
                      setShowConsole((prev) => !prev);
                    }}
                  >
                    <SquareTerminal size={14} strokeWidth={1.75} />
                    <span className="canvas-menu-label">Console</span>
                    {showConsole ? (
                      <Check className="canvas-menu-check" size={14} strokeWidth={2} />
                    ) : (
                      <kbd className="canvas-menu-kbd">L</kbd>
                    )}
                  </button>
                  {sessionStatus === "active" && !isInteractiveMode && (
                    <>
                      <div className="canvas-menu-separator" role="separator" />
                      <div className="canvas-menu-section-label">Auto-refresh</div>
                      <div className="canvas-refresh-segmented" role="radiogroup">
                        {REFRESH_RATE_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            role="radio"
                            aria-checked={refreshRate === option.value}
                            className={`canvas-refresh-option ${refreshRate === option.value ? "active" : ""}`}
                            onClick={() => handleRefreshRateChange(option.value)}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <span className="canvas-actions-divider" aria-hidden="true" />
          <button
            className="canvas-action-btn"
            onClick={handleMinimize}
            title={isMinimized ? "Expand (M)" : "Collapse (M)"}
          >
            {isMinimized ? (
              <ChevronsUpDown size={15} strokeWidth={1.75} />
            ) : (
              <ChevronsDownUp size={15} strokeWidth={1.75} />
            )}
          </button>
          <button className="canvas-action-btn" onClick={handleClose} title="Close canvas">
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>
      </div>
      {showBrowserUrlInput && (
        <div className="canvas-browser-input-row">
          <input
            ref={browserInputRef}
            className="canvas-browser-input"
            type="text"
            value={browserUrl}
            onChange={(e) => setBrowserUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSubmitBrowserUrl();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setShowBrowserUrlInput(false);
              }
            }}
            placeholder="https://example.com"
          />
          <button className="canvas-browser-btn" onClick={handleSubmitBrowserUrl}>
            Open
          </button>
          <button
            className="canvas-browser-btn ghost"
            onClick={() => setShowBrowserUrlInput(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {!isMinimized && (
        <>
          <div className="canvas-preview-content">
            {/* Loading/error only show in snapshot mode */}
            {!isInteractiveMode && isLoading && !currentDisplayImage && (
              <div className="canvas-preview-loading">
                <LoaderCircle className="spinner" size={20} strokeWidth={1.75} />
                <span>{agentContext.getUiCopy("canvasLoading")}</span>
              </div>
            )}
            {!isInteractiveMode && error && !currentDisplayImage && (
              <div className="canvas-preview-error">
                <CircleAlert size={20} strokeWidth={1.75} />
                <span className="canvas-error-title">{error}</span>
                {errorDetails && <span className="canvas-error-details">{errorDetails}</span>}
                <button className="canvas-retry-btn" onClick={handleRefresh}>
                  Try again
                </button>
              </div>
            )}
            {/* Interactive mode: show webview for full interactivity */}
            {isInteractiveMode && (
              <div className="canvas-interactive-wrapper" style={{ height: previewHeight - 48 }}>
                <webview
                  partition={`canvas-${session.id}`}
                  src={`canvas://${session.id}/index.html`}
                  className="canvas-interactive-iframe"
                  style={{ width: "100%", height: "100%" }}
                  /* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
                  // @ts-expect-error - webview attributes not typed in React
                  allowpopups="true"
                  webpreferences="contextIsolation=yes, nodeIntegration=no"
                />
              </div>
            )}
            {/* Snapshot mode: show image */}
            {!isInteractiveMode && currentDisplayImage && (
              <CanvasImage
                src={currentDisplayImage}
                dimensions={currentDisplayDimensions}
                isLoading={isLoading}
                historyIndex={historyIndex}
                historyTimestamp={
                  historyIndex >= 0 ? snapshotHistory[historyIndex]?.timestamp : undefined
                }
                onOpenWindow={handleOpenWindow}
              />
            )}
          </div>
          {isInteractiveMode && (
            <div className="canvas-preview-footer">
              <span className="canvas-footer-hint">
                <kbd>I</kbd> snapshot view
              </span>
              <span className="canvas-footer-hint">Drag the edge below to resize</span>
            </div>
          )}

          {/* History timeline */}
          {showHistory && snapshotHistory.length > 0 && (
            <div className="canvas-history-panel">
              <div className="canvas-history-header">
                <span>
                  Snapshot history
                  <span className="canvas-history-count">{snapshotHistory.length}</span>
                </span>
                <button
                  className={`canvas-history-live-btn ${historyIndex < 0 ? "active" : ""}`}
                  onClick={handleGoLive}
                >
                  Live
                </button>
              </div>
              <div className="canvas-history-slider">
                <input
                  type="range"
                  min={-1}
                  max={snapshotHistory.length - 1}
                  value={historyIndex}
                  onChange={(e) => handleHistoryChange(parseInt(e.target.value))}
                  className="history-slider"
                />
              </div>
              <div className="canvas-history-thumbnails">
                {snapshotHistory.slice(-10).map((entry, idx) => {
                  const actualIndex = snapshotHistory.length - 10 + idx;
                  if (actualIndex < 0) return null;
                  return (
                    <button
                      key={entry.timestamp}
                      className={`history-thumbnail ${historyIndex === actualIndex ? "active" : ""}`}
                      onClick={() => handleHistoryChange(actualIndex)}
                      title={formatHistoryTime(entry.timestamp)}
                    >
                      <img src={entry.imageData} alt={`Snapshot ${actualIndex + 1}`} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Console log viewer */}
          {showConsole && (
            <div className="canvas-console-panel">
              <div className="canvas-console-header">
                <span>Console</span>
                <button className="canvas-console-clear" onClick={handleClearConsole}>
                  Clear
                </button>
              </div>
              <div className="canvas-console-logs">
                {consoleLogs.length === 0 ? (
                  <div className="canvas-console-empty">No console output</div>
                ) : (
                  consoleLogs.map((log, idx) => (
                    <div key={idx} className={`console-log console-${log.type}`}>
                      <span className="console-time">{formatHistoryTime(log.timestamp)}</span>
                      <span className="console-message">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Resize handle */}
          <ResizableDividerHandle
            className="canvas-resize-handle"
            orientation="horizontal"
            onMouseDown={handleResizeStart}
            title="Drag to resize"
          />
        </>
      )}
    </div>
  );
}
