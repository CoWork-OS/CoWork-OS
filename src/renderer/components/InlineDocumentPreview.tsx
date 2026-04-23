import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type InlineDocumentPreviewProps = {
  filePath: string;
  workspacePath: string;
  onOpenViewer?: (path: string) => void;
};

type SupportedDocumentType = "pdf" | "docx" | "markdown" | "latex" | "text" | "code";

const PREVIEW_MAX_CHARS = 1600;

const markdownComponents = {
  table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="markdown-table-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
};

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function isDocumentType(type: string): type is SupportedDocumentType {
  return type === "pdf" || type === "docx" || type === "markdown" || type === "latex" || type === "text" || type === "code";
}

function htmlToText(html: string): string {
  if (!html) return "";
  try {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    return parsed.body?.textContent || "";
  } catch {
    return html.replace(/<[^>]+>/g, " ");
  }
}

function getTypeLabel(type: SupportedDocumentType): string {
  switch (type) {
    case "pdf":
      return "PDF";
    case "docx":
      return "Word";
    case "markdown":
      return "Markdown";
    case "latex":
      return "LaTeX";
    case "code":
      return "Code";
    case "text":
    default:
      return "Text";
  }
}

function getPreviewText(data: {
  fileType: SupportedDocumentType;
  content: string | null;
  htmlContent?: string;
}): string {
  if (data.fileType === "docx") {
    return htmlToText(data.htmlContent || "");
  }
  return data.content || "";
}

export function InlineDocumentPreview({
  filePath,
  workspacePath,
  onOpenViewer,
}: InlineDocumentPreviewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileType, setFileType] = useState<SupportedDocumentType | null>(null);
  const [content, setContent] = useState("");
  const [size, setSize] = useState<number>(0);
  const [pdfThumbnailDataUrl, setPdfThumbnailDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      setFileName("");
      setFileType(null);
      setContent("");
      setSize(0);
      setPdfThumbnailDataUrl(null);

      try {
        const response = await window.electronAPI.readFileForViewer(filePath, workspacePath);
        if (cancelled) return;
        if (!response.success || !response.data) {
          setError(response.error || "Failed to load preview");
          return;
        }
        const docType = response.data.fileType;
        if (!isDocumentType(docType)) {
          setError("File type is not available for inline document preview.");
          return;
        }

        setFileName(response.data.fileName || filePath.split("/").pop() || filePath);
        setFileType(docType);
        setSize(typeof response.data.size === "number" ? response.data.size : 0);
        setPdfThumbnailDataUrl(
          typeof response.data.pdfThumbnailDataUrl === "string"
            ? response.data.pdfThumbnailDataUrl
            : null,
        );
        setContent(
          getPreviewText({
            fileType: docType,
            content: response.data.content,
            htmlContent: response.data.htmlContent,
          }).replace(/\r\n/g, "\n"),
        );
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load preview");
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

  const preview = useMemo(() => {
    const normalized = String(content || "").trim();
    if (!normalized) {
      return { text: "No previewable text extracted.", truncated: false };
    }
    if (normalized.length <= PREVIEW_MAX_CHARS) {
      return { text: normalized, truncated: false };
    }
    return {
      text: `${normalized.slice(0, PREVIEW_MAX_CHARS).trimEnd()}\n…`,
      truncated: true,
    };
  }, [content]);

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

  if (loading) {
    return (
      <div className="inline-document-preview">
        <div className="inline-document-loading">Loading document…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="inline-document-preview">
        <div className="inline-document-error">{error}</div>
      </div>
    );
  }

  if (!fileType) return null;

  const subtitle = [getTypeLabel(fileType), formatFileSize(size)].filter(Boolean).join(" • ");
  const hasPdfThumbnail = fileType === "pdf" && typeof pdfThumbnailDataUrl === "string";

  return (
    <div className="inline-document-preview">
      <div className="inline-document-header">
        <div className="inline-document-header-left">
          <div className={`inline-document-icon inline-document-icon-${fileType}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" />
              <line x1="9" y1="13" x2="17" y2="13" stroke="currentColor" strokeWidth="2" />
              <line x1="9" y1="17" x2="15" y2="17" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
          <div className="inline-document-name-wrap">
            <div className="inline-document-filename" title={fileName}>
              {fileName}
            </div>
            {subtitle && <div className="inline-document-subtitle">{subtitle}</div>}
          </div>
        </div>

        <div className="inline-document-header-actions">
          <button className="inline-document-action-btn" onClick={handleOpen} title="Open preview">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>
      </div>

      {hasPdfThumbnail ? (
        <button
          className="inline-document-thumbnail-button"
          type="button"
          onClick={handleOpen}
          title="Open PDF preview"
          aria-label="Open PDF preview"
        >
          <div className="inline-document-thumbnail-wrap">
            <img
              src={pdfThumbnailDataUrl || ""}
              alt={`${fileName} first page`}
              className="inline-document-thumbnail-image"
            />
          </div>
        </button>
      ) : fileType === "markdown" ? (
        <div className="inline-document-markdown markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{preview.text}</ReactMarkdown>
        </div>
      ) : (
        <pre className="inline-document-content">{preview.text}</pre>
      )}
      {!hasPdfThumbnail && preview.truncated && (
        <div className="inline-document-truncated">
          Showing first {PREVIEW_MAX_CHARS.toLocaleString()} characters
        </div>
      )}
    </div>
  );
}
