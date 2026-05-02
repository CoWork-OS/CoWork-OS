import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import type { FileViewerResult } from "../../electron/preload";

type InlineImagePreviewProps = {
  filePath: string;
  workspacePath: string;
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

export function InlineImagePreview({
  filePath,
  workspacePath,
  onOpenViewer,
}: InlineImagePreviewProps) {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<FileViewerResult["data"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  const meta = useMemo(() => {
    if (!result) return "";
    const size = typeof result.size === "number" ? formatFileSize(result.size) : "";
    const dims = dimensions ? `${dimensions.width}x${dimensions.height}` : "";
    return [dims, size].filter(Boolean).join(" • ");
  }, [result, dimensions]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      setResult(null);
      setDimensions(null);

      try {
        const response = await window.electronAPI.readFileForViewer(filePath, workspacePath);
        if (cancelled) return;
        if (!response.success || !response.data) {
          setError(response.error || "Failed to load image preview");
          return;
        }
        if (response.data.fileType !== "image" || !response.data.content) {
          setError("File is not an image or cannot be previewed.");
          return;
        }
        setResult(response.data);
      } catch (e: Any) {
        if (cancelled) return;
        setError(e?.message || "Failed to load image preview");
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
      console.error("Failed to open file:", e);
    }
  };

  return (
    <div className="inline-image-preview">
      {loading && <div className="inline-image-preview-loading">Loading image…</div>}

      {!loading && error && <div className="inline-image-preview-error">{error}</div>}

      {!loading && !error && result?.content && (
        <>
          <div className="inline-image-preview-frame">
            <button
              className="inline-image-preview-button"
              type="button"
              onClick={handleOpen}
              title="Click to preview"
              aria-label="Open image preview"
            >
              <img
                src={result.content}
                alt={result.fileName}
                className="inline-image-preview-image"
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img?.naturalWidth && img?.naturalHeight) {
                    setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
                  }
                }}
              />
            </button>
            <a
              className="inline-image-preview-download-button"
              href={result.content}
              download={result.fileName || "image.png"}
              title="Download image"
              aria-label={`Download ${result.fileName || "image"}`}
              onClick={(event) => event.stopPropagation()}
            >
              <Download size={17} strokeWidth={2.2} aria-hidden="true" />
            </a>
          </div>
          {meta && <div className="inline-image-preview-meta">{meta}</div>}
        </>
      )}
    </div>
  );
}
