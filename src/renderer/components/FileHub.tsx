import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  FolderOpen,
  File,
  Search,
  Clock,
  HardDrive,
  Cloud,
  Download,
  FileSpreadsheet,
  FileText,
  Image,
  Code,
  Archive,
  ChevronRight,
  X,
} from "lucide-react";
import { hasHostMethod } from "../host/browser-capabilities";
import { triggerBrowserBlobDownload } from "../host/browser-download";
import { DocumentAwareFileModal } from "./DocumentAwareFileModal";
import {
  createBrowserFileHubAdapter,
  type BrowserFileHubApi,
  type FileHubEntry,
} from "./file-hub-browser";

interface UnifiedFile {
  id: string;
  name: string;
  path: string;
  source: string;
  mimeType: string;
  size: number;
  modifiedAt: number;
  isDirectory?: boolean;
  metadata?: Record<string, unknown>;
}

const SOURCE_TABS = [
  { key: "local", label: "Local", icon: HardDrive },
  { key: "artifacts", label: "Artifacts", icon: Archive },
  { key: "google_drive", label: "Drive", icon: Cloud },
  { key: "onedrive", label: "OneDrive", icon: Cloud },
  { key: "dropbox", label: "Dropbox", icon: Cloud },
];

function getFileIcon(mimeType: string, isDir?: boolean) {
  if (isDir) return <FolderOpen size={16} style={{ color: "#f59e0b" }} />;
  if (mimeType.startsWith("image/")) return <Image size={16} style={{ color: "#8b5cf6" }} />;
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel"))
    return <FileSpreadsheet size={16} style={{ color: "#22c55e" }} />;
  if (
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    mimeType.includes("python") ||
    mimeType.includes("json")
  )
    return <Code size={16} style={{ color: "#3b82f6" }} />;
  if (mimeType.includes("text") || mimeType.includes("markdown"))
    return <FileText size={16} style={{ color: "#6b7280" }} />;
  return <File size={16} style={{ color: "var(--text-tertiary, #666)" }} />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

export const FileHub: React.FC<{ workspaceId?: string }> = (props) => {
  if (typeof window !== "undefined" && window.coworkBrowserHost === true) {
    return <BrowserFileHub workspaceId={props.workspaceId} />;
  }
  return <DesktopFileHub />;
};

function DesktopFileHub() {
  const [activeSource, setActiveSource] = useState("local");
  const [files, setFiles] = useState<UnifiedFile[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentFiles, setRecentFiles] = useState<UnifiedFile[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  const [availableSources, setAvailableSources] = useState<string[]>(["local", "artifacts"]);
  const [viewerFilePath, setViewerFilePath] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    try {
      if (searchQuery.trim()) {
        const results = await (window as Any).electronAPI.searchHubFiles(searchQuery, [
          activeSource,
        ]);
        setFiles((results || []).map((r: Any) => r.file));
      } else {
        const result = await (window as Any).electronAPI.listHubFiles({ source: activeSource });
        setFiles(result || []);
      }
    } catch {
      setFiles([]);
    }
  }, [activeSource, searchQuery]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    (async () => {
      try {
        const sources = await (window as Any).electronAPI.getHubSources();
        setAvailableSources(sources || ["local", "artifacts"]);
        const recent = await (window as Any).electronAPI.getRecentHubFiles(10);
        setRecentFiles(recent || []);
      } catch {
        // API not available yet
      }
    })();
  }, []);

  const handleFileClick = (file: UnifiedFile) => {
    if (file.isDirectory) {
      // Navigate into directory
      return;
    }
    setViewerFilePath(file.path);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Search bar */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color, #333)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid var(--border-color, #333)",
            background: "var(--surface-secondary, #1a1a1a)",
          }}
        >
          <Search size={14} style={{ color: "var(--text-tertiary, #666)", flexShrink: 0 }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search files across all sources..."
            style={{
              flex: 1,
              border: "none",
              background: "none",
              color: "var(--text-primary, #e5e5e5)",
              fontSize: 13,
              outline: "none",
            }}
          />
        </div>
      </div>

      {/* Source tabs */}
      <div
        style={{
          display: "flex",
          gap: 2,
          padding: "8px 16px",
          borderBottom: "1px solid var(--border-color, #333)",
          overflowX: "auto",
        }}
      >
        <button
          onClick={() => setShowRecent(!showRecent)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 10px",
            borderRadius: 4,
            border: "none",
            background: showRecent ? "var(--accent-bg, #2563eb22)" : "none",
            color: showRecent ? "var(--accent-color, #60a5fa)" : "var(--text-secondary, #999)",
            cursor: "pointer",
            fontSize: 12,
            whiteSpace: "nowrap",
          }}
        >
          <Clock size={12} /> Recent
        </button>
        {SOURCE_TABS.filter((t) => availableSources.includes(t.key)).map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              setActiveSource(tab.key);
              setShowRecent(false);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 10px",
              borderRadius: 4,
              border: "none",
              background:
                activeSource === tab.key && !showRecent ? "var(--accent-bg, #2563eb22)" : "none",
              color:
                activeSource === tab.key && !showRecent
                  ? "var(--accent-color, #60a5fa)"
                  : "var(--text-secondary, #999)",
              cursor: "pointer",
              fontSize: 12,
              whiteSpace: "nowrap",
            }}
          >
            <tab.icon size={12} /> {tab.label}
          </button>
        ))}
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {(showRecent ? recentFiles : files).length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: 32,
              color: "var(--text-tertiary, #666)",
              fontSize: 13,
            }}
          >
            {searchQuery ? "No files match your search" : "No files found"}
          </div>
        ) : (
          (showRecent ? recentFiles : files).map((file) => (
            <div
              key={file.id}
              onClick={() => handleFileClick(file)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 16px",
                cursor: "pointer",
                borderBottom: "1px solid var(--border-color, #1a1a1a)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background =
                  "var(--surface-secondary, #1a1a1a)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "";
              }}
            >
              {getFileIcon(file.mimeType, file.isDirectory)}

              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--text-primary, #e5e5e5)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {file.name}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary, #666)" }}>
                  {file.source !== "local" && (
                    <span style={{ marginRight: 8 }}>{file.source.replace("_", " ")}</span>
                  )}
                  {!file.isDirectory && formatSize(file.size)}
                </div>
              </div>

              <div style={{ fontSize: 11, color: "var(--text-tertiary, #666)", flexShrink: 0 }}>
                {formatDate(file.modifiedAt)}
              </div>
            </div>
          ))
        )}
      </div>
      {viewerFilePath && (
        <DocumentAwareFileModal filePath={viewerFilePath} onClose={() => setViewerFilePath(null)} />
      )}
    </div>
  );
}

type BrowserPreview = { name: string; mimeType: string; blob: Blob };

function BrowserFileHub({ workspaceId }: { workspaceId?: string }) {
  const browserWorkspaceId =
    workspaceId ||
    (typeof window !== "undefined" ? window.coworkBrowserHostInfo?.activeWorkspaceId : null) ||
    "";
  const adapter = useMemo(() => {
    const api = (window as unknown as { electronAPI: BrowserFileHubApi }).electronAPI;
    return createBrowserFileHubAdapter(api);
  }, []);
  const canReadWorkspaceFiles = hasHostMethod("listBrowserWorkspaceFiles");
  const canReadArtifacts = hasHostMethod("listBrowserTaskArtifacts");
  const [activeSource, setActiveSource] = useState<"local" | "artifacts">("local");
  const [currentPath, setCurrentPath] = useState("");
  const [files, setFiles] = useState<FileHubEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentFiles, setRecentFiles] = useState<FileHubEntry[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BrowserPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const loadRequestSeqRef = useRef(0);
  const previewRequestSeqRef = useRef(0);
  const workspaceIdRef = useRef(browserWorkspaceId);
  workspaceIdRef.current = browserWorkspaceId;

  const loadFiles = useCallback(async () => {
    const requestId = ++loadRequestSeqRef.current;
    if (!browserWorkspaceId) {
      setFiles([]);
      setError("Choose a workspace to browse its files and task artifacts.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setTruncated(false);
    try {
      const workspace = await adapter.resolveWorkspace(browserWorkspaceId);
      let result: { entries: FileHubEntry[]; truncated: boolean };
      if (activeSource === "artifacts") {
        result = await adapter.listWorkspaceArtifacts(browserWorkspaceId);
        if (searchQuery.trim()) {
          const normalized = searchQuery.trim().toLocaleLowerCase();
          result = {
            ...result,
            entries: result.entries.filter((entry) =>
              entry.name.toLocaleLowerCase().includes(normalized),
            ),
          };
        }
      } else if (searchQuery.trim()) {
        result = await adapter.searchWorkspaceFiles(browserWorkspaceId, searchQuery, currentPath);
      } else {
        result = await adapter.listWorkspaceDirectory(browserWorkspaceId, currentPath);
      }
      if (requestId !== loadRequestSeqRef.current) return;
      setWorkspaceName(workspace.name);
      setFiles(result.entries);
      setTruncated(result.truncated);
    } catch (loadError) {
      if (requestId !== loadRequestSeqRef.current) return;
      setFiles([]);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "The browser Library could not load files.",
      );
    } finally {
      if (requestId === loadRequestSeqRef.current) setLoading(false);
    }
  }, [adapter, activeSource, browserWorkspaceId, currentPath, searchQuery]);

  useEffect(() => {
    previewRequestSeqRef.current += 1;
    setCurrentPath("");
    setShowRecent(false);
    setRecentFiles([]);
    setPreview(null);
    setPreviewError(null);
  }, [browserWorkspaceId]);

  useEffect(() => {
    if (showRecent) {
      loadRequestSeqRef.current += 1;
      setLoading(false);
      return;
    }
    void loadFiles();
  }, [loadFiles, showRecent]);

  const remember = (entry: FileHubEntry) => {
    setRecentFiles((previous) =>
      [entry, ...previous.filter((item) => item.id !== entry.id)].slice(0, 10),
    );
  };

  const downloadEntry = async (entry: FileHubEntry) => {
    try {
      let blob: Blob;
      let fileName = entry.name;
      if (entry.source === "artifacts") {
        const result = await adapter.downloadArtifact(
          String(entry.metadata?.artifactId || entry.path),
        );
        blob = result.blob;
        fileName = result.fileName || entry.name;
      } else {
        blob = await adapter.downloadWorkspaceFile(browserWorkspaceId, entry.path);
      }
      triggerBlobDownload(blob, fileName);
      remember(entry);
    } catch (downloadFailure) {
      setError(
        downloadFailure instanceof Error
          ? downloadFailure.message
          : "This file could not be downloaded.",
      );
    }
  };

  const openEntry = async (entry: FileHubEntry) => {
    if (entry.isDirectory) {
      setCurrentPath(entry.path);
      setSearchQuery("");
      setShowRecent(false);
      return;
    }
    setPreviewError(null);
    setPreview(null);
    setError(null);
    const requestId = ++previewRequestSeqRef.current;
    const selectedWorkspaceId = browserWorkspaceId;
    try {
      let result: { blob: Blob; fileName?: string };
      if (entry.source === "artifacts") {
        const downloaded = await adapter.downloadArtifact(
          String(entry.metadata?.artifactId || entry.path),
        );
        result = { blob: downloaded.blob, fileName: downloaded.fileName };
      } else {
        result = { blob: await adapter.downloadWorkspaceFile(browserWorkspaceId, entry.path) };
      }
      if (
        requestId !== previewRequestSeqRef.current ||
        selectedWorkspaceId !== workspaceIdRef.current
      ) {
        return;
      }
      const mimeType = safePreviewType(
        result.blob.type || entry.mimeType,
        result.fileName || entry.name,
      );
      setPreview({ name: result.fileName || entry.name, mimeType, blob: result.blob });
      remember(entry);
    } catch (openFailure) {
      if (
        requestId !== previewRequestSeqRef.current ||
        selectedWorkspaceId !== workspaceIdRef.current
      ) {
        return;
      }
      setError(
        openFailure instanceof Error ? openFailure.message : "This file could not be opened.",
      );
    }
  };

  const pathParts = currentPath ? currentPath.split("/") : [];
  const visibleFiles = showRecent ? recentFiles : files;
  const unavailableCloudSources =
    "Drive, OneDrive and Dropbox aren't available in browser sessions.";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 320 }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color, #333)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid var(--border-color, #333)",
            background: "var(--surface-secondary, #1a1a1a)",
          }}
        >
          <Search size={14} style={{ color: "var(--text-tertiary, #666)", flexShrink: 0 }} />
          <input
            aria-label="Search workspace files"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={
              activeSource === "artifacts"
                ? "Search task artifacts..."
                : "Search workspace files..."
            }
            style={{
              flex: 1,
              border: "none",
              background: "none",
              color: "var(--text-primary, #e5e5e5)",
              fontSize: 13,
              outline: "none",
            }}
          />
          {searchQuery && (
            <button
              aria-label="Clear search"
              onClick={() => setSearchQuery("")}
              style={smallIconButton}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "8px 16px",
          borderBottom: "1px solid var(--border-color, #333)",
          overflowX: "auto",
        }}
      >
        <button onClick={() => setShowRecent((value) => !value)} style={tabStyle(showRecent)}>
          <Clock size={12} /> Recent
        </button>
        <button
          onClick={() => {
            setActiveSource("local");
            setShowRecent(false);
          }}
          disabled={!canReadWorkspaceFiles}
          title={
            !canReadWorkspaceFiles
              ? "Workspace file access isn't available in this browser session."
              : undefined
          }
          style={tabStyle(activeSource === "local" && !showRecent)}
        >
          <HardDrive size={12} /> Workspace
        </button>
        <button
          onClick={() => {
            setActiveSource("artifacts");
            setShowRecent(false);
          }}
          disabled={!canReadArtifacts}
          title={
            !canReadArtifacts
              ? "Task artifact access isn't available in this browser session."
              : undefined
          }
          style={tabStyle(activeSource === "artifacts" && !showRecent)}
        >
          <Archive size={12} /> Task artifacts
        </button>
        <span
          title={unavailableCloudSources}
          style={{
            marginLeft: "auto",
            color: "var(--text-tertiary, #777)",
            fontSize: 11,
            whiteSpace: "nowrap",
          }}
        >
          <Cloud size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          Drive, OneDrive and Dropbox unavailable
        </span>
      </div>

      {!showRecent && activeSource === "local" && (
        <nav
          aria-label="Workspace folder"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "7px 16px",
            borderBottom: "1px solid var(--border-color, #252525)",
            overflowX: "auto",
            fontSize: 12,
          }}
        >
          <button
            onClick={() => {
              setCurrentPath("");
              setSearchQuery("");
            }}
            style={breadcrumbButton}
          >
            {workspaceName || "Workspace"}
          </button>
          {pathParts.map((part, index) => {
            const path = pathParts.slice(0, index + 1).join("/");
            return (
              <React.Fragment key={path}>
                <ChevronRight size={12} />
                <button
                  onClick={() => {
                    setCurrentPath(path);
                    setSearchQuery("");
                  }}
                  style={breadcrumbButton}
                >
                  {part}
                </button>
              </React.Fragment>
            );
          })}
        </nav>
      )}

      {error && (
        <div
          role="alert"
          style={{ padding: "10px 16px", color: "var(--error-color, #f87171)", fontSize: 12 }}
        >
          {error}
        </div>
      )}
      {truncated && (
        <div
          role="status"
          style={{ padding: "6px 16px", color: "var(--text-tertiary, #999)", fontSize: 11 }}
        >
          Showing a limited result set. Refine the search to see more.
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {loading ? (
          <div role="status" style={emptyStateStyle}>
            Loading {activeSource === "artifacts" ? "task artifacts" : "workspace files"}…
          </div>
        ) : visibleFiles.length === 0 ? (
          <div style={emptyStateStyle}>
            {error
              ? ""
              : showRecent
                ? "Files opened or downloaded in this browser session will appear here."
                : searchQuery
                  ? "No files match your search."
                  : activeSource === "artifacts"
                    ? "No task artifacts found for this workspace."
                    : "This folder is empty."}
          </div>
        ) : (
          visibleFiles.map((entry) => (
            <div key={entry.id} style={fileRowStyle}>
              <button
                onClick={() => void openEntry(entry)}
                style={fileOpenButton}
                title={entry.isDirectory ? `Open folder ${entry.name}` : `Preview ${entry.name}`}
              >
                {getFileIcon(entry.mimeType, entry.isDirectory)}
                <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <span style={fileNameStyle}>{entry.name}</span>
                  <span style={fileMetaStyle}>
                    {entry.source === "artifacts" ? "Task artifact · " : ""}
                    {entry.isDirectory ? "Folder" : formatSize(entry.size)}
                  </span>
                </span>
                {entry.modifiedAt && <span style={dateStyle}>{formatDate(entry.modifiedAt)}</span>}
              </button>
              {!entry.isDirectory && (
                <button
                  aria-label={`Download ${entry.name}`}
                  title="Download"
                  onClick={() => void downloadEntry(entry)}
                  style={smallIconButton}
                >
                  <Download size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
      {preview && (
        <BrowserFilePreview
          preview={preview}
          error={previewError}
          onError={setPreviewError}
          onClose={() => {
            previewRequestSeqRef.current += 1;
            setPreview(null);
            setPreviewError(null);
          }}
        />
      )}
    </div>
  );
}

function BrowserFilePreview({
  preview,
  error,
  onError,
  onClose,
}: {
  preview: BrowserPreview;
  error: string | null;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState("");
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(preview.blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview.blob]);
  useEffect(() => {
    if (
      preview.mimeType.startsWith("text/") ||
      preview.mimeType === "application/json" ||
      preview.mimeType === "application/typescript"
    ) {
      preview.blob
        .text()
        .then(setText)
        .catch(() => onError("This file could not be previewed."));
    } else setText(null);
  }, [onError, preview]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${preview.name}`}
      style={modalBackdropStyle}
    >
      <section style={modalStyle}>
        <header style={modalHeaderStyle}>
          <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {preview.name}
          </strong>
          <button aria-label="Close preview" onClick={onClose} style={smallIconButton}>
            <X size={16} />
          </button>
        </header>
        <div
          style={{
            flex: 1,
            overflow: "auto",
            minHeight: 0,
            background: "var(--color-bg-secondary, #242428)",
            color: "var(--color-text-primary, #f8fafc)",
          }}
        >
          {error ? (
            <div role="alert" style={emptyStateStyle}>
              {error}
            </div>
          ) : !objectUrl ? (
            <div role="status" style={emptyStateStyle}>
              Preparing preview…
            </div>
          ) : text !== null ? (
            <pre
              style={{
                margin: 0,
                padding: 16,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                color: "var(--color-text-primary, #f8fafc)",
                fontSize: 12,
              }}
            >
              {text}
            </pre>
          ) : preview.mimeType.startsWith("image/") && preview.mimeType !== "image/svg+xml" ? (
            <img
              src={objectUrl}
              alt={preview.name}
              style={{
                display: "block",
                maxWidth: "100%",
                maxHeight: "100%",
                margin: "auto",
                objectFit: "contain",
              }}
              onError={() => onError("This image could not be previewed.")}
            />
          ) : preview.mimeType === "application/pdf" ? (
            <iframe
              title={`PDF preview: ${preview.name}`}
              src={objectUrl}
              sandbox=""
              style={{ border: 0, width: "100%", height: "100%", minHeight: 420 }}
            />
          ) : (
            <div style={emptyStateStyle}>
              Preview isn't available for this file type. Use Download to save it.
            </div>
          )}
        </div>
        <footer style={modalFooterStyle}>
          <button
            onClick={() => triggerBlobDownload(preview.blob, preview.name)}
            style={downloadButtonStyle}
          >
            <Download size={14} /> Download
          </button>
        </footer>
      </section>
    </div>
  );
}

function safePreviewType(type: string, name: string): string {
  const normalized = type.split(";")[0]?.trim().toLowerCase() || "";
  const allowed = new Set([
    "application/json",
    "application/pdf",
    "application/typescript",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/csv",
    "text/markdown",
    "text/plain",
  ]);
  if (allowed.has(normalized)) return normalized;
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  if ([".txt", ".md", ".csv", ".json", ".ts", ".tsx", ".js", ".jsx", ".py"].includes(extension)) {
    return extension === ".json"
      ? "application/json"
      : extension === ".csv"
        ? "text/csv"
        : extension === ".md"
          ? "text/markdown"
          : extension === ".ts" ||
              extension === ".tsx" ||
              extension === ".js" ||
              extension === ".jsx" ||
              extension === ".py"
            ? "application/typescript"
            : "text/plain";
  }
  return "application/octet-stream";
}

function triggerBlobDownload(blob: Blob, fileName: string) {
  triggerBrowserBlobDownload(blob, fileName);
}

const tabStyle = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 10px",
  borderRadius: 4,
  border: "none",
  background: active ? "var(--accent-bg, #2563eb22)" : "none",
  color: active ? "var(--accent-color, #60a5fa)" : "var(--text-secondary, #999)",
  cursor: "pointer",
  fontSize: 12,
  whiteSpace: "nowrap",
});
const smallIconButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--border-color, #444)",
  borderRadius: 4,
  color: "var(--text-secondary, #aaa)",
  background: "transparent",
  padding: 5,
  cursor: "pointer",
};
const breadcrumbButton: React.CSSProperties = {
  border: 0,
  padding: 2,
  background: "transparent",
  color: "var(--text-secondary, #aaa)",
  cursor: "pointer",
  fontSize: 12,
  whiteSpace: "nowrap",
};
const emptyStateStyle: React.CSSProperties = {
  textAlign: "center",
  padding: 32,
  color: "var(--text-tertiary, #777)",
  fontSize: 13,
};
const fileRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 16px",
  borderBottom: "1px solid var(--border-color, #1a1a1a)",
};
const fileOpenButton: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flex: 1,
  minWidth: 0,
  border: 0,
  background: "transparent",
  color: "inherit",
  padding: "4px 0",
  cursor: "pointer",
};
const fileNameStyle: React.CSSProperties = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--text-primary, #e5e5e5)",
  fontSize: 13,
};
const fileMetaStyle: React.CSSProperties = {
  display: "block",
  marginTop: 2,
  color: "var(--text-tertiary, #777)",
  fontSize: 11,
};
const dateStyle: React.CSSProperties = {
  flexShrink: 0,
  color: "var(--text-tertiary, #777)",
  fontSize: 11,
  padding: "0 8px",
};
const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  background: "rgba(0,0,0,.62)",
};
const modalStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "min(960px, 96vw)",
  height: "min(720px, 90vh)",
  border: "1px solid var(--color-border, #444)",
  borderRadius: 10,
  overflow: "hidden",
  background: "var(--color-bg-elevated, #202024)",
  color: "var(--color-text-primary, #f8fafc)",
  boxShadow: "0 16px 48px rgba(0,0,0,.45)",
};
const modalHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 14px",
  color: "var(--color-text-primary, #f8fafc)",
  borderBottom: "1px solid var(--color-border, #333)",
};
const modalFooterStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  padding: 10,
  borderTop: "1px solid var(--color-border, #333)",
};
const downloadButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  border: "1px solid var(--color-border, #555)",
  borderRadius: 5,
  color: "var(--color-text-primary, #f8fafc)",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
};
