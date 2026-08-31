import type { TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

export type LiveTaskEventLane = "immediate" | "batchable" | "coalescible" | "hiddenLiveNoise";

const IMMEDIATE_EVENT_TYPES = new Set([
  "assistant_message",
  "user_message",
  "approval_requested",
  "input_request_created",
  "task_completed",
  "task_cancelled",
  "task_failed",
  "error",
  "timeline_error",
  "follow_up_failed",
  "step_failed",
]);

const BATCHABLE_EVENT_TYPES = new Set([
  "tool_call",
  "tool_result",
  "progress_update",
  "timeline_step_updated",
  "timeline_step_finished",
  "executing",
  "llm_streaming",
]);

const HIDDEN_LIVE_NOISE_EVENT_TYPES = new Set([
  "log",
  "llm_usage",
  "task_analysis",
  "llm_output_budget",
  "llm_output_budget_escalation",
]);

const NETWORK_FAILURE_RE =
  /\b(fetch failed|network|timeout|timed out|unable to get local issuer certificate|certificate|tls)\b/i;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getPayloadText(payload: Record<string, unknown>): string {
  const values = [
    payload.message,
    payload.error,
    payload.reason,
    payload.userMessage,
    payload.title,
  ];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
}

export function getLiveTaskEventCoalesceFingerprint(event: TaskEvent): string | null {
  const effectiveType = getEffectiveTaskEventType(event);
  const payload = asObject(event.payload);
  const text = getPayloadText(payload);
  const tool = typeof payload.tool === "string" ? payload.tool.trim() : "";
  const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
  const code = typeof payload.code === "string" ? payload.code.trim() : "";
  const failureClass = typeof payload.failureClass === "string" ? payload.failureClass.trim() : "";
  const normalizedText = text.replace(/\s+/g, " ").slice(0, 180);

  if (
    effectiveType === "error" ||
    effectiveType === "timeline_error" ||
    event.type === "timeline_error" ||
    effectiveType === "follow_up_failed"
  ) {
    if (!normalizedText && !code && !failureClass) return null;
    return [event.taskId, effectiveType, provider, tool, code, failureClass, normalizedText]
      .filter(Boolean)
      .join(":");
  }

  if (
    effectiveType === "tool_result" &&
    (payload.success === false || payload.isError === true || NETWORK_FAILURE_RE.test(text))
  ) {
    return [event.taskId, effectiveType, tool, code, normalizedText].filter(Boolean).join(":");
  }

  if (
    (effectiveType === "progress_update" || effectiveType === "timeline_step_updated") &&
    NETWORK_FAILURE_RE.test(text)
  ) {
    return [event.taskId, effectiveType, code, normalizedText].filter(Boolean).join(":");
  }

  return null;
}

export function classifyLiveTaskEvent(event: TaskEvent): LiveTaskEventLane {
  const effectiveType = getEffectiveTaskEventType(event);
  if (HIDDEN_LIVE_NOISE_EVENT_TYPES.has(effectiveType)) return "hiddenLiveNoise";
  if (getLiveTaskEventCoalesceFingerprint(event)) return "coalescible";
  if (IMMEDIATE_EVENT_TYPES.has(effectiveType)) return "immediate";
  if (BATCHABLE_EVENT_TYPES.has(effectiveType)) return "batchable";
  return "immediate";
}

export function isImmediateLiveTaskEvent(event: TaskEvent): boolean {
  return classifyLiveTaskEvent(event) === "immediate";
}
