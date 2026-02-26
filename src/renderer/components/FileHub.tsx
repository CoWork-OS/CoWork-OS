import React, { useState, useEffect, useCallback } from "react";
import {
  FolderOpen,
  File,
  Search,
  Clock,
  HardDrive,
  Cloud,
  FileSpreadsheet,
  FileText,
  Image,
  Code,
  Archive,
} from "lucide-react";

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

export const FileHub: React.FC<{ workspaceId?: string }> = ({ workspaceId: _workspaceId }) => {
  const [activeSource, setActiveSource] = useState("local");
  const [files, setFiles] = useState<UnifiedFile[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentFiles, setRecentFiles] = useState<UnifiedFile[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  const [availableSources, setAvailableSources] = useState<string[]>(["local", "artifacts"]);

  const loadFiles = useCallback(async () => {
    try {
      if (searchQuery.trim()) {
        const results = await (window as any).electronAPI.searchHubFiles(searchQuery, [
          activeSource,
        ]);
        setFiles((results || []).map((r: any) => r.file));
      } else {
        const result = await (window as any).electronAPI.listHubFiles({ source: activeSource });
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
        const sources = await (window as any).electronAPI.getHubSources();
        setAvailableSources(sources || ["local", "artifacts"]);
        const recent = await (window as any).electronAPI.getRecentHubFiles(10);
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
    // Open file
    window.electronAPI?.openFile?.(file.path);
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
    </div>
  );
};
