import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDot,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Pause,
  Plus,
  Sparkles,
  TimerReset,
  Wand2,
} from "lucide-react";
import type { FileViewerResult } from "../../electron/preload";
import { Task, Workspace, NodeInfo } from "../../shared/types";
import { getFileName, resolveTaskOutputSummaryFromTask } from "../utils/task-outputs";
import { isActiveSessionStatus, isAutomatedSession } from "./Sidebar";

interface RecentHubFile {
  id: string;
  name: string;
  path: string;
  source: string;
  mimeType: string;
  size: number;
  modifiedAt: number;
  isDirectory?: boolean;
  thumbnailUrl?: string;
}

type PreviewableFileType = NonNullable<FileViewerResult["data"]>["fileType"];

type HomeFilePreviewState =
  | { status: "loading" }
  | { status: "ready"; fileType: PreviewableFileType; content: string | null; pdfThumbnailDataUrl?: string }
  | { status: "error" };

interface HomeDashboardProps {
  workspace: Workspace | null;
  tasks: Task[];
  onOpenTask: (taskId: string) => void;
  onNewSession: () => void;
  onOpenScheduledTasks: () => void;
  onOpenMissionControl: () => void;
  onOpenSkills: () => void;
  onOpenConnectedTools: () => void;
  onOpenDevices?: () => void;
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "Just now";
  const diff = Date.now() - timestamp;
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "File";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stripHtml(html: string): string {
  if (!html) return "";
  try {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    return parsed.body?.textContent || "";
  } catch {
    return html.replace(/<[^>]+>/g, " ");
  }
}

function normalizePreviewText(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function getPreviewLabel(fileType?: PreviewableFileType, filePath?: string): string {
  switch (fileType) {
    case "image":
      return "Image";
    case "pdf":
      return "PDF";
    case "docx":
      return "Word";
    case "xlsx":
      return "Sheet";
    case "pptx":
      return "Slides";
    case "markdown":
      return "Markdown";
    case "code":
      return "Code";
    case "html":
      return "HTML";
    case "text":
      return "Text";
    default:
      return filePath?.split(".").pop()?.toUpperCase() || "File";
  }
}

function getTextPreviewContent(preview: HomeFilePreviewState): string {
  if (preview.status !== "ready") return "";
  if (preview.fileType === "docx") return normalizePreviewText(stripHtml(preview.content || ""));
  return normalizePreviewText(preview.content);
}

function HomeFilePreview({
  filePath,
  workspacePath,
  fileName,
  isDirectory,
  cloudThumbnailUrl,
}: {
  filePath: string;
  workspacePath?: string;
  fileName: string;
  isDirectory?: boolean;
  cloudThumbnailUrl?: string;
}) {
  const [preview, setPreview] = useState<HomeFilePreviewState>(() =>
    isDirectory ? { status: "error" } : { status: "loading" },
  );

  useEffect(() => {
    let cancelled = false;

    if (isDirectory) {
      setPreview({ status: "error" });
      return () => {
        cancelled = true;
      };
    }

    if (cloudThumbnailUrl) {
      setPreview({
        status: "ready",
        fileType: "image",
        content: cloudThumbnailUrl,
      });
      return () => {
        cancelled = true;
      };
    }

    setPreview({ status: "loading" });

    void window.electronAPI
      .readFileForViewer(filePath, workspacePath, { includeImageContent: true })
      .then((result) => {
        if (cancelled) return;
        if (!result.success || !result.data) {
          setPreview({ status: "error" });
          return;
        }

        const content =
          result.data.fileType === "docx"
            ? result.data.htmlContent || ""
            : result.data.content;

        setPreview({
          status: "ready",
          fileType: result.data.fileType,
          content,
          pdfThumbnailDataUrl: result.data.pdfThumbnailDataUrl,
        });
      })
      .catch(() => {
        if (!cancelled) setPreview({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [cloudThumbnailUrl, filePath, isDirectory, workspacePath]);

  if (isDirectory) {
    return (
      <div className="home-file-thumb-preview home-file-thumb-preview-fallback">
        <FolderOpen size={28} />
        <span>Folder</span>
      </div>
    );
  }

  if (preview.status === "ready" && preview.fileType === "image" && preview.content) {
    return (
      <div className="home-file-thumb-preview home-file-thumb-preview-media">
        <img src={preview.content} alt={fileName} className="home-file-thumb-preview-image" />
        <span className="home-file-thumb-preview-badge">{getPreviewLabel(preview.fileType, filePath)}</span>
      </div>
    );
  }

  if (preview.status === "ready" && preview.fileType === "pdf" && preview.pdfThumbnailDataUrl) {
    return (
      <div className="home-file-thumb-preview home-file-thumb-preview-media">
        <img
          src={preview.pdfThumbnailDataUrl}
          alt={`${fileName} preview`}
          className="home-file-thumb-preview-image"
        />
        <span className="home-file-thumb-preview-badge">{getPreviewLabel(preview.fileType, filePath)}</span>
      </div>
    );
  }

  const textPreview = getTextPreviewContent(preview);
  if (preview.status === "ready" && textPreview) {
    return (
      <div className="home-file-thumb-preview home-file-thumb-preview-text">
        <span className="home-file-thumb-preview-badge">{getPreviewLabel(preview.fileType, filePath)}</span>
        <p>{textPreview}</p>
      </div>
    );
  }

  return (
    <div className="home-file-thumb-preview home-file-thumb-preview-fallback">
      {preview.status === "loading" ? (
        <>
          <div className="home-file-thumb-preview-skeleton" />
          <div className="home-file-thumb-preview-skeleton home-file-thumb-preview-skeleton-short" />
        </>
      ) : (
        <>
          {filePath.endsWith(".xlsx") || filePath.endsWith(".xls") ? (
            <FileSpreadsheet size={28} />
          ) : filePath.match(/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i) ? (
            <ImageIcon size={28} />
          ) : filePath.match(/\.(ts|tsx|js|jsx|json|css|html|py|go|rs|java|sh|sql|yml|yaml)$/i) ? (
            <FileCode2 size={28} />
          ) : (
            <FileText size={28} />
          )}
          <span>{getPreviewLabel(undefined, filePath)}</span>
        </>
      )}
    </div>
  );
}

function getTaskStatusInfo(task: Task): { icon: "live" | "complete" | "paused"; label: string } {
  if (isActiveSessionStatus(task.status)) {
    if (task.source === "cron") return { icon: "live", label: "Scheduled run" };
    if (task.source === "improvement") return { icon: "live", label: "Improvement loop" };
    return { icon: "live", label: "Working" };
  }
  if (task.status === "paused" || task.status === "blocked") return { icon: "paused", label: "Awaiting reply" };
  if (task.status === "completed") return { icon: "complete", label: "Complete" };
  if (task.status === "failed") return { icon: "paused", label: "Needs attention" };
  if (task.status === "cancelled") return { icon: "complete", label: "Cancelled" };
  return { icon: "complete", label: "Complete" };
}

function getTaskTone(task: Task): "live" | "queued" | "done" | "attention" {
  if (isActiveSessionStatus(task.status)) return "live";
  if (task.status === "paused" || task.status === "blocked") return "queued";
  if (task.status === "failed" || task.status === "cancelled") return "attention";
  return "done";
}

export function HomeDashboard({
  workspace,
  tasks,
  onOpenTask,
  onNewSession,
  onOpenScheduledTasks,
  onOpenMissionControl,
  onOpenSkills,
  onOpenConnectedTools,
  onOpenDevices,
}: HomeDashboardProps) {
  const [recentHubFiles, setRecentHubFiles] = useState<RecentHubFile[]>([]);
  const [connectedNodes, setConnectedNodes] = useState<NodeInfo[]>([]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const electronApi = (window as any).electronAPI;
        const recent = await electronApi.getRecentHubFiles(8);
        if (cancelled) return;
        setRecentHubFiles(Array.isArray(recent) ? (recent as RecentHubFile[]) : []);
      } catch {
        if (cancelled) return;
        setRecentHubFiles([]);
      }
    })();

    // Load connected nodes
    (async () => {
      try {
        const result = await window.electronAPI?.nodeList?.();
        if (cancelled) return;
        if (result?.ok && result.nodes) {
          setConnectedNodes(result.nodes);
        }
      } catch {
        /* ignore */
      }
    })();

    const unsubscribeNodes = window.electronAPI?.onNodeEvent?.((event) => {
      if (event.type === "connected" || event.type === "disconnected") {
        window.electronAPI?.nodeList?.().then((result) => {
          if (result?.ok && result.nodes) setConnectedNodes(result.nodes);
        });
      }
    });

    return () => {
      cancelled = true;
      unsubscribeNodes?.();
    };
  }, []);

  const rootTasks = useMemo(
    () => tasks.filter((task) => !task.parentTaskId).sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks],
  );

  const activeTasks = useMemo(
    () =>
      rootTasks.filter(
        (task) =>
          isActiveSessionStatus(task.status) || task.status === "paused" || task.status === "blocked",
      ),
    [rootTasks],
  );

  const automatedTasks = useMemo(
    () => rootTasks.filter((task) => isAutomatedSession(task)).slice(0, 6),
    [rootTasks],
  );

  const recentSessions = useMemo(
    () => rootTasks.filter((task) => !isAutomatedSession(task)).slice(0, 5),
    [rootTasks],
  );

  const recentOutputs = useMemo(() => {
    const items = rootTasks
      .map((task) => {
        const summary = resolveTaskOutputSummaryFromTask(task);
        if (!summary?.primaryOutputPath) return null;
        return {
          taskId: task.id,
          taskTitle: task.title,
          fileName: getFileName(summary.primaryOutputPath),
          filePath: summary.primaryOutputPath,
          updatedAt: task.completedAt || task.updatedAt || task.createdAt,
          outputCount: summary.outputCount,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.filePath)) return false;
      seen.add(item.filePath);
      return true;
    });
  }, [rootTasks]);

  const automationGroups = useMemo(() => {
    const counts = {
      cron: 0,
      improvement: 0,
      hook: 0,
      api: 0,
      heartbeat: 0,
    };
    for (const task of rootTasks) {
      if (!isAutomatedSession(task)) continue;
      if (task.heartbeatRunId) counts.heartbeat += 1;
      else if (task.source === "cron") counts.cron += 1;
      else if (task.source === "improvement") counts.improvement += 1;
      else if (task.source === "hook") counts.hook += 1;
      else if (task.source === "api") counts.api += 1;
    }
    return counts;
  }, [rootTasks]);

  const displayTasks = activeTasks.length > 0 ? activeTasks.slice(0, 4) : recentSessions.slice(0, 4);


  return (
    <main className="main-content home-main-content">
      <div className="home-dashboard">
        <section className="home-new-task-section">
          <button type="button" className="home-new-task-btn" onClick={onNewSession}>
            <Plus size={20} strokeWidth={2.5} />
            <span>Start a new Task</span>
          </button>
        </section>

        {/* Running Tasks */}
        <section className="home-section">
          <div className="home-section-header">
            <h2>Running Tasks</h2>
            <button type="button" className="home-section-link" onClick={onNewSession}>
              View all tasks <ArrowRight size={14} />
            </button>
          </div>
          <div className="home-task-grid">
            {displayTasks.map((task) => {
              const status = getTaskStatusInfo(task);
              const tone = getTaskTone(task);
              return (
                <button
                  type="button"
                  key={task.id}
                  className={`home-task-card tone-${tone}`}
                  onClick={() => onOpenTask(task.id)}
                >
                  <strong className="home-task-title">{task.title}</strong>
                  <div className="home-task-status-row">
                    <span className="home-task-status">
                      {status.icon === "live" && <CircleDot size={14} />}
                      {status.icon === "complete" && <CheckCircle2 size={14} />}
                      {status.icon === "paused" && <Pause size={14} />}
                      {status.label}
                    </span>
                    <span className="home-task-time">
                      {formatRelativeTime(task.updatedAt || task.createdAt)}
                    </span>
                  </div>
                </button>
              );
            })}
            {displayTasks.length === 0 && (
              <div className="home-empty-state home-empty-wide">
                <FileText size={18} />
                <span>No tasks yet. Start one above to get going.</span>
              </div>
            )}
          </div>
        </section>

        {/* Automation */}
        <section className="home-section">
          <div className="home-section-header">
            <h2>Automation</h2>
            <button type="button" className="home-section-link" onClick={onOpenScheduledTasks}>
              Manage automations <ArrowRight size={14} />
            </button>
          </div>
          <div className="home-automation-strip">
            <button type="button" className="home-auto-card" onClick={onOpenScheduledTasks}>
              <div className="home-auto-card-icon">
                <TimerReset size={20} />
              </div>
              <div className="home-auto-card-copy">
                <strong>Scheduled tasks</strong>
                <span>{automationGroups.cron} recurring</span>
              </div>
            </button>
            <button type="button" className="home-auto-card" onClick={onOpenMissionControl}>
              <div className="home-auto-card-icon">
                <Bot size={20} />
              </div>
              <div className="home-auto-card-copy">
                <strong>Mission Control</strong>
                <span>{automationGroups.improvement + automationGroups.heartbeat} active</span>
              </div>
            </button>
            <button type="button" className="home-auto-card" onClick={onOpenConnectedTools}>
              <div className="home-auto-card-icon">
                <Wand2 size={20} />
              </div>
              <div className="home-auto-card-copy">
                <strong>Connected tools</strong>
                <span>{automationGroups.hook + automationGroups.api} triggers</span>
              </div>
            </button>
            <button type="button" className="home-auto-card" onClick={onOpenSkills}>
              <div className="home-auto-card-icon">
                <Sparkles size={20} />
              </div>
              <div className="home-auto-card-copy">
                <strong>Skill store</strong>
                <span>Browse skills</span>
              </div>
            </button>
          </div>
          {automatedTasks.length > 0 && (
            <div className="home-automation-list">
              {automatedTasks.slice(0, 3).map((task) => {
                const status = getTaskStatusInfo(task);
                return (
                  <button
                    type="button"
                    key={task.id}
                    className="home-automation-row"
                    onClick={() => onOpenTask(task.id)}
                  >
                    <div className="home-automation-row-left">
                      <strong>{task.title}</strong>
                      <span>{status.label}</span>
                    </div>
                    <small>{formatRelativeTime(task.updatedAt || task.createdAt)}</small>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Devices */}
        <section className="home-section">
          <div className="home-section-header">
            <h2>Devices</h2>
            {onOpenDevices && (
              <button type="button" className="home-section-link" onClick={onOpenDevices}>
                Manage devices <ArrowRight size={14} />
              </button>
            )}
          </div>
          {connectedNodes.length > 0 ? (
            <div className="home-automation-strip">
              {connectedNodes.slice(0, 4).map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className="home-auto-card"
                  onClick={onOpenDevices}
                >
                  <span className="home-auto-card-icon">
                    {node.platform === "ios" || node.platform === "android" ? "\u{1F4F1}" : "\u{1F5A5}"}
                  </span>
                  <span className="home-auto-card-label">{node.displayName}</span>
                  <span className="home-auto-card-description">
                    {node.isForeground ? "Connected" : "Background"}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="home-auto-empty">
              <p>No devices connected</p>
              {onOpenDevices && (
                <button type="button" className="home-section-link" onClick={onOpenDevices}>
                  Add a device <ArrowRight size={14} />
                </button>
              )}
            </div>
          )}
        </section>

        {/* Files */}
        <section className="home-section">
          <div className="home-section-header">
            <h2>Files</h2>
            <button
              type="button"
              className="home-section-link"
              onClick={() => {
                const firstFile = recentHubFiles[0];
                if (firstFile?.path) {
                  void (window as any).electronAPI.openFile(firstFile.path, workspace?.path);
                }
              }}
              disabled={recentHubFiles.length === 0 && recentOutputs.length === 0}
            >
              View all files <ArrowRight size={14} />
            </button>
          </div>
          <div className="home-files-scroll">
            {recentOutputs.slice(0, 6).map((output) => (
              <button
                type="button"
                key={output.filePath}
                className="home-file-thumb"
                onClick={() => onOpenTask(output.taskId)}
              >
                <HomeFilePreview
                  filePath={output.filePath}
                  workspacePath={workspace?.path}
                  fileName={output.fileName}
                />
                <div className="home-file-thumb-label">
                  <strong>{output.fileName}</strong>
                  <span>{output.taskTitle}</span>
                </div>
              </button>
            ))}
            {recentHubFiles.slice(0, 4).map((file) => (
              <button
                type="button"
                key={file.id}
                className="home-file-thumb"
                onClick={() => void (window as any).electronAPI.openFile(file.path, workspace?.path)}
              >
                <HomeFilePreview
                  filePath={file.path}
                  workspacePath={workspace?.path}
                  fileName={file.name}
                  isDirectory={file.isDirectory}
                  cloudThumbnailUrl={file.thumbnailUrl}
                />
                <div className="home-file-thumb-label">
                  <strong>{file.name}</strong>
                  <span>{file.isDirectory ? "Folder" : formatFileSize(file.size)}</span>
                </div>
              </button>
            ))}
            {recentOutputs.length === 0 && recentHubFiles.length === 0 && (
              <div className="home-empty-state home-empty-wide">
                <FileText size={18} />
                <span>No files yet. Completed sessions with artifacts will show up here.</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
