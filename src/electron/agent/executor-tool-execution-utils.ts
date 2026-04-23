import { truncateToolResult } from "./context-manager";
import type {
  LLMImageMimeType,
  LLMToolResult,
  LLMToolResultCompanionContent,
} from "./llm";
import { canonicalizeToolName } from "./tool-semantics";

export interface NormalizedToolFailureReason {
  message: string;
  kind?: string;
  display?: string;
  code?: string;
}

export interface ToolInputValidationResult {
  input: Any;
  error: string | null;
  repairable: boolean;
  repaired: boolean;
  repairReason?: string;
}

const QUERY_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "in",
  "of",
  "for",
  "and",
  "or",
  "with",
  "on",
  "at",
  "from",
  "by",
  "if",
  "then",
  "also",
  "this",
  "that",
  "these",
  "those",
  "step",
  "task",
  "create",
  "build",
  "write",
  "implement",
  "generate",
  "file",
  "files",
  "script",
  "results",
  "output",
]);

const NESTED_PACKAGE_MANIFEST_PATH_REGEX = /(?:^|[\\/])src[\\/]+package\.json$/i;
const WEB_APP_SCAFFOLD_CONTEXT_REGEX =
  /\b(create|build|scaffold|bootstrap|initialize|set up|setup|implement|make)\b[\s\S]{0,120}\b(website|web app|webapp|app|application|ui|interface|react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i;
const NESTED_PACKAGE_INTENT_REGEX =
  /\b(monorepo|multi[- ]package|nested package|subpackage|workspace package|package workspace)\b/i;

function deriveSearchQueryFromContext(context: string): string {
  const tokens = String(context || "")
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 3 &&
        !QUERY_STOPWORDS.has(token) &&
        !/^\d+$/.test(token) &&
        !token.startsWith("http"),
    );
  return tokens.slice(0, 6).join(" ");
}

export function preflightValidateAndRepairToolInput(opts: {
  toolName: string;
  input: Any;
  contextText?: string;
}): ToolInputValidationResult {
  const toolName = String(opts.toolName || "");
  let input: Any =
    opts.input && typeof opts.input === "object" && !Array.isArray(opts.input) ? { ...opts.input } : {};
  let repaired = false;
  let repairable = false;
  const repairReasons: string[] = [];

  if (toolName === "search_files") {
    repairable = true;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      input.path = ".";
      repaired = true;
      repairReasons.push('defaulted path to "."');
    }
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) {
      const derivedQuery = deriveSearchQueryFromContext(opts.contextText || "");
      if (!derivedQuery) {
        return {
          input,
          error: "search_files requires a non-empty query",
          repairable: false,
          repaired,
          repairReason: repairReasons.join("; ") || undefined,
        };
      }
      input.query = derivedQuery;
      repaired = true;
      repairReasons.push(`derived query from context: "${derivedQuery}"`);
    }
  } else if (toolName === "glob") {
    repairable = true;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      input.path = ".";
      repaired = true;
      repairReasons.push('defaulted path to "."');
    }
    if (typeof input.pattern !== "string" || input.pattern.trim().length === 0) {
      input.pattern = "**/*";
      repaired = true;
      repairReasons.push('defaulted pattern to "**/*"');
    }
  } else if (toolName === "read_file") {
    repairable = true;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      const candidatePath = [input.filename, input.file, input.target]
        .map((candidate) => (typeof candidate === "string" ? candidate.trim() : ""))
        .find(Boolean);
      if (candidatePath) {
        input.path = candidatePath;
        repaired = true;
        repairReasons.push("normalized alternate path field");
      }
    }
  } else if (toolName === "write_file") {
    repairable = true;
    if ((typeof input.path !== "string" || input.path.trim().length === 0) && typeof input.filename === "string") {
      input.path = input.filename;
      repaired = true;
      repairReasons.push("normalized filename -> path");
    }
    if (typeof input.content !== "string" || input.content.length === 0) {
      const altContent = input.contents || input.text || input.body || input.data;
      if (typeof altContent === "string" && altContent.length > 0) {
        input.content = altContent;
        delete input.contents;
        delete input.text;
        delete input.body;
        delete input.data;
        repaired = true;
        repairReasons.push("normalized alternate content field");
      }
    }

    const normalizedPath = String(input.path || "").replace(/\\/g, "/");
    const normalizedContext = String(opts.contextText || "");
    const isSuspiciousNestedPackageManifest =
      NESTED_PACKAGE_MANIFEST_PATH_REGEX.test(normalizedPath) &&
      WEB_APP_SCAFFOLD_CONTEXT_REGEX.test(normalizedContext) &&
      !NESTED_PACKAGE_INTENT_REGEX.test(normalizedContext);
    if (isSuspiciousNestedPackageManifest) {
      return {
        input,
        error:
          "write_file to a nested src/package.json is blocked for website/app scaffold tasks. Use the workspace root package.json unless this is explicitly a monorepo or nested-package setup.",
        repairable: false,
        repaired,
        repairReason: repairReasons.join("; ") || undefined,
      };
    }
  }

  const error = getToolInputValidationError(toolName, input);
  return {
    input,
    error,
    repairable,
    repaired,
    repairReason: repairReasons.join("; ") || undefined,
  };
}

export function formatToolInputForLog(input: Any, maxLength = 200): string {
  try {
    const serialized = JSON.stringify(input);
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized;
  } catch {
    return "(unserializable)";
  }
}

function prependRunCommandTerminationContext(sanitizedResult: string, result: Any): string {
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

function normalizeImageMimeType(value: unknown): LLMImageMimeType | null {
  switch (String(value || "").trim().toLowerCase()) {
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
      return String(value || "").trim().toLowerCase() as LLMImageMimeType;
    default:
      return null;
  }
}

function buildComputerUseCompanionContent(
  toolName: string,
  result: Any,
): { compactResult: string; companionUserContent: LLMToolResultCompanionContent[] } | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const imageBase64 = typeof result.imageBase64 === "string" ? result.imageBase64.trim() : "";
  const captureId = typeof result.captureId === "string" ? result.captureId.trim() : "";
  const mediaType = normalizeImageMimeType(result.mediaType);
  if (!imageBase64 || !captureId || !mediaType) {
    return null;
  }

  const action = typeof result.action === "string" && result.action.trim() ? result.action.trim() : toolName;
  const appName =
    typeof result?.target?.appName === "string" && result.target.appName.trim()
      ? result.target.appName.trim()
      : undefined;
  const windowTitle =
    typeof result?.target?.windowTitle === "string" && result.target.windowTitle.trim()
      ? result.target.windowTitle.trim()
      : undefined;
  const note = typeof result.note === "string" && result.note.trim() ? result.note.trim() : undefined;

  const compactResult = JSON.stringify({
    ok: true,
    tool: toolName,
    action,
    captureId,
    mediaType,
    width: Number.isFinite(result.width) ? result.width : undefined,
    height: Number.isFinite(result.height) ? result.height : undefined,
    scaleFactor: Number.isFinite(result.scaleFactor) ? result.scaleFactor : undefined,
    target: {
      appName,
      windowTitle,
      windowId: Number.isFinite(result?.target?.windowId) ? result.target.windowId : undefined,
    },
    imageAttached: true,
    ...(note ? { note } : {}),
  });

  const companionText =
    `Latest controlled-window screenshot after ${action}. ` +
    `Use only this newest screenshot for the next computer-use action. ` +
    `captureId=${captureId}.` +
    (appName ? ` App=${appName}.` : "") +
    (windowTitle ? ` Window=${windowTitle}.` : "") +
    (note ? ` Note=${note}` : "");

  return {
    compactResult,
    companionUserContent: [
      { type: "text", text: companionText.trim() },
      {
        type: "image",
        data: imageBase64,
        mimeType: mediaType,
      },
    ],
  };
}

export function buildNormalizedToolResult(opts: {
  toolName: string;
  toolUseId: string;
  result: Any;
  rawResult: string;
  sanitizeToolResult: (toolName: string, resultText: string) => string;
  getToolFailureReason: (result: Any, fallback: string) => string;
  includeRunCommandTerminationContext?: boolean;
}): { toolResult: LLMToolResult; resultIsError: boolean; toolFailureReason: string } {
  const truncatedResult = truncateToolResult(opts.rawResult);
  let sanitizedResult = opts.sanitizeToolResult(opts.toolName, truncatedResult);

  if (opts.includeRunCommandTerminationContext && opts.toolName === "run_command") {
    sanitizedResult = prependRunCommandTerminationContext(sanitizedResult, opts.result);
  }

  const resultIsError = Boolean(opts.result && opts.result.success === false);
  const advisoryFallbackFailure = isAdvisoryToolFailureResult(opts.result);
  const normalizedFailure = resultIsError
    ? normalizeToolFailureReason(opts.result, "Tool execution failed")
    : null;
  const toolFailureReason = normalizedFailure?.message || "";
  const companion = !resultIsError ? buildComputerUseCompanionContent(opts.toolName, opts.result) : null;

  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: opts.toolUseId,
      content: resultIsError && !advisoryFallbackFailure
        ? JSON.stringify({
            error: toolFailureReason,
            ...(normalizedFailure?.kind ? { kind: normalizedFailure.kind } : {}),
            ...(normalizedFailure?.display ? { display: normalizedFailure.display } : {}),
            ...(normalizedFailure?.code ? { code: normalizedFailure.code } : {}),
            ...(opts.result?.url ? { url: opts.result.url } : {}),
          })
        : companion?.compactResult || sanitizedResult,
      is_error: resultIsError && !advisoryFallbackFailure,
      ...(companion ? { companion_user_content: companion.companionUserContent } : {}),
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
  input: Any;
  inferMissingParameters: (
    toolName: string,
    input: Any,
  ) => { modified: boolean; input: Any; inference?: string };
  emitParameterInference: (tool: string, inference: string) => void;
}): Any {
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
  hint?: string;
  alternatives?: string[];
}): LLMToolResult {
  const baseError = `Tool "${opts.toolName}" is not available in this context. Please choose a different tool or check permissions/integrations.`;
  const alternatives =
    Array.isArray(opts.alternatives) && opts.alternatives.length > 0
      ? Array.from(new Set(opts.alternatives.map((value) => String(value).trim()).filter(Boolean)))
      : [];
  const alternativesHint =
    alternatives.length > 0
      ? ` Try one of these available alternatives instead: ${alternatives.join(", ")}.`
      : "";
  const error = `${baseError}${alternativesHint}${opts.hint ? ` ${opts.hint}` : ""}`.trim();
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error,
      unavailable: true,
      ...(alternatives.length > 0 ? { alternatives } : {}),
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

const CLOUD_ACTION_READ_ONLY_ACTIONS = new Set([
  "get_current_user",
  "search",
  "get_file",
  "get_folder",
  "list_folder_items",
  "list_folder",
  "list_children",
  "get_item",
  "get_item_metadata",
  "list_drives",
  "list_sites",
  "list_lists",
  "list_messages",
  "list_events",
  "download_file",
]);

const READ_ONLY_ACTION_PREFIX = /^(get_|list_|search|read_|query_|describe_|check_)/;
const MUTATING_ACTION_PREFIX = /^(create_|update_|delete_|remove_|move_|copy_|rename_|upload_|write_|set_|add_|append_|patch_|modify_)/;

function isReadOnlyCloudAction(action: string): boolean {
  const normalized = String(action || "").trim().toLowerCase();
  if (!normalized) return false;
  if (CLOUD_ACTION_READ_ONLY_ACTIONS.has(normalized)) return true;
  if (MUTATING_ACTION_PREFIX.test(normalized)) return false;
  return READ_ONLY_ACTION_PREFIX.test(normalized);
}

export function isEffectivelyIdempotentToolCall(opts: {
  toolName: string;
  input: Any;
  isIdempotentTool: (toolName: string) => boolean;
}): boolean {
  if (opts.isIdempotentTool(opts.toolName)) return true;
  if (!opts.toolName.endsWith("_action")) return false;

  const action =
    opts.input && typeof opts.input.action === "string" ? String(opts.input.action) : "";
  if (!action) return false;
  return isReadOnlyCloudAction(action);
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
  result: Any;
  persistentToolFailures: Map<string, number>;
  recordFailure: (toolName: string, error: string) => boolean;
  isHardToolFailure: (toolName: string, result: Any, reason: string) => boolean;
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

export function getToolInputValidationError(toolName: string, input: Any): string | null {
  const canonicalToolName = canonicalizeToolName(toolName);

  if (canonicalToolName === "create_document") {
    if (!input?.filename) return "create_document requires a filename";
    // create_document requires format; generate_document is valid with markdown/sections.
    if (toolName === "create_document" && !input?.format) {
      return "create_document requires a format (docx or pdf)";
    }
    if (toolName === "create_document" && !input?.content) return "create_document requires content";
    if (toolName === "generate_document" && !input?.markdown && !input?.sections) {
      return "generate_document requires markdown or sections";
    }
  }
  if (toolName === "compile_latex") {
    if (!input?.sourcePath) return "compile_latex requires a sourcePath";
  }
  if (toolName === "write_file") {
    if (typeof input?.path !== "string" || input.path.trim().length === 0)
      return "write_file requires a path";
    if (typeof input?.content !== "string" || input.content.length === 0)
      return (
        "write_file requires a non-empty 'content' parameter (string). " +
        "If the content is very long, split it: write the first half with write_file, " +
        "then append the rest with edit_file."
      );
  }
  if (toolName === "read_file") {
    if (typeof input?.path !== "string" || input.path.trim().length === 0) {
      return "read_file requires a non-empty path";
    }
  }
  if (toolName === "search_files") {
    if (typeof input?.query !== "string" || input.query.trim().length === 0) {
      return "search_files requires a non-empty query";
    }
  }
  if (toolName === "glob") {
    if (typeof input?.path !== "string" || input.path.trim().length === 0) {
      return "glob requires a non-empty path";
    }
    if (typeof input?.pattern !== "string" || input.pattern.trim().length === 0) {
      return "glob requires a non-empty pattern";
    }
  }
  if (canonicalToolName === "create_spreadsheet") {
    if (!input?.filename) return "create_spreadsheet requires a filename";
    if (!input?.sheets) return "create_spreadsheet requires sheets";
  }
  if (canonicalToolName === "create_presentation") {
    if (!input?.filename) return "create_presentation requires a filename";
    if (!input?.slides) return "create_presentation requires slides";
  }
  if (toolName === "count_text" || toolName === "text_metrics") {
    const hasText = typeof input?.text === "string";
    const hasPath = typeof input?.path === "string" && input.path.trim().length > 0;
    if (!hasText && !hasPath) {
      return `${toolName} requires either 'text' or 'path'`;
    }
    if (hasText && hasPath) {
      return `${toolName} requires either 'text' or 'path', not both`;
    }
  }
  if (toolName === "canvas_push") {
    return null;
  }
  return null;
}

export function isHardToolFailure(toolName: string, result: Any, failureReason = ""): boolean {
  if (!result || result.success !== false) {
    return false;
  }

  if (result.nonBlocking === true || result.recoverableFallback === true) {
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

  if (toolName === "Skill") {
    return /not currently executable|cannot be invoked automatically|not found|blocked by|disabled/.test(
      message,
    );
  }

  return /not currently executable|blocked by|disabled|not available in this context|not configured/.test(
    message,
  );
}

export function isAdvisoryToolFailureResult(result: Any): boolean {
  return Boolean(
    result &&
      result.success === false &&
      (result.nonBlocking === true || result.recoverableFallback === true),
  );
}

export function getToolFailureReason(result: Any, fallback: string): string {
  return normalizeToolFailureReason(result, fallback).message;
}

export function normalizeToolFailureReason(result: Any, fallback: string): NormalizedToolFailureReason {
  const fallbackMessage = typeof fallback === "string" && fallback.trim() ? fallback : "unknown error";
  const errorValue = result?.error;

  if (typeof errorValue === "string" && errorValue.trim()) {
    return { message: errorValue.trim() };
  }

  if (errorValue && typeof errorValue === "object") {
    const errorObj = errorValue as Record<string, unknown>;
    const message =
      typeof errorObj.message === "string" && errorObj.message.trim()
        ? errorObj.message.trim()
        : typeof errorObj.display === "string" && errorObj.display.trim()
          ? errorObj.display.trim()
          : typeof errorObj.kind === "string" && errorObj.kind.trim()
            ? `${errorObj.kind.trim()} error`
            : "";
    if (message) {
      return {
        message,
        kind: typeof errorObj.kind === "string" ? errorObj.kind : undefined,
        display: typeof errorObj.display === "string" ? errorObj.display : undefined,
        code: typeof errorObj.code === "string" ? errorObj.code : undefined,
      };
    }
  }

  if (typeof result?.reason === "string" && result.reason.trim()) {
    return { message: result.reason.trim() };
  }

  if (typeof result?.terminationReason === "string" && result.terminationReason.trim()) {
    return { message: `termination: ${result.terminationReason}` };
  }
  if (typeof result?.exitCode === "number") {
    return { message: `exit code ${result.exitCode}` };
  }
  return { message: fallbackMessage };
}
