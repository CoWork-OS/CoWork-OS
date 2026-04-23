import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileViewerResult } from "../../electron/preload";
import { useAgentContext } from "../hooks/useAgentContext";
import { createVideoObjectUrl } from "../utils/videoPlayback";
import { PDFDocumentSurface } from "./PDFDocumentSurface";
import { PresentationViewer } from "./PresentationViewer";
import { ThemeIcon } from "./ThemeIcon";
import {
  AlertTriangleIcon,
  CodeIcon,
  FileIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  PresentationIcon,
} from "./LineIcons";

interface FileViewerProps {
  filePath: string;
  workspacePath?: string;
  onClose: () => void;
}

export function FileViewer({ filePath, workspacePath, onClose }: FileViewerProps) {
  const [loading, setLoading] = useState(true);
  const [fileData, setFileData] = useState<FileViewerResult["data"] | null>(null);
  const [videoPlaybackUrl, setVideoPlaybackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agentContext = useAgentContext();

  // Load file on mount
  useEffect(() => {
    const loadFile = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await window.electronAPI.readFileForViewer(filePath, workspacePath, {
          includePdfBase64: true,
        });
        if (result.success && result.data) {
          setFileData(result.data);
        } else {
          setError(result.error || "Failed to load file");
        }
      } catch (err: Any) {
        setError(err.message || "Failed to load file");
      } finally {
        setLoading(false);
      }
    };
    loadFile();
  }, [filePath, workspacePath]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const nextUrl = fileData?.fileType === "video" ? fileData.playbackUrl : null;
    if (!nextUrl) {
      setVideoPlaybackUrl(null);
      return;
    }

    const resolvedUrl = createVideoObjectUrl(nextUrl);
    if (!resolvedUrl) {
      setVideoPlaybackUrl(null);
      setError("Failed to prepare video playback.");
      return;
    }

    setVideoPlaybackUrl(resolvedUrl);
    setError((current) => (current === "Failed to prepare video playback." ? null : current));

    return () => {
      if (resolvedUrl !== nextUrl) {
        URL.revokeObjectURL(resolvedUrl);
      }
    };
  }, [fileData]);

  // Open in external app
  const handleOpenExternal = async () => {
    try {
      await window.electronAPI.openFile(filePath, workspacePath);
    } catch (err) {
      console.error("Failed to open file externally:", err);
    }
  };

  const handleShowInFinder = async () => {
    try {
      await window.electronAPI.showInFinder(filePath, workspacePath);
    } catch (err) {
      console.error("Failed to show file:", err);
    }
  };

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Get file icon based on type
  const getFileIcon = (type?: string): React.ReactNode => {
    switch (type) {
      case "markdown":
        return <ThemeIcon emoji="📝" icon={<FileTextIcon size={16} />} />;
      case "code":
        return <ThemeIcon emoji="💻" icon={<CodeIcon size={16} />} />;
      case "text":
        return <ThemeIcon emoji="📄" icon={<FileIcon size={16} />} />;
      case "docx":
        return <ThemeIcon emoji="📘" icon={<FileTextIcon size={16} />} />;
      case "pdf":
        return <ThemeIcon emoji="📕" icon={<FileTextIcon size={16} />} />;
      case "latex":
        return <ThemeIcon emoji="📄" icon={<FileTextIcon size={16} />} />;
      case "image":
        return <ThemeIcon emoji="🖼️" icon={<ImageIcon size={16} />} />;
      case "video":
        return <ThemeIcon emoji="🎬" icon={<FileIcon size={16} />} />;
      case "pptx":
        return <ThemeIcon emoji="📊" icon={<PresentationIcon size={16} />} />;
      case "xlsx":
        return <ThemeIcon emoji="📊" icon={<FileTextIcon size={16} />} />;
      case "html":
        return <ThemeIcon emoji="🌐" icon={<GlobeIcon size={16} />} />;
      default:
        return <ThemeIcon emoji="📁" icon={<FileIcon size={16} />} />;
    }
  };

  // Render content based on file type
  const renderContent = () => {
    if (!fileData) return null;

    switch (fileData.fileType) {
      case "markdown":
        return (
          <div className="file-viewer-markdown markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileData.content || ""}</ReactMarkdown>
          </div>
        );

      case "code":
      case "latex":
      case "text":
        return <pre className="file-viewer-code">{fileData.content}</pre>;

      case "docx":
        return (
          <div
            className="file-viewer-docx"
            dangerouslySetInnerHTML={{ __html: fileData.htmlContent || "" }}
          />
        );

      case "html":
        return (
          <iframe
            className="file-viewer-html"
            srcDoc={fileData.htmlContent || ""}
            sandbox="allow-scripts allow-same-origin"
            title={fileData.fileName}
          />
        );

      case "pdf":
        return (
          <div className="file-viewer-pdf">
            {fileData.pdfReviewSummary && (
              <div className="file-viewer-pdf-summary">
                <div className="file-viewer-pdf-summary-row">
                  <span>Pages</span>
                  <strong>{fileData.pdfReviewSummary.pageCount}</strong>
                </div>
                <div className="file-viewer-pdf-summary-row">
                  <span>Native text</span>
                  <strong>{fileData.pdfReviewSummary.nativeTextPages}</strong>
                </div>
                <div className="file-viewer-pdf-summary-row">
                  <span>OCR</span>
                  <strong>{fileData.pdfReviewSummary.ocrPages}</strong>
                </div>
                {fileData.pdfReviewSummary.extractionMode && (
                  <div className="file-viewer-pdf-summary-row">
                    <span>Mode</span>
                    <strong>{fileData.pdfReviewSummary.extractionMode}</strong>
                  </div>
                )}
                {fileData.pdfReviewSummary.truncatedPages && (
                  <div className="file-viewer-pdf-summary-note">
                    Preview limited to the first extracted pages.
                  </div>
                )}
                {fileData.pdfReviewSummary.imageHeavy && (
                  <div className="file-viewer-pdf-summary-note">
                    Image-heavy PDF detected. OCR-first extraction was used when available.
                  </div>
                )}
              </div>
            )}
            {fileData.pdfDataBase64 ? (
              <PDFDocumentSurface
                fileName={fileData.fileName}
                pdfDataBase64={fileData.pdfDataBase64}
                selection={null}
                onSelectionChange={() => {}}
                readOnly
              />
            ) : (
              <>
                {fileData.pdfThumbnailDataUrl && (
                  <div className="file-viewer-pdf-thumbnail">
                    <img
                      src={fileData.pdfThumbnailDataUrl}
                      alt={`${fileData.fileName} first page`}
                    />
                  </div>
                )}
                <pre className="file-viewer-code">{fileData.content}</pre>
              </>
            )}
          </div>
        );

      case "image":
        return (
          <div className="file-viewer-image-container">
            <img
              src={fileData.content || ""}
              alt={fileData.fileName}
              className="file-viewer-image"
            />
          </div>
        );

      case "video":
        return (
          <div className="file-viewer-video-container">
            <video
              key={videoPlaybackUrl || fileData.playbackUrl || ""}
              src={videoPlaybackUrl || ""}
              className="file-viewer-video"
              controls
              preload="auto"
              playsInline
              poster={fileData.posterDataUrl}
            />
          </div>
        );

      case "pptx":
        if (fileData.presentationPreview) {
          return (
            <PresentationViewer
              fileName={fileData.fileName}
              sizeLabel={formatSize(fileData.size)}
              preview={fileData.presentationPreview}
              onOpenExternal={handleOpenExternal}
              onShowInFinder={handleShowInFinder}
            />
          );
        }
        return (
          <div className="file-viewer-placeholder">
            <span className="file-viewer-placeholder-icon">
              <ThemeIcon emoji="📊" icon={<PresentationIcon size={28} />} />
            </span>
            <p>PowerPoint preview is not available.</p>
            <button onClick={handleOpenExternal} className="file-viewer-open-btn">
              Open in PowerPoint
            </button>
          </div>
        );

      case "xlsx": {
        // Parse tab-separated content produced by the backend:
        // Sheets separated by "\n\n", each starting with "## Sheet: <name>"
        const sheets = (fileData.content || "").split("\n\n").map((block) => {
          const lines = block.split("\n");
          let name = "Sheet";
          let dataLines = lines;
          if (lines[0]?.startsWith("## Sheet: ")) {
            name = lines[0].replace("## Sheet: ", "");
            dataLines = lines.slice(1);
          }
          const rows = dataLines.map((line) => line.split("\t"));
          return { name, rows };
        });

        return (
          <div className="file-viewer-xlsx">
            {sheets.map((sheet, si) => (
              <div key={si} className="file-viewer-xlsx-sheet">
                {sheets.length > 1 && <h3 className="file-viewer-xlsx-sheet-name">{sheet.name}</h3>}
                <div className="file-viewer-xlsx-scroll">
                  <table className="file-viewer-xlsx-table">
                    {sheet.rows.length > 0 && (
                      <thead>
                        <tr>
                          {sheet.rows[0].map((cell, ci) => (
                            <th key={ci}>{cell}</th>
                          ))}
                        </tr>
                      </thead>
                    )}
                    <tbody>
                      {sheet.rows.slice(1).map((row, ri) => (
                        <tr key={ri}>
                          {row.map((cell, ci) => (
                            <td key={ci}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        );
      }

      default:
        return (
          <div className="file-viewer-placeholder">
            <span className="file-viewer-placeholder-icon">
              <ThemeIcon emoji="📁" icon={<FileIcon size={28} />} />
            </span>
            <p>This file type cannot be previewed.</p>
            <button onClick={handleOpenExternal} className="file-viewer-open-btn">
              Open with Default App
            </button>
          </div>
        );
    }
  };

  // Use portal to render at document body level (escapes parent container constraints)
  return createPortal(
    <div className="file-viewer-overlay" onClick={onClose}>
      <div
        className={`file-viewer-modal ${fileData?.fileType === "pptx" ? "file-viewer-modal-presentation" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="file-viewer-header">
          <div className="file-viewer-title">
            <span className="file-viewer-icon">{getFileIcon(fileData?.fileType)}</span>
            <span className="file-viewer-filename">
              {fileData?.fileName || filePath.split("/").pop()}
            </span>
            {fileData && <span className="file-viewer-size">{formatSize(fileData.size)}</span>}
          </div>
          <div className="file-viewer-actions">
            <button
              className="file-viewer-action-btn"
              onClick={handleOpenExternal}
              title="Open in external app"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5z" />
                <path d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0v-5z" />
              </svg>
            </button>
            <button
              className="file-viewer-action-btn file-viewer-close-btn"
              onClick={onClose}
              title="Close (Esc)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="file-viewer-content">
          {loading && (
            <div className="file-viewer-loading">
              <div className="file-viewer-spinner"></div>
              <span>{agentContext.getUiCopy("fileLoading")}</span>
            </div>
          )}

          {error && (
            <div className="file-viewer-error">
              <span className="file-viewer-error-icon">
                <ThemeIcon emoji="⚠️" icon={<AlertTriangleIcon size={18} />} />
              </span>
              <p>{error}</p>
              <button onClick={handleOpenExternal} className="file-viewer-open-btn">
                Try Opening with Default App
              </button>
            </div>
          )}

          {!loading && !error && renderContent()}
        </div>
      </div>
    </div>,
    document.body,
  );
}
