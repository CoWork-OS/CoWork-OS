import { useRef, useEffect, useState, useCallback, useMemo, memo } from 'react';
import type { CanvasSession } from '../../shared/types';
import { useAgentContext } from '../hooks/useAgentContext';

interface CanvasPreviewProps {
  session: CanvasSession;
  onClose?: () => void;
  forceSnapshot?: boolean;
}

interface SnapshotHistoryEntry {
  imageData: string;
  timestamp: number;
  dimensions: { width: number; height: number };
}

interface ConsoleLogEntry {
  type: 'log' | 'warn' | 'error' | 'info';
  message: string;
  timestamp: number;
}

// Refresh rate options
type RefreshRate = 1000 | 2000 | 5000 | 0; // 0 = manual only
const REFRESH_RATE_OPTIONS: { value: RefreshRate; label: string }[] = [
  { value: 1000, label: '1s' },
  { value: 2000, label: '2s' },
  { value: 5000, label: '5s' },
  { value: 0, label: 'Manual' },
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
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

// Memoized image component to prevent re-renders when only image changes
interface CanvasImageProps {
  src: string;
  dimensions: { width: number; height: number };
  isPaused: boolean;
  isLoading: boolean;
  historyIndex: number;
  historyTimestamp?: number;
  onOpenWindow: () => void;
}

const CanvasImage = memo(function CanvasImage({
  src,
  dimensions,
  isPaused,
  isLoading,
  historyIndex,
  historyTimestamp,
  onOpenWindow,
}: CanvasImageProps) {
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div
      className="canvas-preview-image-wrapper"
      onClick={onOpenWindow}
      title="Click to open in window (O)"
    >
      <img
        src={src}
        alt="Canvas Preview"
        className="canvas-preview-image"
      />
      {dimensions.width > 0 && (
        <div className="canvas-preview-dimensions">
          {dimensions.width} x {dimensions.height}
          {isPaused && historyIndex < 0 && <span className="canvas-paused-indicator"> • Paused</span>}
          {historyIndex >= 0 && historyTimestamp && (
            <span className="canvas-history-time"> • {formatTime(historyTimestamp)}</span>
          )}
        </div>
      )}
      {isLoading && historyIndex < 0 && (
        <div className="canvas-preview-updating">
          <svg className="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  );
});

export function CanvasPreview({ session, onClose, forceSnapshot = false }: CanvasPreviewProps) {
  const isBrowserCanvas = session.mode === 'browser';
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
  const [showRefreshMenu, setShowRefreshMenu] = useState(false);
  const [previewHeight, setPreviewHeight] = useState(DEFAULT_PREVIEW_HEIGHT);
  const [isResizing, setIsResizing] = useState(false);
  const [snapshotHistory, setSnapshotHistory] = useState<SnapshotHistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 means live view
  const [showHistory, setShowHistory] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [isInteractiveMode, setIsInteractiveMode] = useState(!isBrowserCanvas && !forceSnapshot);

  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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
  const addToHistory = useCallback((newImageData: string, dimensions: { width: number; height: number }) => {
    setSnapshotHistory(prev => {
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
  }, []);

  // Take a snapshot of the canvas with timeout and debouncing
  const takeSnapshot = useCallback(async (isRetry = false, isManual = false) => {
    if (!mountedRef.current) return;

    // Check if session is closed
    if (sessionStatus === 'closed') {
      setError('Canvas session closed');
      setErrorDetails('The canvas session has been terminated');
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
        'Snapshot request timed out'
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
        throw new Error('Empty snapshot received');
      }
    } catch (err) {
      if (!mountedRef.current) return;

      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error('Failed to take canvas snapshot:', errorMessage);

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
      let userError = 'Failed to capture canvas';
      let details = errorMessage;

      if (errorMessage.includes('not found') || errorMessage.includes('not open')) {
        userError = 'Canvas window not available';
        details = 'The canvas window may have been closed or not yet created';
      } else if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
        userError = 'Snapshot timed out';
        details = 'The canvas took too long to respond. Try refreshing.';
      } else if (errorMessage.includes('destroyed')) {
        userError = 'Canvas window destroyed';
        details = 'The canvas window has been closed';
        setSessionStatus('closed');
      } else if (errorMessage.includes('closed')) {
        userError = 'Canvas session closed';
        details = 'The canvas session is no longer available';
        setSessionStatus('closed');
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
  }, [session.id, sessionStatus, initialLoadComplete, refreshRate, addToHistory]);

  // Debounced version of takeSnapshot for manual refreshes
  const debouncedTakeSnapshot = useCallback((isManual = true) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        takeSnapshot(false, isManual);
      }
    }, DEBOUNCE_DELAY_MS);
  }, [takeSnapshot]);

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
        case 'session_closed':
          setSessionStatus('closed');
          setError('Canvas session closed');
          setErrorDetails('The canvas session has been terminated');
          if (refreshIntervalRef.current) {
            clearInterval(refreshIntervalRef.current);
            refreshIntervalRef.current = null;
          }
          break;

        case 'content_pushed':
          if (!isPaused && !isMinimized) {
            setTimeout(() => {
              if (mountedRef.current && !snapshotInProgressRef.current) {
                takeSnapshot(false, false);
              }
            }, 500);
          }
          break;

        case 'session_updated':
          if (event.session && event.session.status !== sessionStatus) {
            setSessionStatus(event.session.status);
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
    if (!isMinimized && !isPaused && sessionStatus === 'active' && refreshRate > 0) {
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
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartYRef.current = e.clientY;
    resizeStartHeightRef.current = previewHeight;
  }, [previewHeight]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - resizeStartYRef.current;
      const newHeight = Math.min(
        MAX_PREVIEW_HEIGHT,
        Math.max(MIN_PREVIEW_HEIGHT, resizeStartHeightRef.current + deltaY)
      );
      setPreviewHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Open the canvas in its own window
  const handleOpenWindow = useCallback(async () => {
    try {
      await window.electronAPI.canvasShow(session.id);
    } catch (err) {
      console.error('Failed to show canvas window:', err);
    }
  }, [session.id]);

  // Close the canvas session
  const handleClose = useCallback(async () => {
    try {
      await window.electronAPI.canvasClose(session.id);
      onClose?.();
    } catch (err) {
      console.error('Failed to close canvas:', err);
    }
  }, [session.id, onClose]);

  // Toggle minimize state
  const handleMinimize = useCallback(() => {
    setIsMinimized(prev => !prev);
  }, []);

  // Toggle pause state
  const handleTogglePause = useCallback(() => {
    setIsPaused(prev => !prev);
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

      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);

      setCopyFeedback('Copied!');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
      setCopyFeedback('Failed to copy');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [imageData, historyIndex, snapshotHistory]);

  // Save snapshot as PNG
  const handleSaveSnapshot = useCallback(() => {
    const currentImage = historyIndex >= 0 ? snapshotHistory[historyIndex]?.imageData : imageData;
    if (!currentImage) return;

    try {
      const link = document.createElement('a');
      link.download = `canvas-${session.id.slice(0, 8)}-${Date.now()}.png`;
      link.href = currentImage;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setCopyFeedback('Saved!');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error('Failed to save snapshot:', err);
      setCopyFeedback('Failed to save');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [imageData, session.id, historyIndex, snapshotHistory]);

  // Handle refresh rate change
  const handleRefreshRateChange = useCallback((rate: RefreshRate) => {
    setRefreshRate(rate);
    setShowRefreshMenu(false);
    // If switching to manual, pause auto-refresh
    if (rate === 0) {
      setIsPaused(true);
    } else {
      setIsPaused(false);
    }
  }, []);

  // Export as standalone HTML file
  const handleExportHTML = useCallback(async () => {
    setShowExportMenu(false);
    try {
      const result = await window.electronAPI.canvasExportHTML(session.id);
      // Create and download the file
      const blob = new Blob([result.content], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setCopyFeedback('Exported!');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error('Failed to export HTML:', err);
      setCopyFeedback('Export failed');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [session.id]);

  // Open canvas in system browser
  const handleOpenInBrowser = useCallback(async () => {
    setShowExportMenu(false);
    try {
      await window.electronAPI.canvasOpenInBrowser(session.id);
      setCopyFeedback('Opened in browser');
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch (err) {
      console.error('Failed to open in browser:', err);
      setCopyFeedback('Failed to open');
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }, [session.id]);

  // Open session folder in Finder
  const handleOpenFolder = useCallback(async () => {
    setShowExportMenu(false);
    try {
      const sessionDir = await window.electronAPI.canvasGetSessionDir(session.id);
      if (sessionDir) {
        await window.electronAPI.showInFinder(sessionDir);
        setCopyFeedback('Opened folder');
        setTimeout(() => setCopyFeedback(null), 2000);
      }
    } catch (err) {
      console.error('Failed to open folder:', err);
      setCopyFeedback('Failed to open');
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

  // TODO: Implement console capture from canvas window via IPC
  // The addConsoleLog function can be added when canvas console forwarding is implemented
  // Example usage: addConsoleLog('log', 'Message from canvas');

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
    setIsInteractiveMode(prev => !prev);
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
      if (!containerRef.current?.contains(document.activeElement) &&
          document.activeElement !== containerRef.current) {
        return;
      }

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'r':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            debouncedTakeSnapshot(true);
          }
          break;
        case 'm':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setIsMinimized(prev => !prev);
          }
          break;
        case 'o':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleOpenWindow();
          }
          break;
        case 'p':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setIsPaused(prev => !prev);
          }
          break;
        case 'c':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleCopyToClipboard();
          }
          break;
        case 's':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleSaveSnapshot();
          }
          break;
        case 'h':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setShowHistory(prev => !prev);
          }
          break;
        case 'l':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setShowConsole(prev => !prev);
          }
          break;
        case 'e':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            setShowExportMenu(prev => !prev);
          }
          break;
        case 'b':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleOpenInBrowser();
          }
          break;
        case 'i':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            handleToggleInteractiveMode();
          }
          break;
        case 'arrowleft':
          if (showHistory && historyIndex < snapshotHistory.length - 1) {
            e.preventDefault();
            setHistoryIndex(prev => prev === -1 ? snapshotHistory.length - 1 : Math.min(prev + 1, snapshotHistory.length - 1));
          }
          break;
        case 'arrowright':
          if (showHistory && historyIndex >= 0) {
            e.preventDefault();
            setHistoryIndex(prev => prev - 1);
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [debouncedTakeSnapshot, handleCopyToClipboard, handleSaveSnapshot, handleOpenWindow, handleOpenInBrowser, handleToggleInteractiveMode, showHistory, historyIndex, snapshotHistory.length]);

  // Get status indicator
  const getStatusIndicator = () => {
    if (historyIndex >= 0) {
      return <span className="canvas-status history">History</span>;
    }
    if (isPaused && sessionStatus === 'active') {
      return <span className="canvas-status paused">Paused</span>;
    }
    switch (sessionStatus) {
      case 'active':
        return <span className="canvas-status active">Live</span>;
      case 'paused':
        return <span className="canvas-status paused">Paused</span>;
      case 'closed':
        return <span className="canvas-status closed">Closed</span>;
      default:
        return null;
    }
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
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
      className={`canvas-preview-container ${isMinimized ? 'minimized' : ''} ${isResizing ? 'resizing' : ''}`}
      ref={containerRef}
      tabIndex={0}
      style={!isMinimized ? { '--preview-height': `${previewHeight}px` } as React.CSSProperties : undefined}
    >
      <div className="canvas-preview-header">
        <div className="canvas-preview-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span className="canvas-title-text">{session.title || 'Live Canvas'}</span>
        </div>
        <div className="canvas-preview-actions">
          {getStatusIndicator()}
          {copyFeedback && (
            <span className="canvas-copy-feedback">{copyFeedback}</span>
          )}
          {!isMinimized && currentDisplayImage && (
            <>
              {/* Copy to clipboard */}
              <button
                className="canvas-action-btn"
                onClick={handleCopyToClipboard}
                title="Copy to clipboard (C)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              </button>
              {/* Save as PNG */}
              <button
                className="canvas-action-btn"
                onClick={handleSaveSnapshot}
                title="Save as PNG (S)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </button>
              {/* History toggle */}
              <button
                className={`canvas-action-btn ${showHistory ? 'active' : ''}`}
                onClick={() => setShowHistory(prev => !prev)}
                title={`${showHistory ? 'Hide' : 'Show'} history (H)`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </button>
              {/* Console toggle */}
              <button
                className={`canvas-action-btn ${showConsole ? 'active' : ''}`}
                onClick={() => setShowConsole(prev => !prev)}
                title={`${showConsole ? 'Hide' : 'Show'} console (L)`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </button>
              {/* Interactive mode toggle */}
          <button
            className={`canvas-action-btn ${isInteractiveMode ? 'active' : ''} ${(isBrowserCanvas || forceSnapshot) ? 'disabled' : ''}`}
            onClick={handleToggleInteractiveMode}
            disabled={isBrowserCanvas || forceSnapshot}
            title={isBrowserCanvas
              ? 'Interactive preview unavailable for browser pages. Use Open in window.'
              : (forceSnapshot ? 'Snapshot locked for previous canvases' : (isInteractiveMode ? 'Switch to snapshot mode (I)' : 'Switch to interactive mode (I)'))}
          >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 3l14 9-7 2-4 6-3-17z" />
                </svg>
              </button>
              {/* Export menu */}
              <div className="canvas-export-menu-container">
                <button
                  className={`canvas-action-btn ${showExportMenu ? 'active' : ''}`}
                  onClick={() => setShowExportMenu(prev => !prev)}
                  title="Export options (E)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </button>
                {showExportMenu && (
                  <div className="canvas-export-menu">
                    <button className="export-menu-item" onClick={handleExportHTML}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      Export HTML
                    </button>
                    <button className="export-menu-item" onClick={handleOpenInBrowser}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                      </svg>
                      Open in Browser (B)
                    </button>
                    <button className="export-menu-item" onClick={handleOpenFolder}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                      </svg>
                      Show in Finder
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          {!isMinimized && sessionStatus === 'active' && (
            <>
              {/* Refresh rate selector */}
              <div className="canvas-refresh-rate-container">
                <button
                  className="canvas-action-btn"
                  onClick={() => setShowRefreshMenu(prev => !prev)}
                  title="Refresh rate"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                  </svg>
                  <span className="refresh-rate-label">{refreshRate === 0 ? 'M' : `${refreshRate / 1000}s`}</span>
                </button>
                {showRefreshMenu && (
                  <div className="canvas-refresh-menu">
                    {REFRESH_RATE_OPTIONS.map(option => (
                      <button
                        key={option.value}
                        className={`refresh-menu-item ${refreshRate === option.value ? 'active' : ''}`}
                        onClick={() => handleRefreshRateChange(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Pause/Resume */}
              <button
                className={`canvas-action-btn ${isPaused ? 'paused' : ''}`}
                onClick={handleTogglePause}
                title={isPaused ? 'Resume auto-refresh (P)' : 'Pause auto-refresh (P)'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {isPaused ? (
                    <polygon points="5 3 19 12 5 21 5 3" />
                  ) : (
                    <>
                      <rect x="6" y="4" width="4" height="16" />
                      <rect x="14" y="4" width="4" height="16" />
                    </>
                  )}
                </svg>
              </button>
              {/* Refresh */}
              <button
                className="canvas-action-btn"
                onClick={handleRefresh}
                title="Refresh snapshot (R)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>
            </>
          )}
          {/* Go live button (when viewing history) */}
          {historyIndex >= 0 && (
            <button
              className="canvas-action-btn go-live"
              onClick={handleGoLive}
              title="Return to live view"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
              <span>Live</span>
            </button>
          )}
          {/* Open in window */}
          <button
            className="canvas-action-btn"
            onClick={handleOpenWindow}
            title="Open in window (O)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
          {/* Minimize */}
          <button
            className="canvas-action-btn"
            onClick={handleMinimize}
            title={isMinimized ? 'Expand (M)' : 'Minimize (M)'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {isMinimized ? (
                <polyline points="15 3 21 3 21 9" />
              ) : (
                <line x1="5" y1="12" x2="19" y2="12" />
              )}
            </svg>
          </button>
          {/* Close */}
          <button
            className="canvas-close-btn"
            onClick={handleClose}
            title="Close canvas"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      {!isMinimized && (
        <>
          <div className="canvas-preview-content">
            {/* Loading/error only show in snapshot mode */}
            {!isInteractiveMode && isLoading && !currentDisplayImage && (
              <div className="canvas-preview-loading">
                <svg className="spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                  <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                </svg>
                <span>{agentContext.getUiCopy('canvasLoading')}</span>
              </div>
            )}
            {!isInteractiveMode && error && !currentDisplayImage && (
              <div className="canvas-preview-error">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span className="canvas-error-title">{error}</span>
                {errorDetails && (
                  <span className="canvas-error-details">{errorDetails}</span>
                )}
                <button className="canvas-retry-btn" onClick={handleRefresh}>
                  Try Again
                </button>
              </div>
            )}
            {/* Interactive mode: show webview for full interactivity */}
            {isInteractiveMode && (
              <div className="canvas-interactive-wrapper" style={{ height: previewHeight - 48 }}>
                <webview
                  src={`canvas://${session.id}/index.html`}
                  className="canvas-interactive-iframe"
                  style={{ width: '100%', height: '100%' }}
                  /* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
                  // @ts-expect-error - webview attributes not typed in React
                  allowpopups="true"
                  webpreferences="contextIsolation=yes, nodeIntegration=no"
                />
                <div className="canvas-interactive-indicator">
                  <span>Interactive Mode</span>
                  <span className="canvas-interactive-hint">Press I to switch to snapshot mode • Drag bottom edge to resize</span>
                </div>
              </div>
            )}
            {/* Snapshot mode: show image */}
            {!isInteractiveMode && currentDisplayImage && (
              <CanvasImage
                src={currentDisplayImage}
                dimensions={currentDisplayDimensions}
                isPaused={isPaused}
                isLoading={isLoading}
                historyIndex={historyIndex}
                historyTimestamp={historyIndex >= 0 ? snapshotHistory[historyIndex]?.timestamp : undefined}
                onOpenWindow={handleOpenWindow}
              />
            )}
          </div>

          {/* History timeline */}
          {showHistory && snapshotHistory.length > 0 && (
            <div className="canvas-history-panel">
              <div className="canvas-history-header">
                <span>Snapshot History ({snapshotHistory.length})</span>
                <button
                  className={`canvas-history-live-btn ${historyIndex < 0 ? 'active' : ''}`}
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
                      className={`history-thumbnail ${historyIndex === actualIndex ? 'active' : ''}`}
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
          <div
            className="canvas-resize-handle"
            onMouseDown={handleResizeStart}
            title="Drag to resize"
          >
            <div className="resize-handle-bar"></div>
          </div>
        </>
      )}
    </div>
  );
}
