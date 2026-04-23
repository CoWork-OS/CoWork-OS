import type { TaskEvent } from "../../../shared/types";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Check,
  Circle,
  FileOutput,
  FileText,
  Link2,
  Loader2,
  Package,
  Play,
  RotateCcw,
  Search,
  Shield,
  Terminal,
  Wrench,
} from "lucide-react";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";

export type TimelineIndicatorTone = "neutral" | "active" | "success" | "warning" | "error";

export interface TimelineIndicatorSpec {
  icon: LucideIcon;
  tone: TimelineIndicatorTone;
  spin?: boolean;
  label: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function resolveStage(payload: unknown): string {
  const obj = asObject(payload);
  const raw = typeof obj.stage === "string" ? obj.stage.trim().toUpperCase() : "";
  return raw;
}

function resolveGroupLabel(payload: unknown): string {
  const obj = asObject(payload);
  const raw = typeof obj.groupLabel === "string" ? obj.groupLabel.trim() : "";
  return raw;
}

export function resolveTimelineGroupId(event: TaskEvent): string | null {
  if (typeof event.groupId === "string" && event.groupId.trim().length > 0) {
    return event.groupId.trim();
  }
  const payload = asObject(event.payload);
  if (typeof payload.groupId === "string" && payload.groupId.trim().length > 0) {
    return payload.groupId.trim();
  }
  return null;
}

export function shouldShowTimelineBranchStub(event: TaskEvent): boolean {
  const groupId = resolveTimelineGroupId(event);
  if (!groupId) return false;
  return !groupId.toLowerCase().startsWith("stage:");
}

export interface ResolveTimelineIndicatorOptions {
  /** When true, past progress events show as completed (no spinner) instead of in-progress */
  isTaskCompleted?: boolean;
}

export function resolveTimelineIndicator(
  event: TaskEvent,
  options?: ResolveTimelineIndicatorOptions,
): TimelineIndicatorSpec {
  const effectiveType = getEffectiveTaskEventType(event);
  const isTaskCompleted = options?.isTaskCompleted ?? false;

  if (event.type === "timeline_group_started") {
    if (isTaskCompleted) {
      return { icon: Check, tone: "success", label: "Stage completed" };
    }
    const stage = resolveStage(event.payload);
    const groupLabel = resolveGroupLabel(event.payload);
    const isSubStage = groupLabel && groupLabel.toUpperCase() !== stage;
    const subStageLabel = isSubStage ? groupLabel : null;
    switch (stage) {
      case "DISCOVER":
        return { icon: Search, tone: "active", label: subStageLabel ?? "Discover stage started" };
      case "BUILD":
        return { icon: Terminal, tone: "active", label: subStageLabel ?? "Build stage started" };
      case "VERIFY":
        return { icon: Shield, tone: "active", label: subStageLabel ?? "Verify stage started" };
      case "FIX":
        return { icon: Wrench, tone: "active", label: subStageLabel ?? "Fix stage started" };
      case "DELIVER":
        return { icon: Package, tone: "active", label: subStageLabel ?? "Deliver stage started" };
      default:
        return { icon: Play, tone: "active", label: subStageLabel ?? "Group started" };
    }
  }

  if (event.type === "timeline_group_finished") {
    return { icon: Check, tone: "success", label: "Group finished" };
  }

  if (event.type === "timeline_error") {
    const payload = asObject(event.payload);
    const legacyType =
      typeof event.legacyType === "string"
        ? event.legacyType
        : typeof payload.legacyType === "string"
          ? payload.legacyType
          : "";
    return {
      icon: AlertTriangle,
      tone: "error",
      label: legacyType === "tool_error" ? "Tool error" : "Error",
    };
  }

  if (effectiveType === "verification_started") {
    return { icon: Shield, tone: "active", label: "Verification started" };
  }

  if (effectiveType === "verification_passed") {
    return { icon: Shield, tone: "success", label: "Verification passed" };
  }

  if (effectiveType === "verification_failed" || effectiveType === "verification_pending_user_action") {
    return { icon: Shield, tone: "warning", label: "Verification requires attention" };
  }

  if (effectiveType === "approval_requested") {
    return { icon: Shield, tone: "warning", label: "Approval requested" };
  }

  if (effectiveType === "retry_started") {
    return { icon: RotateCcw, tone: "active", label: "Retry started" };
  }

  if (
    event.type === "timeline_step_finished" &&
    (event.status === "failed" || event.status === "blocked")
  ) {
    return { icon: AlertTriangle, tone: "error", label: "Step failed" };
  }

  if (effectiveType === "step_failed" || effectiveType === "error") {
    return { icon: AlertTriangle, tone: "error", label: "Error" };
  }

  if (
    event.type === "timeline_step_finished" &&
    (event.status === "completed" || event.status === "skipped" || event.status === "cancelled")
  ) {
    return { icon: Check, tone: "success", label: "Step completed" };
  }

  if (effectiveType === "step_completed" || effectiveType === "task_completed") {
    return { icon: Check, tone: "success", label: "Completed" };
  }

  if (
    event.type === "timeline_step_updated" ||
    effectiveType === "progress_update" ||
    effectiveType === "executing"
  ) {
    if (isTaskCompleted) {
      return { icon: Check, tone: "success", label: "Completed" };
    }
    return { icon: Loader2, tone: "active", spin: true, label: "In progress" };
  }

  if (event.type === "timeline_step_started" || effectiveType === "step_started") {
    if (isTaskCompleted) {
      return { icon: Check, tone: "success", label: "Step completed" };
    }
    return { icon: Play, tone: "active", label: "Step started" };
  }

  if (event.type === "timeline_evidence_attached" || effectiveType === "citations_collected") {
    return { icon: Link2, tone: "neutral", label: "Evidence attached" };
  }

  if (event.type === "timeline_artifact_emitted" || effectiveType === "artifact_created") {
    return { icon: FileOutput, tone: "success", label: "Output ready" };
  }

  if (
    effectiveType === "file_created" ||
    effectiveType === "file_modified" ||
    effectiveType === "file_deleted"
  ) {
    return { icon: FileText, tone: "neutral", label: "File change" };
  }

  return { icon: Circle, tone: "neutral", label: "Event" };
}
