import { useState, useEffect, useCallback } from "react";
import { Folder, File, ChevronRight, ArrowLeft, Loader2 } from "lucide-react";

export interface RemoteFileEntry {
  name: string;
  type: "file" | "directory";
  size: number;
}

export interface RemoteWorkspace {
  id: string;
  name: string;
}

export interface RemoteFilePickerProps {
  nodeId: string;
  deviceName: string;
  workspaces: RemoteWorkspace[];
  onSelect: (paths: string[]) => void;
  onCancel: () => void;
}

export function RemoteFilePicker({
  nodeId,
  deviceName,
  workspaces,
  onSelect,
  onCancel,
}: RemoteFilePickerProps) {
  const [selectedWorkspace, setSelectedWorkspace] = useState<RemoteWorkspace>(
    workspaces[0] ?? { id: "", name: "" },
  );
  const [pathStack, setPathStack] = useState<string[]>([]);
  const [files, setFiles] = useState<RemoteFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const currentPath = pathStack.length > 0 ? pathStack.join("/") : ".";

  const loadFiles = useCallback(async () => {
    if (!selectedWorkspace.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI?.deviceListFiles?.({
        nodeId,
        workspaceId: selectedWorkspace.id,
        path: currentPath,
      });
      if (res?.ok && Array.isArray(res.files)) {
        setFiles(res.files);
      } else {
        setError(res?.error || "Failed to list files");
        setFiles([]);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to list files");
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [nodeId, selectedWorkspace.id, currentPath]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    setPathStack([]);
    setSelectedPaths(new Set());
  }, [selectedWorkspace.id]);

  const handleNavigate = (name: string) => {
    setPathStack((prev) => [...prev, name]);
  };

  const handleGoBack = (index: number) => {
    setPathStack((prev) => prev.slice(0, index));
  };

  const handleToggleFile = (relativePath: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(relativePath)) {
        next.delete(relativePath);
      } else {
        next.add(relativePath);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    onSelect(Array.from(selectedPaths));
  };

  const sortedFiles = [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return (
    <div className="remote-file-picker-overlay" onClick={onCancel}>
      <div
        className="remote-file-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Select files from remote device"
      >
        <div className="remote-file-picker-header">
          <h3>Select files from {deviceName}</h3>
          <button
            type="button"
            className="remote-file-picker-close"
            onClick={onCancel}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {workspaces.length > 1 && (
          <div className="remote-file-picker-workspace-select">
            <label htmlFor="remote-workspace-select">Workspace:</label>
            <select
              id="remote-workspace-select"
              value={selectedWorkspace.id}
              onChange={(e) => {
                const ws = workspaces.find((w) => w.id === e.target.value);
                if (ws) setSelectedWorkspace(ws);
              }}
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="remote-file-picker-breadcrumb">
          <button
            type="button"
            className="remote-file-picker-breadcrumb-item"
            onClick={() => handleGoBack(0)}
          >
            {selectedWorkspace.name || "Workspace"}
          </button>
          {pathStack.map((segment, i) => (
            <span key={i} className="remote-file-picker-breadcrumb-sep">
              <ChevronRight size={14} />
              <button
                type="button"
                className="remote-file-picker-breadcrumb-item"
                onClick={() => handleGoBack(i + 1)}
              >
                {segment}
              </button>
            </span>
          ))}
        </div>

        <div className="remote-file-picker-body">
          {loading ? (
            <div className="remote-file-picker-loading">
              <Loader2 size={24} className="spin" />
              <span>Loading...</span>
            </div>
          ) : error ? (
            <div className="remote-file-picker-error">
              {error.includes("Unknown method") || error.includes("file.listDirectory")
                ? "File selection requires the remote device to be updated. Please update CoWork on the remote device (e.g. Mac Mini) to the latest version, then try again."
                : error}
            </div>
          ) : (
            <div className="remote-file-picker-list">
              {pathStack.length > 0 && (
                <button
                  type="button"
                  className="remote-file-picker-row"
                  onClick={() => handleGoBack(pathStack.length)}
                >
                  <ArrowLeft size={18} />
                  <span>..</span>
                </button>
              )}
              {sortedFiles.map((entry) => {
                const relativePath =
                  currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
                const isSelected = selectedPaths.has(relativePath);
                return (
                  <button
                    key={relativePath}
                    type="button"
                    className={`remote-file-picker-row ${isSelected ? "selected" : ""}`}
                    onClick={() =>
                      entry.type === "directory"
                        ? handleNavigate(entry.name)
                        : handleToggleFile(relativePath)
                    }
                  >
                    {entry.type === "directory" ? <Folder size={18} /> : <File size={18} />}
                    <span className="remote-file-picker-row-name">{entry.name}</span>
                    {entry.type === "file" && entry.size > 0 && (
                      <span className="remote-file-picker-row-size">
                        {entry.size >= 1024
                          ? `${(entry.size / 1024).toFixed(1)} KB`
                          : `${entry.size} B`}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="remote-file-picker-footer">
          <span className="remote-file-picker-selected-count">
            {selectedPaths.size} file{selectedPaths.size !== 1 ? "s" : ""} selected
          </span>
          <div className="remote-file-picker-actions">
            <button type="button" className="remote-file-picker-btn secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="remote-file-picker-btn primary"
              onClick={handleConfirm}
              disabled={selectedPaths.size === 0}
            >
              Add files
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
