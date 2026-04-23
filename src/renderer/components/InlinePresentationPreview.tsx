import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Presentation } from "lucide-react";
import type { FileViewerResult } from "../../electron/preload";

type InlinePresentationPreviewProps = {
  filePath: string;
  workspacePath: string;
  onOpenViewer?: (path: string) => void;
};

type PresentationPreview = NonNullable<
  NonNullable<FileViewerResult["data"]>["presentationPreview"]
>;

const PREVIEW_TEXT_MAX = 420;

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function getFirstMeaningfulSlide(preview: PresentationPreview | null) {
  if (!preview) return null;
  return (
    preview.slides.find((slide) => slide.imageDataUrl) ||
    preview.slides.find((slide) => slide.text.trim().length > 0) ||
    preview.slides[0] ||
    null
  );
}

export function InlinePresentationPreview({
  filePath,
  workspacePath,
  onOpenViewer,
}: InlinePresentationPreviewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [size, setSize] = useState(0);
  const [preview, setPreview] = useState<PresentationPreview | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      setFileName("");
      setSize(0);
      setPreview(null);

      try {
        const response = await window.electronAPI.readFileForViewer(filePath, workspacePath);
        if (cancelled) return;
        if (!response.success || !response.data) {
          setError(response.error || "Failed to load presentation");
          return;
        }
        if (response.data.fileType !== "pptx" || !response.data.presentationPreview) {
          setError("Presentation preview is not available.");
          return;
        }
        setFileName(response.data.fileName || filePath.split("/").pop() || filePath);
        setSize(response.data.size);
        setPreview(response.data.presentationPreview);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load presentation");
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

  const firstSlide = useMemo(() => getFirstMeaningfulSlide(preview), [preview]);
  const previewText = useMemo(() => {
    const text = firstSlide?.text.trim() || "No extractable slide text.";
    if (text.length <= PREVIEW_TEXT_MAX) return text;
    return `${text.slice(0, PREVIEW_TEXT_MAX).trimEnd()}\n...`;
  }, [firstSlide]);

  const handleOpen = () => {
    if (onOpenViewer) {
      onOpenViewer(filePath);
    }
  };

  if (loading) {
    return (
      <div className="inline-presentation-preview">
        <div className="inline-presentation-loading">Loading presentation...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="inline-presentation-preview">
        <div className="inline-presentation-error">{error}</div>
      </div>
    );
  }

  if (!preview || !firstSlide) return null;

  const subtitle = [
    `${preview.slideCount} slide${preview.slideCount === 1 ? "" : "s"}`,
    formatFileSize(size),
    preview.renderStatus === "rendered" ? "Preview rendered" : "Text preview",
  ]
    .filter(Boolean)
    .join(" • ");

  return (
    <div
      className="inline-presentation-preview"
      onClick={handleOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleOpen();
        }
      }}
      role="button"
      tabIndex={0}
      title="Open presentation preview"
    >
      <div className="inline-presentation-header">
        <div className="inline-presentation-header-left">
          <span className="inline-presentation-icon">
            <Presentation size={16} />
          </span>
          <span className="inline-presentation-name-wrap">
            <span className="inline-presentation-filename">{fileName}</span>
            <span className="inline-presentation-subtitle">{subtitle}</span>
          </span>
        </div>
        <ExternalLink size={16} />
      </div>
      <div className="inline-presentation-body">
        {firstSlide.imageDataUrl ? (
          <img src={firstSlide.imageDataUrl} alt={`Slide ${firstSlide.index}`} />
        ) : (
          <pre>{previewText}</pre>
        )}
      </div>
    </div>
  );
}
