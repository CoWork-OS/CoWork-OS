import type { PlanStep, Task, TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

export type TaskProgressPeekStatus =
  | "working"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"
  | "blocked"
  | "waiting"
  | "idle";

export interface TaskProgressPeekStep {
  id: string;
  description: string;
  status: PlanStep["status"];
  durationLabel: string | null;
  error?: string;
}

export interface TaskProgressPeekActivity {
  id: string;
  label: string;
  tone: "neutral" | "active" | "success" | "warning" | "danger";
  timeLabel: string;
}

export interface TaskProgressPeekModel {
  label: string;
  status: TaskProgressPeekStatus;
  statusLabel: string;
  progressPercent: number | null;
  progressText: string;
  activeStep: TaskProgressPeekStep | null;
  steps: TaskProgressPeekStep[];
  recentActivity: TaskProgressPeekActivity[];
}

export interface DeriveTaskProgressPeekModelParams {
  task?: Task | null;
  events: TaskEvent[];
  planSteps: PlanStep[];
  label: string;
  isTaskWorking: boolean;
  maxRecentActivity?: number;
  now?: number;
}

const MAX_ACTIVITY_LABEL_LENGTH = 140;

function cleanInlineText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2")
    .replace(/[ \t\r\n]{2,}/g, " ")
    .trim();
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function humanizeProgressStepDescription(description: string): string {
  const cleaned = cleanInlineText(description);
  if (!cleaned) return cleaned;

  const useSkillMatch = cleaned.match(
    /use\s+the\s+Skill\s+tool\s+with\s+skill\s+(?:ID\s+)?([a-z0-9_-]+)/i,
  );
  if (useSkillMatch) {
    const skillName = useSkillMatch[1]
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return `Run the ${skillName} skill`;
  }

  if (/use\s+request_user_input\b/i.test(cleaned)) {
    const rest = cleaned.replace(/use\s+request_user_input\s+(to\s+)?/i, "").trim();
    return rest.length > 4 ? capitalize(rest) : "Collect details from you";
  }

  const rawToolCallMatch = cleaned.match(/^\s*(?:assistant\s+)?to=([a-z_][\w-]*)\b/i);
  if (rawToolCallMatch) {
    return capitalize(rawToolCallMatch[1].replace(/_/g, " "));
  }

  return cleaned;
}

function formatRelativeTime(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const diffMs = Math.max(0, now - timestamp);
  if (diffMs < 45_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatStepDuration(step: PlanStep): string | null {
  if (
    typeof step.startedAt !== "number" ||
    typeof step.completedAt !== "number" ||
    !Number.isFinite(step.startedAt) ||
    !Number.isFinite(step.completedAt) ||
    step.completedAt <= step.startedAt
  ) {
    return null;
  }
  const seconds = Math.round((step.completedAt - step.startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function getStepFromPayload(event: TaskEvent): Record<string, unknown> {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const step = payload.step;
  return step && typeof step === "object" && !Array.isArray(step)
    ? (step as Record<string, unknown>)
    : {};
}

function getPayloadString(event: TaskEvent, key: string): string {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function truncateActivityLabel(label: string): string {
  if (label.length <= MAX_ACTIVITY_LABEL_LENGTH) return label;
  return `${label.slice(0, MAX_ACTIVITY_LABEL_LENGTH - 1).trimEnd()}...`;
}

function isUserFacingProgressMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (/^thinking(?:\.\.\.)?$/i.test(trimmed)) return false;
  if (/^executing$/i.test(trimmed)) return false;
  if (/^progress_update$/i.test(trimmed)) return false;
  return true;
}

function getActivityForEvent(
  event: TaskEvent,
  now: number,
): Omit<TaskProgressPeekActivity, "id"> | null {
  const effectiveType = getEffectiveTaskEventType(event);
  const stepPayload = getStepFromPayload(event);
  const stepDescription =
    typeof stepPayload.description === "string"
      ? humanizeProgressStepDescription(stepPayload.description)
      : "";
  const message = cleanInlineText(getPayloadString(event, "message"));
  const reason = cleanInlineText(getPayloadString(event, "reason") || getPayloadString(event, "error"));

  if (effectiveType === "step_started" || event.type === "timeline_step_started") {
    return {
      label: stepDescription || message || "Started a step",
      tone: "active",
      timeLabel: formatRelativeTime(event.timestamp, now),
    };
  }
  if (effectiveType === "step_completed" || event.type === "timeline_step_finished") {
    return {
      label: stepDescription ? `Completed ${stepDescription}` : message || "Completed a step",
      tone: "success",
      timeLabel: formatRelativeTime(event.timestamp, now),
    };
  }
  if (effectiveType === "step_failed") {
    return {
      label: reason || (stepDescription ? `Failed ${stepDescription}` : "Step failed"),
      tone: "danger",
      timeLabel: formatRelativeTime(event.timestamp, now),
    };
  }
  if (effectiveType === "approval_requested") {
    return {
      label: message || "Waiting for approval",
      tone: "warning",
      timeLabel: formatRelativeTime(event.timestamp, now),
    };
  }
  if (effectiveType === "error" || event.type === "timeline_error") {
    return {
      label: reason || message || "Error reported",
      tone: "danger",
      timeLabel: formatRelativeTime(event.timestamp, now),
    };
  }
  if (effectiveType === "progress_update" || event.type === "timeline_step_updated") {
    const label = message || stepDescription;
    if (!isUserFacingProgressMessage(label)) return null;
    return {
      label,
      tone: "neutral",
      timeLabel: formatRelativeTime(event.timestamp, now),
    };
  }
  return null;
}

function deriveStatus(task: Task | null | undefined, isTaskWorking: boolean): TaskProgressPeekStatus {
  if (!task) return "idle";
  if (task.terminalStatus === "awaiting_approval" || task.status === "blocked") return "waiting";
  if (isTaskWorking || task.status === "executing" || task.status === "planning") return "working";
  if (task.status === "completed") return "completed";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "paused" || task.status === "interrupted") return "paused";
  if (task.status === "blocked") return "blocked";
  return "idle";
}

function getStatusLabel(status: TaskProgressPeekStatus): string {
  switch (status) {
    case "working":
      return "In progress";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "paused":
      return "Paused";
    case "blocked":
    case "waiting":
      return "Waiting";
    default:
      return "Activity";
  }
}

export function deriveTaskProgressPeekModel({
  task,
  events,
  planSteps,
  label,
  isTaskWorking,
  maxRecentActivity = 8,
  now = Date.now(),
}: DeriveTaskProgressPeekModelParams): TaskProgressPeekModel {
  const steps = planSteps.map((step) => ({
    id: step.id,
    description: humanizeProgressStepDescription(step.description),
    status: step.status,
    durationLabel: formatStepDuration(step),
    error: step.error,
  }));

  const completedCount = steps.filter(
    (step) => step.status === "completed" || step.status === "skipped",
  ).length;
  const failedCount = steps.filter((step) => step.status === "failed").length;
  const totalCount = steps.length;
  const progressPercent =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : null;
  const progressText =
    totalCount > 0
      ? `${completedCount} of ${totalCount} steps complete${failedCount > 0 ? `, ${failedCount} failed` : ""}`
      : "No plan steps yet";

  const activeStep =
    steps.find((step) => step.status === "in_progress") ||
    steps.find((step) => step.status === "failed") ||
    steps.find((step) => step.status === "pending") ||
    null;

  const recentActivity: TaskProgressPeekActivity[] = [];
  const seenLabels = new Set<string>();
  for (let index = events.length - 1; index >= 0 && recentActivity.length < maxRecentActivity; index -= 1) {
    const event = events[index];
    if (task?.id && event.taskId !== task.id) continue;
    const activity = getActivityForEvent(event, now);
    if (!activity) continue;
    const label = truncateActivityLabel(activity.label);
    const signature = `${activity.tone}:${label}`;
    if (seenLabels.has(signature)) continue;
    seenLabels.add(signature);
    recentActivity.unshift({
      id: event.id || event.eventId || `${event.type}:${event.timestamp}:${index}`,
      ...activity,
      label,
    });
  }

  const status = deriveStatus(task, isTaskWorking);
  return {
    label,
    status,
    statusLabel: getStatusLabel(status),
    progressPercent,
    progressText,
    activeStep,
    steps,
    recentActivity,
  };
}
