import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";
import { Download } from "lucide-react";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { FileViewerResult } from "../../electron/preload";

if (!hljs.getLanguage("typescript")) {
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("plaintext", plaintext);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("yaml", yaml);
}
import { useAgentContext } from "../hooks/useAgentContext";
import { createVideoObjectUrl } from "../utils/videoPlayback";
import { PDFDocumentSurface } from "./PDFDocumentSurface";
import { PresentationViewer } from "./PresentationViewer";
import { ThemeIcon } from "./ThemeIcon";
import {
  AlertTriangleIcon,
  ClipboardIcon,
  CodeIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  ImageIcon,
  PresentationIcon,
} from "./LineIcons";

type FileViewerData = NonNullable<FileViewerResult["data"]>;
type FileType = FileViewerData["fileType"];

interface FileViewerProps {
  filePath: string;
  workspacePath?: string;
  onClose: () => void;
}

const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
};

const EXT_LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  json: "json",
  jsonl: "json",
  geojson: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  html: "xml",
  htm: "xml",
  xml: "xml",
  css: "css",
  scss: "css",
  diff: "diff",
  tex: "plaintext",
};

const detectLanguage = (fileName: string): string => {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return EXT_LANG_MAP[ext] || "plaintext";
};

const safeHighlight = (code: string, language: string): string => {
  try {
    if (hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
  } catch {
    // fall through
  }
  // escape HTML for raw fallback
  return code.replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[c] as string);
};

// Minimal RFC 4180 parser supporting quoted fields with embedded commas/newlines
const parseDsv = (text: string, delimiter: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      if (ch === "\r" && text[i + 1] === "\n") i += 2;
      else i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
};

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const ALPHA_FORMATS = new Set(["png", "svg", "webp", "gif", "ico"]);

const hasAlphaChannel = (fileName: string): boolean => {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return ALPHA_FORMATS.has(ext);
};

interface JsonNodeProps {
  value: unknown;
  name?: string;
  depth: number;
  defaultOpen: boolean;
}

function JsonNode({ value, name, depth, defaultOpen }: JsonNodeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isObject = value !== null && typeof value === "object";
  const isArray = Array.isArray(value);
  const keyLabel = name !== undefined ? <span className="json-node-key">{JSON.stringify(name)}:</span> : null;

  if (!isObject) {
    let valueClass = "json-node-value";
    let display: string;
    if (typeof value === "string") {
      valueClass += " json-node-string";
      display = JSON.stringify(value);
    } else if (typeof value === "number") {
      valueClass += " json-node-number";
      display = String(value);
    } else if (typeof value === "boolean") {
      valueClass += " json-node-boolean";
      display = String(value);
    } else if (value === null) {
      valueClass += " json-node-null";
      display = "null";
    } else {
      display = String(value);
    }
    return (
      <div className="json-node json-node-leaf" style={{ paddingLeft: depth * 14 }}>
        {keyLabel}
        <span className={valueClass}>{display}</span>
      </div>
    );
  }

  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;
  const openBracket = isArray ? "[" : "{";
  const closeBracket = isArray ? "]" : "}";

  return (
    <div className="json-node">
      <div
        className="json-node-header"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen(!open)}
      >
        <span className="json-node-toggle">{open ? "▾" : "▸"}</span>
        {keyLabel}
        <span className="json-node-bracket">{openBracket}</span>
        {!open && <span className="json-node-summary">{summary}</span>}
        {!open && <span className="json-node-bracket">{closeBracket}</span>}
      </div>
      {open && (
        <>
          {entries.map(([k, v]) => (
            <JsonNode
              key={k}
              name={isArray ? undefined : k}
              value={v}
              depth={depth + 1}
              defaultOpen={depth < 1}
            />
          ))}
          <div className="json-node-bracket-close" style={{ paddingLeft: depth * 14 }}>
            {closeBracket}
          </div>
        </>
      )}
    </div>
  );
}

export function FileViewer({ filePath, workspacePath, onClose }: FileViewerProps) {
  const [loading, setLoading] = useState(true);
  const [fileData, setFileData] = useState<FileViewerData | null>(null);
  const [videoPlaybackUrl, setVideoPlaybackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [imageActualSize, setImageActualSize] = useState(false);
  const [audioDurationSec, setAudioDurationSec] = useState<number | null>(null);
  const [jsonRaw, setJsonRaw] = useState(false);
  const [copyFlash, setCopyFlash] = useState(false);
  const agentContext = useAgentContext();
  const copyTimerRef = useRef<number | null>(null);

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

  // Prepare video / audio playback URL
  useEffect(() => {
    const isMedia = fileData?.fileType === "video" || fileData?.fileType === "audio";
    const nextUrl = isMedia ? fileData?.playbackUrl : null;
    if (!nextUrl) {
      setVideoPlaybackUrl(null);
      return;
    }

    const resolvedUrl = createVideoObjectUrl(nextUrl);
    if (!resolvedUrl) {
      setVideoPlaybackUrl(null);
      setError("Failed to prepare media playback.");
      return;
    }

    setVideoPlaybackUrl(resolvedUrl);
    setError((current) => (current === "Failed to prepare media playback." ? null : current));

    return () => {
      if (resolvedUrl !== nextUrl) {
        URL.revokeObjectURL(resolvedUrl);
      }
    };
  }, [fileData]);

  // Decode image dimensions for the subtitle metadata
  useEffect(() => {
    if (fileData?.fileType !== "image" || !fileData.content) {
      setImageDimensions(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      if (cancelled) return;
      setImageDimensions(null);
    };
    img.src = fileData.content;
    return () => {
      cancelled = true;
    };
  }, [fileData]);

  // Reset per-format state when fileData changes
  useEffect(() => {
    setImageActualSize(false);
    setAudioDurationSec(null);
    setJsonRaw(false);
  }, [fileData?.fileType, fileData?.path]);

  // Cleanup copy-flash timer
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

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

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(filePath);
      setCopyFlash(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopyFlash(false), 1400);
    } catch (err) {
      console.error("Failed to copy path:", err);
    }
  };

  const getFileIcon = (type?: FileType): React.ReactNode => {
    switch (type) {
      case "markdown":
        return <ThemeIcon emoji="📝" icon={<FileTextIcon size={16} />} />;
      case "code":
      case "json":
        return <ThemeIcon emoji="💻" icon={<CodeIcon size={16} />} />;
      case "csv":
      case "xlsx":
        return <ThemeIcon emoji="📊" icon={<FileTextIcon size={16} />} />;
      case "text":
        return <ThemeIcon emoji="📄" icon={<FileIcon size={16} />} />;
      case "docx":
      case "document":
        return <ThemeIcon emoji="📘" icon={<FileTextIcon size={16} />} />;
      case "pdf":
        return <ThemeIcon emoji="📕" icon={<FileTextIcon size={16} />} />;
      case "latex":
        return <ThemeIcon emoji="📄" icon={<FileTextIcon size={16} />} />;
      case "image":
        return <ThemeIcon emoji="🖼️" icon={<ImageIcon size={16} />} />;
      case "video":
        return <ThemeIcon emoji="🎬" icon={<FileIcon size={16} />} />;
      case "audio":
        return <ThemeIcon emoji="🎵" icon={<FileIcon size={16} />} />;
      case "pptx":
        return <ThemeIcon emoji="📊" icon={<PresentationIcon size={16} />} />;
      case "html":
        return <ThemeIcon emoji="🌐" icon={<GlobeIcon size={16} />} />;
      default:
        return <ThemeIcon emoji="📁" icon={<FileIcon size={16} />} />;
    }
  };

  // Per-format subtitle (e.g. "PDF · 12 pages · 1.4 MB")
  const subtitle = useMemo<string>(() => {
    if (!fileData) return "";
    const sizeStr = formatSize(fileData.size);
    const parts: string[] = [];

    switch (fileData.fileType) {
      case "html":
        parts.push("HTML");
        if (sizeStr) parts.push(sizeStr);
        break;
      case "image": {
        const ext = fileData.fileName.split(".").pop()?.toUpperCase() || "Image";
        parts.push(ext);
        if (imageDimensions) parts.push(`${imageDimensions.width}×${imageDimensions.height}`);
        if (sizeStr) parts.push(sizeStr);
        break;
      }
      case "video":
        parts.push("Video");
        if (sizeStr) parts.push(sizeStr);
        break;
      case "audio": {
        parts.push("Audio");
        if (audioDurationSec) parts.push(formatDuration(audioDurationSec));
        if (sizeStr) parts.push(sizeStr);
        break;
      }
      case "pdf": {
        parts.push("PDF");
        const pages = fileData.pdfReviewSummary?.pageCount;
        if (pages) parts.push(`${pages} page${pages === 1 ? "" : "s"}`);
        if (sizeStr) parts.push(sizeStr);
        break;
      }
      case "pptx": {
        parts.push("PowerPoint");
        const slideCount = fileData.presentationPreview?.slideCount;
        if (slideCount) parts.push(`${slideCount} slide${slideCount === 1 ? "" : "s"}`);
        if (sizeStr) parts.push(sizeStr);
        break;
      }
      case "xlsx":
        parts.push("Spreadsheet");
        if (sizeStr) parts.push(sizeStr);
        break;
      case "csv": {
        const ext = fileData.fileName.toLowerCase().endsWith(".tsv") ? "TSV" : "CSV";
        parts.push(ext);
        const text = fileData.content || "";
        const rowCount = text ? text.split(/\r?\n/).filter((l) => l.length > 0).length : 0;
        if (rowCount) parts.push(`${rowCount} row${rowCount === 1 ? "" : "s"}`);
        if (sizeStr) parts.push(sizeStr);
        break;
      }
      case "json": {
        const ext = fileData.fileName.split(".").pop()?.toUpperCase() || "JSON";
        parts.push(ext);
        if (sizeStr) parts.push(sizeStr);
        break;
      }
      case "code": {
        const ext = fileData.fileName.split(".").pop()?.toLowerCase() || "code";
        parts.push(ext.toUpperCase());
        if (sizeStr) parts.push(sizeStr);
        break;
      }
      case "markdown":
        parts.push("Markdown");
        if (sizeStr) parts.push(sizeStr);
        break;
      case "latex":
        parts.push("LaTeX");
        if (sizeStr) parts.push(sizeStr);
        break;
      case "docx":
      case "document":
        parts.push("Word");
        if (fileData.documentPreview?.format) parts.push(fileData.documentPreview.format);
        if (sizeStr) parts.push(sizeStr);
        break;
      case "text":
      default:
        parts.push("Text");
        if (sizeStr) parts.push(sizeStr);
    }
    return parts.join(" · ");
  }, [fileData, imageDimensions, audioDurationSec]);

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
      case "latex": {
        const lang = fileData.fileType === "latex" ? "plaintext" : detectLanguage(fileData.fileName);
        const html = safeHighlight(fileData.content || "", lang);
        return (
          <div className="file-viewer-code-block">
            <pre className="file-viewer-code">
              <code className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
          </div>
        );
      }

      case "text":
        return <pre className="file-viewer-code">{fileData.content}</pre>;

      case "json": {
        const raw = fileData.content || "";
        if (jsonRaw) {
          const html = safeHighlight(raw, "json");
          return (
            <div className="file-viewer-code-block">
              <pre className="file-viewer-code">
                <code className="hljs language-json" dangerouslySetInnerHTML={{ __html: html }} />
              </pre>
            </div>
          );
        }
        const isJsonl = fileData.fileName.toLowerCase().endsWith(".jsonl");
        let parsed: unknown;
        let parseError: string | null = null;
        try {
          if (isJsonl) {
            parsed = raw
              .split(/\r?\n/)
              .filter((l) => l.trim().length > 0)
              .map((l) => JSON.parse(l));
          } else {
            parsed = JSON.parse(raw);
          }
        } catch (e) {
          parseError = e instanceof Error ? e.message : "Invalid JSON";
        }

        if (parseError) {
          const html = safeHighlight(raw, "json");
          return (
            <div className="file-viewer-code-block">
              <div className="file-viewer-json-warning">
                Failed to parse JSON ({parseError}). Showing raw content.
              </div>
              <pre className="file-viewer-code">
                <code className="hljs language-json" dangerouslySetInnerHTML={{ __html: html }} />
              </pre>
            </div>
          );
        }

        return (
          <div className="file-viewer-json-tree">
            <JsonNode value={parsed} depth={0} defaultOpen />
          </div>
        );
      }

      case "csv": {
        const isTsv = fileData.fileName.toLowerCase().endsWith(".tsv");
        const rows = parseDsv(fileData.content || "", isTsv ? "\t" : ",");
        if (rows.length === 0) {
          return <div className="file-viewer-placeholder">Empty file.</div>;
        }
        const [header, ...body] = rows;
        return (
          <div className="file-viewer-tabular">
            <div className="file-viewer-tabular-scroll">
              <table className="file-viewer-tabular-table">
                <thead>
                  <tr>
                    {header.map((cell, ci) => (
                      <th key={ci}>{cell}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.map((row, ri) => (
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
        );
      }

      case "docx":
      case "document": {
        const preview = fileData.documentPreview;
        if (preview?.previewMode === "unavailable") {
          return (
            <div className="file-viewer-placeholder">
              {preview.conversionMessage || "No in-app document preview is available."}
            </div>
          );
        }
        if (preview?.previewMode === "text") {
          return <pre className="file-viewer-code">{preview.text}</pre>;
        }
        return (
          <div
            className="file-viewer-docx"
            dangerouslySetInnerHTML={{ __html: preview?.htmlContent || fileData.htmlContent || "" }}
          />
        );
      }

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
          <div
            className="file-viewer-image-container"
            data-alpha={hasAlphaChannel(fileData.fileName) ? "true" : undefined}
            data-mode={imageActualSize ? "actual" : "fit"}
          >
            <img
              src={fileData.content || ""}
              alt={fileData.fileName}
              className="file-viewer-image"
            />
            {fileData.content && (
              <a
                className="file-viewer-image-download-button"
                href={fileData.content}
                download={fileData.fileName || "image.png"}
                title="Download image"
                aria-label={`Download ${fileData.fileName || "image"}`}
              >
                <Download size={18} strokeWidth={2.2} aria-hidden="true" />
              </a>
            )}
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

      case "audio":
        return (
          <div className="file-viewer-audio-container">
            <div className="file-viewer-audio-icon">
              <ThemeIcon emoji="🎵" icon={<FileIcon size={36} />} />
            </div>
            <div className="file-viewer-audio-name">{fileData.fileName}</div>
            <audio
              key={videoPlaybackUrl || fileData.playbackUrl || ""}
              src={videoPlaybackUrl || ""}
              className="file-viewer-audio"
              controls
              preload="metadata"
              onLoadedMetadata={(e) => {
                const target = e.currentTarget;
                if (Number.isFinite(target.duration)) {
                  setAudioDurationSec(target.duration);
                }
              }}
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
          <div className="file-viewer-tabular">
            {sheets.map((sheet, si) => (
              <div key={si} className="file-viewer-tabular-sheet">
                {sheets.length > 1 && (
                  <h3 className="file-viewer-tabular-sheet-name">{sheet.name}</h3>
                )}
                <div className="file-viewer-tabular-scroll">
                  <table className="file-viewer-tabular-table">
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

  const fileType = fileData?.fileType;
  const showImageFitToggle = fileType === "image";
  const showJsonRawToggle = fileType === "json";

  return createPortal(
    <div className="file-viewer-overlay" onClick={onClose}>
      <div
        className="file-viewer-modal"
        data-format={fileType || "loading"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="file-viewer-header">
          <div className="file-viewer-title">
            <span className="file-viewer-icon">{getFileIcon(fileType)}</span>
            <div className="file-viewer-name-wrap">
              <span className="file-viewer-filename" title={fileData?.fileName}>
                {fileData?.fileName || filePath.split("/").pop()}
              </span>
              {subtitle && <span className="file-viewer-subtitle">{subtitle}</span>}
            </div>
          </div>
          <div className="file-viewer-actions">
            {showImageFitToggle && (
              <button
                className="file-viewer-action-btn"
                onClick={() => setImageActualSize((v) => !v)}
                title={imageActualSize ? "Fit to window" : "Actual size"}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  {imageActualSize ? (
                    <>
                      <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" strokeLinecap="round" />
                    </>
                  ) : (
                    <>
                      <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" strokeLinecap="round" />
                    </>
                  )}
                </svg>
              </button>
            )}
            {showJsonRawToggle && (
              <button
                className={`file-viewer-action-btn ${jsonRaw ? "is-active" : ""}`}
                onClick={() => setJsonRaw((v) => !v)}
                title={jsonRaw ? "Show as tree" : "Show raw"}
              >
                <span className="file-viewer-action-text">{jsonRaw ? "Tree" : "Raw"}</span>
              </button>
            )}
            <button
              className="file-viewer-action-btn"
              onClick={handleCopyPath}
              title={copyFlash ? "Copied!" : "Copy file path"}
            >
              {copyFlash ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 8l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <ClipboardIcon size={16} />
              )}
            </button>
            <button
              className="file-viewer-action-btn"
              onClick={handleShowInFinder}
              title="Show in Finder"
            >
              <FolderIcon size={16} />
            </button>
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
              <div className="file-viewer-error-actions">
                <button onClick={handleShowInFinder} className="file-viewer-open-btn file-viewer-open-btn-secondary">
                  Show in Finder
                </button>
                <button onClick={handleOpenExternal} className="file-viewer-open-btn">
                  Open with Default App
                </button>
              </div>
            </div>
          )}

          {!loading && !error && renderContent()}
        </div>
      </div>
    </div>,
    document.body,
  );
}
