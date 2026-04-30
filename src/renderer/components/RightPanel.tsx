import { memo, useState, useEffect, useMemo, useRef, useCallback, useDeferredValue, type ComponentType } from "react";
import {
  Task,
  Workspace,
  TaskEvent,
  PlanStep,
  QueueStatus,
  SessionChecklistItem,
  SessionChecklistState,
} from "../../shared/types";
import { isVerificationStepDescription } from "../../shared/plan-utils";
import { DocumentAwareFileModal } from "./DocumentAwareFileModal";
import { useAgentContext } from "../hooks/useAgentContext";
import {
  deriveTaskOutputSummaryFromEvents,
  hasTaskOutputs,
  resolvePreferredTaskOutputSummary,
} from "../utils/task-outputs";
import { normalizeEventsForTimelineUi } from "../utils/timeline-projection";
import { getEffectiveTaskEventType } from "../utils/task-event-compat";
import {
  type FileInfo,
  type SharedTaskEventUiState,
  type ToolUsage,
} from "../utils/task-event-derived";
import {
  Cloud,
  Database,
  MessageCircle,
  Wrench,
  ClipboardList,
  KeyRound,
  Mail,
  Hash,
  Gamepad2,
  FileEdit,
  Github,
  GitBranch,
  FolderOpen,
  CreditCard,
  Phone,
  BarChart3,
  BookOpen,
  Calendar,
  Palette,
  Shield,
  Zap,
  Search,
  Plug,
  PenLine,
  Flame,
  Bell,
  type LucideProps,
} from "lucide-react";
import { getEmojiIcon } from "../utils/emoji-icon-map";
import { measureRendererPerf, recordRendererRender } from "../utils/renderer-perf";

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
  return getEmojiIcon(emoji) || Plug;
}

const TOOL_FRIENDLY_LABELS: Record<string, string> = {
  glob: "Search for files",
  grep: "Search code",
  read: "Read file",
  edit: "Edit file",
  write: "Write file",
  bash: "Run command",
  agent: "Delegate to sub-agent",
  web_fetch: "Fetch web page",
  web_search: "Search the web",
  todo_write: "Update task list",
  skill: "Run skill",
  request_user_input: "Collect details from you",
};

/**
 * Strips technical tool-call language from LLM-generated plan step descriptions.
 * Converts e.g. "Use the `Skill` tool with skill ID `novelist`..." into
 * "Run the Novelist skill" so the Progress panel stays readable.
 */
function humanizeStepDescription(description: string): string {
  if (!description) return description;

  // "Use the `Skill` tool with skill ID `<id>`..." → "Run the <Id> skill"
  const useSkillMatch = description.match(
    /use\s+the\s+`?Skill`?\s+tool\s+with\s+skill\s+(?:ID\s+)?`?([a-z0-9_-]+)`?/i,
  );
  if (useSkillMatch) {
    const skillId = useSkillMatch[1];
    const skillName = skillId
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    // Append any meaningful context after the skill ID match
    const rest = description.slice(description.indexOf(useSkillMatch[0]) + useSkillMatch[0].length).trim();
    const suffix = rest.replace(/^[^a-zA-Z]*/, "").split(/[.]/)[0].trim();
    const humanized = suffix.length > 4 ? `Run the ${skillName} skill — ${suffix}` : `Run the ${skillName} skill`;
    return stripInlineMarkdownFormatting(humanized);
  }

  // "Use request_user_input to collect..." → "Collect details from you"
  if (/use\s+request_user_input\b/i.test(description)) {
    const rest = description.replace(/use\s+request_user_input\s+(to\s+)?/i, "").trim();
    const clean = rest.replace(/`[^`]+`/g, "").trim();
    const humanized = clean.length > 4 ? capitalize(clean) : "Collect details from you";
    return stripInlineMarkdownFormatting(humanized);
  }

  // Detect raw tool-call text leaking into descriptions: "to=glob 】【..." or "assistant to=read ..."
  const rawToolCallMatch = description.match(/^\s*(?:assistant\s+)?to=([a-z_][\w-]*)\b/i);
  if (rawToolCallMatch) {
    const toolName = rawToolCallMatch[1].toLowerCase();
    const humanized = TOOL_FRIENDLY_LABELS[toolName] ?? capitalize(toolName.replace(/_/g, " "));
    return stripInlineMarkdownFormatting(humanized);
  }

  return stripInlineMarkdownFormatting(description);
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripInlineMarkdownFormatting(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function getTaskEventActivityText(event: TaskEvent | null): string | null {
  if (!event) return null;
  const effectiveType = getEffectiveTaskEventType(event);
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};

  if (
    (effectiveType === "skill_applied" || effectiveType === "skill_used") &&
    typeof payload.skillName === "string" &&
    payload.skillName.trim().length > 0
  ) {
    return `Using ${payload.skillName.trim()}`;
  }

  if (effectiveType === "tool_call" && typeof payload.tool === "string") {
    if (payload.tool === "skill") {
      const input =
        payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
          ? (payload.input as Record<string, unknown>)
          : {};
      const rawSkillName =
        typeof input.skill_name === "string"
          ? input.skill_name
          : typeof input.skillName === "string"
            ? input.skillName
            : typeof input.skill_id === "string"
              ? input.skill_id
              : typeof input.skillId === "string"
                ? input.skillId
                : typeof input.skill === "string"
                  ? input.skill
                  : "";
      if (rawSkillName.trim().length > 0) {
        return `Running ${humanizeStepDescription(`Run the ${rawSkillName.trim()} skill`)}`;
      }
    }
    return TOOL_FRIENDLY_LABELS[payload.tool] ?? `Using ${payload.tool}`;
  }

  const step =
    payload.step && typeof payload.step === "object" && !Array.isArray(payload.step)
      ? (payload.step as Record<string, unknown>)
      : null;
  if (
    (effectiveType === "step_started" ||
      effectiveType === "progress_update" ||
      effectiveType === "step_completed") &&
    typeof step?.description === "string" &&
    step.description.trim().length > 0
  ) {
    return humanizeStepDescription(step.description.trim());
  }

  if (
    (effectiveType === "step_started" || effectiveType === "progress_update") &&
    typeof payload.message === "string" &&
    payload.message.trim().length > 0
  ) {
    return stripInlineMarkdownFormatting(payload.message.trim());
  }

  if (
    (effectiveType === "file_created" ||
      effectiveType === "file_modified" ||
      effectiveType === "artifact_created") &&
    typeof payload.path === "string" &&
    payload.path.trim().length > 0
  ) {
    const name = payload.path.split("/").pop() || payload.path;
    return `${effectiveType === "file_modified" ? "Updated" : "Created"} ${name}`;
  }

  return null;
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
  sharedTaskEventUi?: SharedTaskEventUiState | null;
  hasActiveChildren?: boolean;
  runningTasks?: Task[];
  queuedTasks?: Task[];
  queueStatus?: QueueStatus | null;
  onSelectTask?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => void;
  rendererPerfLoggingEnabled?: boolean;
  highlightOutputPath?: string | null;
  onHighlightConsumed?: () => void;
}

function getRightPanelTaskSignature(task: Task | undefined): string {
  if (!task) return "none";
  return [
    task.id,
    task.status,
    task.terminalStatus ?? "",
    task.updatedAt,
    task.completedAt ?? "",
    task.error ?? "",
  ].join(":");
}

function getQueueStatusSignature(queueStatus: QueueStatus | null | undefined): string {
  if (!queueStatus) return "none";
  return [
    queueStatus.runningCount,
    queueStatus.queuedCount,
    queueStatus.maxConcurrent,
    queueStatus.runningTaskIds.join(","),
    queueStatus.queuedTaskIds.join(","),
  ].join(":");
}

function getPlanStepsSignature(planSteps: PlanStep[]): string {
  return planSteps
    .map((step) => `${step.id}:${step.status}:${step.error ?? ""}:${step.description}`)
    .join("|");
}

function getTaskListSignature(tasks: Task[]): string {
  return tasks.map((task) => `${task.id}:${task.status}:${task.title || task.prompt}`).join("|");
}

export function getProgressSectionMaterialSignature(args: {
  expanded: boolean;
  planSteps: PlanStep[];
  taskStatus?: Task["status"];
  taskTerminalStatus?: Task["terminalStatus"];
  hasActiveChildren: boolean;
  emptyHintText: string;
}): string {
  return [
    args.expanded ? 1 : 0,
    getPlanStepsSignature(args.planSteps),
    args.taskStatus ?? "none",
    args.taskTerminalStatus ?? "none",
    args.hasActiveChildren ? 1 : 0,
    args.emptyHintText,
  ].join(":");
}

export function getQueueSectionMaterialSignature(args: {
  expanded: boolean;
  runningTasks: Task[];
  queuedTasks: Task[];
  activeLabel: string;
  nextLabel: string;
}): string {
  return [
    args.expanded ? 1 : 0,
    getTaskListSignature(args.runningTasks),
    getTaskListSignature(args.queuedTasks),
    args.activeLabel,
    args.nextLabel,
  ].join(":");
}

function getChecklistSignature(checklistState: SessionChecklistState | null): string {
  if (!checklistState) return "none";
  return [
    checklistState.updatedAt,
    checklistState.verificationNudgeNeeded ? 1 : 0,
    checklistState.nudgeReason ?? "",
    checklistState.items
      .map((item) => `${item.id}:${item.status}:${item.kind}:${item.updatedAt}:${item.title}`)
      .join("|"),
  ].join(":");
}

function getFilesSignature(files: FileInfo[]): string {
  return files.map((file) => `${file.path}:${file.action}:${file.timestamp}`).join("|");
}

function getConnectorsSignature(
  connectors: { id: string; name: string; icon: string; status: string; tools: string[] }[],
): string {
  return connectors
    .map((connector) => `${connector.id}:${connector.status}:${connector.name}:${connector.tools.join(",")}`)
    .join("|");
}

function getActiveContextSignature(
  activeContext:
    | {
        connectors: { id: string; name: string; icon: string; status: string; tools: string[] }[];
        skills: { id: string; name: string; icon: string }[];
      }
    | null
    | undefined,
): string {
  if (!activeContext) return "none";
  return [
    getConnectorsSignature(activeContext.connectors),
    activeContext.skills.map((skill) => `${skill.id}:${skill.name}:${skill.icon}`).join("|"),
  ].join("::");
}

function getToolUsageSignature(toolUsage: ToolUsage[]): string {
  return toolUsage.map((tool) => `${tool.name}:${tool.count}:${tool.lastUsed}`).join("|");
}

function getStringListSignature(values: string[]): string {
  return values.join("|");
}

const MAX_VISIBLE_PROGRESS_STEPS = 5;

type ProgressDisplayStep = PlanStep & {
  isOverflow?: boolean;
  hiddenCount?: number;
  hiddenLabel?: string;
};

function makeProgressOverflowStep(startIndex: number, endIndex: number, hiddenSteps: PlanStep[]): ProgressDisplayStep {
  const hiddenCount = Math.max(0, endIndex - startIndex + 1);
  const completedCount = hiddenSteps.filter((step) => step.status === "completed").length;
  const failedCount = hiddenSteps.filter((step) => step.status === "failed").length;
  const skippedCount = hiddenSteps.filter((step) => step.status === "skipped").length;
  const pendingCount = hiddenSteps.filter((step) => step.status === "pending").length;
  const status: PlanStep["status"] =
    failedCount > 0
      ? "failed"
      : hiddenCount > 0 && completedCount + skippedCount === hiddenCount
        ? "completed"
        : "pending";
  const descriptor =
    hiddenCount === 1
      ? completedCount === 1
        ? "1 completed step"
        : pendingCount === 1
          ? "1 planned step"
          : "1 step"
      : completedCount + skippedCount === hiddenCount
        ? `${hiddenCount} completed steps`
        : pendingCount === hiddenCount
          ? `${hiddenCount} planned steps`
          : `${hiddenCount} more steps`;
  return {
    id: `progress-overflow-${startIndex}-${endIndex}`,
    description: descriptor,
    status,
    isOverflow: true,
    hiddenCount,
    hiddenLabel: descriptor,
  };
}

export function getVisibleProgressSteps(planSteps: PlanStep[]): ProgressDisplayStep[] {
  if (planSteps.length <= MAX_VISIBLE_PROGRESS_STEPS) {
    return planSteps.map((step) => ({ ...step }));
  }

  const selected = new Set<number>();
  const activeIndex = planSteps.findIndex((step) => step.status === "in_progress");
  const firstPendingIndex = planSteps.findIndex((step) => step.status === "pending");
  const anchorIndex =
    activeIndex >= 0 ? activeIndex : firstPendingIndex >= 0 ? firstPendingIndex : planSteps.length - 1;

  planSteps.forEach((step, index) => {
    if (step.status === "failed") selected.add(index);
  });

  const completedBeforeAnchor = planSteps
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => index < anchorIndex && (step.status === "completed" || step.status === "skipped"))
    .slice(-2);
  completedBeforeAnchor.forEach(({ index }) => selected.add(index));

  selected.add(anchorIndex);

  const pendingAfterAnchor = planSteps
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => index > anchorIndex && step.status === "pending")
    .slice(0, 2);
  pendingAfterAnchor.forEach(({ index }) => selected.add(index));

  if (selected.size < MAX_VISIBLE_PROGRESS_STEPS) {
    for (let index = 0; index < planSteps.length && selected.size < MAX_VISIBLE_PROGRESS_STEPS; index += 1) {
      if (planSteps[index]?.status === "pending") selected.add(index);
    }
  }

  if (selected.size < MAX_VISIBLE_PROGRESS_STEPS) {
    for (let index = planSteps.length - 1; index >= 0 && selected.size < MAX_VISIBLE_PROGRESS_STEPS; index -= 1) {
      selected.add(index);
    }
  }

  const selectedIndexes = Array.from(selected).sort((a, b) => a - b);
  const displaySteps: ProgressDisplayStep[] = [];
  let previousIndex = -1;

  for (const index of selectedIndexes) {
    if (index > previousIndex + 1) {
      displaySteps.push(
        makeProgressOverflowStep(
          previousIndex + 1,
          index - 1,
          planSteps.slice(previousIndex + 1, index),
        ),
      );
    }
    displaySteps.push({ ...planSteps[index] });
    previousIndex = index;
  }

  if (previousIndex < planSteps.length - 1) {
    displaySteps.push(
      makeProgressOverflowStep(
        previousIndex + 1,
        planSteps.length - 1,
        planSteps.slice(previousIndex + 1),
      ),
    );
  }

  return displaySteps;
}

function useStableSnapshotBySignature<T>(value: T, signature: string): T {
  const snapshotRef = useRef<{ signature: string; value: T }>({ signature, value });
  if (snapshotRef.current.signature !== signature) {
    snapshotRef.current = { signature, value };
  }
  return snapshotRef.current.value;
}

const ProgressSectionContent = memo(function ProgressSectionContent({
  expanded,
  planSteps,
  taskStatus,
  taskTerminalStatus,
  hasActiveChildren,
  emptyHintText,
  fallbackActivityText,
  rendererPerfLoggingEnabled,
  getStatusIndicator,
}: {
  expanded: boolean;
  planSteps: PlanStep[];
  taskStatus?: Task["status"];
  taskTerminalStatus?: Task["terminalStatus"];
  hasActiveChildren: boolean;
  emptyHintText: string;
  fallbackActivityText: string | null;
  rendererPerfLoggingEnabled: boolean;
  getStatusIndicator: (status: string) => React.ReactNode;
}) {
  recordRendererRender("RightPanel.section", "progress", rendererPerfLoggingEnabled);
  if (!expanded) return null;
  const visiblePlanSteps = getVisibleProgressSteps(planSteps);
  return (
    <div className="cli-section-content">
      {planSteps.length > 0 ? (
        <div className="cli-progress-list">
          {visiblePlanSteps.map((step, index) => {
            const displayDescription =
              step.isOverflow
                ? step.hiddenLabel || step.description
                : humanizeStepDescription(step.description) || `Step ${index + 1}`;
            return (
              <div
                key={step.id || index}
                className={`cli-progress-item ${step.status}${step.isOverflow ? " compact-overflow" : ""}`}
              >
                <span className="cli-progress-num">
                  {step.isOverflow ? "…" : String(index + 1).padStart(2, "0")}
                </span>
                <span className={`cli-progress-status ${step.status}`}>
                  {step.isOverflow ? "…" : getStatusIndicator(step.status)}
                </span>
                <span className="cli-progress-text" title={displayDescription}>
                  {displayDescription}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="cli-empty-state">
          <div
            className={`cli-status-badge ${(taskStatus === "executing" || (taskStatus === "completed" && hasActiveChildren)) ? "active" : taskStatus === "paused" ? "paused" : taskStatus === "blocked" ? "blocked" : taskStatus === "completed" ? "completed" : ""}`}
          >
            <span className="terminal-only">
              {(taskStatus === "executing" || (taskStatus === "completed" && hasActiveChildren))
                ? "◉ WORKING..."
                : taskStatus === "paused"
                  ? "⏸ WAITING"
                  : taskStatus === "blocked"
                    ? "! NEEDS YOUR GO-AHEAD"
                    : taskStatus === "completed"
                      ? taskTerminalStatus === "needs_user_action"
                        ? "⚠ ACTION REQUIRED"
                        : "✓ ALL DONE"
                      : "○ READY"}
            </span>
            <span className="modern-only">
              {(taskStatus === "executing" || (taskStatus === "completed" && hasActiveChildren))
                ? "Working..."
                : taskStatus === "paused"
                  ? "Waiting for your cue"
                  : taskStatus === "blocked"
                    ? "Needs your go-ahead"
                    : taskStatus === "completed"
                      ? taskTerminalStatus === "needs_user_action"
                        ? "Completed - action required"
                        : "All done"
                      : "Ready"}
            </span>
          </div>
          <p className="cli-hint">
            <span className="terminal-only">{fallbackActivityText || emptyHintText}</span>
            <span className="modern-only">
              {fallbackActivityText ||
                (hasActiveChildren ? "Sub-task is still working..." : "Standing by when you are ready.")}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.expanded === next.expanded &&
  getPlanStepsSignature(prev.planSteps) === getPlanStepsSignature(next.planSteps) &&
  prev.taskStatus === next.taskStatus &&
  prev.taskTerminalStatus === next.taskTerminalStatus &&
  prev.hasActiveChildren === next.hasActiveChildren &&
  prev.emptyHintText === next.emptyHintText &&
  prev.fallbackActivityText === next.fallbackActivityText &&
  prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled
);

const QueueSectionContent = memo(function QueueSectionContent({
  expanded,
  runningTasks,
  queuedTasks,
  activeLabel,
  nextLabel,
  onSelectTask,
  onCancelTask,
  rendererPerfLoggingEnabled,
}: {
  expanded: boolean;
  runningTasks: Task[];
  queuedTasks: Task[];
  activeLabel: string;
  nextLabel: string;
  onSelectTask?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => void;
  rendererPerfLoggingEnabled: boolean;
}) {
  recordRendererRender("RightPanel.section", "queue", rendererPerfLoggingEnabled);
  if (!expanded) return null;
  return (
    <div className="cli-section-content">
      {runningTasks.length > 0 && (
        <div className="cli-queue-group">
          <div className="cli-context-label">
            <span className="terminal-only">{activeLabel}</span>
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
              <button className="cli-queue-cancel" onClick={() => onCancelTask?.(t.id)} title="Cancel">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {queuedTasks.length > 0 && (
        <div className="cli-queue-group">
          <div className="cli-context-label">
            <span className="terminal-only">{nextLabel}</span>
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
              <button className="cli-queue-cancel" onClick={() => onCancelTask?.(t.id)} title="Cancel">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.expanded === next.expanded &&
  getTaskListSignature(prev.runningTasks) === getTaskListSignature(next.runningTasks) &&
  getTaskListSignature(prev.queuedTasks) === getTaskListSignature(next.queuedTasks) &&
  prev.activeLabel === next.activeLabel &&
  prev.nextLabel === next.nextLabel &&
  prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled
);

const ProgressSection = memo(function ProgressSection({
  expanded,
  planSteps,
  taskStatus,
  taskTerminalStatus,
  hasActiveChildren,
  progressTitleText,
  emptyHintText,
  fallbackActivityText,
  toggleSection,
  rendererPerfLoggingEnabled,
  getStatusIndicator,
}: {
  expanded: boolean;
  planSteps: PlanStep[];
  taskStatus?: Task["status"];
  taskTerminalStatus?: Task["terminalStatus"];
  hasActiveChildren: boolean;
  progressTitleText: string;
  emptyHintText: string;
  fallbackActivityText: string | null;
  toggleSection: () => void;
  rendererPerfLoggingEnabled: boolean;
  getStatusIndicator: (status: string) => React.ReactNode;
}) {
  return (
    <div className="right-panel-section cli-section">
      <div className="cli-section-header" onClick={toggleSection}>
        <span className="cli-section-prompt">&gt;</span>
        <span className="cli-section-title">
          <span className="terminal-only">{progressTitleText}</span>
          <span className="modern-only">Progress</span>
        </span>
        <span className="cli-section-toggle">
          <span className="terminal-only">{expanded ? "[-]" : "[+]"}</span>
          <span className="modern-only">{expanded ? "−" : "+"}</span>
        </span>
      </div>
      <ProgressSectionContent
        expanded={expanded}
        planSteps={planSteps}
        taskStatus={taskStatus}
        taskTerminalStatus={taskTerminalStatus}
        hasActiveChildren={hasActiveChildren}
        emptyHintText={emptyHintText}
        fallbackActivityText={fallbackActivityText}
        rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
        getStatusIndicator={getStatusIndicator}
      />
    </div>
  );
}, (prev, next) =>
  getProgressSectionMaterialSignature({
    expanded: prev.expanded,
    planSteps: prev.planSteps,
    taskStatus: prev.taskStatus,
    taskTerminalStatus: prev.taskTerminalStatus,
    hasActiveChildren: prev.hasActiveChildren,
    emptyHintText: prev.emptyHintText,
  }) ===
    getProgressSectionMaterialSignature({
      expanded: next.expanded,
      planSteps: next.planSteps,
      taskStatus: next.taskStatus,
      taskTerminalStatus: next.taskTerminalStatus,
      hasActiveChildren: next.hasActiveChildren,
      emptyHintText: next.emptyHintText,
    }) &&
  prev.progressTitleText === next.progressTitleText &&
  prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled
);

const QueueSection = memo(function QueueSection({
  visible,
  expanded,
  runningTasks,
  queuedTasks,
  queueBadgeText,
  queueTitleText,
  activeLabel,
  nextLabel,
  toggleSection,
  onSelectTask,
  onCancelTask,
  rendererPerfLoggingEnabled,
}: {
  visible: boolean;
  expanded: boolean;
  runningTasks: Task[];
  queuedTasks: Task[];
  queueBadgeText: string;
  queueTitleText: string;
  activeLabel: string;
  nextLabel: string;
  toggleSection: () => void;
  onSelectTask?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => void;
  rendererPerfLoggingEnabled: boolean;
}) {
  if (!visible) return null;
  return (
    <div className="right-panel-section cli-section">
      <div className="cli-section-header" onClick={toggleSection}>
        <span className="cli-section-prompt">&gt;</span>
        <span className="cli-section-title">
          <span className="terminal-only">{queueTitleText}</span>
          <span className="modern-only">Queue</span>
        </span>
        <span className="cli-queue-badge">{queueBadgeText}</span>
        <span className="cli-section-toggle">
          <span className="terminal-only">{expanded ? "[-]" : "[+]"}</span>
          <span className="modern-only">{expanded ? "−" : "+"}</span>
        </span>
      </div>
      <QueueSectionContent
        expanded={expanded}
        runningTasks={runningTasks}
        queuedTasks={queuedTasks}
        activeLabel={activeLabel}
        nextLabel={nextLabel}
        onSelectTask={onSelectTask}
        onCancelTask={onCancelTask}
        rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
      />
    </div>
  );
}, (prev, next) =>
  prev.visible === next.visible &&
  prev.queueBadgeText === next.queueBadgeText &&
  prev.queueTitleText === next.queueTitleText &&
  getQueueSectionMaterialSignature({
    expanded: prev.expanded,
    runningTasks: prev.runningTasks,
    queuedTasks: prev.queuedTasks,
    activeLabel: prev.activeLabel,
    nextLabel: prev.nextLabel,
  }) ===
    getQueueSectionMaterialSignature({
      expanded: next.expanded,
      runningTasks: next.runningTasks,
      queuedTasks: next.queuedTasks,
      activeLabel: next.activeLabel,
      nextLabel: next.nextLabel,
    }) &&
  prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled
);

const ChecklistSection = memo(function ChecklistSection({
  visible,
  expanded,
  checklistState,
  toggleSection,
  rendererPerfLoggingEnabled,
  getStatusIndicator,
  getChecklistStatusLabel,
}: {
  visible: boolean;
  expanded: boolean;
  checklistState: SessionChecklistState | null;
  toggleSection: () => void;
  rendererPerfLoggingEnabled: boolean;
  getStatusIndicator: (status: string) => React.ReactNode;
  getChecklistStatusLabel: (status: string) => string;
}) {
  if (!visible || !checklistState) return null;
  recordRendererRender("RightPanel.section", "checklist", rendererPerfLoggingEnabled);
  return (
    <div className="right-panel-section cli-section">
      <div className="cli-section-header" onClick={toggleSection}>
        <span className="cli-section-prompt">&gt;</span>
        <span className="cli-section-title">
          <span className="terminal-only">CHECKLIST</span>
          <span className="modern-only">Checklist</span>
        </span>
        <span className="cli-section-toggle">
          <span className="terminal-only">{expanded ? "[-]" : "[+]"}</span>
          <span className="modern-only">{expanded ? "−" : "+"}</span>
        </span>
      </div>
      {expanded && (
        <div className="cli-section-content">
          <div className="cli-progress-list">
            {checklistState.items.map((item, index) => (
              <div key={item.id} className={`cli-progress-item ${item.status}`}>
                <span className="cli-progress-num">{String(index + 1).padStart(2, "0")}</span>
                <span
                  className={`cli-progress-status ${item.status === "blocked" ? "failed" : item.status}`}
                >
                  {getStatusIndicator(item.status === "blocked" ? "failed" : item.status)}
                </span>
                <span className="cli-progress-text" title={item.title}>
                  {item.title}
                  {item.kind === "verification" ? " [Verification]" : ""}
                </span>
                <span className="cli-context-key">{getChecklistStatusLabel(item.status)}</span>
              </div>
            ))}
          </div>
          {checklistState.verificationNudgeNeeded && (
            <p className="cli-hint">
              <span className="terminal-only">
                {checklistState.nudgeReason || "Add and run a verification checklist item before finishing."}
              </span>
              <span className="modern-only">
                {checklistState.nudgeReason || "Add and run a verification checklist item before finishing."}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.visible === next.visible &&
  prev.expanded === next.expanded &&
  getChecklistSignature(prev.checklistState) === getChecklistSignature(next.checklistState) &&
  prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled
);

const FolderSection = memo(function FolderSection({
  visible,
  expanded,
  files,
  outputSummary,
  highlightedOutputPath,
  workspace,
  filesTitleText,
  toggleSection,
  fileItemRefs,
  setViewerFilePath,
  rendererPerfLoggingEnabled,
  getFileActionSymbol,
}: {
  visible: boolean;
  expanded: boolean;
  files: FileInfo[];
  outputSummary: ReturnType<typeof deriveTaskOutputSummaryFromEvents> | null;
  highlightedOutputPath: string | null;
  workspace: Workspace | null;
  filesTitleText: string;
  toggleSection: () => void;
  fileItemRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  setViewerFilePath: React.Dispatch<React.SetStateAction<string | null>>;
  rendererPerfLoggingEnabled: boolean;
  getFileActionSymbol: (action: FileInfo["action"]) => string;
}) {
  if (!visible) return null;
  recordRendererRender("RightPanel.section", "folder", rendererPerfLoggingEnabled);
  const fileCount = files.length || outputSummary?.outputCount || 0;
  const fileCountLabel = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  return (
    <div className="right-panel-section cli-section">
      <div className="cli-section-header" onClick={toggleSection}>
        <span className="cli-section-prompt">&gt;</span>
        <span className="cli-section-title">
          <span className="terminal-only">{filesTitleText}</span>
          <span className="modern-only">Files</span>
        </span>
        {fileCount > 0 && (
          <span
            className="cli-output-count-badge cli-file-count-badge"
            aria-label={fileCountLabel}
            title={fileCountLabel}
          >
            <span className="cli-file-count-number">{fileCount}</span>
          </span>
        )}
        <span className="cli-section-toggle">
          <span className="terminal-only">{expanded ? "[-]" : "[+]"}</span>
          <span className="modern-only">{expanded ? "−" : "+"}</span>
        </span>
      </div>
      {expanded && (
        <div className="cli-section-content">
          <div className="cli-file-list">
            {files.map((file, index) => (
              <div
                key={`${file.path}-${index}`}
                ref={(el) => {
                  fileItemRefs.current.set(file.path, el);
                }}
                className={`cli-file-item ${file.action} ${outputSummary?.primaryOutputPath === file.path ? "primary-output" : ""} ${highlightedOutputPath === file.path ? "highlight-output" : ""}`}
              >
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
          {workspace && (
            <div
              className="cli-workspace-path"
              style={{ cursor: "pointer" }}
              onClick={() => window.electronAPI.openFile(workspace.path, workspace.path)}
              title={workspace.path}
            >
              <span className="cli-label">
                <span className="terminal-only">PWD:</span>
                <span className="modern-only">Workspace</span>
              </span>
              <span className="cli-path">{workspace.name}/</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.visible === next.visible &&
  prev.expanded === next.expanded &&
  prev.highlightedOutputPath === next.highlightedOutputPath &&
  prev.workspace?.path === next.workspace?.path &&
  prev.filesTitleText === next.filesTitleText &&
  prev.outputSummary?.primaryOutputPath === next.outputSummary?.primaryOutputPath &&
  prev.outputSummary?.outputCount === next.outputSummary?.outputCount &&
  getFilesSignature(prev.files) === getFilesSignature(next.files) &&
  prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled
);

const ActiveContextSection = memo(function ActiveContextSection({
  visible,
  expanded,
  connectedActiveConnectors,
  toggleSection,
  rendererPerfLoggingEnabled,
}: {
  visible: boolean;
  expanded: boolean;
  connectedActiveConnectors: {
    id: string;
    name: string;
    icon: string;
    status: string;
    tools: string[];
  }[];
  toggleSection: () => void;
  rendererPerfLoggingEnabled: boolean;
}) {
  if (!visible || connectedActiveConnectors.length === 0) return null;
  recordRendererRender("RightPanel.section", "activeContext", rendererPerfLoggingEnabled);
  return (
    <div className="right-panel-section cli-section">
      <div className="cli-section-header" onClick={toggleSection}>
        <span className="cli-section-prompt">&gt;</span>
        <span className="cli-section-title">
          <span className="terminal-only">ACTIVE</span>
          <span className="modern-only">Active Context</span>
        </span>
        <span className="cli-active-context-badge">{connectedActiveConnectors.length}</span>
        <span className="cli-section-toggle">
          <span className="terminal-only">{expanded ? "[-]" : "[+]"}</span>
          <span className="modern-only">{expanded ? "−" : "+"}</span>
        </span>
      </div>
      {expanded && (
        <div className="cli-section-content">
          <div className="cli-context-list">
            <div className="cli-context-group">
              <div className="cli-context-label">
                <span className="terminal-only"># connectors:</span>
                <span className="modern-only">Connectors</span>
              </div>
              <div className="cli-active-context-scroll">
                {connectedActiveConnectors.map((connector) => {
                  const ConnectorIcon = resolveConnectorLucideIcon(connector.name, connector.icon);
                  return (
                    <div key={connector.id} className="cli-context-item">
                      <span className="cli-active-context-icon">
                        <ConnectorIcon size={14} />
                      </span>
                      <span className="cli-context-key">{connector.name}</span>
                      <span className="cli-active-context-status connected" />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.visible === next.visible &&
  prev.expanded === next.expanded &&
  getConnectorsSignature(prev.connectedActiveConnectors) ===
    getConnectorsSignature(next.connectedActiveConnectors) &&
  prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled
);

const ContextSection = memo(function ContextSection({
  visible,
  expanded,
  usedSkills,
  toolUsage,
  referencedFiles,
  workspace,
  contextTitleText,
  toggleSection,
  setViewerFilePath,
  rendererPerfLoggingEnabled,
}: {
  visible: boolean;
  expanded: boolean;
  usedSkills: string[];
  toolUsage: ToolUsage[];
  referencedFiles: string[];
  workspace: Workspace | null;
  contextTitleText: string;
  toggleSection: () => void;
  setViewerFilePath: React.Dispatch<React.SetStateAction<string | null>>;
  rendererPerfLoggingEnabled: boolean;
}) {
  if (!visible) return null;
  recordRendererRender("RightPanel.section", "context", rendererPerfLoggingEnabled);
  return (
    <div className="right-panel-section cli-section">
      <div className="cli-section-header" onClick={toggleSection}>
        <span className="cli-section-prompt">&gt;</span>
        <span className="cli-section-title">
          <span className="terminal-only">{contextTitleText}</span>
          <span className="modern-only">Context</span>
        </span>
        <span className="cli-section-toggle">
          <span className="terminal-only">{expanded ? "[-]" : "[+]"}</span>
          <span className="modern-only">{expanded ? "−" : "+"}</span>
        </span>
      </div>
      {expanded && (
        <div className="cli-section-content">
          <div className="cli-context-list">
            {usedSkills.length > 0 && (
              <div className="cli-context-group">
                <div className="cli-context-label">
                  <span className="terminal-only"># skills_used:</span>
                  <span className="modern-only">Skills used</span>
                </div>
                {usedSkills.map((skill, index) => (
                  <div key={`${skill}-${index}`} className="cli-context-item">
                    <span className="cli-context-key">{skill}</span>
                  </div>
                ))}
              </div>
            )}
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
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.visible === next.visible &&
  prev.expanded === next.expanded &&
  prev.workspace?.path === next.workspace?.path &&
  prev.contextTitleText === next.contextTitleText &&
  getStringListSignature(prev.usedSkills) === getStringListSignature(next.usedSkills) &&
  getToolUsageSignature(prev.toolUsage) === getToolUsageSignature(next.toolUsage) &&
  getStringListSignature(prev.referencedFiles) === getStringListSignature(next.referencedFiles) &&
  prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled
);

function RightPanelComponent({
  task,
  workspace,
  events: rawEvents,
  sharedTaskEventUi = null,
  hasActiveChildren = false,
  runningTasks = [],
  queuedTasks = [],
  queueStatus,
  onSelectTask,
  onCancelTask,
  rendererPerfLoggingEnabled = false,
  highlightOutputPath = null,
  onHighlightConsumed,
}: RightPanelProps) {
  recordRendererRender(
    "RightPanel",
    task?.id ? `task:${task.id}` : "task:none",
    rendererPerfLoggingEnabled,
  );
  const events = useMemo(
    () => {
      if (sharedTaskEventUi) {
        return sharedTaskEventUi.normalizedEvents;
      }
      return measureRendererPerf("RightPanel.normalizeEvents", rendererPerfLoggingEnabled, () =>
        normalizeEventsForTimelineUi(rawEvents),
      );
    },
    [rawEvents, rendererPerfLoggingEnabled, sharedTaskEventUi],
  );
  const [expandedSections, setExpandedSections] = useState({
    progress: true,
    checklist: true,
    queue: true,
    folder: true,
    activeContext: true,
    context: true,
  });
  const [viewerFilePath, setViewerFilePath] = useState<string | null>(null);
  const [highlightedOutputPath, setHighlightedOutputPath] = useState<string | null>(null);
  const [taskFeedbackDecision, setTaskFeedbackDecision] = useState<"accepted" | "rejected" | null>(
    null,
  );
  const [taskFeedbackDismissed, setTaskFeedbackDismissed] = useState(false);
  const fileItemRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const agentContext = useAgentContext();

  // Active context: connectors + skills
  const [activeContext, setActiveContext] = useState<{
    connectors: { id: string; name: string; icon: string; status: string; tools: string[] }[];
    skills: { id: string; name: string; icon: string }[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadContext() {
      try {
        const data = await window.electronAPI.getActiveContext();
        if (!cancelled) {
          setActiveContext((prev) =>
            getActiveContextSignature(prev) === getActiveContextSignature(data) ? prev : data,
          );
        }
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
  const totalQueueActive = (queueStatus?.runningCount || 0) + (queueStatus?.queuedCount || 0);
  const progressTitleText = agentContext.getUiCopy("rightProgressTitle");
  const progressEmptyHintText = agentContext.getUiCopy("rightProgressEmptyHint");
  const queueTitleText = agentContext.getUiCopy("rightQueueTitle");
  const queueActiveLabel = agentContext.getUiCopy("rightQueueActiveLabel");
  const queueNextLabel = agentContext.getUiCopy("rightQueueNextLabel");
  const filesTitleText = agentContext.getUiCopy("rightFilesTitle");
  const contextTitleText = agentContext.getUiCopy("rightContextTitle");
  const queueBadgeText = `${queueStatus?.runningCount || 0}/${queueStatus?.maxConcurrent || 0}${
    queueStatus && queueStatus.queuedCount > 0 ? ` +${queueStatus.queuedCount}` : ""
  }`;

  const toggleSection = useCallback((section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  }, []);

  // Extract plan steps from events
  const planSteps = useMemo((): PlanStep[] => {
    if (sharedTaskEventUi) return sharedTaskEventUi.planSteps;
    return measureRendererPerf("RightPanel.planSteps", rendererPerfLoggingEnabled, () => {
      const planEvent = events.find((event) => getEffectiveTaskEventType(event) === "plan_created");
      if (!planEvent?.payload?.plan?.steps) return [];

      const steps = [...planEvent.payload.plan.steps];

      events.forEach((event) => {
        const effectiveType = getEffectiveTaskEventType(event);
        if (effectiveType === "step_started" && event.payload.step) {
          const step = steps.find((s) => s.id === event.payload.step.id);
          if (step) step.status = "in_progress";
        }
        if (effectiveType === "step_completed" && event.payload.step) {
          const step = steps.find((s) => s.id === event.payload.step.id);
          if (step) step.status = "completed";
        }
        if (effectiveType === "step_failed" && event.payload.step) {
          const step = steps.find((s) => s.id === event.payload.step.id);
          if (step) {
            step.status = "failed";
            if (event.payload.reason && !step.error) step.error = String(event.payload.reason);
          }
        }
        if (effectiveType === "step_skipped" && event.payload.step) {
          const step = steps.find((s) => s.id === event.payload.step.id);
          if (step) step.status = "skipped";
        }
      });

      return steps.filter(
        (step) => !isVerificationStepDescription(step.description) || step.status === "failed",
      );
    });
  }, [events, sharedTaskEventUi, rendererPerfLoggingEnabled]);
  const progressMaterialSignature = useMemo(
    () =>
      getProgressSectionMaterialSignature({
        expanded: expandedSections.progress,
        planSteps,
        taskStatus: task?.status,
        taskTerminalStatus: task?.terminalStatus,
        hasActiveChildren,
        emptyHintText: progressEmptyHintText,
      }),
    [
      expandedSections.progress,
      planSteps,
      task?.status,
      task?.terminalStatus,
      hasActiveChildren,
      progressEmptyHintText,
    ],
  );
  const deferredProgressMaterialSignature = useDeferredValue(progressMaterialSignature);
  const stableProgressPlanSteps = useStableSnapshotBySignature(
    planSteps,
    deferredProgressMaterialSignature,
  );

  const checklistState = useMemo((): SessionChecklistState | null => {
    if (sharedTaskEventUi) return sharedTaskEventUi.checklistState;
    return measureRendererPerf("RightPanel.checklistState", rendererPerfLoggingEnabled, () => {
      const normalizeChecklistState = (payload: Any): SessionChecklistState | null => {
        const checklist =
          payload?.checklist && typeof payload.checklist === "object" ? payload.checklist : null;
        if (!checklist || !Array.isArray(checklist.items)) return null;

        const items: SessionChecklistItem[] = checklist.items
          .filter((item: Any) => item && typeof item === "object")
          .map((item: Any) => ({
            id: typeof item.id === "string" ? item.id : "",
            title: typeof item.title === "string" ? item.title : "",
            kind:
              item.kind === "verification" || item.kind === "other" ? item.kind : "implementation",
            status:
              item.status === "in_progress" ||
              item.status === "completed" ||
              item.status === "blocked"
                ? item.status
                : "pending",
            createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
            updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
          }))
          .filter((item: SessionChecklistItem) => Boolean(item.id && item.title));

        return {
          items,
          updatedAt: typeof checklist.updatedAt === "number" ? checklist.updatedAt : 0,
          verificationNudgeNeeded: checklist.verificationNudgeNeeded === true,
          nudgeReason:
            typeof checklist.nudgeReason === "string" && checklist.nudgeReason.trim().length > 0
              ? checklist.nudgeReason
              : null,
        };
      };

      for (const event of [...events].reverse()) {
        const effectiveType = getEffectiveTaskEventType(event);
        if (
          effectiveType === "task_list_created" ||
          effectiveType === "task_list_updated" ||
          effectiveType === "task_list_verification_nudged" ||
          event.type === "conversation_snapshot"
        ) {
          const state = normalizeChecklistState(event.payload);
          if (state) return state;
        }
      }

      return null;
    });
  }, [events, sharedTaskEventUi, rendererPerfLoggingEnabled]);

  // Extract files from events
  const files = useMemo((): FileInfo[] => {
    if (sharedTaskEventUi) return sharedTaskEventUi.files;
    const fileMap = new Map<string, FileInfo>();

    // Normalize to a consistent relative path key for deduplication.
    // Two events may emit the same file as an absolute path and a relative path.
    const normalizePathKey = (p: string): string => {
      const normalized = p.replace(/\\/g, "/");
      if (workspace?.path) {
        const base = workspace.path.replace(/\\/g, "/").replace(/\/$/, "");
        if (normalized.startsWith(base + "/")) return normalized.slice(base.length + 1);
      }
      return normalized;
    };

    events.forEach((event) => {
      const effectiveType = getEffectiveTaskEventType(event);
      if (effectiveType === "file_created" && event.payload.path) {
        if (event.payload.type === "directory") return;
        const key = normalizePathKey(event.payload.path);
        fileMap.set(key, {
          path: key,
          action: "created",
          timestamp: event.timestamp,
        });
      }
      if (effectiveType === "file_modified" && (event.payload.path || event.payload.from)) {
        const raw = event.payload.path || event.payload.from;
        const key = normalizePathKey(raw);
        fileMap.set(key, {
          path: key,
          action: "modified",
          timestamp: event.timestamp,
        });
      }
      if (effectiveType === "file_deleted" && event.payload.path) {
        const key = normalizePathKey(event.payload.path);
        fileMap.set(key, {
          path: key,
          action: "deleted",
          timestamp: event.timestamp,
        });
      }
      if (effectiveType === "artifact_created" && event.payload.path) {
        const key = normalizePathKey(event.payload.path);
        fileMap.set(key, {
          path: key,
          action: "created",
          timestamp: event.timestamp,
        });
      }
    });

    const latestCompletionEvent = [...events]
      .reverse()
      .find((event) => getEffectiveTaskEventType(event) === "task_completed");
    const completionOutputSummary = resolvePreferredTaskOutputSummary({
      task,
      latestCompletionEvent,
      fallbackEvents: events,
    });
    if (hasTaskOutputs(completionOutputSummary)) {
      const modifiedFallbackSet = new Set(completionOutputSummary.modifiedFallback || []);
      const completionOutputPaths =
        completionOutputSummary.created.length > 0
          ? completionOutputSummary.created
          : completionOutputSummary.modifiedFallback || [];
      completionOutputPaths.forEach((outputPath, index) => {
        const key = normalizePathKey(outputPath);
        if (fileMap.has(key)) return;
        fileMap.set(key, {
          path: key,
          action: modifiedFallbackSet.has(outputPath) ? "modified" : "created",
          timestamp: (latestCompletionEvent?.timestamp || Date.now()) - index,
        });
      });
    }

    return Array.from(fileMap.values())
      .filter((f) => !f.path.endsWith("/") && !f.path.endsWith("\\"))
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [events, sharedTaskEventUi, task, workspace]);
  const outputSummary = useMemo(() => {
    if (sharedTaskEventUi) return sharedTaskEventUi.outputSummary;
    const latestCompletionEvent = [...events]
      .reverse()
      .find((event) => getEffectiveTaskEventType(event) === "task_completed");
    return (
      resolvePreferredTaskOutputSummary({
        task,
        latestCompletionEvent,
        fallbackEvents: events,
      }) || deriveTaskOutputSummaryFromEvents(events)
    );
  }, [events, sharedTaskEventUi, task]);

  useEffect(() => {
    if (!highlightOutputPath) return;

    setExpandedSections((prev) => (prev.folder ? prev : { ...prev, folder: true }));
    const targetEl = fileItemRefs.current.get(highlightOutputPath);
    if (!targetEl) return;

    targetEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setHighlightedOutputPath(highlightOutputPath);
    onHighlightConsumed?.();

    const timer = setTimeout(() => {
      setHighlightedOutputPath((prev) => (prev === highlightOutputPath ? null : prev));
    }, 2200);
    return () => clearTimeout(timer);
  }, [highlightOutputPath, files.length]);

  useEffect(() => {
    setTaskFeedbackDecision(null);
    setTaskFeedbackDismissed(false);
  }, [task?.id]);

  const handleTaskFeedback = useCallback(
    async (decision: "accepted" | "rejected") => {
      if (!task?.id) return;
      setTaskFeedbackDecision(decision);
      try {
        await window.electronAPI.submitMessageFeedback({
          taskId: task.id,
          decision,
          kind: "task",
        });
      } catch (err) {
        console.error("[Feedback] Failed to submit task feedback:", err);
      }
    },
    [task?.id],
  );

  // Extract tool usage from events
  const toolUsage = useMemo((): ToolUsage[] => {
    if (sharedTaskEventUi) return sharedTaskEventUi.toolUsage;
    const toolMap = new Map<string, ToolUsage>();

    events.forEach((event) => {
      if (getEffectiveTaskEventType(event) === "tool_call" && event.payload.tool) {
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
  }, [events, sharedTaskEventUi]);
  const usedSkills = useMemo((): string[] => {
    const skills = new Set<string>();

    events.forEach((event) => {
      const effectiveType = getEffectiveTaskEventType(event);
      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};

      if (
        (effectiveType === "skill_applied" || effectiveType === "skill_used") &&
        typeof payload.skillName === "string" &&
        payload.skillName.trim().length > 0
      ) {
        skills.add(payload.skillName.trim());
        return;
      }

      if (effectiveType === "tool_call" && payload.tool === "skill") {
        const input =
          payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
            ? (payload.input as Record<string, unknown>)
            : {};
        const rawSkillName =
          typeof input.skill_name === "string"
            ? input.skill_name
            : typeof input.skillName === "string"
              ? input.skillName
              : typeof input.skill_id === "string"
                ? input.skill_id
                : typeof input.skillId === "string"
                  ? input.skillId
                  : typeof input.skill === "string"
                    ? input.skill
                    : "";
        if (rawSkillName.trim().length > 0) {
          skills.add(
            rawSkillName
              .trim()
              .replace(/[-_]/g, " ")
              .replace(/\b\w/g, (char) => char.toUpperCase()),
          );
        }
      }
    });

    return Array.from(skills).slice(0, 10);
  }, [events]);

  // Extract referenced files from tool results (files that were read)
  const referencedFiles = useMemo((): string[] => {
    if (sharedTaskEventUi) return sharedTaskEventUi.referencedFiles;
    const files = new Set<string>();

    events.forEach((event) => {
      if (getEffectiveTaskEventType(event) === "tool_call") {
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
  }, [events, sharedTaskEventUi]);

  // Extract tool names used in this task/session (for connector filtering)
  const usedToolNames = useMemo((): Set<string> => {
    if (sharedTaskEventUi) return sharedTaskEventUi.usedToolNames;
    const names = new Set<string>();
    events.forEach((event) => {
      if (getEffectiveTaskEventType(event) === "tool_call" && event.payload.tool) {
        names.add(event.payload.tool);
      }
    });
    return names;
  }, [events, sharedTaskEventUi]);
  const connectedActiveConnectors = useMemo(
    () =>
      activeContext?.connectors.filter(
        (connector) =>
          connector.status === "connected" &&
          connector.tools.some((toolName) => usedToolNames.has(toolName)),
      ) || [],
    [activeContext, usedToolNames],
  );
  const isLiveExecutionMode =
    task?.status === "executing" || (task?.status === "completed" && hasActiveChildren);
  const checklistSignature = useMemo(() => getChecklistSignature(checklistState), [checklistState]);
  const deferredChecklistSignature = useDeferredValue(checklistSignature);
  const stableChecklistState = useStableSnapshotBySignature(
    checklistState,
    isLiveExecutionMode ? deferredChecklistSignature : checklistSignature,
  );
  const filesSignature = useMemo(() => getFilesSignature(files), [files]);
  const deferredFilesSignature = useDeferredValue(filesSignature);
  const stableFiles = useStableSnapshotBySignature(
    files,
    isLiveExecutionMode ? deferredFilesSignature : filesSignature,
  );
  const connectorsSignature = useMemo(
    () => getConnectorsSignature(connectedActiveConnectors),
    [connectedActiveConnectors],
  );
  const deferredConnectorsSignature = useDeferredValue(connectorsSignature);
  const stableConnectedActiveConnectors = useStableSnapshotBySignature(
    connectedActiveConnectors,
    isLiveExecutionMode ? deferredConnectorsSignature : connectorsSignature,
  );
  const toolUsageSignature = useMemo(() => getToolUsageSignature(toolUsage), [toolUsage]);
  const deferredToolUsageSignature = useDeferredValue(toolUsageSignature);
  const stableToolUsage = useStableSnapshotBySignature(
    toolUsage,
    isLiveExecutionMode ? deferredToolUsageSignature : toolUsageSignature,
  );
  const usedSkillsSignature = useMemo(() => getStringListSignature(usedSkills), [usedSkills]);
  const deferredUsedSkillsSignature = useDeferredValue(usedSkillsSignature);
  const stableUsedSkills = useStableSnapshotBySignature(
    usedSkills,
    isLiveExecutionMode ? deferredUsedSkillsSignature : usedSkillsSignature,
  );
  const referencedFilesSignature = useMemo(
    () => getStringListSignature(referencedFiles),
    [referencedFiles],
  );
  const deferredReferencedFilesSignature = useDeferredValue(referencedFilesSignature);
  const stableReferencedFiles = useStableSnapshotBySignature(
    referencedFiles,
    isLiveExecutionMode ? deferredReferencedFilesSignature : referencedFilesSignature,
  );
  const showChecklistSection =
    !!stableChecklistState &&
    stableChecklistState.items.length > 0;
  const showQueueSection = totalQueueActive > 0;
  const showFolderSection = stableFiles.length > 0;
  const showActiveContextSection = stableConnectedActiveConnectors.length > 0 && !isLiveExecutionMode;
  const showContextSection =
    stableUsedSkills.length > 0 || stableToolUsage.length > 0 || stableReferencedFiles.length > 0;
  const fallbackProgressText = useMemo(() => {
    const activeChecklistItem = stableChecklistState?.items.find((item) => item.status === "in_progress");
    if (activeChecklistItem) return activeChecklistItem.title;

    const latestActivityText = getTaskEventActivityText(sharedTaskEventUi?.latestVisibleTaskEvent ?? null);
    if (latestActivityText) return latestActivityText;

    const pendingChecklistItem = stableChecklistState?.items.find((item) => item.status === "pending");
    if (pendingChecklistItem) return `Up next: ${pendingChecklistItem.title}`;

    return null;
  }, [sharedTaskEventUi?.latestVisibleTaskEvent, stableChecklistState]);
  const queueMaterialSignature = useMemo(
    () =>
      getQueueSectionMaterialSignature({
        expanded: expandedSections.queue,
        runningTasks,
        queuedTasks,
        activeLabel: queueActiveLabel,
        nextLabel: queueNextLabel,
      }),
    [
      expandedSections.queue,
      runningTasks,
      queuedTasks,
      queueActiveLabel,
      queueNextLabel,
    ],
  );
  const deferredQueueMaterialSignature = useDeferredValue(queueMaterialSignature);
  const stableRunningTasks = useStableSnapshotBySignature(runningTasks, deferredQueueMaterialSignature);
  const stableQueuedTasks = useStableSnapshotBySignature(queuedTasks, deferredQueueMaterialSignature);

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
      case "skipped":
        return (
          <>
            <span className="terminal-only">[→]</span>
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
                <polyline points="5 4 15 12 5 20" />
                <line x1="19" y1="4" x2="19" y2="20" />
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

  const getChecklistStatusLabel = (status: string) => {
    switch (status) {
      case "in_progress":
        return "In progress";
      case "completed":
        return "Completed";
      case "blocked":
        return "Blocked";
      default:
        return "Pending";
    }
  };

  const preservedOutputsTooltip =
    "Completed with preserved outputs. Cowork kept the files and summary it produced, even though some checks or steps did not fully finish.";

  return (
    <div className="right-panel cli-panel">
      {/* Progress Section */}
      <ProgressSection
        expanded={expandedSections.progress}
        planSteps={stableProgressPlanSteps}
        taskStatus={task?.status}
        taskTerminalStatus={task?.terminalStatus}
        hasActiveChildren={hasActiveChildren}
        progressTitleText={progressTitleText}
        emptyHintText={progressEmptyHintText}
        fallbackActivityText={fallbackProgressText}
        toggleSection={() => toggleSection("progress")}
        rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
        getStatusIndicator={getStatusIndicator}
      />

      <ChecklistSection
        visible={showChecklistSection}
        expanded={expandedSections.checklist}
        checklistState={stableChecklistState}
        toggleSection={() => toggleSection("checklist")}
        rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
        getStatusIndicator={getStatusIndicator}
        getChecklistStatusLabel={getChecklistStatusLabel}
      />

      {/* Lineup Section */}
      <QueueSection
        visible={showQueueSection}
        expanded={expandedSections.queue}
        runningTasks={stableRunningTasks}
        queuedTasks={stableQueuedTasks}
        queueBadgeText={queueBadgeText}
        queueTitleText={queueTitleText}
        activeLabel={queueActiveLabel}
        nextLabel={queueNextLabel}
        toggleSection={() => toggleSection("queue")}
        onSelectTask={onSelectTask}
        onCancelTask={onCancelTask}
        rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
      />

      {/* Working Folder Section — only shown when files were touched */}
      <FolderSection
        visible={showFolderSection}
        expanded={expandedSections.folder}
        files={stableFiles}
        outputSummary={outputSummary}
        highlightedOutputPath={highlightedOutputPath}
        workspace={workspace}
        filesTitleText={filesTitleText}
        toggleSection={() => toggleSection("folder")}
        fileItemRefs={fileItemRefs}
        setViewerFilePath={setViewerFilePath}
        rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
        getFileActionSymbol={getFileActionSymbol}
      />

      <ActiveContextSection
        visible={showActiveContextSection}
        expanded={expandedSections.activeContext}
        connectedActiveConnectors={stableConnectedActiveConnectors}
        toggleSection={() => toggleSection("activeContext")}
        rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
      />

      <ContextSection
        visible={showContextSection}
        expanded={expandedSections.context}
        usedSkills={stableUsedSkills}
        toolUsage={stableToolUsage}
        referencedFiles={stableReferencedFiles}
        workspace={workspace}
        contextTitleText={contextTitleText}
        toggleSection={() => toggleSection("context")}
        setViewerFilePath={setViewerFilePath}
        rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
      />

      {task?.status === "completed" && !hasActiveChildren && !taskFeedbackDismissed && (
        <div className="right-panel-section cli-section right-panel-feedback-section">
          <div className="cli-section-content">
            <div className="right-panel-feedback-card">
              <div className="right-panel-feedback-copy">
                <strong>Rate this result</strong>
                <span className="right-panel-feedback-detail">
                  Helps improve this agent and persona.
                </span>
              </div>
              <div className="right-panel-feedback-actions">
                <button
                  type="button"
                  className={`message-feedback-btn right-panel-feedback-btn${taskFeedbackDecision === "accepted" ? " active" : ""}`}
                  onClick={() => void handleTaskFeedback("accepted")}
                  title="This task result was helpful"
                >
                  Up
                </button>
                <button
                  type="button"
                  className={`message-feedback-btn right-panel-feedback-btn${taskFeedbackDecision === "rejected" ? " active" : ""}`}
                  onClick={() => void handleTaskFeedback("rejected")}
                  title="This task result needs improvement"
                >
                  Down
                </button>
                <button
                  type="button"
                  className="message-feedback-btn right-panel-feedback-btn right-panel-feedback-dismiss"
                  onClick={() => setTaskFeedbackDismissed(true)}
                  title="Close without rating"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {task?.status === "completed" && !hasActiveChildren && task?.terminalStatus === "partial_success" && (
        <div
          className="right-panel-preserved-line"
          title={preservedOutputsTooltip}
        >
          Completed with preserved outputs
        </div>
      )}
      {task?.status === "failed" && outputSummary && outputSummary.outputCount > 0 && (
        <div
          className="right-panel-preserved-line"
          title={preservedOutputsTooltip}
        >
          Output created, final verification failed
        </div>
      )}

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
        <DocumentAwareFileModal
          filePath={viewerFilePath}
          workspacePath={workspace.path}
          onClose={() => setViewerFilePath(null)}
        />
      )}
    </div>
  );
}

function areRightPanelPropsEqual(prev: RightPanelProps, next: RightPanelProps): boolean {
  const sharedEventsEqual = prev.sharedTaskEventUi || next.sharedTaskEventUi
    ? prev.sharedTaskEventUi === next.sharedTaskEventUi
    : prev.events === next.events;

  return (
    getRightPanelTaskSignature(prev.task) === getRightPanelTaskSignature(next.task) &&
    prev.workspace?.path === next.workspace?.path &&
    sharedEventsEqual &&
    prev.hasActiveChildren === next.hasActiveChildren &&
    getTaskListSignature(prev.runningTasks || []) === getTaskListSignature(next.runningTasks || []) &&
    getTaskListSignature(prev.queuedTasks || []) === getTaskListSignature(next.queuedTasks || []) &&
    getQueueStatusSignature(prev.queueStatus) === getQueueStatusSignature(next.queueStatus) &&
    prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled &&
    prev.highlightOutputPath === next.highlightOutputPath &&
    prev.onSelectTask === next.onSelectTask &&
    prev.onCancelTask === next.onCancelTask &&
    prev.onHighlightConsumed === next.onHighlightConsumed
  );
}

export const RightPanel = memo(RightPanelComponent, areRightPanelPropsEqual);
