import { useEffect, useMemo, useState } from "react";
import type { FileViewerResult } from "../../electron/preload";
import { createVideoObjectUrl } from "../utils/videoPlayback";

type InlineVideoPreviewProps = {
  filePath: string;
  workspacePath: string;
  title?: string;
  posterPath?: string;
  muted?: boolean;
  loop?: boolean;
  className?: string;
  onOpenViewer?: (path: string) => void;
};

const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
};

export function InlineVideoPreview({
  filePath,
  workspacePath,
  title,
  posterPath,
  muted = false,
  loop = false,
  className = "",
  onOpenViewer,
}: InlineVideoPreviewProps) {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<FileViewerResult["data"] | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const subtitle = useMemo(() => {
    if (!result) return "";
    const parts = [result.mimeType || "Video", formatFileSize(result.size)].filter(Boolean);
    return parts.join(" • ");
  }, [result]);

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
          setError(response.error || "Failed to load video preview");
          return;
        }
        if (response.data.fileType !== "video" || !response.data.playbackUrl) {
          setError("File is not a previewable video.");
          return;
        }
        setResult(response.data);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load video preview");
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

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!posterPath || !workspacePath) {
        setPosterUrl(null);
        return;
      }

      try {
        const response = await window.electronAPI.readFileForViewer(posterPath, workspacePath, {
          includeImageContent: true,
        });
        if (cancelled) return;
        if (response.success && response.data?.fileType === "image" && response.data.content) {
          setPosterUrl(response.data.content);
          return;
        }
        setPosterUrl(null);
      } catch {
        if (!cancelled) setPosterUrl(null);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [posterPath, workspacePath]);

  useEffect(() => {
    const nextUrl = result?.playbackUrl;
    if (!nextUrl) {
      setPlaybackUrl(null);
      return;
    }

    const resolvedUrl = createVideoObjectUrl(nextUrl);
    if (!resolvedUrl) {
      setPlaybackUrl(null);
      setError("Failed to prepare video playback.");
      return;
    }

    setPlaybackUrl(resolvedUrl);
    setError((current) => (current === "Failed to prepare video playback." ? null : current));

    return () => {
      if (resolvedUrl !== nextUrl) {
        URL.revokeObjectURL(resolvedUrl);
      }
    };
  }, [result?.playbackUrl]);

  const handleOpen = async () => {
    if (onOpenViewer) {
      onOpenViewer(filePath);
      return;
    }
    try {
      await window.electronAPI.openFile(filePath, workspacePath);
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  };

  const displayTitle = title || result?.fileName || filePath.split("/").pop() || filePath;

  return (
    <div className={`inline-video-preview ${className}`.trim()}>
      {loading && <div className="inline-video-loading">Loading video…</div>}

      {!loading && error && <div className="inline-video-error">{error}</div>}

      {!loading && !error && playbackUrl && (
        <>
          <div className="inline-video-header">
            <div className="inline-video-header-left">
              <div className="inline-video-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <rect
                    x="3"
                    y="5"
                    width="14"
                    height="14"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path d="M10 9.5v5l4-2.5-4-2.5Z" fill="currentColor" />
                  <path d="m17 10 4-2v8l-4-2" stroke="currentColor" strokeWidth="2" />
                </svg>
              </div>
              <div className="inline-video-name-wrap">
                <div className="inline-video-filename" title={displayTitle}>
                  {displayTitle}
                </div>
                {subtitle && <div className="inline-video-subtitle">{subtitle}</div>}
              </div>
            </div>
            <div className="inline-video-header-actions">
              <button className="inline-video-action-btn" onClick={handleOpen} title="Open preview">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
            </div>
          </div>

          <div className="inline-video-player-wrap">
            <video
              key={playbackUrl}
              className="inline-video-player"
              src={playbackUrl}
              controls
              // blob: URLs hold data already in memory — "auto" is fine and speeds up first-frame.
              // For media-server URLs the full video must be fetched, so use "metadata" to avoid
              // eagerly downloading potentially large files.
              preload={playbackUrl?.startsWith("blob:") ? "auto" : "metadata"}
              playsInline
              muted={muted}
              loop={loop}
              poster={posterUrl || result?.posterDataUrl || undefined}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onLoadedMetadata={() => {
                setError((current) =>
                  current === "This video failed to load in the app preview." ? null : current,
                );
              }}
              onError={() => {
                setError("This video failed to load in the app preview.");
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
