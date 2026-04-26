import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type MarkdownImagePreviewProps = {
  src?: string;
  alt?: string;
  title?: string;
  workspacePath?: string;
};

const REMOTE_IMAGE_RE = /^https?:\/\//i;
const DATA_IMAGE_RE = /^data:image\//i;

function normalizeFileSrc(src: string): string {
  if (src.startsWith("file://")) {
    const rawPath = src.replace(/^file:\/\//, "");
    try {
      return decodeURIComponent(rawPath).replace(/^\/([a-zA-Z]:\/)/, "$1").split(/[?#]/)[0];
    } catch {
      return rawPath.replace(/^\/([a-zA-Z]:\/)/, "$1").split(/[?#]/)[0];
    }
  }
  return src.split(/[?#]/)[0];
}

function isLocalImageSrc(src: string): boolean {
  if (!src || src.startsWith("#")) return false;
  if (DATA_IMAGE_RE.test(src) || REMOTE_IMAGE_RE.test(src)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) && !src.startsWith("file://")) return false;
  return true;
}

export function MarkdownImagePreview({
  src = "",
  alt = "",
  title,
  workspacePath,
}: MarkdownImagePreviewProps) {
  const trimmedSrc = src.trim();
  const localPath = useMemo(
    () => (isLocalImageSrc(trimmedSrc) ? normalizeFileSrc(trimmedSrc) : null),
    [trimmedSrc],
  );
  const [displaySrc, setDisplaySrc] = useState(
    DATA_IMAGE_RE.test(trimmedSrc) || REMOTE_IMAGE_RE.test(trimmedSrc) ? trimmedSrc : "",
  );
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(Boolean(localPath && workspacePath));
  const [error, setError] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (!localPath || !workspacePath) {
      setDisplaySrc(DATA_IMAGE_RE.test(trimmedSrc) || REMOTE_IMAGE_RE.test(trimmedSrc) ? trimmedSrc : "");
      setLoading(false);
      setError(localPath ? "Image preview needs an active workspace." : "");
      setFileName("");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError("");
    setDisplaySrc("");
    setFileName("");

    window.electronAPI
      .readFileForViewer(localPath, workspacePath)
      .then((response) => {
        if (cancelled) return;
        if (!response.success || !response.data?.content || response.data.fileType !== "image") {
          setError(response.error || "Image preview unavailable.");
          return;
        }
        setDisplaySrc(response.data.content);
        setFileName(response.data.fileName || "");
      })
      .catch((err: Any) => {
        if (!cancelled) setError(err?.message || "Image preview unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [localPath, trimmedSrc, workspacePath]);

  useEffect(() => {
    if (!isExpanded) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsExpanded(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isExpanded]);

  const label = title || alt || fileName || localPath || "Image";

  if (!trimmedSrc) return null;

  return (
    <>
      <span className="markdown-image-preview">
        {loading && <span className="markdown-image-preview-placeholder">Loading image...</span>}
        {!loading && error && <span className="markdown-image-preview-error">{error}</span>}
        {!loading && !error && displaySrc && (
          <button
            type="button"
            className="markdown-image-preview-button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsExpanded(true);
            }}
            title="Open larger preview"
            aria-label={`Open larger preview for ${label}`}
          >
            <img
              src={displaySrc}
              alt={alt || label}
              className="markdown-image-preview-img"
              loading="lazy"
            />
          </button>
        )}
      </span>

      {isExpanded &&
        displaySrc &&
        createPortal(
          <div
            className="markdown-image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={label}
            onClick={() => setIsExpanded(false)}
          >
            <div
              className="markdown-image-lightbox-content"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="markdown-image-lightbox-close"
                onClick={() => setIsExpanded(false)}
                aria-label="Close image preview"
                title="Close"
              >
                x
              </button>
              <img src={displaySrc} alt={alt || label} className="markdown-image-lightbox-img" />
              {label && <div className="markdown-image-lightbox-caption">{label}</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
