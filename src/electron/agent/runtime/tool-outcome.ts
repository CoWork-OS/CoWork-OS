import type {
  ToolAttemptEffect,
  ToolCoverage,
  ToolResultEnvelopeStatus,
} from "../../../shared/types";

export type CanonicalToolOutcomeStatus = "success" | "error" | "blocked" | "cancelled" | "unknown";

export interface CanonicalToolOutcome {
  status: CanonicalToolOutcomeStatus;
  success: boolean;
  blocked: boolean;
  retryable: boolean;
  result?: unknown;
  error?: unknown;
  reason?: string;
  /** How much of the asked-for scope was checked; absent when the tool does not say. */
  coverage?: ToolCoverage;
  /** When the underlying data was last updated, separate from the query time. */
  dataAsOf?: number;
  queriedAt?: number;
}

const FAILURE_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "discarded",
  "timeout",
  "timed_out",
  "timed-out",
]);
const BLOCKED_STATUSES = new Set([
  "blocked",
  "denied",
  "unauthorized",
  "forbidden",
  "not_allowed",
  "not-allowed",
  "rejected",
]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "aborted", "interrupted"]);
const TIMEOUT_STATUSES = new Set(["timeout", "timed_out", "timed-out"]);
/**
 * Failures after which a dispatched call may still have had its effect: a timeout, a lost
 * connection or transport, or an abort that arrived while the call was running.
 */
const OUTCOME_UNKNOWN_FAILURE =
  /timed out|timeout|etimedout|econnreset|econnaborted|epipe|socket hang up|connection (?:closed|reset|lost)|transport (?:closed|error)|network error|aborted/i;

/** What the caller knows about the call beyond its result. */
export interface ToolOutcomeContext {
  /** Whether the tool can change something; only `read` keeps the old timeout handling. */
  effect?: ToolAttemptEffect;
  /** The call's abort signal fired while it was running. */
  aborted?: boolean;
}

function outcomeUnknown(reasonDetail: string | undefined, error?: unknown): CanonicalToolOutcome {
  return {
    status: "unknown",
    success: false,
    blocked: false,
    retryable: false,
    ...(error !== undefined ? { error } : {}),
    reason: reasonDetail ? `outcome_unknown: ${reasonDetail}` : "outcome_unknown",
  };
}
const UNKNOWN_STATUSES = new Set([
  "unknown",
  "queued",
  "running",
  "pending",
  "in_progress",
  "in-progress",
  "skipped",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (record && typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }
  return undefined;
}

function statusFrom(value: unknown): CanonicalToolOutcomeStatus | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (BLOCKED_STATUSES.has(normalized)) return "blocked";
  if (CANCELLED_STATUSES.has(normalized)) return "cancelled";
  if (FAILURE_STATUSES.has(normalized)) return "error";
  if (UNKNOWN_STATUSES.has(normalized)) return "unknown";
  if (normalized === "success" || normalized === "completed" || normalized === "ok") {
    return "success";
  }
  return null;
}

/**
 * Normalize every tool result shape used by serial execution, parallel
 * execution, persisted events, and progress scoring.  Failure signals always
 * win over optimistic `success` fields; a missing result is unknown rather
 * than silently treated as success.
 */
export function normalizeToolOutcome(
  value: unknown,
  thrownError?: unknown,
  context: ToolOutcomeContext = {},
): CanonicalToolOutcome {
  const mayHaveEffect = context.effect !== undefined && context.effect !== "read";
  if (thrownError !== undefined) {
    const message = messageFrom(thrownError);
    if (mayHaveEffect && (context.aborted || OUTCOME_UNKNOWN_FAILURE.test(message ?? ""))) {
      return outcomeUnknown(message, thrownError);
    }
    return {
      status: "error",
      success: false,
      blocked: false,
      retryable: false,
      error: thrownError,
      reason: messageFrom(thrownError),
    };
  }

  const outer = asRecord(value);
  const envelope = outer ? asRecord(outer.envelope) : null;
  const sources = [outer, envelope].filter(
    (candidate): candidate is Record<string, unknown> => !!candidate,
  );
  const nestedResult =
    outer && Object.prototype.hasOwnProperty.call(outer, "result")
      ? outer.result
      : envelope && Object.prototype.hasOwnProperty.call(envelope, "structuredData")
        ? envelope.structuredData
        : value;
  const hasResultProperty = !!outer && Object.prototype.hasOwnProperty.call(outer, "result");
  const missingWrappedResult =
    !!outer &&
    ((hasResultProperty && (outer.result === undefined || outer.result === null)) ||
      (!hasResultProperty &&
        !Object.prototype.hasOwnProperty.call(outer, "structuredData") &&
        !Object.prototype.hasOwnProperty.call(outer, "content") &&
        (Object.prototype.hasOwnProperty.call(outer, "tool") ||
          Object.prototype.hasOwnProperty.call(outer, "toolUseId") ||
          Object.prototype.hasOwnProperty.call(outer, "tool_use_id") ||
          outer.type === "tool_result" ||
          outer.type === "tool_error")));
  const resultRecord = asRecord(nestedResult);
  if (
    mayHaveEffect &&
    [...sources.map((candidate) => candidate.status), resultRecord?.status].some(
      (candidate) =>
        typeof candidate === "string" && TIMEOUT_STATUSES.has(candidate.trim().toLowerCase()),
    )
  ) {
    return outcomeUnknown("timeout");
  }
  const statuses = [
    ...sources.map((candidate) => statusFrom(candidate.status)),
    statusFrom(resultRecord?.status),
  ].filter((candidate): candidate is CanonicalToolOutcomeStatus => candidate !== null);
  const status =
    statuses.find((candidate) => candidate === "blocked") ||
    statuses.find((candidate) => candidate === "cancelled") ||
    statuses.find((candidate) => candidate === "error") ||
    statuses.find((candidate) => candidate === "unknown") ||
    statuses.find((candidate) => candidate === "success") ||
    null;
  const blocked =
    sources.some((candidate) => candidate.blocked === true) ||
    resultRecord?.blocked === true ||
    status === "blocked";
  const explicitError =
    sources.find((candidate) => candidate.error !== undefined && candidate.error !== false)
      ?.error ?? resultRecord?.error;
  const failed =
    blocked ||
    status === "error" ||
    status === "cancelled" ||
    status === "unknown" ||
    sources.some(
      (candidate) =>
        candidate.isError === true ||
        candidate.is_error === true ||
        candidate.success === false ||
        candidate.ok === false,
    ) ||
    resultRecord?.success === false ||
    resultRecord?.ok === false ||
    typeof explicitError === "string" ||
    (explicitError !== undefined && explicitError !== null);

  if (blocked) {
    return {
      status: "blocked",
      success: false,
      blocked: true,
      retryable: false,
      result: nestedResult,
      error: explicitError,
      reason:
        messageFrom(explicitError) ||
        messageFrom(resultRecord?.reason) ||
        messageFrom(resultRecord?.message) ||
        sources
          .map((candidate) => messageFrom(candidate.reason) || messageFrom(candidate.message))
          .find(Boolean),
    };
  }
  if (status === "cancelled") {
    return {
      status,
      success: false,
      blocked: false,
      retryable: sources.some((candidate) => candidate.retryable === true),
      result: nestedResult,
      error: explicitError,
      reason:
        messageFrom(explicitError) ||
        messageFrom(resultRecord?.reason) ||
        messageFrom(resultRecord?.message) ||
        sources
          .map((candidate) => messageFrom(candidate.reason) || messageFrom(candidate.message))
          .find(Boolean),
    };
  }
  const hasExplicitFailureSignal =
    explicitError !== undefined && explicitError !== null && explicitError !== false;
  const hasBooleanFailureSignal =
    sources.some(
      (candidate) =>
        candidate.isError === true ||
        candidate.is_error === true ||
        candidate.success === false ||
        candidate.ok === false,
    ) ||
    resultRecord?.success === false ||
    resultRecord?.ok === false;
  if (status === "unknown" && !hasExplicitFailureSignal && !hasBooleanFailureSignal) {
    return {
      status: "unknown",
      success: false,
      blocked: false,
      retryable: sources.some((candidate) => candidate.retryable === true),
      result: nestedResult,
      reason:
        messageFrom(resultRecord?.reason) ||
        sources.map((candidate) => messageFrom(candidate.reason)).find(Boolean) ||
        "Tool is still in progress.",
    };
  }
  if (failed) {
    return {
      status: "error",
      success: false,
      blocked: false,
      retryable: sources.some((candidate) => candidate.retryable === true),
      result: nestedResult,
      error:
        explicitError ||
        resultRecord?.reason ||
        resultRecord?.message ||
        sources
          .map((candidate) => candidate.reason ?? candidate.message)
          .find((candidate) => candidate !== undefined),
      reason:
        messageFrom(explicitError) ||
        messageFrom(resultRecord?.reason) ||
        messageFrom(resultRecord?.message) ||
        sources
          .map((candidate) => messageFrom(candidate.reason) || messageFrom(candidate.message))
          .find(Boolean),
    };
  }

  if (missingWrappedResult) {
    return {
      status: "unknown",
      success: false,
      blocked: false,
      retryable: false,
      reason: "Tool returned no result.",
    };
  }

  if (value === undefined || value === null) {
    return {
      status: "unknown",
      success: false,
      blocked: false,
      retryable: false,
      reason: "Tool returned no result.",
    };
  }

  return {
    status: "success",
    success: true,
    blocked: false,
    retryable: sources.some((candidate) => candidate.retryable === true),
    result: nestedResult,
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : undefined;
}

/**
 * Coverage of a search, list or query result, from the fields tools already return. `partial`
 * when part of the scope was not checked (a limit, a time budget, a policy filter, another page);
 * `complete` only when the tool says it was not truncated; absent when the tool does not say.
 */
export function deriveToolCoverage(toolName: string, result: unknown): ToolCoverage | undefined {
  const record = recordOf(result);
  if (!record || record.success === false) return undefined;
  const explicit = recordOf(record.coverage);
  if (
    explicit &&
    (explicit.status === "complete" ||
      explicit.status === "partial" ||
      explicit.status === "unknown")
  ) {
    return {
      status: explicit.status,
      ...(textOf(explicit.reason) ? { reason: textOf(explicit.reason) } : {}),
    };
  }
  if (record.scanTruncated === true) {
    return {
      status: "partial",
      reason: textOf(record.truncationReason) || "the scan stopped before covering everything",
    };
  }
  if (record.truncated === true) {
    return {
      status: "partial",
      reason:
        textOf(record.truncationReason) ||
        (toolName === "list_directory"
          ? "the folder has more entries than were listed"
          : "results were cut off at the tool's limit"),
    };
  }
  const metadata = recordOf(record.metadata);
  const filteredOut = Number(metadata?.filteredOutCount ?? record.filteredOutCount);
  if (Number.isFinite(filteredOut) && filteredOut > 0) {
    return {
      status: "partial",
      reason: `${filteredOut} result${filteredOut === 1 ? " was" : "s were"} removed by the domain policy`,
    };
  }
  for (const key of ["nextPageToken", "next_page_token", "nextCursor"]) {
    if (textOf(record[key])) {
      return { status: "partial", reason: "more results are available on another page" };
    }
  }
  if (record.hasMore === true) {
    return { status: "partial", reason: "more results are available on another page" };
  }
  if (record.truncated === false) return { status: "complete" };
  return undefined;
}

/** When the data a result describes was last updated, if the tool reports it. */
export function deriveToolDataAsOf(result: unknown): number | undefined {
  const record = recordOf(result);
  if (!record) return undefined;
  for (const key of ["dataAsOf", "lastModified", "modifiedTime", "updatedAt", "modified"]) {
    const value = record[key];
    const time =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
    if (Number.isFinite(time) && time > 0) return Math.floor(time);
  }
  return undefined;
}

export function toToolEnvelopeStatus(status: CanonicalToolOutcomeStatus): ToolResultEnvelopeStatus {
  switch (status) {
    case "success":
      return "success";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "error":
    case "unknown":
    default:
      return "error";
  }
}
