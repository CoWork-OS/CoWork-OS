import { useState, useEffect, useMemo, type ComponentType } from "react";
import { Task, Workspace, TaskEvent, PlanStep, QueueStatus } from "../../shared/types";
import { isVerificationStepDescription } from "../../shared/plan-utils";
import { FileViewer } from "./FileViewer";
import { useAgentContext } from "../hooks/useAgentContext";
import {
  Cloud, Database, MessageCircle, Wrench, ClipboardList, KeyRound, Mail,
  Hash, Gamepad2, FileEdit, Github, GitBranch, FolderOpen,
  CreditCard, Phone, BarChart3, BookOpen, Calendar,
  Palette, Shield, Zap, Search, Plug, PenLine, Flame, Bell,
  type LucideProps,
} from "lucide-react";
import { EMOJI_ICON_MAP } from "../utils/emoji-icon-map";

/**
 * Map connector name patterns to Lucide icon components.
 * Matched against the lowercase connector name/ID.
 */
const CONNECTOR_LUCIDE_MAP: Record<string, ComponentType<LucideProps>> = {
  salesforce: Cloud,
  jira: ClipboardList,
  hubspot: MessageCircle,
  zendesk: MessageCircle,
  servicenow: Wrench,
  linear: PenLine,
  asana: ClipboardList,
  okta: KeyRound,
  resend: Mail,
  slack: Hash,
  discord: Gamepad2,
  notion: FileEdit,
  github: Github,
  gitlab: GitBranch,
  "google-drive": FolderOpen,
  "google drive": FolderOpen,
  gmail: Mail,
  bigquery: Database,
  intercom: MessageCircle,
  docusign: PenLine,
  stripe: CreditCard,
  twilio: Phone,
  sendgrid: Mail,
  datadog: BarChart3,
  pagerduty: Bell,
  confluence: BookOpen,
  trello: ClipboardList,
  monday: Calendar,
  airtable: Database,
  figma: Palette,
  sentry: Shield,
  supabase: Zap,
  firebase: Flame,
  postgres: Database,
  mongodb: Database,
  redis: Database,
  elasticsearch: Search,
};

/** Resolve a Lucide icon component for a connector by name, falling back to emoji map then Plug. */
function resolveConnectorLucideIcon(name: string, emoji: string): ComponentType<LucideProps> {
  const lower = name.toLowerCase();
  for (const [key, Icon] of Object.entries(CONNECTOR_LUCIDE_MAP)) {
    if (lower.includes(key)) return Icon;
  }
  return EMOJI_ICON_MAP[emoji] || Plug;
}

/** Resolve a Lucide icon component for a skill from its emoji, falling back to Zap. */
function resolveSkillLucideIcon(emoji: string): ComponentType<LucideProps> {
  return EMOJI_ICON_MAP[emoji] || Zap;
}

// Clickable file path component - opens file viewer on click, shows in Finder on right-click
function ClickableFilePath({
  path,
  workspacePath,
  className = "",
  onOpenViewer,
}: {
  path: string;
  workspacePath?: string;
  className?: string;
  onOpenViewer?: (path: string) => void;
}) {
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // If viewer callback is provided and we have a workspace, use the in-app viewer
    if (onOpenViewer && workspacePath) {
      onOpenViewer(path);
      return;
    }

    // Fallback to external app
    try {
      const error = await window.electronAPI.openFile(path, workspacePath);
      if (error) {
        console.error("Failed to open file:", error);
      }
    } catch (err) {
      console.error("Error opening file:", err);
    }
  };

  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await window.electronAPI.showInFinder(path, workspacePath);
    } catch (err) {
      console.error("Error showing in Finder:", err);
    }
  };

  const fileName = path.split("/").pop() || path;

  return (
    <span
      className={`clickable-file-path ${className}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={`${path}\n\nClick to preview • Right-click to show in Finder`}
    >
      {fileName}
    </span>
  );
}

interface RightPanelProps {
  task: Task | undefined;
  workspace: Workspace | null;
  events: TaskEvent[];
  tasks?: Task[];
  queueStatus?: QueueStatus | null;
  onSelectTask?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => void;
}

interface FileInfo {
  path: string;
  action: "created" | "modified" | "deleted";
  timestamp: number;
}

interface ToolUsage {
  name: string;
  count: number;
  lastUsed: number;
}

export function RightPanel({
  task,
  workspace,
  events,
  tasks = [],
  queueStatus,
  onSelectTask,
  onCancelTask,
}: RightPanelProps) {
  const [expandedSections, setExpandedSections] = useState({
    progress: true,
    queue: true,
    folder: true,
    activeContext: true,
    context: true,
  });
  const [viewerFilePath, setViewerFilePath] = useState<string | null>(null);
  const agentContext = useAgentContext();

  // Active context: connectors + skills
  const [activeContext, setActiveContext] = useState<{
    connectors: { id: string; name: string; icon: string; status: string }[];
    skills: { id: string; name: string; icon: string }[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadContext() {
      try {
        const data = await window.electronAPI.getActiveContext();
        if (!cancelled) setActiveContext(data);
      } catch {
        // Context load failed silently
      }
    }

    loadContext();
    const interval = setInterval(loadContext, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Queue data
  const runningTasks = useMemo(
    () => (queueStatus ? tasks.filter((t) => queueStatus.runningTaskIds.includes(t.id)) : []),
    [tasks, queueStatus],
  );
  const queuedTasks = useMemo(
    () => (queueStatus ? tasks.filter((t) => queueStatus.queuedTaskIds.includes(t.id)) : []),
    [tasks, queueStatus],
  );
  const totalQueueActive = (queueStatus?.runningCount || 0) + (queueStatus?.queuedCount || 0);

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  // Extract plan steps from events
  const planSteps = useMemo((): PlanStep[] => {
    const planEvent = events.find((e) => e.type === "plan_created");
    if (!planEvent?.payload?.plan?.steps) return [];

    // Get the base steps from the plan
    const steps = [...planEvent.payload.plan.steps];

    // Update step statuses based on step events
    events.forEach((event) => {
      if (event.type === "step_started" && event.payload.step) {
        const step = steps.find((s) => s.id === event.payload.step.id);
        if (step) step.status = "in_progress";
      }
      if (event.type === "step_completed" && event.payload.step) {
        const step = steps.find((s) => s.id === event.payload.step.id);
        if (step) step.status = "completed";
      }
      if (event.type === "step_failed" && event.payload.step) {
        const step = steps.find((s) => s.id === event.payload.step.id);
        if (step) {
          step.status = "failed";
          if (event.payload.reason && !step.error) step.error = String(event.payload.reason);
        }
      }
    });

    // Hide the explicit verification step (unless it failed).
    return steps.filter(
      (step) => !isVerificationStepDescription(step.description) || step.status === "failed",
    );
  }, [events]);

  // Extract files from events
  const files = useMemo((): FileInfo[] => {
    const fileMap = new Map<string, FileInfo>();

    events.forEach((event) => {
      if (event.type === "file_created" && event.payload.path) {
        fileMap.set(event.payload.path, {
          path: event.payload.path,
          action: "created",
          timestamp: event.timestamp,
        });
      }
      if (event.type === "file_modified" && (event.payload.path || event.payload.from)) {
        const path = event.payload.path || event.payload.from;
        fileMap.set(path, {
          path,
          action: "modified",
          timestamp: event.timestamp,
        });
      }
      if (event.type === "file_deleted" && event.payload.path) {
        fileMap.set(event.payload.path, {
          path: event.payload.path,
          action: "deleted",
          timestamp: event.timestamp,
        });
      }
    });

    return Array.from(fileMap.values())
      .filter((f) => {
        // Filter out directories – only show actual files
        const name = f.path.split("/").pop() || f.path;
        return name.includes(".");
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [events]);

  // Extract tool usage from events
  const toolUsage = useMemo((): ToolUsage[] => {
    const toolMap = new Map<string, ToolUsage>();

    events.forEach((event) => {
      if (event.type === "tool_call" && event.payload.tool) {
        const existing = toolMap.get(event.payload.tool);
        if (existing) {
          existing.count++;
          existing.lastUsed = event.timestamp;
        } else {
          toolMap.set(event.payload.tool, {
            name: event.payload.tool,
            count: 1,
            lastUsed: event.timestamp,
          });
        }
      }
    });

    return Array.from(toolMap.values()).sort((a, b) => b.lastUsed - a.lastUsed);
  }, [events]);

  // Extract referenced files from tool results (files that were read)
  const referencedFiles = useMemo((): string[] => {
    const files = new Set<string>();

    events.forEach((event) => {
      if (event.type === "tool_call") {
        // Check if it's a read_file or list_directory call
        if (event.payload.tool === "read_file" && event.payload.input?.path) {
          files.add(event.payload.input.path);
        }
        if (event.payload.tool === "search_files" && event.payload.input?.path) {
          files.add(event.payload.input.path);
        }
      }
    });

    return Array.from(files).slice(0, 10); // Limit to 10 most recent
  }, [events]);

  // Get status indicator (terminal vs modern)
  const getStatusIndicator = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <>
            <span className="terminal-only">[✓]</span>
            <span className="modern-only">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          </>
        );
      case "in_progress":
        return (
          <>
            <span className="terminal-only">[~]</span>
            <span className="modern-only">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
              </svg>
            </span>
          </>
        );
      case "failed":
        return (
          <>
            <span className="terminal-only">[✗]</span>
            <span className="modern-only">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </span>
          </>
        );
      default:
        return (
          <>
            <span className="terminal-only">[ ]</span>
            <span className="modern-only">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" opacity="0.3" />
              </svg>
            </span>
          </>
        );
    }
  };

  const getFileActionSymbol = (action: FileInfo["action"]) => {
    switch (action) {
      case "created":
        return "+";
      case "modified":
        return "~";
      case "deleted":
        return "-";
    }
  };

  return (
    <div className="right-panel cli-panel">
      {/* Progress Section */}
      <div className="right-panel-section cli-section">
        <div className="cli-section-header" onClick={() => toggleSection("progress")}>
          <span className="cli-section-prompt">&gt;</span>
          <span className="cli-section-title">
            <span className="terminal-only">{agentContext.getUiCopy("rightProgressTitle")}</span>
            <span className="modern-only">Progress</span>
          </span>
          <span className="cli-section-toggle">
            <span className="terminal-only">{expandedSections.progress ? "[-]" : "[+]"}</span>
            <span className="modern-only">{expandedSections.progress ? "−" : "+"}</span>
          </span>
        </div>
        {expandedSections.progress && (
          <div className="cli-section-content">
            {planSteps.length > 0 ? (
              <div className="cli-progress-list">
                {planSteps.map((step, index) => (
                  <div key={step.id || index} className={`cli-progress-item ${step.status}`}>
                    <span className="cli-progress-num">{String(index + 1).padStart(2, "0")}</span>
                    <span className={`cli-progress-status ${step.status}`}>
                      {getStatusIndicator(step.status)}
                    </span>
                    <span className="cli-progress-text" title={step.description}>
                      {step.description}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="cli-empty-state">
                <div
                  className={`cli-status-badge ${task?.status === "executing" ? "active" : task?.status === "paused" ? "paused" : task?.status === "blocked" ? "blocked" : task?.status === "completed" ? "completed" : ""}`}
                >
                  <span className="terminal-only">
                    {task?.status === "executing"
                      ? "◉ WORKING..."
                      : task?.status === "paused"
                        ? "⏸ WAITING"
                        : task?.status === "blocked"
                          ? "! NEEDS YOUR GO-AHEAD"
                          : task?.status === "completed"
                            ? "✓ ALL DONE"
                            : "○ READY"}
                  </span>
                  <span className="modern-only">
                    {task?.status === "executing"
                      ? "Working..."
                      : task?.status === "paused"
                        ? "Waiting for your cue"
                        : task?.status === "blocked"
                          ? "Needs your go-ahead"
                          : task?.status === "completed"
                            ? "All done"
                            : "Ready"}
                  </span>
                </div>
                <p className="cli-hint">
                  <span className="terminal-only">
                    {agentContext.getUiCopy("rightProgressEmptyHint")}
                  </span>
                  <span className="modern-only">Standing by when you are ready.</span>
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Lineup Section */}
      {totalQueueActive > 0 && (
        <div className="right-panel-section cli-section">
          <div className="cli-section-header" onClick={() => toggleSection("queue")}>
            <span className="cli-section-prompt">&gt;</span>
            <span className="cli-section-title">
              <span className="terminal-only">{agentContext.getUiCopy("rightQueueTitle")}</span>
              <span className="modern-only">Queue</span>
            </span>
            <span className="cli-queue-badge">
              {queueStatus?.runningCount}/{queueStatus?.maxConcurrent}
              {queueStatus && queueStatus.queuedCount > 0 && ` +${queueStatus.queuedCount}`}
            </span>
            <span className="cli-section-toggle">
              <span className="terminal-only">{expandedSections.queue ? "[-]" : "[+]"}</span>
              <span className="modern-only">{expandedSections.queue ? "−" : "+"}</span>
            </span>
          </div>
          {expandedSections.queue && (
            <div className="cli-section-content">
              {runningTasks.length > 0 && (
                <div className="cli-queue-group">
                  <div className="cli-context-label">
                    <span className="terminal-only">
                      {agentContext.getUiCopy("rightQueueActiveLabel")}
                    </span>
                    <span className="modern-only">Active</span>
                  </div>
                  {runningTasks.map((t) => (
                    <div key={t.id} className="cli-queue-item running">
                      <span className="cli-queue-status">
                        <span className="terminal-only">[~]</span>
                        <span className="modern-only">
                          <span className="queue-status-dot running" />
                        </span>
                      </span>
                      <span className="cli-queue-title" onClick={() => onSelectTask?.(t.id)}>
                        {t.title || t.prompt}
                      </span>
                      <button
                        className="cli-queue-cancel"
                        onClick={() => onCancelTask?.(t.id)}
                        title="Cancel"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {queuedTasks.length > 0 && (
                <div className="cli-queue-group">
                  <div className="cli-context-label">
                    <span className="terminal-only">
                      {agentContext.getUiCopy("rightQueueNextLabel")}
                    </span>
                    <span className="modern-only">Up next</span>
                  </div>
                  {queuedTasks.map((t, i) => (
                    <div key={t.id} className="cli-queue-item queued">
                      <span className="cli-queue-status">
                        <span className="terminal-only">[{i + 1}]</span>
                        <span className="modern-only">
                          <span className="queue-status-pill">{i + 1}</span>
                        </span>
                      </span>
                      <span className="cli-queue-title" onClick={() => onSelectTask?.(t.id)}>
                        {t.title || t.prompt}
                      </span>
                      <button
                        className="cli-queue-cancel"
                        onClick={() => onCancelTask?.(t.id)}
                        title="Cancel"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Working Folder Section */}
      <div className="right-panel-section cli-section">
        <div className="cli-section-header" onClick={() => toggleSection("folder")}>
          <span className="cli-section-prompt">&gt;</span>
          <span className="cli-section-title">
            <span className="terminal-only">{agentContext.getUiCopy("rightFilesTitle")}</span>
            <span className="modern-only">Files</span>
          </span>
          <span className="cli-section-toggle">
            <span className="terminal-only">{expandedSections.folder ? "[-]" : "[+]"}</span>
            <span className="modern-only">{expandedSections.folder ? "−" : "+"}</span>
          </span>
        </div>
        {expandedSections.folder && (
          <div className="cli-section-content">
            {files.length > 0 ? (
              <div className="cli-file-list">
                {files.map((file, index) => (
                  <div key={`${file.path}-${index}`} className={`cli-file-item ${file.action}`}>
                    <span className={`cli-file-action ${file.action}`}>
                      <span className="terminal-only">{getFileActionSymbol(file.action)}</span>
                      <span className="modern-only">
                        <span className="file-action-dot" />
                      </span>
                    </span>
                    <ClickableFilePath
                      path={file.path}
                      workspacePath={workspace?.path}
                      className="cli-file-name"
                      onOpenViewer={setViewerFilePath}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="cli-empty-state">
                <pre className="cli-tree">
                  {`├── (empty)
└── ...`}
                </pre>
                <p className="cli-hint">
                  <span className="terminal-only">
                    {agentContext.getUiCopy("rightFilesEmptyHint")}
                  </span>
                  <span className="modern-only">No file changes yet.</span>
                </p>
              </div>
            )}
            {workspace && (
              <div className="cli-workspace-path">
                <span className="cli-label">
                  <span className="terminal-only">PWD:</span>
                  <span className="modern-only">Workspace</span>
                </span>
                <span className="cli-path" title={workspace.path}>
                  {workspace.name}/
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Active Context Section (Connectors + Skills) */}
      {(() => {
        const connectedServers = activeContext?.connectors.filter((c) => c.status === "connected") || [];
        const activeSkills = activeContext?.skills || [];
        const activeCount = connectedServers.length + activeSkills.length;
        const hasActiveContent = connectedServers.length > 0 || activeSkills.length > 0;

        return (
          <div className="right-panel-section cli-section">
            <div className="cli-section-header" onClick={() => toggleSection("activeContext")}>
              <span className="cli-section-prompt">&gt;</span>
              <span className="cli-section-title">
                <span className="terminal-only">ACTIVE</span>
                <span className="modern-only">Active Context</span>
              </span>
              {activeCount > 0 && (
                <span className="cli-active-context-badge">{activeCount}</span>
              )}
              <span className="cli-section-toggle">
                <span className="terminal-only">{expandedSections.activeContext ? "[-]" : "[+]"}</span>
                <span className="modern-only">{expandedSections.activeContext ? "−" : "+"}</span>
              </span>
            </div>
            {expandedSections.activeContext && (
              <div className="cli-section-content">
                {hasActiveContent ? (
                  <div className="cli-context-list">
                    {connectedServers.length > 0 && (
                      <div className="cli-context-group">
                        <div className="cli-context-label">
                          <span className="terminal-only"># connectors:</span>
                          <span className="modern-only">Connectors</span>
                        </div>
                        {connectedServers.map((c) => {
                          const ConnIcon = resolveConnectorLucideIcon(c.name, c.icon);
                          return (
                            <div key={c.id} className="cli-context-item">
                              <span className="cli-active-context-icon"><ConnIcon size={14} /></span>
                              <span className="cli-context-key">{c.name}</span>
                              <span className="cli-active-context-status connected" />
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {activeSkills.length > 0 && (
                      <div className="cli-context-group">
                        <div className="cli-context-label">
                          <span className="terminal-only"># skills:</span>
                          <span className="modern-only">Skills</span>
                        </div>
                        {activeSkills.slice(0, 10).map((s) => {
                          const SkillIcon = resolveSkillLucideIcon(s.icon);
                          return (
                            <div key={s.id} className="cli-context-item">
                              <span className="cli-active-context-icon"><SkillIcon size={14} /></span>
                              <span className="cli-context-key">{s.name}</span>
                            </div>
                          );
                        })}
                        {activeSkills.length > 10 && (
                          <div className="cli-context-item cli-context-overflow">
                            +{activeSkills.length - 10} more
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="cli-empty-state">
                    <div className="cli-context-empty">
                      <span className="terminal-only">connectors: 0 skills: 0</span>
                      <span className="modern-only">No active integrations</span>
                    </div>
                    <p className="cli-hint">
                      <span className="terminal-only"># configure in settings</span>
                      <span className="modern-only">Set up connectors or skills in Settings.</span>
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Context Section */}
      <div className="right-panel-section cli-section">
        <div className="cli-section-header" onClick={() => toggleSection("context")}>
          <span className="cli-section-prompt">&gt;</span>
          <span className="cli-section-title">
            <span className="terminal-only">{agentContext.getUiCopy("rightContextTitle")}</span>
            <span className="modern-only">Context</span>
          </span>
          <span className="cli-section-toggle">
            <span className="terminal-only">{expandedSections.context ? "[-]" : "[+]"}</span>
            <span className="modern-only">{expandedSections.context ? "−" : "+"}</span>
          </span>
        </div>
        {expandedSections.context && (
          <div className="cli-section-content">
            {toolUsage.length > 0 || referencedFiles.length > 0 ? (
              <div className="cli-context-list">
                {toolUsage.length > 0 && (
                  <div className="cli-context-group">
                    <div className="cli-context-label">
                      <span className="terminal-only"># tools_used:</span>
                      <span className="modern-only">Tools used</span>
                    </div>
                    {toolUsage.map((tool, index) => (
                      <div key={`${tool.name}-${index}`} className="cli-context-item">
                        <span className="cli-context-key">{tool.name}</span>
                        <span className="cli-context-sep">:</span>
                        <span className="cli-context-val">{tool.count}x</span>
                      </div>
                    ))}
                  </div>
                )}
                {referencedFiles.length > 0 && (
                  <div className="cli-context-group">
                    <div className="cli-context-label">
                      <span className="terminal-only"># files_read:</span>
                      <span className="modern-only">Files read</span>
                    </div>
                    {referencedFiles.map((file, index) => (
                      <div key={`${file}-${index}`} className="cli-context-item">
                        <ClickableFilePath
                          path={file}
                          workspacePath={workspace?.path}
                          className="cli-context-file"
                          onOpenViewer={setViewerFilePath}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="cli-empty-state">
                <div className="cli-context-empty">
                  <span className="terminal-only">tools: 0 files: 0</span>
                  <span className="modern-only">Nothing shared yet.</span>
                </div>
                <p className="cli-hint">
                  <span className="terminal-only">
                    {agentContext.getUiCopy("rightContextEmptyHint")}
                  </span>
                  <span className="modern-only">Share tools or files to populate this panel.</span>
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Empty space filler */}
      <div style={{ flex: 1 }} />

      {/* Footer note */}
      <div className="cli-panel-footer">
        <span className="cli-footer-prompt">
          <span className="terminal-only">$</span>
          <span className="modern-only">•</span>
        </span>
        <span className="cli-footer-text">
          <span className="terminal-only">{agentContext.getUiCopy("rightFooterText")}</span>
          <span className="modern-only">Local work only</span>
        </span>
      </div>

      {/* File Viewer Modal */}
      {viewerFilePath && workspace?.path && (
        <FileViewer
          filePath={viewerFilePath}
          workspacePath={workspace.path}
          onClose={() => setViewerFilePath(null)}
        />
      )}
    </div>
  );
}
