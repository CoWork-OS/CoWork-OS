import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
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
  Zap,
  Mail,
} from "lucide-react";
import type { FileViewerResult } from "../../electron/preload";
import { Task, Workspace } from "../../shared/types";
import {
  formatOutputLocationLabel,
  getFileName,
  resolveTaskOutputSummaryFromTask,
} from "../utils/task-outputs";
import { buildCompletionOutputMessage } from "../utils/task-completion-ux";
import { normalizeMarkdownForCollab } from "../utils/markdown-inline-lists";
import { isActiveSessionStatus, isAutomatedSession, shouldShowTaskInSidebarSessions } from "./Sidebar";

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
  onCreateTask: (title: string, prompt: string) => void;
  onNewSession: () => void;
  onOpenScheduledTasks: () => void;
  onOpenMissionControl: () => void;
  onOpenEventTriggers: () => void;
  onOpenSelfImprove: () => void;
  automationInboxFocusTick?: number;
}

interface CompanionSuggestion {
  id: string;
  kind: "notification" | "suggestion";
  type: string;
  title: string;
  description: string;
  actionPrompt?: string;
  confidence: number;
  createdAt: number;
  expiresAt: number;
  urgency?: "low" | "medium" | "high";
  recommendedDelivery?: "briefing" | "inbox" | "nudge";
  companionStyle?: "email" | "note";
  workspaceScope?: "single" | "all";
  sourceEntity?: string;
  sourceTaskId?: string;
  workspaceId?: string;
  notificationId?: string;
  read?: boolean;
  workspaceName?: string;
}

interface CompanionTaskResultItem {
  id: string;
  kind: "task_result";
  title: string;
  description: string;
  createdAt: number;
  sourceTaskId: string;
  workspaceId?: string;
  workspaceName?: string;
  sourceEntity: string;
  automationTag: string;
  terminalLabel: string;
  outputLabel?: string;
  outputLocationLabel?: string;
  outputCount?: number;
}

type CompanionInboxItem = CompanionSuggestion | CompanionTaskResultItem;

function isCompanionTaskResultItem(item: CompanionInboxItem): item is CompanionTaskResultItem {
  return item.kind === "task_result";
}

interface CompanionNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: number;
  taskId?: string;
  workspaceId?: string;
  suggestionId?: string;
  recommendedDelivery?: "briefing" | "inbox" | "nudge";
  companionStyle?: "email" | "note";
}

const inboxMarkdownPlugins = [remarkGfm, remarkBreaks];

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
    case "json":
      return "JSON";
    case "csv":
      return "CSV";
    case "audio":
      return "Audio";
    case "video":
      return "Video";
    case "latex":
      return "LaTeX";
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
    if (task.source === "improvement" || task.source === "subconscious") {
      return { icon: "live", label: "Workflow Intelligence run" };
    }
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

function getAutomationSender(task: Task): string {
  if (task.heartbeatRunId) return "Heartbeat";
  if (task.source === "cron") return "Scheduled task";
  if (task.source === "improvement" || task.source === "subconscious") return "Workflow Intelligence";
  if (task.source === "hook") return "Event trigger";
  if (task.source === "api") return "API";
  return "Manual";
}

function getAutomationPreview(task: Task): string {
  const text =
    task.resultSummary?.trim() ||
    task.bestKnownOutcome?.resultSummary?.trim() ||
    task.prompt?.trim() ||
    task.userPrompt?.trim() ||
    "";
  if (!text) return "No summary available yet.";
  return text.length > 180 ? `${text.slice(0, 177).trimEnd()}...` : text;
}

function getAutomationTag(task: Task): string {
  if (task.heartbeatRunId) return "Companion";
  if (task.source === "cron") return "Recurring";
  if (task.source === "improvement" || task.source === "subconscious") return "Workflow Intelligence";
  if (task.source === "hook") return "Triggered";
  if (task.source === "api") return "API";
  return "Manual";
}

export function HomeDashboard({
  workspace,
  tasks,
  onOpenTask,
  onCreateTask,
  onNewSession,
  onOpenScheduledTasks,
  onOpenMissionControl,
  onOpenEventTriggers,
  onOpenSelfImprove,
  automationInboxFocusTick,
}: HomeDashboardProps) {
  const AUTOMATION_VISIBLE_ROWS = 4;
  const AUTOMATION_ROW_HEIGHT = 72;
  const AUTOMATION_ROW_GAP = 8;
  const AUTOMATION_ROW_PITCH = AUTOMATION_ROW_HEIGHT + AUTOMATION_ROW_GAP;
  const AUTOMATION_OVERSCAN = 2;
  const AUTOMATION_BATCH_SIZE = 10;
  const [recentHubFiles, setRecentHubFiles] = useState<RecentHubFile[]>([]);
  const [automationLoadedCount, setAutomationLoadedCount] = useState(AUTOMATION_BATCH_SIZE);
  const [automationScrollTop, setAutomationScrollTop] = useState(0);
  const [knownWorkspaces, setKnownWorkspaces] = useState<Workspace[]>([]);
  const [companionSuggestions, setCompanionSuggestions] = useState<CompanionSuggestion[]>([]);
  const [companionLoading, setCompanionLoading] = useState(false);
  const [companionError, setCompanionError] = useState<string | null>(null);
  const [selectedCompanionItemId, setSelectedCompanionItemId] = useState<string | null>(null);
  const automationInboxRef = useRef<HTMLDivElement>(null);
  const currentWorkspaceName = workspace?.name || "Workspace";

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

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setCompanionLoading(true);
        setCompanionError(null);

        const loadedWorkspaces = await window.electronAPI.listWorkspaces();
        const visibleWorkspaces = (Array.isArray(loadedWorkspaces) ? loadedWorkspaces : []).filter(
          (item) => !String(item.id || "").startsWith("__temp_workspace__"),
        );
        setKnownWorkspaces(visibleWorkspaces as Workspace[]);

        const notificationResults = await window.electronAPI.listNotifications();
        const companionNotifications = (Array.isArray(notificationResults)
          ? notificationResults
          : []
        ).filter((item: CompanionNotification) => item.type === "companion_suggestion");

        const suggestionResults = visibleWorkspaces.length
          ? await window.electronAPI.listSuggestionsForWorkspaces(
              visibleWorkspaces.map((item) => item.id),
            )
          : [];

        if (cancelled) return;

        const merged = new Map<string, CompanionSuggestion>();

        for (const notification of companionNotifications as CompanionNotification[]) {
          const workspaceName =
            visibleWorkspaces.find((item) => item.id === notification.workspaceId)?.name ||
            "Workspace";
          merged.set(notification.suggestionId || notification.id, {
            id: notification.suggestionId || notification.id,
            type: notification.type,
            title: notification.title,
            description: notification.message,
            actionPrompt: undefined,
            confidence: notification.recommendedDelivery === "nudge" ? 0.95 : 0.75,
            createdAt: notification.createdAt,
            expiresAt: notification.createdAt + 7 * 24 * 60 * 60 * 1000,
            urgency: notification.recommendedDelivery === "nudge" ? "high" : "medium",
            recommendedDelivery: notification.recommendedDelivery,
            companionStyle: notification.companionStyle,
            workspaceScope: "single",
            sourceEntity: workspaceName,
            sourceTaskId: notification.taskId,
            workspaceId: notification.workspaceId,
            notificationId: notification.id,
            read: notification.read,
            workspaceName,
            kind: "notification",
          });
        }

        for (const entry of suggestionResults) {
          const workspaceName =
            visibleWorkspaces.find((item) => item.id === entry.workspaceId)?.name || "Workspace";
          for (const suggestion of entry.suggestions as CompanionSuggestion[]) {
            const existing = merged.get(suggestion.id);
            merged.set(suggestion.id, {
              ...(existing || suggestion),
              ...suggestion,
              workspaceName,
              sourceEntity: suggestion.sourceEntity || workspaceName,
              workspaceId: entry.workspaceId,
              kind: "suggestion",
              notificationId: existing?.notificationId,
              read: existing?.read,
            });
          }
        }

        setCompanionSuggestions(
          Array.from(merged.values()).sort((a, b) => {
            const aUrgency = a.urgency === "high" ? 0 : a.urgency === "medium" ? 1 : 2;
            const bUrgency = b.urgency === "high" ? 0 : b.urgency === "medium" ? 1 : 2;
            if (aUrgency !== bUrgency) return aUrgency - bUrgency;
            return (b.createdAt || 0) - (a.createdAt || 0);
          }),
        );
      } catch (error) {
        if (cancelled) return;
        setCompanionError(error instanceof Error ? error.message : "Failed to load inbox");
        setCompanionSuggestions([]);
      } finally {
        if (!cancelled) setCompanionLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!automationInboxFocusTick) return;
    automationInboxRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [automationInboxFocusTick]);

  const handleDismissCompanionSuggestion = async (id: string) => {
    const suggestion = companionSuggestions.find((item) => item.id === id);
    const workspaceId = suggestion?.workspaceId || workspace?.id;
    if (!workspaceId) return;
    try {
      await window.electronAPI.dismissSuggestion(workspaceId, id);
      setCompanionSuggestions((prev) => prev.filter((s) => s.id !== id));
      setSelectedCompanionItemId((current) => (current === id ? null : current));
    } catch {
      // best-effort
    }
  };

  const handleSnoozeCompanionSuggestion = async (id: string) => {
    const suggestion = companionSuggestions.find((item) => item.id === id);
    const workspaceId = suggestion?.workspaceId || workspace?.id;
    if (!workspaceId) return;
    try {
      await window.electronAPI.snoozeSuggestion(
        workspaceId,
        id,
        Date.now() + 24 * 60 * 60 * 1000,
      );
      setCompanionSuggestions((prev) => prev.filter((s) => s.id !== id));
      setSelectedCompanionItemId((current) => (current === id ? null : current));
    } catch {
      // best-effort
    }
  };

  const handleActOnCompanionSuggestion = async (suggestion: CompanionSuggestion) => {
    const workspaceId = suggestion.workspaceId || workspace?.id;
    if (!workspaceId || !suggestion.actionPrompt) return;
    try {
      const result = await window.electronAPI.actOnSuggestion(workspaceId, suggestion.id);
      const prompt = typeof result === "string" ? result : suggestion.actionPrompt;
      if (prompt) {
        onCreateTask(suggestion.title, prompt);
      }
      setCompanionSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
      setSelectedCompanionItemId(null);
    } catch {
      // best-effort
    }
  };

  const workspaceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of knownWorkspaces) {
      map.set(item.id, item.name);
    }
    if (workspace?.id && workspace.name) {
      map.set(workspace.id, workspace.name);
    }
    return map;
  }, [knownWorkspaces, workspace?.id, workspace?.name]);

  useEffect(() => {
    if (!workspace?.id) return;
    setCompanionSuggestions((prev) =>
      prev.map((item) =>
        item.workspaceName && item.workspaceName !== currentWorkspaceName
          ? item
          : {
              ...item,
              workspaceName: currentWorkspaceName,
            },
      ),
    );
  }, [workspace?.id, currentWorkspaceName]);

  const rootTasks = useMemo(
    () =>
      tasks
        .filter((task) => !task.parentTaskId && shouldShowTaskInSidebarSessions(task))
        .sort((a, b) => b.updatedAt - a.updatedAt),
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
    () => rootTasks.filter((task) => isAutomatedSession(task)),
    [rootTasks],
  );

  const completedAutomationInboxItems = useMemo<CompanionTaskResultItem[]>(() => {
    return automatedTasks
      .filter((task) => task.status === "completed")
      .map((task) => {
        const outputSummary = resolveTaskOutputSummaryFromTask(task);
        const outputLabel = outputSummary ? buildCompletionOutputMessage(outputSummary) : undefined;
        const resultSummary =
          task.resultSummary?.trim() || task.bestKnownOutcome?.resultSummary?.trim() || "";
        const description = resultSummary
          ? resultSummary
          : outputLabel
            ? `Completed with ${outputLabel}.`
            : getAutomationPreview(task);
        const status = getTaskStatusInfo(task);
        return {
          id: `task-result:${task.id}`,
          kind: "task_result" as const,
          title: `Automation completed: ${task.title}`,
          description,
          createdAt: task.completedAt || task.updatedAt || task.createdAt,
          sourceTaskId: task.id,
          workspaceId: task.workspaceId,
          workspaceName: workspaceNameById.get(task.workspaceId) || currentWorkspaceName,
          sourceEntity: getAutomationSender(task),
          automationTag: getAutomationTag(task),
          terminalLabel: status.label,
          ...(outputLabel ? { outputLabel } : {}),
          ...(outputSummary ? { outputLocationLabel: formatOutputLocationLabel(outputSummary) } : {}),
          ...(outputSummary?.outputCount ? { outputCount: outputSummary.outputCount } : {}),
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [automatedTasks, currentWorkspaceName, workspaceNameById]);

  const companionInboxItems = useMemo(() => {
    const urgencyRank: Record<NonNullable<CompanionSuggestion["urgency"]>, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };

    return [...companionSuggestions, ...completedAutomationInboxItems].sort((a, b) => {
      const urgencyA = a.kind === "task_result" ? 3 : a.urgency ? urgencyRank[a.urgency] : 3;
      const urgencyB = b.kind === "task_result" ? 3 : b.urgency ? urgencyRank[b.urgency] : 3;
      if (urgencyA !== urgencyB) return urgencyA - urgencyB;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }, [companionSuggestions, completedAutomationInboxItems]);

  const selectedCompanionItem = useMemo<CompanionInboxItem | null>(() => {
    if (companionInboxItems.length === 0) return null;
    if (!selectedCompanionItemId) return companionInboxItems[0];
    return (
      companionInboxItems.find((item) => item.id === selectedCompanionItemId) ||
      companionInboxItems[0]
    );
  }, [companionInboxItems, selectedCompanionItemId]);

  useEffect(() => {
    if (companionInboxItems.length === 0) {
      if (selectedCompanionItemId !== null) {
        setSelectedCompanionItemId(null);
      }
      return;
    }

    if (
      !selectedCompanionItemId ||
      !companionInboxItems.some((item) => item.id === selectedCompanionItemId)
    ) {
      setSelectedCompanionItemId(companionInboxItems[0].id);
    }
  }, [companionInboxItems, selectedCompanionItemId]);

  useEffect(() => {
    setAutomationLoadedCount(Math.min(automatedTasks.length, AUTOMATION_BATCH_SIZE));
    setAutomationScrollTop(0);
  }, [AUTOMATION_BATCH_SIZE, automatedTasks.length]);

  const automationVisibleStart = Math.max(0, Math.floor(automationScrollTop / AUTOMATION_ROW_PITCH));
  const automationRenderStart = Math.max(0, automationVisibleStart - AUTOMATION_OVERSCAN);
  const automationRenderEnd = Math.min(
    automationLoadedCount,
    automationVisibleStart + AUTOMATION_VISIBLE_ROWS + AUTOMATION_OVERSCAN,
  );
  const visibleAutomatedTasks = automatedTasks.slice(automationRenderStart, automationRenderEnd);
  const automationTopSpacer = automationRenderStart * AUTOMATION_ROW_PITCH;
  const automationBottomSpacer = Math.max(
    0,
    (automationLoadedCount - automationRenderEnd) * AUTOMATION_ROW_PITCH,
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
      else if (task.source === "improvement" || task.source === "subconscious") counts.improvement += 1;
      else if (task.source === "hook") counts.hook += 1;
      else if (task.source === "api") counts.api += 1;
    }
    return counts;
  }, [rootTasks]);

  const displayTasks = activeTasks.filter(isAutomatedSession).slice(0, 4);

  const loadMoreAutomationTasks = (element?: HTMLDivElement | null) => {
    if (automationLoadedCount >= automatedTasks.length) return;
    if (element) {
      const hasOverflow = element.scrollHeight > element.clientHeight + 1;
      const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (hasOverflow && remaining > 120) return;
    }
    setAutomationLoadedCount((count) => Math.min(automatedTasks.length, count + AUTOMATION_BATCH_SIZE));
  };

  const handleAutomationListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setAutomationScrollTop(element.scrollTop);
    loadMoreAutomationTasks(element);
  };


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
                <span>No running tasks right now.</span>
              </div>
            )}
          </div>
        </section>

        {/* Automation */}
        <section className="home-section">
          <div className="home-section-header">
            <h2>Automations</h2>
          </div>
          <div ref={automationInboxRef} className="home-automation-inbox">
            <div className="home-automation-inbox-header">
              <div>
                <h3>Companion Inbox</h3>
                <p>
                  Suggestions, summaries, and completed outputs from the automation core.
                </p>
              </div>
              <button
                type="button"
                className="home-section-link"
                onClick={() => {
                  if (automationInboxRef.current) {
                    automationInboxRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
                  }
                }}
              >
                <Mail size={14} /> Open inbox
              </button>
            </div>
            {companionLoading && companionInboxItems.length === 0 ? (
              <div className="home-automation-inbox-empty">Loading companion inbox...</div>
            ) : companionError && companionInboxItems.length === 0 ? (
              <div className="home-automation-inbox-empty">{companionError}</div>
            ) : companionInboxItems.length === 0 ? (
              <div className="home-automation-inbox-empty">
                No automation messages yet. When heartbeat, reflection, or memory produce
                suggestions or completed work, they will surface here like an inbox.
              </div>
            ) : (
              <>
                {selectedCompanionItem && (
                  <div className="home-automation-inbox-reader">
                    <div className="home-automation-inbox-reader-header">
                      <div className="home-automation-inbox-reader-from">
                        <span className="home-automation-inbox-pill">
                          {isCompanionTaskResultItem(selectedCompanionItem)
                            ? "Completed"
                            : selectedCompanionItem.recommendedDelivery === "nudge"
                            ? "Nudge"
                            : selectedCompanionItem.companionStyle === "email"
                              ? "Inbox"
                              : "Companion"}
                        </span>
                        <div>
                          <strong>
                            {selectedCompanionItem.sourceEntity ||
                              selectedCompanionItem.workspaceName ||
                              "Heartbeat"}
                          </strong>
                          <span>to you</span>
                        </div>
                      </div>
                      <span className="home-automation-inbox-time">
                        {formatRelativeTime(selectedCompanionItem.createdAt)}
                      </span>
                    </div>
                    <div className="home-automation-inbox-reader-subject">
                      Subject: {selectedCompanionItem.title}
                    </div>
                    <div className="home-automation-inbox-reader-body markdown-content">
                      <ReactMarkdown remarkPlugins={inboxMarkdownPlugins}>
                        {normalizeMarkdownForCollab(selectedCompanionItem.description || "")}
                      </ReactMarkdown>
                    </div>
                    {!isCompanionTaskResultItem(selectedCompanionItem) &&
                      selectedCompanionItem.actionPrompt && (
                      <div className="home-automation-inbox-reader-box">
                        <span>Suggested action</span>
                        <p>{selectedCompanionItem.actionPrompt}</p>
                      </div>
                    )}
                    {isCompanionTaskResultItem(selectedCompanionItem) &&
                      selectedCompanionItem.outputLabel && (
                        <div className="home-automation-inbox-reader-box">
                          <span>What came out of it</span>
                          <p>
                            {selectedCompanionItem.outputLabel}
                            {selectedCompanionItem.outputLocationLabel
                              ? ` in ${selectedCompanionItem.outputLocationLabel}`
                              : ""}
                          </p>
                        </div>
                      )}
                    <div className="home-automation-inbox-meta">
                      <span>
                        {isCompanionTaskResultItem(selectedCompanionItem)
                          ? selectedCompanionItem.terminalLabel
                          : selectedCompanionItem.urgency
                            ? `Priority: ${selectedCompanionItem.urgency}`
                            : "Inbox item"}
                      </span>
                      {isCompanionTaskResultItem(selectedCompanionItem) && (
                        <span>{selectedCompanionItem.automationTag}</span>
                      )}
                      <span>
                        {!isCompanionTaskResultItem(selectedCompanionItem) &&
                        selectedCompanionItem.workspaceScope === "all"
                          ? "All workspaces"
                          : selectedCompanionItem.workspaceName || "Current workspace"}
                      </span>
                      {isCompanionTaskResultItem(selectedCompanionItem) &&
                        selectedCompanionItem.outputCount && (
                          <span>
                            {selectedCompanionItem.outputCount} output
                            {selectedCompanionItem.outputCount === 1 ? "" : "s"}
                          </span>
                        )}
                      {selectedCompanionItem.sourceTaskId && <span>Related task available</span>}
                    </div>
                    <div className="home-automation-inbox-actions">
                      {selectedCompanionItem.sourceTaskId && (
                        <button
                          type="button"
                          className="home-automation-inbox-action"
                          onClick={() => {
                            if (selectedCompanionItem.sourceTaskId) {
                              onOpenTask(selectedCompanionItem.sourceTaskId);
                            }
                          }}
                        >
                          {isCompanionTaskResultItem(selectedCompanionItem) ? "Open task" : "Open related task"}
                        </button>
                      )}
                      {!isCompanionTaskResultItem(selectedCompanionItem) && (
                        <>
                          <button
                            type="button"
                            className="home-automation-inbox-action primary"
                            onClick={() => void handleActOnCompanionSuggestion(selectedCompanionItem)}
                            disabled={!selectedCompanionItem.actionPrompt}
                          >
                            Act
                          </button>
                          <button
                            type="button"
                            className="home-automation-inbox-action"
                            onClick={() => void handleSnoozeCompanionSuggestion(selectedCompanionItem.id)}
                          >
                            Snooze
                          </button>
                          <button
                            type="button"
                            className="home-automation-inbox-action"
                            onClick={() => void handleDismissCompanionSuggestion(selectedCompanionItem.id)}
                          >
                            Dismiss
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
                <div className="home-automation-inbox-list">
                  {companionInboxItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`home-automation-inbox-item ${
                        selectedCompanionItem?.id === item.id ? "selected" : ""
                      }`}
                      onClick={() => setSelectedCompanionItemId(item.id)}
                    >
                      <div className="home-automation-inbox-item-body">
                        <div className="home-automation-inbox-item-top">
                          <div className="home-automation-inbox-item-sender">
                            <span className="home-automation-inbox-pill">
                              {isCompanionTaskResultItem(item)
                                ? "Completed"
                                : item.recommendedDelivery === "nudge"
                                ? "Nudge"
                                : item.companionStyle === "email"
                                  ? "Inbox"
                                  : "Companion"}
                            </span>
                            <strong className="home-automation-inbox-item-sender-name">
                              {item.sourceEntity || item.workspaceName || "Heartbeat"}
                            </strong>
                          </div>
                          <span className="home-automation-inbox-time">
                            {formatRelativeTime(item.createdAt)}
                          </span>
                        </div>
                        <div className="home-automation-inbox-item-subject">{item.title}</div>
                        <p className="home-automation-inbox-preview">{item.description}</p>
                      </div>
                      <div className="home-automation-inbox-meta">
                        <span>
                          {isCompanionTaskResultItem(item)
                            ? item.terminalLabel
                            : item.urgency
                              ? `Priority: ${item.urgency}`
                              : "Inbox item"}
                        </span>
                        {isCompanionTaskResultItem(item) && <span>{item.automationTag}</span>}
                        <span>
                          {!isCompanionTaskResultItem(item) && item.workspaceScope === "all"
                            ? "All workspaces"
                            : item.workspaceName || "Current workspace"}
                        </span>
                        {isCompanionTaskResultItem(item) && item.outputLabel && <span>{item.outputLabel}</span>}
                        {item.sourceTaskId && <span>Task linked</span>}
                        {!isCompanionTaskResultItem(item) && item.read === false && <span>Unread</span>}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="home-automation-strip">
            <button type="button" className="home-auto-card" onClick={onOpenScheduledTasks}>
              <div className="home-auto-card-icon">
                <TimerReset size={20} />
              </div>
              <div className="home-auto-card-copy">
                <strong>Triggered Work</strong>
                <span>{automationGroups.cron} recurring</span>
              </div>
            </button>
            <button type="button" className="home-auto-card" onClick={onOpenMissionControl}>
              <div className="home-auto-card-icon">
                <Bot size={20} />
              </div>
              <div className="home-auto-card-copy">
                <strong>Core automation</strong>
                <span>{automationGroups.heartbeat} heartbeat reviews</span>
              </div>
            </button>
            <button type="button" className="home-auto-card" onClick={onOpenEventTriggers}>
              <div className="home-auto-card-icon">
                <Zap size={20} />
              </div>
              <div className="home-auto-card-copy">
                <strong>Triggers</strong>
                <span>{automationGroups.hook + automationGroups.api} triggers</span>
              </div>
            </button>
            <button type="button" className="home-auto-card" onClick={onOpenSelfImprove}>
              <div className="home-auto-card-icon">
                <Sparkles size={20} />
              </div>
              <div className="home-auto-card-copy">
                <strong>Workflow Intelligence</strong>
                <span>{automationGroups.improvement} core runs</span>
              </div>
            </button>
          </div>
          {automatedTasks.length > 0 && (
            <div className="home-automation-panel">
              <div className="home-automation-panel-header">
                <span>
                  {automatedTasks.length} automated task{automatedTasks.length === 1 ? "" : "s"}
                </span>
              </div>
              <div
                className="home-automation-list"
                onScroll={handleAutomationListScroll}
              >
                {automationTopSpacer > 0 && (
                  <div
                    aria-hidden="true"
                    style={{ height: `${automationTopSpacer}px`, flexShrink: 0 }}
                  />
                )}
                {visibleAutomatedTasks.map((task) => {
                  const status = getTaskStatusInfo(task);
                  const sender = getAutomationSender(task);
                  const tag = getAutomationTag(task);
                  const preview = getAutomationPreview(task);
                  return (
                    <button
                      type="button"
                      key={task.id}
                      className="home-automation-row home-automation-mail-row"
                      onClick={() => onOpenTask(task.id)}
                    >
                      <div className="home-automation-mail-row-top">
                        <div className="home-automation-mail-row-sender">
                          <span className="home-automation-inbox-pill">{tag}</span>
                          <strong>{sender}</strong>
                        </div>
                        <span className="home-automation-row-time">
                          {formatRelativeTime(task.updatedAt || task.createdAt)}
                        </span>
                      </div>
                      <div className="home-automation-mail-row-subject">{task.title}</div>
                      <div className="home-automation-mail-row-preview">{preview}</div>
                      <div className="home-automation-mail-row-meta">
                        <span>{status.label}</span>
                        {task.resultSummary?.trim() && <span>Result ready</span>}
                        {resolveTaskOutputSummaryFromTask(task)?.outputCount ? (
                          <span>
                            {resolveTaskOutputSummaryFromTask(task)?.outputCount} output
                            {resolveTaskOutputSummaryFromTask(task)?.outputCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
                {automationBottomSpacer > 0 && (
                  <div
                    aria-hidden="true"
                    style={{ height: `${automationBottomSpacer}px`, flexShrink: 0 }}
                  />
                )}
              </div>
              <div className="home-automation-panel-footer">
                <span>Click a row to open the task in normal task view.</span>
              </div>
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
