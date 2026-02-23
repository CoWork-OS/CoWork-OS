import { truncateToolResult } from "./context-manager";
import type { LLMToolResult } from "./llm";

export function formatToolInputForLog(input: any, maxLength = 200): string {
  try {
    const serialized = JSON.stringify(input);
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized;
  } catch {
    return "(unserializable)";
  }
}

function prependRunCommandTerminationContext(sanitizedResult: string, result: any): string {
  if (!result || !result.terminationReason) return sanitizedResult;

  let contextPrefix = "";
  switch (result.terminationReason) {
    case "user_stopped":
      contextPrefix =
        "[USER STOPPED] The user intentionally interrupted this command. " +
        "Do not retry automatically. Ask the user if they want you to continue or try a different approach.\n\n";
      break;
    case "timeout":
      contextPrefix =
        "[TIMEOUT] Command exceeded time limit. " +
        "Consider: 1) Breaking into smaller steps, 2) Using a longer timeout if available, 3) Asking the user to run this manually.\n\n";
      break;
    case "error":
      contextPrefix =
        "[EXECUTION ERROR] The command could not be spawned or executed properly.\n\n";
      break;
  }

  return contextPrefix ? contextPrefix + sanitizedResult : sanitizedResult;
}

export function buildNormalizedToolResult(opts: {
  toolName: string;
  toolUseId: string;
  result: any;
  rawResult: string;
  sanitizeToolResult: (toolName: string, resultText: string) => string;
  getToolFailureReason: (result: any, fallback: string) => string;
  includeRunCommandTerminationContext?: boolean;
}): { toolResult: LLMToolResult; resultIsError: boolean; toolFailureReason: string } {
  const truncatedResult = truncateToolResult(opts.rawResult);
  let sanitizedResult = opts.sanitizeToolResult(opts.toolName, truncatedResult);

  if (opts.includeRunCommandTerminationContext && opts.toolName === "run_command") {
    sanitizedResult = prependRunCommandTerminationContext(sanitizedResult, opts.result);
  }

  const resultIsError = Boolean(opts.result && opts.result.success === false);
  const toolFailureReason = resultIsError
    ? opts.getToolFailureReason(opts.result, "Tool execution failed")
    : "";

  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: opts.toolUseId,
      content: resultIsError
        ? JSON.stringify({
            error: toolFailureReason,
            ...(opts.result?.url ? { url: opts.result.url } : {}),
          })
        : sanitizedResult,
      is_error: resultIsError,
    },
    resultIsError,
    toolFailureReason,
  };
}

export function normalizeToolUseName(opts: {
  toolName: string;
  normalizeToolName: (toolName: string) => {
    name: string;
    original: string;
    modified: boolean;
  };
  emitParameterInference: (tool: string, inference: string) => void;
}): string {
  const normalized = opts.normalizeToolName(opts.toolName);
  if (normalized.modified) {
    opts.emitParameterInference(
      opts.toolName,
      `Normalized tool name "${normalized.original}" -> "${normalized.name}"`,
    );
  }
  return normalized.name;
}

export function inferAndNormalizeToolInput(opts: {
  toolName: string;
  input: any;
  inferMissingParameters: (
    toolName: string,
    input: any,
  ) => { modified: boolean; input: any; inference?: string };
  emitParameterInference: (tool: string, inference: string) => void;
}): any {
  const inference = opts.inferMissingParameters(opts.toolName, opts.input);
  if (!inference.modified) {
    return opts.input;
  }
  const message =
    typeof inference.inference === "string" && inference.inference.trim()
      ? inference.inference
      : "Inferred missing parameters from available context";
  opts.emitParameterInference(opts.toolName, message);
  return inference.input;
}

export function buildDisabledToolResult(opts: {
  toolName: string;
  toolUseId: string;
  lastError?: string;
}): LLMToolResult {
  const errorDetail =
    typeof opts.lastError === "string" && opts.lastError.trim() ? opts.lastError : "unknown error";
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error: `Tool "${opts.toolName}" is temporarily unavailable due to: ${errorDetail}. Please try a different approach or wait and try again later.`,
      disabled: true,
    }),
    is_error: true,
  };
}

export function buildUnavailableToolResult(opts: {
  toolName: string;
  toolUseId: string;
}): LLMToolResult {
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error: `Tool "${opts.toolName}" is not available in this context. Please choose a different tool or check permissions/integrations.`,
      unavailable: true,
    }),
    is_error: true,
  };
}

export function buildInvalidInputToolResult(opts: {
  toolUseId: string;
  validationError: string;
}): LLMToolResult {
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error: opts.validationError,
      suggestion:
        "Include all required fields in the tool call (e.g., content for create_document/write_file).",
      invalid_input: true,
    }),
    is_error: true,
  };
}

export function buildDuplicateToolResult(opts: {
  toolName: string;
  toolUseId: string;
  duplicateCheck: { reason?: string; cachedResult?: string };
  isIdempotentTool: (toolName: string) => boolean;
  suggestion: string;
}): { toolResult: LLMToolResult; hasDuplicateAttempt: boolean } {
  const reason =
    typeof opts.duplicateCheck.reason === "string" && opts.duplicateCheck.reason.trim()
      ? opts.duplicateCheck.reason
      : "Duplicate tool call blocked.";

  if (opts.duplicateCheck.cachedResult && opts.isIdempotentTool(opts.toolName)) {
    return {
      toolResult: {
        type: "tool_result",
        tool_use_id: opts.toolUseId,
        content: opts.duplicateCheck.cachedResult,
      },
      hasDuplicateAttempt: false,
    };
  }

  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: opts.toolUseId,
      content: JSON.stringify({
        error: reason,
        suggestion: opts.suggestion,
        duplicate: true,
      }),
      is_error: true,
    },
    hasDuplicateAttempt: true,
  };
}

export function buildCancellationToolResult(opts: {
  toolUseId: string;
  cancelled: boolean;
}): LLMToolResult {
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error: opts.cancelled ? "Task was cancelled" : "Task already completed",
    }),
    is_error: true,
  };
}

export function buildRedundantFileOperationToolResult(opts: {
  toolUseId: string;
  fileOpCheck: { cachedResult?: string; reason?: string; suggestion?: string };
}): LLMToolResult {
  const reason =
    typeof opts.fileOpCheck.reason === "string" && opts.fileOpCheck.reason.trim()
      ? opts.fileOpCheck.reason
      : "Redundant file operation blocked.";
  if (opts.fileOpCheck.cachedResult) {
    return {
      type: "tool_result",
      tool_use_id: opts.toolUseId,
      content: opts.fileOpCheck.cachedResult,
      is_error: false,
    };
  }

  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error: reason,
      suggestion: opts.fileOpCheck.suggestion,
      blocked: true,
    }),
    is_error: true,
  };
}

export function buildWatchSkipBlockedArtifactToolResult(opts: {
  toolName: string;
  toolUseId: string;
}): LLMToolResult {
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error:
        `Tool "${opts.toolName}" is not allowed for this watch/skip recommendation task. ` +
        'Please provide a direct "watch" or "skip" recommendation based on your analysis.',
      suggestion: "Switch to a text-only answer with your recommendation and brief rationale.",
      blocked: true,
    }),
    is_error: true,
  };
}

export function recordToolFailureOutcome(opts: {
  toolName: string;
  failureReason: string;
  result: any;
  persistentToolFailures: Map<string, number>;
  recordFailure: (toolName: string, error: string) => boolean;
  isHardToolFailure: (toolName: string, result: any, reason: string) => boolean;
}): {
  shouldDisable: boolean;
  isHardFailure: boolean;
  failureCount: number;
} {
  const shouldDisable = opts.recordFailure(opts.toolName, opts.failureReason);
  const isHardFailure = opts.isHardToolFailure(opts.toolName, opts.result, opts.failureReason);
  const failureCount = (opts.persistentToolFailures.get(opts.toolName) || 0) + 1;
  opts.persistentToolFailures.set(opts.toolName, failureCount);
  return {
    shouldDisable,
    isHardFailure,
    failureCount,
  };
}

export function getToolInputValidationError(toolName: string, input: any): string | null {
  if (toolName === "create_document") {
    if (!input?.filename) return "create_document requires a filename";
    if (!input?.format) return "create_document requires a format (docx or pdf)";
    if (!input?.content) return "create_document requires content";
  }
  if (toolName === "write_file") {
    if (!input?.path) return "write_file requires a path";
    if (!input?.content)
      return (
        "write_file requires a non-empty 'content' parameter (string). " +
        "If the content is very long, split it: write the first half with write_file, " +
        "then append the rest with edit_file."
      );
  }
  if (toolName === "create_spreadsheet") {
    if (!input?.filename) return "create_spreadsheet requires a filename";
    if (!input?.sheets) return "create_spreadsheet requires sheets";
  }
  if (toolName === "create_presentation") {
    if (!input?.filename) return "create_presentation requires a filename";
    if (!input?.slides) return "create_presentation requires slides";
  }
  if (toolName === "canvas_push") {
    return null;
  }
  return null;
}

export function isHardToolFailure(toolName: string, result: any, failureReason = ""): boolean {
  if (!result || result.success !== false) {
    return false;
  }

  if (result.disabled === true || result.unavailable === true || result.blocked === true) {
    return true;
  }

  if (result.missing_requirements || result.missing_tools || result.missing_items) {
    return true;
  }

  const message = String(failureReason || result.error || result.reason || "").toLowerCase();
  if (!message) {
    return false;
  }

  if (toolName === "use_skill") {
    return /not currently executable|cannot be invoked automatically|not found|blocked by|disabled/.test(
      message,
    );
  }

  return /not currently executable|blocked by|disabled|not available in this context|not configured/.test(
    message,
  );
}

export function getToolFailureReason(result: any, fallback: string): string {
  if (typeof result?.error === "string" && result.error.trim()) {
    return result.error;
  }
  if (typeof result?.terminationReason === "string") {
    return `termination: ${result.terminationReason}`;
  }
  if (typeof result?.exitCode === "number") {
    return `exit code ${result.exitCode}`;
  }
  return fallback;
}
