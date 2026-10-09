import { useEffect, useState } from "react";
import { AlertTriangle, FileDown, FolderOpen, Pause, Play, X } from "lucide-react";

type DownloadEntry = {
  id: string;
  taskId: string;
  sessionId: string;
  filename: string;
  url: string;
  savePath?: string;
  state: "progressing" | "paused" | "completed" | "cancelled" | "interrupted" | "blocked";
  receivedBytes: number;
  totalBytes: number;
  dangerous: boolean;
  agentInitiated: boolean;
  error?: string;
};

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function statusText(entry: DownloadEntry): string {
  switch (entry.state) {
    case "progressing":
      return entry.totalBytes
        ? `${formatBytes(entry.receivedBytes)} of ${formatBytes(entry.totalBytes)}`
        : formatBytes(entry.receivedBytes);
    case "paused":
      return "Paused";
    case "completed":
      return entry.agentInitiated ? "Saved to workspace downloads" : "Done";
    case "cancelled":
      return "Cancelled";
    case "blocked":
      return entry.error || "Blocked";
    default:
      return entry.error || "Failed";
  }
}

/** Download shelf at the bottom of the workbench: progress, pause/resume/cancel, open, reveal. */
export function DownloadShelf({ taskId, sessionId }: { taskId: string; sessionId: string }) {
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      .listBrowserDownloads?.({ taskId, sessionId })
      .then((entries) => {
        if (!cancelled && Array.isArray(entries)) setDownloads(entries as DownloadEntry[]);
      })
      .catch(() => undefined);
    const unsubscribe = window.electronAPI.onBrowserWorkbenchDownload?.((event) => {
      if (event.taskId !== taskId || event.sessionId !== sessionId) return;
      setDownloads((current) => {
        const next = current.filter((entry) => entry.id !== event.id);
        return [...next, event as DownloadEntry].slice(-20);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [sessionId, taskId]);

  const act = async (
    entry: DownloadEntry,
    action: "pause" | "resume" | "cancel" | "open" | "reveal" | "clear",
    confirmedDangerous = false,
  ) => {
    const result = await window.electronAPI.browserDownloadAction?.({
      id: entry.id,
      action,
      confirmedDangerous,
    });
    if (result?.error === "confirm_dangerous") {
      setConfirmId(entry.id);
      return;
    }
    setConfirmId(null);
    if (action === "clear" && result?.success) {
      setDownloads((current) => current.filter((candidate) => candidate.id !== entry.id));
    }
  };

  if (downloads.length === 0) return null;
  const visible = [...downloads].reverse().slice(0, 4);

  return (
    <div className="browser-workbench-downloads" aria-label="Downloads">
      {visible.map((entry) => {
        const progress =
          entry.totalBytes > 0 ? Math.min(100, (entry.receivedBytes / entry.totalBytes) * 100) : 0;
        const active = entry.state === "progressing" || entry.state === "paused";
        return (
          <div
            key={entry.id}
            className={`browser-workbench-download is-${entry.state}`}
            title={entry.savePath || entry.url}
          >
            <span className="browser-workbench-download-icon" aria-hidden="true">
              {entry.dangerous ? <AlertTriangle size={14} /> : <FileDown size={14} />}
            </span>
            <span className="browser-workbench-download-text">
              <span className="browser-workbench-download-name">{entry.filename}</span>
              <span className="browser-workbench-download-status">
                {confirmId === entry.id
                  ? "This file type can harm your computer. Open anyway?"
                  : statusText(entry)}
              </span>
              {active && (
                <span className="browser-workbench-download-bar">
                  <span style={{ width: `${progress}%` }} />
                </span>
              )}
            </span>
            <span className="browser-workbench-download-actions">
              {entry.state === "progressing" && (
                <button type="button" title="Pause" onClick={() => void act(entry, "pause")}>
                  <Pause size={13} aria-hidden="true" />
                </button>
              )}
              {entry.state === "paused" && (
                <button type="button" title="Resume" onClick={() => void act(entry, "resume")}>
                  <Play size={13} aria-hidden="true" />
                </button>
              )}
              {entry.state === "completed" &&
                (confirmId === entry.id ? (
                  <>
                    <button type="button" onClick={() => void act(entry, "open", true)}>
                      Open anyway
                    </button>
                    <button type="button" onClick={() => setConfirmId(null)}>
                      Keep closed
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => void act(entry, "open")}>
                      Open
                    </button>
                    <button
                      type="button"
                      title="Show in folder"
                      onClick={() => void act(entry, "reveal")}
                    >
                      <FolderOpen size={13} aria-hidden="true" />
                    </button>
                  </>
                ))}
              <button
                type="button"
                title={active ? "Cancel" : "Remove from list"}
                onClick={() => void act(entry, active ? "cancel" : "clear")}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
