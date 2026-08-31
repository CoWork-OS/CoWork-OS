import type { ToolPolicyTrace } from "../../../shared/types";
import { buildToolResultEnvelope } from "./tool-result-envelope";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asToolError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string" && error.trim()) return new Error(error);
  return new Error("Tool execution failed");
}

export function enrichToolEventPayload(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (type !== "tool_result" && type !== "tool_error") {
    return payload;
  }

  if (payload.envelope && typeof payload.envelope === "object") {
    return payload;
  }

  const toolName =
    (typeof payload.tool === "string" && payload.tool.trim()) ||
    (typeof payload.name === "string" && payload.name.trim()) ||
    "unknown_tool";
  const toolUseId =
    (typeof payload.toolUseId === "string" && payload.toolUseId.trim()) ||
    (typeof payload.tool_use_id === "string" && payload.tool_use_id.trim()) ||
    `${toolName}:${Date.now()}`;
  const policyTrace =
    payload.policyTrace && typeof payload.policyTrace === "object"
      ? (payload.policyTrace as ToolPolicyTrace)
      : undefined;
  const resultRecord = asRecord(payload.result);
  const resultStatus = String(payload.status || "")
    .trim()
    .toLowerCase();
  const outcomeFailed =
    type === "tool_error" ||
    payload.success === false ||
    payload.isError === true ||
    payload.is_error === true ||
    ["error", "failed", "blocked", "cancelled"].includes(resultStatus) ||
    resultRecord.success === false ||
    resultRecord.blocked === true ||
    typeof resultRecord.error === "string";
  const outcomeError = payload.error || resultRecord.error || resultRecord.reason;

  const envelope = buildToolResultEnvelope({
    toolUseId,
    toolName,
    status: outcomeFailed ? "error" : "success",
    result: payload.result,
    error: outcomeFailed ? asToolError(outcomeError) : undefined,
    retryable: false,
    policyTrace,
    userSummary:
      typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : `${toolName} ${outcomeFailed ? "failed" : "completed"}`,
    telemetry: {
      source: "event_enrichment",
      ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
    },
  });

  const nextPayload: Record<string, unknown> = {
    ...payload,
    tool: toolName,
    toolUseId,
    envelope,
  };

  if (policyTrace) {
    nextPayload.policyTrace = policyTrace;
  }

  if (type === "tool_result" && Object.keys(resultRecord).length > 0) {
    nextPayload.result = resultRecord;
  }

  return nextPayload;
}
