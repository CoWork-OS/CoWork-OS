import type { TaskEvent } from "../../shared/types";

type TaskEventLike = Pick<TaskEvent, "type" | "legacyType" | "status" | "payload">;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function coerceNonEmptyText(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const obj = asObject(value);
  if (obj && typeof obj.message === "string" && obj.message.trim().length > 0) {
    return obj.message.trim();
  }
  return "";
}

function isLikelyTaskCompletionPayload(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;

  if (typeof payload.terminalStatus === "string") return true;
  if (typeof payload.resultSummary === "string" && payload.resultSummary.trim().length > 0) return true;
  if (typeof payload.semanticSummary === "string" && payload.semanticSummary.trim().length > 0) return true;
  if (typeof payload.verificationVerdict === "string" && payload.verificationVerdict.trim().length > 0)
    return true;
  if (typeof payload.verificationReport === "string" && payload.verificationReport.trim().length > 0)
    return true;
  if (payload.outputSummary && typeof payload.outputSummary === "object") return true;
  if (Array.isArray(payload.pendingChecklist) && payload.pendingChecklist.length > 0) return true;

  if (typeof payload.message === "string" && /^\s*task completed\b/i.test(payload.message)) {
    return true;
  }

  return false;
}

export function getEffectiveTaskEventType(event: TaskEventLike): string {
  if (!event.type.startsWith("timeline_")) return String(event.type);
  if (event.type === "timeline_error") return "timeline_error";

  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
  const legacyType =
    typeof event.legacyType === "string"
      ? event.legacyType
      : typeof payload?.legacyType === "string"
        ? payload.legacyType
        : undefined;
  if (legacyType && !legacyType.startsWith("timeline_")) {
    return legacyType;
  }

  switch (event.type) {
    case "timeline_group_started":
    case "timeline_step_started":
      return "step_started";
    case "timeline_group_finished":
    case "timeline_step_finished":
      if (event.status === "failed") return "step_failed";
      if (event.status === "skipped") return "step_skipped";
      if (event.status === "cancelled") return "task_cancelled";
      if (isLikelyTaskCompletionPayload(payload)) return "task_completed";
      return "step_completed";
    case "timeline_artifact_emitted":
      return "artifact_created";
    case "timeline_command_output":
      return "command_output";
    case "timeline_evidence_attached":
      return "citations_collected";
    case "timeline_step_updated":
    default:
      return "progress_update";
  }
}

export function getTimelineErrorText(event: Pick<TaskEvent, "type" | "payload">): string {
  if (event.type !== "timeline_error") return "";
  const payload = asObject(event.payload);
  if (!payload) return "";
  return (
    coerceNonEmptyText(payload.message) ||
    coerceNonEmptyText(payload.error) ||
    coerceNonEmptyText(payload.reason) ||
    coerceNonEmptyText(payload.display) ||
    coerceNonEmptyText(payload.failureReason)
  );
}
