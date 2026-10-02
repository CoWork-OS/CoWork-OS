/**
 * Executor Helper Classes and Utilities
 *
 * Standalone helper classes and utility functions extracted from executor.ts.
 * These have no dependency on TaskExecutor and can be used independently.
 *
 * Contains:
 * - Error classification (retryable vs input-dependent)
 * - ToolCallDeduplicator (duplicate/loop detection)
 * - ToolFailureTracker (circuit breaker pattern)
 * - FileOperationTracker (redundant read/creation prevention)
 * - Utility functions (timeout, backoff, sleep, date formatting, question detection)
 */

import { createHash } from "crypto";
import * as path from "path";
import {
  canonicalizeToolName,
  isArtifactGenerationToolName,
  isFileMutationToolName,
} from "./tool-semantics";
import { classifyProviderError } from "./llm/provider-error-classifier";

// ===== Custom Error =====

export class AwaitingUserInputError extends Error {
  reasonCode?: string;
  userMessage?: string;

  constructor(message: string, opts?: { reasonCode?: string; userMessage?: string }) {
    super(message);
    this.name = "AwaitingUserInputError";
    this.reasonCode = opts?.reasonCode;
    this.userMessage = opts?.userMessage;
  }
}

// ===== Types =====

export type CompletionContract = {
  requiresExecutionEvidence: boolean;
  requiresDirectAnswer: boolean;
  requiresDecisionSignal: boolean;
  allowsOperationalStatus: boolean;
  requiresArtifactEvidence: boolean;
  requiredArtifactExtensions: string[];
  requiresVerificationEvidence: boolean;
  artifactKind: "none" | "file" | "canvas";
  requiredSuccessfulTools: string[];
};

// ===== Constants =====

// Timeout for LLM API calls (2 minutes)
export const LLM_TIMEOUT_MS = 2 * 60 * 1000;

// Per-step timeout (15 minutes max per step).
// A single 32000-token write at ~60 tps takes ~533s. With tool calls and
// quality refinement overhead, a typical write-heavy step runs ~560-600s.
// 15 minutes (900s, soft deadline ~810s) accommodates this with margin.
// If max_tokens recovery triggers at 32K (rare), a second attempt pushes to
// ~1066s which will exceed the soft deadline — but recovery at 32K should
// only occur for unusually massive documents (>25K words).
export const STEP_TIMEOUT_MS = 15 * 60 * 1000;

// Per-step timeout for deep work mode (45 minutes; raised from 30 min).
// Deep work tasks are long-running autonomous runs that may involve
// complex multi-step operations, web research for error recovery,
// and iterative problem-solving cycles. The previous 30-min cap was
// prematurely aborting large document generation and full-repo analysis steps.
export const DEEP_WORK_STEP_TIMEOUT_MS = 45 * 60 * 1000;

// Default per-tool execution timeout (overrideable per tool)
export const TOOL_TIMEOUT_MS = 30 * 1000;

// Maximum consecutive failures for the same tool before giving up (raised from 2 → 5).
// The previous limit of 2 was disabling tools too aggressively: transient network
// errors, file-not-found during refactors, and flaky shell commands were permanently
// disabling tools after a single retry. 5 consecutive failures remains a reliable
// signal of a truly broken tool while tolerating normal intermittent errors.
export const MAX_TOOL_FAILURES = 5;

// Maximum total steps in a plan (including revisions) to prevent runaway execution
export const MAX_TOTAL_STEPS = 20;

// Exponential backoff configuration
export const INITIAL_BACKOFF_MS = 1000; // Start with 1 second
export const MAX_BACKOFF_MS = 30000; // Cap at 30 seconds
export const BACKOFF_MULTIPLIER = 2; // Double each time

// Patterns that indicate non-retryable errors (quota, rate limits, etc.)
// These errors should immediately disable the tool
export const NON_RETRYABLE_ERROR_PATTERNS = [
  /quota.*exceeded/i,
  /exceeds?.*usage.*limit/i,
  /usage.*limit/i,
  /rate.*limit/i,
  /exceeded.*quota/i,
  /too many requests/i,
  /429/i,
  /432/i,
  /resource.*exhausted/i,
  /billing/i,
  /payment.*required/i,
  /upgrade your plan/i,
];

// Patterns that indicate context/window capacity overflow.
// These should trigger compaction + retry rather than terminal failure.
export const CONTEXT_CAPACITY_ERROR_PATTERNS = [
  /context length/i,
  /context window/i,
  /maximum context/i,
  /max context/i,
  /input too long/i,
  /prompt too long/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /request too large/i,
  /message too large/i,
  /maximum number of input tokens/i,
  /reduce the length of the messages/i,
  /invalid_request_error.*(context|tokens|length)/i,
  // Anthropic / Vertex: "prompt is too long: 210000 tokens > 200000 maximum"
  /prompt is too long/i,
  // Bedrock: "Input is too long for requested model."
  /input is too long/i,
  // Gemini: "The input token count (N) exceeds the maximum number of tokens allowed (M)."
  /input token count[^.]*exceeds/i,
  // llama.cpp: "the request exceeds the available context size, try increasing it"
  /exceeds the available context size/i,
  // Anthropic: "input length and `max_tokens` exceed context limit: N + M > L"
  /exceeds? (?:the )?context limit/i,
  // xAI: "This model's maximum prompt length is N but the request contains M tokens."
  /maximum prompt length/i,
];

// The requested output size (max_tokens) is over the model's output cap. That is
// an output-budget problem: compacting the input cannot fix it.
const OUTPUT_TOKEN_CAP_ERROR_PATTERNS = [
  /max_tokens:\s*\d+\s*>\s*\d+/i,
  /maximum allowed number of output tokens/i,
  /max_(?:completion_)?tokens is too large/i,
  /supports at most \d+ completion tokens/i,
  /max(?:imum)?[_ ]?output[_ ]?tokens/i,
];

// Wording that names the input as too long; it wins over an output-cap match.
const INPUT_OVERFLOW_ERROR_PATTERNS = [
  /prompt is too long/i,
  /input is too long/i,
  /input too long/i,
  /prompt too long/i,
  /context length/i,
  /context window/i,
  /context limit/i,
  /context size/i,
  /maximum context/i,
  /input token count/i,
  /maximum prompt length/i,
  /reduce the length of the messages/i,
];

// Patterns that indicate input-dependent errors (not tool failures)
// These are normal operational errors that should NOT count towards circuit breaker
export const INPUT_DEPENDENT_ERROR_PATTERNS = [
  /ENOENT/i, // File/directory not found
  /ENOTDIR/i, // Not a directory
  /EISDIR/i, // Is a directory (when expecting file)
  /no such file/i, // File not found
  /not found/i, // Generic not found
  /does not exist/i, // Resource doesn't exist
  /invalid path/i, // Invalid path provided
  /path.*invalid/i, // Path is invalid
  /cannot find/i, // Cannot find resource
  /permission denied/i, // Permission on specific file (not API permission)
  /EACCES/i, // Access denied to specific file
  // Missing/invalid parameter errors (LLM didn't provide required params)
  /parameter.*required/i, // "parameter is required"
  /required.*not provided/i, // "required but was not provided"
  /invalid.*parameter/i, // "Invalid content" type errors
  /must be.*string/i, // Type validation: "must be a non-empty string"
  /expected.*but received/i, // Type validation: "expected string but received undefined"
  /cannot specify both/i, // Parameter conflict: "Cannot specify both head and tail"
  /mutually exclusive/i, // "parameters are mutually exclusive"
  /invalid.*argument/i, // "Invalid argument" from tool validation
  /unexpected.*parameter/i, // "Unexpected parameter" from strict schemas
  /not a valid/i, // "X is not a valid value for Y"
  /timed out/i, // Command/operation timed out (often due to slow query)
  /module not found/i, // Missing runtime module import (e.g., sandboxed monty imports)
  /no module named/i, // Python-style missing module error
  // Network/navigation failures are often domain- or environment-specific
  /net::ERR_/i, // Playwright/Chromium navigation errors
  /ERR_HTTP2_PROTOCOL_ERROR/i, // Common site-specific failure
  /syntax error/i, // Script syntax errors (AppleScript, shell, etc.)
  /applescript execution failed/i, // AppleScript errors are input-related
  /user denied/i, // User denied an approval request
];

// Keywords that imply a step wants image verification.
export const IMAGE_VERIFICATION_KEYWORDS = [
  "image",
  "photo",
  "photograph",
  "picture",
  "illustration",
  "screenshot",
  "png",
  "jpg",
  "jpeg",
  "webp",
];

export const IMAGE_FILE_EXTENSION_REGEX = /\.(png|jpe?g|webp|gif|bmp)$/i;

// Allow a small buffer for file timestamp granularity/clock skew.
export const IMAGE_VERIFICATION_TIME_SKEW_MS = 1000;

// When the context is nearing compaction, flush a durable summary to memory/kit so
// dropped context doesn't erase important decisions/open loops.
export const PRE_COMPACTION_FLUSH_SLACK_TOKENS = 1200;
export const PRE_COMPACTION_FLUSH_COOLDOWN_MS = 2 * 60 * 1000;
export const PRE_COMPACTION_FLUSH_MAX_OUTPUT_TOKENS = 220;
export const PRE_COMPACTION_FLUSH_MIN_TOKEN_DELTA = 250;

// Proactive compaction: trigger at 90% utilization (aligned with Codex CLI's 90%
// threshold; Claude Code uses ~95%). Compacts down to 55% utilization, freeing ~35%
// of the context window for a comprehensive structured summary + ongoing conversation.
// Reference: Codex uses 20 000 tokens for preserved user messages and places no
// explicit limit on summary output. We cap summary output at 6144 tokens, which is
// enough for a thorough 9-section handoff summary without dominating small contexts.
export const PROACTIVE_COMPACTION_THRESHOLD = 0.9;
export const PROACTIVE_COMPACTION_TARGET = 0.55;
export const COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS = 6144;
export const COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS = 500;
export const COMPACTION_SUMMARY_MAX_INPUT_CHARS = 90000;
// Bot conversations commonly accumulate many read-only web results in a single
// turn. Sending that entire transcript through a second LLM call can spend
// several minutes retrying a compaction request, even though the deterministic
// transcript fallback already preserves the evidence needed to continue.
export const COMPACTION_BOT_LLM_MAX_INPUT_CHARS = 24000;
export const COMPACTION_USER_MSG_CLAMP = 4000;
export const COMPACTION_ASSISTANT_TEXT_CLAMP = 2500;
export const COMPACTION_TOOL_USE_CLAMP = 1200;
export const COMPACTION_TOOL_RESULT_CLAMP = 2000;

// ===== Error Classification Functions =====

/**
 * Check if an error is non-retryable (quota/rate limit related)
 * These errors indicate a systemic problem with the tool/API
 */
export function isNonRetryableError(errorMessage: string): boolean {
  return NON_RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Check if an LLM provider error is non-retryable.
 * For LLM providers, 429/rate limit/too many requests are TRANSIENT — retry with backoff.
 * Only billing/quota/payment errors are non-retryable, including an exhausted
 * quota reported as a 429 ("You exceeded your current quota").
 */
export function isNonRetryableLLMError(errorMessage: string): boolean {
  return (
    classifyProviderError({ message: String(errorMessage || "") }).reason === "quota_exhausted"
  );
}

/**
 * Check if an error is input-dependent (normal operational error)
 * These errors are due to bad input, not tool failure, and should not trigger circuit breaker
 */
export function isInputDependentError(errorMessage: string): boolean {
  return INPUT_DEPENDENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

function isCurrentLocationProviderFailure(toolName: string, errorMessage: string): boolean {
  if (toolName !== "get_current_location") return false;
  return /desktop geolocation|native desktop geolocation|core location|geoclue|windows location|timed out while getting current location|location access was denied|current location is unavailable|geolocation is not available/i.test(
    errorMessage,
  );
}

/**
 * Check if an error indicates input/context capacity exhaustion.
 */
export function isContextCapacityError(errorLike: unknown): boolean {
  const message =
    typeof errorLike === "string"
      ? errorLike
      : typeof errorLike === "object" && errorLike !== null
        ? String((errorLike as Any).message || "")
        : "";
  if (!message.trim()) return false;
  if (!CONTEXT_CAPACITY_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return false;
  const isOutputCapError = OUTPUT_TOKEN_CAP_ERROR_PATTERNS.some((pattern) => pattern.test(message));
  return (
    !isOutputCapError || INPUT_OVERFLOW_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/**
 * Token counts a context-overflow error reports, when it reports them:
 * `requested` is what the provider counted for the request and `limit` what it
 * allows. Returns null when the message carries no usable counts.
 */
export function parseContextOverflowTokenCounts(
  errorLike: unknown,
): { requested: number; limit: number } | null {
  const message =
    typeof errorLike === "string"
      ? errorLike
      : typeof errorLike === "object" && errorLike !== null
        ? String((errorLike as Any).message || "")
        : "";
  const toNumber = (value: string | undefined) => Number(String(value || "").replace(/,/g, ""));
  const counts = (requested: number, limit: number) =>
    Number.isFinite(requested) && Number.isFinite(limit) && limit > 0 && requested > limit
      ? { requested, limit }
      : null;

  // Anthropic: "input length and `max_tokens` exceed context limit: 198000 + 8192 > 200000"
  let match = /(\d[\d,]*)\s*\+\s*(\d[\d,]*)\s*>\s*(\d[\d,]*)/.exec(message);
  if (match) return counts(toNumber(match[1]) + toNumber(match[2]), toNumber(match[3]));
  // Anthropic: "prompt is too long: 210000 tokens > 200000 maximum"
  match = /(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i.exec(message);
  if (match) return counts(toNumber(match[1]), toNumber(match[2]));
  // Gemini: "input token count (1100000) exceeds the maximum number of tokens allowed (1048576)"
  match = /input token count \(?(\d[\d,]*)\)?[^(]*\((\d[\d,]*)\)/i.exec(message);
  if (match) return counts(toNumber(match[1]), toNumber(match[2]));
  // OpenAI-compatible: "maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens"
  match =
    /maximum (?:context|prompt) length is (\d[\d,]*)[\s\S]*?(?:resulted in|requested(?: about)?|contains) (\d[\d,]*)/i.exec(
      message,
    );
  if (match) return counts(toNumber(match[2]), toNumber(match[1]));
  // Mistral: "Prompt contains 40000 tokens ... too large for model with 32768 maximum context length"
  match = /contains (\d[\d,]*) tokens[\s\S]*?with (\d[\d,]*) maximum context length/i.exec(message);
  if (match) return counts(toNumber(match[1]), toNumber(match[2]));
  return null;
}

/**
 * Recoverable path-drift class used for task-root rewrite/retry logic.
 * This intentionally targets filesystem-miss style failures rather than boundary/security failures.
 */
export function isRecoverablePathDriftError(errorMessage: string): boolean {
  const lower = String(errorMessage || "").toLowerCase();
  if (!lower.trim()) return false;
  return (
    /enoent|no such file|does not exist|cannot find|not found|enotdir|eisdir/i.test(lower) &&
    !/outside workspace boundary|path traversal outside workspace|protected system path/i.test(
      lower,
    )
  );
}

// ===== Date/Time Utilities =====

/**
 * Get current date formatted for system prompts
 * Returns: "Tuesday, January 28, 2026"
 */
export function getCurrentDateString(): string {
  const now = new Date();
  return now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Get current date/time with timezone for system prompts
 * Used for scheduling features to help the agent understand current time context
 */
export function getCurrentDateTimeContext(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  // Get timezone name
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezoneOffset = now
    .toLocaleTimeString("en-US", { timeZoneName: "short" })
    .split(" ")
    .pop();

  return `${dateStr} at ${timeStr} (${timezone}, ${timezoneOffset})`;
}

// ===== Question Detection =====

/**
 * Check if the assistant's response is asking a question and waiting for user input
 */
export function isAskingQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const maxLengthForAnalysis = 4000;
  const sample = trimmed.slice(0, maxLengthForAnalysis);
  const lines = sample
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const tailLines = lines.slice(-2);

  const nonBlockingQuestionPatterns = [
    /\bwhat\s+(?:else\s+)?can\s+i\s+help\b/i,
    /\bhow\s+can\s+i\s+help\b/i,
    /\bis\s+there\s+anything\s+else\s+(?:i\s+can\s+help|you\s+need|you'd\s+like)\b/i,
    /\banything\s+else\s+(?:i\s+can\s+help|you\s+need|you'd\s+like|to\s+work\s+on)\b/i,
    /\bwhat\s+would\s+you\s+like\s+to\s+(?:do|work\s+on|try|build)\b/i,
    /\bwhat\s+should\s+we\s+do\s+next\b/i,
    /\bcan\s+i\s+help\s+with\s+anything\s+else\b/i,
    /\bdoes\s+that\s+(?:help|make\s+sense)\b/i,
  ];

  const looksLikeNonBlockingTail =
    tailLines.length > 0 &&
    tailLines.every((line) => {
      const normalized = line.replace(/^[-*]?\s*\d*[).]?\s*/, "").trim();
      if (!normalized) return true;
      return nonBlockingQuestionPatterns.some((pattern) => pattern.test(normalized));
    });
  if (looksLikeNonBlockingTail) return false;

  const blockingCuePatterns = [
    /\bneed\s+your\s+(?:input|approval|confirmation|decision|choice|answer)\b/i,
    /\brequired\s+(?:input|approval|confirmation|decision|file|path|value)\b/i,
    /before\s+i\s+can\s+(?:proceed|continue)\b/i,
    /i\s+can(?:not|'t)\s+(?:proceed|continue)\b/i,
    /\bawaiting\s+your\b/i,
    /\baction\s+required\b/i,
    /\bwaiting\s+for\s+your\b/i,
    /\bcannot\s+complete\s+without\b/i,
    /\brequires?\s+your\s+(?:input|approval|confirmation|decision)\b/i,
  ];

  const explicitProceedPatterns = [
    /\bi\s+(?:will|'ll)\s+(?:proceed|continue|go\s+ahead|move\s+forward)\b/i,
    /\bi\s+can\s+(?:proceed|continue|move\s+forward)\b/i,
    /\bi\s+(?:will|'ll)\s+assume\b/i,
    /\bif\s+you\s+do\s+not\s+(?:respond|answer|reply)\b/i,
    /\bif\s+you\s+don't\s+(?:respond|answer|reply)\b/i,
  ];

  const questionWordPatterns = [/^(?:who|what|where|when|why|how|which)\b/i];

  const _imperativePatterns = [
    /^(?:please\s+)?(?:provide|share|send|upload|enter|paste|specify|clarify|confirm|choose|pick|select|list|tell|give)\b/i,
  ];

  const _decisionPatterns = [
    /^(?:do\s+you\s+want|do\s+you\s+prefer|would\s+you\s+like|would\s+you\s+prefer|should\s+i|is\s+it\s+(?:ok|okay|alright)\s+if\s+i)\b/i,
  ];

  const explicitResponseRequestPatterns = [
    /\breply\s+with\b/i,
    /\brespond\s+with\b/i,
    /\bplease\s+(?:reply|respond|confirm|choose|pick|select|provide|share|send|clarify)\b/i,
    /\bchoose\s+(?:one|between|from)\b/i,
    /\bpick\s+(?:one|between|from)\b/i,
    /\bselect\s+(?:one|between|from)\b/i,
    /\bwhich\s+(?:one|option|approach|path)\b/i,
    /\bdo\s+you\s+want\s+me\s+to\b/i,
    /\bwould\s+you\s+like\s+me\s+to\b/i,
    /\bshould\s+i\b/i,
    /\bcan\s+you\s+(?:provide|share|confirm|clarify)\b/i,
    /\bcould\s+you\s+(?:provide|share|confirm|clarify)\b/i,
  ];

  const decisionQuestionPatterns = [
    /^(?:do\s+you\s+want|would\s+you\s+like|should\s+i|can\s+you|could\s+you|which|what(?:\s+option)?|is\s+it\s+ok(?:ay)?\s+if)\b/i,
  ];

  const hasBlockingCue = blockingCuePatterns.some((pattern) => pattern.test(sample));
  const hasExplicitProceed = explicitProceedPatterns.some((pattern) => pattern.test(sample));
  if (hasBlockingCue) return true;
  let tailRequiresResponse = false;

  for (const line of tailLines) {
    const normalized = line.replace(/^[-*]?\s*\d*[).]?\s*/, "").trim();
    if (!normalized) continue;
    if (nonBlockingQuestionPatterns.some((pattern) => pattern.test(normalized))) {
      continue;
    }
    if (explicitResponseRequestPatterns.some((pattern) => pattern.test(normalized))) {
      tailRequiresResponse = true;
    }
    const looksLikeQuestion =
      normalized.endsWith("?") || questionWordPatterns.some((pattern) => pattern.test(normalized));
    if (looksLikeQuestion && decisionQuestionPatterns.some((pattern) => pattern.test(normalized))) {
      tailRequiresResponse = true;
    }
  }

  return tailRequiresResponse && !hasExplicitProceed;
}

// ===== Tool Call Deduplicator =====

/** JSON with object keys sorted at every level, so equal inputs always serialize alike. */
function stableStringify(value: unknown): string {
  return (
    JSON.stringify(value, (_key, nested) =>
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? Object.fromEntries(
            Object.keys(nested)
              .sort()
              .map((key) => [key, (nested as Record<string, unknown>)[key]]),
          )
        : nested,
    ) ?? ""
  );
}

/** Short stable fingerprint of a tool input, independent of key order. */
export function hashToolInput(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 16);
}

// Outputs where writing renamed variants (report_v2.md, report_final.md) is a known
// retry pattern. Source files with numbered names (step-1.ts, step-2.ts) are distinct work.
const DOCUMENT_ARTIFACT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".rtf",
  ".doc",
  ".docx",
  ".odt",
  ".pdf",
  ".ppt",
  ".pptx",
  ".key",
  ".xls",
  ".xlsx",
  ".ods",
  ".csv",
  ".tsv",
]);

// Local tools that only read. Exploring a codebase legitimately takes many distinct
// reads and searches, so these are exempt from the per-minute rate limit.
const LOCAL_READ_ONLY_TOOLS = new Set([
  "grep",
  "glob",
  "read_files",
  "parse_document",
  "count_text",
  "text_metrics",
]);

// Input fields naming the file a mutation or artifact tool writes, in priority order.
const SEMANTIC_TARGET_INPUT_KEYS = [
  "filename",
  "path",
  "file_path",
  "destPath",
  "destination",
  "newPath",
  "sourcePath",
  "outputPath",
  "output_path",
];

function getSemanticTarget(input: Any): {
  targetKey?: string;
  target: string;
  normalizedTarget: string;
} {
  const targetKey = SEMANTIC_TARGET_INPUT_KEYS.find(
    (key) => typeof input?.[key] === "string" && input[key].trim(),
  );
  const target = targetKey ? String(input[targetKey]).trim() : "";
  const normalizedTarget = target
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .toLowerCase();
  return { targetKey, target, normalizedTarget };
}

export type DuplicateCallOutcome = "succeeded" | "failed" | "unknown";

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  reason?: string;
  cachedResult?: string;
  kind?: "exact" | "semantic" | "rate_limit";
  /** Outcome of the last identical call, for exact duplicates. */
  previousOutcome?: DuplicateCallOutcome;
}

interface SemanticCall {
  signature: string;
  /**
   * mutation: identity of a file change (only an identical change repeats it);
   * document_variant: renamed versions of one document; similar: near-identical calls.
   */
  kind: "mutation" | "document_variant" | "similar";
  target: string;
}

/** Whether a recorded tool result reports failure, mirroring the executor's success test. */
function describeRecordedOutcome(result?: string): {
  outcome: DuplicateCallOutcome;
  detail: string;
} {
  if (typeof result !== "string" || !result.trim()) return { outcome: "unknown", detail: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return { outcome: "unknown", detail: "" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { outcome: "unknown", detail: "" };
  }
  const record = parsed as Record<string, unknown>;
  const exitCode =
    typeof record.exitCode === "number"
      ? record.exitCode
      : typeof record.exit_code === "number"
        ? record.exit_code
        : undefined;
  if (record.success !== false && (exitCode === undefined || exitCode === 0)) {
    return { outcome: "succeeded", detail: "" };
  }
  const message = [record.error, record.stderr, record.message]
    .find((value) => typeof value === "string" && value.trim())
    ?.toString()
    .trim()
    .split("\n")[0]
    ?.slice(0, 160);
  const parts = [exitCode !== undefined ? `exit code ${exitCode}` : "", message || ""];
  return { outcome: "failed", detail: parts.filter(Boolean).join(": ") };
}

/**
 * Tracks recent tool calls to detect and prevent duplicate/repetitive calls
 * This prevents the agent from getting stuck in loops calling the same tool
 *
 * Features:
 * - Exact duplicate detection (same tool + same params)
 * - Semantic duplicate detection: an identical file change repeated, renamed variants of
 *   the same document, or near-identical searches/navigations
 * - Rate limiting per tool (local read-only tools are exempt)
 */
export class ToolCallDeduplicator {
  private recentCalls: Map<string, { count: number; lastCallTime: number; lastResult?: string }> =
    new Map();
  // Track semantic patterns (tool name -> list of recent inputs for pattern detection)
  private semanticPatterns: Map<string, Array<{ input: Any; time: number }>> = new Map();
  // Track semantic signature totals for the full task run (not reset per step)
  private semanticTotalCounts: Map<string, number> = new Map();
  // Rate limiting: track calls per tool per minute
  private rateLimitCounters: Map<string, { count: number; windowStart: number }> = new Map();

  private readonly maxDuplicates: number;
  private readonly windowMs: number;
  private readonly maxSemanticSimilar: number;
  private readonly rateLimit: number; // Max calls per tool per minute
  private readonly maxSemanticPerRun: number;

  constructor(
    maxDuplicates = 2,
    windowMs = 60000,
    maxSemanticSimilar = 4,
    rateLimit = 20,
    maxSemanticPerRun = 12,
  ) {
    this.maxDuplicates = maxDuplicates;
    this.windowMs = windowMs;
    this.maxSemanticSimilar = maxSemanticSimilar;
    this.rateLimit = rateLimit;
    this.maxSemanticPerRun = maxSemanticPerRun;
  }

  /**
   * Generate a hash key for a tool call based on name and input
   */
  private getCallKey(toolName: string, input: Any): string {
    // Sort keys at every level: a top-level key list as JSON.stringify replacer would
    // drop nested keys and make calls with different nested inputs look identical.
    return `${toolName}:${stableStringify(input)}`;
  }

  /**
   * Extract semantic signature from input for pattern matching.
   * File changes are identified by target + content, so only an identical change counts
   * as a repeat; renamed variants of one document and near-identical searches collapse.
   */
  private getSemanticSignature(toolName: string, input: Any): SemanticCall {
    const canonicalToolName = canonicalizeToolName(toolName);
    if (!input) return { signature: canonicalToolName, kind: "similar", target: "" };

    if (canonicalToolName === "browser_navigate") {
      const rawUrl = String(input.url || "").trim();
      const normalizedUrl = this.normalizeUrlForSemanticSignature(rawUrl);
      return {
        signature: `${canonicalToolName}:url:${normalizedUrl}`,
        kind: "similar",
        target: "",
      };
    }

    if (
      isFileMutationToolName(canonicalToolName) ||
      isArtifactGenerationToolName(canonicalToolName)
    ) {
      const { targetKey, target, normalizedTarget } = getSemanticTarget(input);
      const extension = path.posix.extname(normalizedTarget);
      const writesDocument =
        (canonicalToolName === "write_file" || canonicalToolName === "copy_file") &&
        DOCUMENT_ARTIFACT_EXTENSIONS.has(extension);
      if (isArtifactGenerationToolName(canonicalToolName) || writesDocument) {
        // Same directory, same extension, name differing only by version-like suffixes.
        const stem = path.posix
          .basename(normalizedTarget, extension)
          .replace(/[_-]v?\d+(\.\d+)?/gi, "")
          .replace(/[_-](complete|final|updated|new|copy|backup|draft)/gi, "");
        const directory = path.posix.dirname(normalizedTarget);
        return {
          signature: `${canonicalToolName}:variant:${directory}/${stem}${extension}`,
          kind: "document_variant",
          target,
        };
      }
      // The target is part of the signature already (normalized), so leave its spelling
      // out of the change fingerprint.
      const change = { ...input };
      if (targetKey) delete change[targetKey];
      return {
        signature: `${canonicalToolName}:${normalizedTarget}:${hashToolInput(change)}`,
        kind: "mutation",
        target,
      };
    }

    // For web searches, normalize the query to detect similar searches
    if (canonicalToolName === "web_search") {
      const query = (input.query || input.search || "").toLowerCase();
      // Remove platform-specific modifiers to get the core search term
      const normalizedQuery = query
        .replace(/site:(twitter\.com|x\.com|reddit\.com|github\.com)/gi, "")
        .replace(/\b(reddit|twitter|x\.com|github)\b/gi, "")
        .replace(/\b(19|20)\d{2}\b/g, "")
        .replace(
          /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
          "",
        )
        .replace(/\b(today|latest|breaking|news)\b/gi, "")
        .replace(/["']/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return {
        signature: `${canonicalToolName}:search:${normalizedQuery}`,
        kind: "similar",
        target: "",
      };
    }

    // For read operations, just use tool name (reading same file repeatedly is OK)
    if (canonicalToolName === "read_file" || canonicalToolName === "list_directory") {
      return {
        signature: `${canonicalToolName}:${input.path || ""}`,
        kind: "similar",
        target: "",
      };
    }

    // Default: use tool name only for semantic grouping
    return { signature: canonicalToolName, kind: "similar", target: "" };
  }

  private normalizeUrlForSemanticSignature(rawUrl: string): string {
    const trimmed = (rawUrl || "").trim();
    if (!trimmed) return "";
    try {
      const url = new URL(trimmed);
      const trackingParams = new Set([
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "utm_id",
        "gclid",
        "fbclid",
        "mc_cid",
        "mc_eid",
        "igshid",
      ]);

      const keptEntries = Array.from(url.searchParams.entries())
        .filter(([key]) => !trackingParams.has(key.toLowerCase()))
        .sort(([aKey, aVal], [bKey, bVal]) => {
          if (aKey === bKey) return aVal.localeCompare(bVal);
          return aKey.localeCompare(bKey);
        });

      const normalizedQuery = keptEntries
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");

      const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
      return `${url.protocol}//${url.host}${normalizedPath}${normalizedQuery ? `?${normalizedQuery}` : ""}`.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  }

  /**
   * Check rate limit for a tool
   */
  private resolveRateLimitForCall(toolName: string, input: Any): number {
    // Reads and searches change nothing; exact repeats are caught by duplicate detection.
    if (ToolCallDeduplicator.isIdempotentTool(toolName) || LOCAL_READ_ONLY_TOOLS.has(toolName)) {
      return Number.POSITIVE_INFINITY;
    }
    // Some cloud listing APIs legitimately require many small paginated calls.
    // Keep strict limits for mutating actions, but allow higher throughput for read-only actions.
    if (toolName.endsWith("_action") && input && typeof input.action === "string") {
      const action = String(input.action).trim().toLowerCase();
      const mutatingAction =
        /^(create_|update_|delete_|remove_|move_|copy_|rename_|upload_|write_|set_|add_|append_|patch_|modify_)/.test(
          action,
        );
      if (!mutatingAction) {
        const readOnlyAction =
          /^(get_|list_|search|read_|query_|describe_|check_)/.test(action) ||
          action === "get_current_user" ||
          action === "list_folder_items";
        if (readOnlyAction) {
          return Math.max(this.rateLimit, 120);
        }
      }
    }

    return this.rateLimit;
  }

  private checkRateLimit(toolName: string, input: Any): { exceeded: boolean; reason?: string } {
    const now = Date.now();
    const counter = this.rateLimitCounters.get(toolName);
    const effectiveRateLimit = this.resolveRateLimitForCall(toolName, input);

    if (!counter || now - counter.windowStart > 60000) {
      // New window or first call
      return { exceeded: false };
    }

    if (counter.count >= effectiveRateLimit) {
      return {
        exceeded: true,
        reason:
          `Rate limit exceeded: "${toolName}" called ${counter.count} times in the last minute. ` +
          `Max allowed: ${effectiveRateLimit}/min.`,
      };
    }

    return { exceeded: false };
  }

  /**
   * Check for semantic duplicates (similar operations with slight variations)
   */
  private checkSemanticDuplicate(toolName: string, input: Any): DuplicateCheckResult {
    const now = Date.now();
    const { signature, kind, target } = this.getSemanticSignature(toolName, input);
    const windowSeconds = this.windowMs / 1000;

    // Get recent calls with this semantic signature
    const patterns = this.semanticPatterns.get(signature) || [];

    // Clean up old entries
    const recentPatterns = patterns.filter((p) => now - p.time <= this.windowMs);
    this.semanticPatterns.set(signature, recentPatterns);

    if (kind === "document_variant") {
      // Rewriting a document already written is an edit of it; only another renamed
      // version (report_v2.md, report_final.md, ...) adds a variant.
      const variants = new Set(
        recentPatterns.map((pattern) => getSemanticTarget(pattern.input).target),
      );
      const isNewVariant = !Array.from(variants).some(
        (variant) => variant.toLowerCase() === target.toLowerCase(),
      );
      if (isNewVariant && variants.size >= this.maxSemanticSimilar) {
        return {
          isDuplicate: true,
          reason:
            `${variants.size} versions of the same document were already written in the last ` +
            `${windowSeconds}s under names that differ only by version-like suffixes ` +
            `(${Array.from(variants).join(", ")}). Update one of them instead of adding "${target}".`,
          kind: "semantic",
        };
      }
    } else if (recentPatterns.length >= this.maxSemanticSimilar) {
      // Check if we have too many semantically similar calls
      const reason =
        kind === "mutation"
          ? `This exact "${toolName}" change${target ? ` to "${target}"` : ""} was already ` +
            `attempted ${recentPatterns.length} times in the last ${windowSeconds}s. Repeating it ` +
            "will not change the outcome: check whether it already applied or why it failed."
          : `Detected ${recentPatterns.length + 1} semantically similar "${toolName}" calls within ${windowSeconds}s. ` +
            `This appears to be a retry loop with slight parameter variations. ` +
            `Please try a different approach or check if the previous operation actually succeeded.`;
      return { isDuplicate: true, reason, kind: "semantic" };
    }

    // The per-run cap is for near-identical searches/navigations; distinct file changes
    // and documents are real work however many a long task needs.
    const totalSeen = this.semanticTotalCounts.get(signature) || 0;
    if (kind === "similar" && totalSeen >= this.maxSemanticPerRun) {
      return {
        isDuplicate: true,
        reason:
          `Per-run duplicate cap reached for "${toolName}" semantic signature after ${totalSeen} attempts. ` +
          "Stop retrying near-identical calls and synthesize from current evidence.",
        kind: "semantic",
      };
    }

    return { isDuplicate: false };
  }

  /**
   * Check if a tool call is a duplicate and should be blocked
   * @returns Object with isDuplicate flag and optional cached result
   */
  checkDuplicate(toolName: string, input: Any): DuplicateCheckResult {
    const now = Date.now();
    const canonicalToolName = canonicalizeToolName(toolName);

    // 0. Exclude stateful browser tools from duplicate detection
    const statefulTools = [
      "screenshot",
      "browser_get_content",
      "browser_screenshot",
      "browser_get_text",
      "browser_evaluate",
      "canvas_push",
    ];
    if (statefulTools.includes(canonicalToolName)) {
      return { isDuplicate: false };
    }

    // 1. Check rate limit first
    const rateLimitCheck = this.checkRateLimit(canonicalToolName, input);
    if (rateLimitCheck.exceeded) {
      return { isDuplicate: true, reason: rateLimitCheck.reason, kind: "rate_limit" };
    }

    // 2. Check exact duplicate
    const callKey = this.getCallKey(canonicalToolName, input);

    // Clean up old entries outside the time window
    for (const [key, value] of this.recentCalls.entries()) {
      if (now - value.lastCallTime > this.windowMs) {
        this.recentCalls.delete(key);
      }
    }

    const existing = this.recentCalls.get(callKey);
    if (
      existing &&
      now - existing.lastCallTime <= this.windowMs &&
      existing.count >= this.maxDuplicates
    ) {
      const { outcome, detail } = describeRecordedOutcome(existing.lastResult);
      const outcomeText =
        outcome === "failed"
          ? `, and the last one failed${detail ? ` (${detail})` : ""}`
          : outcome === "succeeded"
            ? ", and the last one succeeded"
            : "";
      return {
        isDuplicate: true,
        reason:
          `Tool "${canonicalToolName}" was already called ${existing.count} times with these exact ` +
          `parameters in the last ${this.windowMs / 1000}s${outcomeText}.`,
        cachedResult: existing.lastResult,
        kind: "exact",
        previousOutcome: outcome,
      };
    }

    // 3. Check semantic duplicate (for tools prone to retry loops)
    const semanticTools = new Set(["write_file", "copy_file", "web_search", "browser_navigate"]);
    if (
      semanticTools.has(canonicalToolName) ||
      isArtifactGenerationToolName(canonicalToolName) ||
      isFileMutationToolName(canonicalToolName)
    ) {
      const semanticCheck = this.checkSemanticDuplicate(canonicalToolName, input);
      if (semanticCheck.isDuplicate) {
        return semanticCheck;
      }
    }

    return { isDuplicate: false };
  }

  /**
   * Record a tool call (call this after checking for duplicates)
   */
  recordCall(toolName: string, input: Any, result?: string): void {
    const now = Date.now();
    const canonicalToolName = canonicalizeToolName(toolName);

    // Record exact call
    const callKey = this.getCallKey(canonicalToolName, input);
    const existing = this.recentCalls.get(callKey);

    if (existing && now - existing.lastCallTime <= this.windowMs) {
      existing.count++;
      existing.lastCallTime = now;
      if (result) {
        existing.lastResult = result;
      }
    } else {
      this.recentCalls.set(callKey, {
        count: 1,
        lastCallTime: now,
        lastResult: result,
      });
    }

    // Record semantic pattern
    const { signature } = this.getSemanticSignature(canonicalToolName, input);
    const patterns = this.semanticPatterns.get(signature) || [];
    patterns.push({ input, time: now });
    this.semanticPatterns.set(signature, patterns);
    this.semanticTotalCounts.set(signature, (this.semanticTotalCounts.get(signature) || 0) + 1);

    // Update rate limit counter
    const counter = this.rateLimitCounters.get(canonicalToolName);
    if (!counter || now - counter.windowStart > 60000) {
      this.rateLimitCounters.set(canonicalToolName, { count: 1, windowStart: now });
    } else {
      counter.count++;
    }
  }

  /**
   * Reset the deduplicator (e.g., when starting a new step)
   */
  reset(): void {
    this.recentCalls.clear();
    this.semanticPatterns.clear();
    // Per-run caps are scoped to a step or follow-up; otherwise one long session keeps
    // a signature blocked for good once the cap is reached.
    this.semanticTotalCounts.clear();
    // Don't reset rate limit counters - they should persist across steps
  }

  /**
   * After a workspace change, forget repeats of calls whose result depends on workspace
   * state (reads, listings, searches, commands such as test runs): running them again can
   * now give a different result. Repeats of file changes themselves are still tracked.
   * `except` keeps the history of the call that made the change, so a command repeated
   * back-to-back is still caught.
   */
  clearHistoryAfterWorkspaceMutation(except?: { toolName: string; input: Any }): void {
    this.clearReadOnlyHistory();
    const keepKey = except
      ? this.getCallKey(canonicalizeToolName(except.toolName), except.input)
      : null;
    const dependsOnWorkspace = (toolName: string): boolean => {
      const canonical = canonicalizeToolName(toolName);
      return !isFileMutationToolName(canonical) && !isArtifactGenerationToolName(canonical);
    };
    for (const key of Array.from(this.recentCalls.keys())) {
      if (key !== keepKey && dependsOnWorkspace(key.split(":", 1)[0] || "")) {
        this.recentCalls.delete(key);
      }
    }
  }

  /**
   * Clear read/list call history after filesystem mutations.
   * This prevents stale cached read results from being reused immediately
   * after a file was updated.
   */
  clearReadOnlyHistory(): void {
    const readLikePrefixes = [
      "read_file:",
      "read_multiple_files:",
      "list_directory:",
      "list_directory_with_sizes:",
    ];
    for (const key of Array.from(this.recentCalls.keys())) {
      if (readLikePrefixes.some((prefix) => key.startsWith(prefix))) {
        this.recentCalls.delete(key);
      }
    }

    for (const key of Array.from(this.semanticPatterns.keys())) {
      if (key.startsWith("read_file:") || key.startsWith("list_directory:")) {
        this.semanticPatterns.delete(key);
      }
    }

    this.rateLimitCounters.delete("read_file");
    this.rateLimitCounters.delete("read_multiple_files");
    this.rateLimitCounters.delete("list_directory");
    this.rateLimitCounters.delete("list_directory_with_sizes");
  }

  /**
   * Reset mutation duplicate history at step boundaries while preserving
   * read-only dedupe memory and all rate-limit counters.
   *
   * Why: mutation retries across different plan steps can be legitimate
   * (for example editing the same file in a later refinement step).
   */
  resetMutationHistoryForNewStep(): void {
    const isMutationTool = (toolName: string): boolean => {
      const canonical = canonicalizeToolName(toolName);
      return (
        isFileMutationToolName(canonical) ||
        isArtifactGenerationToolName(canonical) ||
        canonical === "copy_file"
      );
    };

    for (const key of Array.from(this.recentCalls.keys())) {
      const toolName = key.split(":", 1)[0] || "";
      if (isMutationTool(toolName)) {
        this.recentCalls.delete(key);
      }
    }

    for (const key of Array.from(this.semanticPatterns.keys())) {
      const toolName = key.split(":", 1)[0] || "";
      if (isMutationTool(toolName)) {
        this.semanticPatterns.delete(key);
      }
    }

    for (const key of Array.from(this.semanticTotalCounts.keys())) {
      const toolName = key.split(":", 1)[0] || "";
      if (isMutationTool(toolName)) {
        this.semanticTotalCounts.delete(key);
      }
    }
  }

  /**
   * Check if a tool is idempotent (safe to cache/skip duplicates)
   */
  static isIdempotentTool(toolName: string): boolean {
    const idempotentTools = [
      "read_file",
      "read_multiple_files",
      "list_directory",
      "directory_tree",
      "search_files",
      "search_code",
      "get_file_info",
      "canvas_list",
      "canvas_checkpoints",
      "task_history",
      "channel_list_chats",
      "channel_history",
      "channel_fetch_discord_messages",
      "channel_download_discord_attachment",
      "web_search",
    ];
    if (idempotentTools.includes(toolName)) {
      return true;
    }

    // Treat "read-only by convention" tool names as idempotent to avoid
    // duplicate-error loops on observational tools.
    const readOnlyPrefixes = ["read_", "list_", "get_", "search_", "check_", "describe_", "query_"];
    if (readOnlyPrefixes.some((prefix) => toolName.startsWith(prefix))) {
      return true;
    }

    const readOnlySuffixes = ["_list", "_status", "_history"];
    return readOnlySuffixes.some((suffix) => toolName.endsWith(suffix));
  }
}

// ===== Tool Failure Tracker =====

/**
 * Tracks tool failures to implement circuit breaker pattern
 * Tools are automatically re-enabled after a cooldown period
 *
 * IMPORTANT: This now tracks ALL consecutive failures, including input-dependent ones.
 * If the LLM consistently fails to provide correct parameters, it's a sign it's stuck
 * in a loop and we should disable the tool to force a different approach.
 */
export class ToolFailureTracker {
  private failures: Map<string, { count: number; lastError: string }> = new Map();
  // Separate tracker for input-dependent errors (higher threshold before disabling)
  private inputDependentFailures: Map<string, { count: number; lastError: string }> = new Map();
  private disabledTools: Map<string, { disabledAt: number; reason: string }> = new Map();
  private readonly cooldownMs: number = 2 * 60 * 1000; // 2 minutes cooldown
  // Higher threshold for input-dependent errors since LLM might eventually get it right
  private readonly maxInputDependentFailures: number = 8;

  private getMaxInputDependentFailures(toolName: string): number {
    // AppleScript often needs a few iterative syntax/quoting fixes before succeeding.
    if (toolName === "run_applescript") {
      return 12;
    }
    if (toolName.startsWith("browser_")) {
      return 10;
    }
    // Shell commands need iteration room for install/path/env fixes.
    if (toolName === "run_command") {
      return 10;
    }
    return this.maxInputDependentFailures;
  }

  private isToolRuntimeTimeoutFailure(toolName: string, errorMessage: string): boolean {
    if (toolName !== "write_file") return false;
    return /Tool write_file timed out|write_file timed out during|write_file aborted during/i.test(
      errorMessage,
    );
  }

  private isShellSandboxRuntimeFailure(toolName: string, errorMessage: string): boolean {
    if (toolName !== "run_command") return false;
    return /Shell sandbox failed|sandbox-exec|sandbox_apply|Abort trap|exit\s+134|code\s+134/i.test(
      errorMessage,
    );
  }

  private getMaxSystemicFailures(toolName: string, errorMessage: string): number {
    if (this.isShellSandboxRuntimeFailure(toolName, errorMessage)) {
      return 2;
    }
    if (this.isToolRuntimeTimeoutFailure(toolName, errorMessage)) {
      return 2;
    }
    return MAX_TOOL_FAILURES;
  }

  private extractSearchProvider(errorMessage: string): string | null {
    const lower = String(errorMessage || "").toLowerCase();
    if (lower.includes("tavily")) return "tavily";
    if (lower.includes("brave")) return "brave";
    if (lower.includes("serpapi")) return "serpapi";
    if (lower.includes("google")) return "google";
    if (lower.includes("duckduckgo")) return "duckduckgo";
    return null;
  }

  /**
   * Record a tool failure
   * @returns true if the tool should be disabled (circuit broken)
   */
  recordFailure(toolName: string, errorMessage: string): boolean {
    const browserHttpStatusFailure =
      toolName.startsWith("browser_") &&
      /http\s*[45]\d{2}|client error\s*\(\d{3}\)|server error\s*\(\d{3}\)/i.test(errorMessage);

    if (isCurrentLocationProviderFailure(toolName, errorMessage)) {
      this.disabledTools.set(toolName, { disabledAt: Date.now(), reason: errorMessage });
      return true;
    }

    // Provider-scoped quota/rate failures for web_search should not disable the
    // whole tool globally on first failure. ProviderFactory handles provider fallback/cooldown.
    if (toolName === "web_search" && isNonRetryableError(errorMessage)) {
      const provider = this.extractSearchProvider(errorMessage);
      if (provider) {
        console.log(
          `[ToolFailureTracker] Provider-scoped non-retryable error for ${toolName}:${provider}: ${errorMessage.substring(0, 100)}`,
        );
        return false;
      }
    }

    // If it's a non-retryable error (quota, rate limit), disable immediately
    if (isNonRetryableError(errorMessage) && !browserHttpStatusFailure) {
      this.disabledTools.set(toolName, { disabledAt: Date.now(), reason: errorMessage });
      console.log(
        `[ToolFailureTracker] Tool ${toolName} disabled due to non-retryable error: ${errorMessage.substring(0, 100)}`,
      );
      return true;
    }

    const runtimeTimeoutFailure = this.isToolRuntimeTimeoutFailure(toolName, errorMessage);

    // Input-dependent errors (missing params, file not found, etc.)
    // These are tracked separately with a higher threshold
    if (
      !runtimeTimeoutFailure &&
      (browserHttpStatusFailure || isInputDependentError(errorMessage))
    ) {
      const existing = this.inputDependentFailures.get(toolName) || { count: 0, lastError: "" };
      existing.count++;
      existing.lastError = errorMessage;
      this.inputDependentFailures.set(toolName, existing);

      const maxFailuresForTool = this.getMaxInputDependentFailures(toolName);

      console.log(
        `[ToolFailureTracker] Input-dependent error for ${toolName} (${existing.count}/${maxFailuresForTool}): ${errorMessage.substring(0, 80)}`,
      );

      // If LLM keeps making the same mistake, disable the tool
      if (existing.count >= maxFailuresForTool) {
        const reason = `LLM failed to provide correct parameters ${existing.count} times: ${errorMessage}`;
        this.disabledTools.set(toolName, { disabledAt: Date.now(), reason });
        console.log(
          `[ToolFailureTracker] Tool ${toolName} disabled after ${existing.count} consecutive input-dependent failures`,
        );
        return true;
      }

      return false;
    }

    // Track other failures (systemic issues)
    const existing = this.failures.get(toolName) || { count: 0, lastError: "" };
    existing.count++;
    existing.lastError = errorMessage;
    this.failures.set(toolName, existing);
    const maxFailuresForTool = this.getMaxSystemicFailures(toolName, errorMessage);

    // If we've hit max failures for systemic issues, disable the tool
    if (existing.count >= maxFailuresForTool) {
      this.disabledTools.set(toolName, { disabledAt: Date.now(), reason: errorMessage });
      console.log(
        `[ToolFailureTracker] Tool ${toolName} disabled after ${existing.count} consecutive systemic failures`,
      );
      return true;
    }

    return false;
  }

  /**
   * Record a successful tool call (resets failure count for both types)
   */
  recordSuccess(toolName: string): void {
    this.failures.delete(toolName);
    this.inputDependentFailures.delete(toolName);
  }

  /**
   * Check if a tool is disabled (with automatic re-enablement after cooldown)
   */
  isDisabled(toolName: string): boolean {
    const disabled = this.disabledTools.get(toolName);
    if (!disabled) {
      return false;
    }

    // Check if cooldown has passed - re-enable the tool
    const elapsed = Date.now() - disabled.disabledAt;
    if (elapsed >= this.cooldownMs) {
      console.log(
        `[ToolFailureTracker] Tool ${toolName} re-enabled after ${this.cooldownMs / 1000}s cooldown`,
      );
      this.disabledTools.delete(toolName);
      this.failures.delete(toolName); // Also reset failure counter
      return false;
    }

    return true;
  }

  /**
   * Get the names of all currently disabled tools.
   */
  getDisabledToolNames(): string[] {
    // Clean up expired cooldowns first
    const now = Date.now();
    for (const [name, info] of this.disabledTools.entries()) {
      if (now - info.disabledAt >= this.cooldownMs) {
        this.disabledTools.delete(name);
        this.failures.delete(name);
      }
    }
    return Array.from(this.disabledTools.keys());
  }

  /**
   * Get the last error for a tool with guidance for alternative approaches
   */
  getLastError(toolName: string): string | undefined {
    const disabled = this.disabledTools.get(toolName);
    const baseError = disabled?.reason || this.failures.get(toolName)?.lastError;

    if (!baseError) return undefined;

    // Add guidance for specific tool failures
    const guidance = this.getAlternativeApproachGuidance(toolName, baseError);
    return guidance ? `${baseError}. ${guidance}` : baseError;
  }

  /**
   * Provide guidance for alternative approaches when a tool fails
   */
  private getAlternativeApproachGuidance(toolName: string, error: string): string | undefined {
    if (toolName === "run_applescript") {
      if (/syntax error/i.test(error)) {
        return 'SUGGESTION: Keep AppleScript minimal and valid. Prefer plain multi-line AppleScript, avoid malformed "with timeout ... end timeout" wrappers, and escape shell command quotes carefully.';
      }
      if (/timed out/i.test(error)) {
        return "SUGGESTION: Break long shell operations into smaller AppleScript calls, then verify output incrementally instead of running a long installer/build in one script.";
      }
    }

    // Shell command failures - distinguish command errors from tool errors
    if (toolName === "run_command") {
      if (/command not found|not found|No such file or directory/i.test(error)) {
        return "SUGGESTION: The command doesn't exist. Try: (1) check if the package needs to be installed first, (2) use the full path to the executable, or (3) use a different command/tool.";
      }
      if (/permission denied|EACCES/i.test(error)) {
        return "SUGGESTION: Permission denied. Try: (1) checking file permissions, (2) writing a script file and running it, or (3) using a different approach.";
      }
      if (/exit code [1-9]|non-zero exit|exited with/i.test(error)) {
        return "SUGGESTION: The command ran but failed (non-zero exit). This is the command itself failing (normal during development), not a tool failure. Read the error output carefully, fix the underlying issue, and retry.";
      }
    }

    // Document editing failures - suggest manual steps or different tool
    if (
      toolName === "edit_document" &&
      (error.includes("images") || error.includes("binary") || error.includes("size"))
    ) {
      return "SUGGESTION: The edit_document tool cannot preserve images in DOCX files. Consider: (1) Create a separate document with the new content only, (2) Provide instructions for the user to manually merge the content, or (3) Use a different output format";
    }

    // File copy/edit loop detection
    if ((toolName === "copy_file" || toolName === "edit_document") && error.includes("failed")) {
      return "SUGGESTION: If copy+edit approach is not working, try creating new content in a separate file instead";
    }

    // Missing parameter errors
    if (error.includes("parameter") && error.includes("required")) {
      return "SUGGESTION: Ensure all required parameters are provided. Check the tool documentation for the exact parameter format";
    }

    // Content validation errors
    if (error.includes("content") && (error.includes("empty") || error.includes("required"))) {
      return 'SUGGESTION: The content parameter must be a non-empty array of content blocks. Example: [{ type: "paragraph", text: "Your text here" }]';
    }

    // Browser navigation errors (often domain-specific blocks or flaky HTTP/2)
    if (toolName === "browser_navigate" && (/net::ERR_/i.test(error) || /http2/i.test(error))) {
      return "SUGGESTION: This looks like a site/network-specific navigation failure. Try an alternative web tool (web_fetch/web_search) or use MCP puppeteer tools (puppeteer_navigate/puppeteer_screenshot) for JS-heavy pages.";
    }
    if (toolName.startsWith("browser_") && (/timed out/i.test(error) || /timeout/i.test(error))) {
      return "SUGGESTION: Wait for the selector to be stable first (browser_wait), then retry with a more specific selector. Keep timeout longer with timeout_ms only when needed.";
    }

    if (
      /cannot be done|not available|not allowed|permission|access denied|disabled|tool .* disabled/i.test(
        error,
      )
    ) {
      return "SUGGESTION: If the normal tool path is blocked, try a different workflow and, if needed, suggest a minimal in-repo implementation patch so the task can still be completed.";
    }

    return undefined;
  }

  /**
   * Get list of disabled tools (excluding those past cooldown)
   */
  getDisabledTools(): string[] {
    const now = Date.now();
    const activelyDisabled: string[] = [];

    for (const [toolName, info] of this.disabledTools.entries()) {
      if (now - info.disabledAt < this.cooldownMs) {
        activelyDisabled.push(toolName);
      } else {
        // Cleanup expired entries
        this.disabledTools.delete(toolName);
      }
    }

    return activelyDisabled;
  }
}

// ===== File Operation Tracker =====

const MUTATION_TARGET_INPUT_KEYS = [
  "path",
  "file_path",
  "filename",
  "destPath",
  "destination",
  "newPath",
  "oldPath",
  "sourcePath",
  "targetPath",
  "outputPath",
  "output_path",
];

/** Every file path a file-mutating tool call names, in its input or its reported result. */
export function collectMutationTargetPaths(input: unknown, result?: unknown): string[] {
  const paths = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) paths.add(value.trim());
  };
  if (input && typeof input === "object") {
    for (const key of MUTATION_TARGET_INPUT_KEYS) add((input as Record<string, unknown>)[key]);
  }
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    add(record.path);
    if (Array.isArray(record.outputPaths)) record.outputPaths.forEach(add);
  }
  return Array.from(paths);
}

// Common exploration tools that never write files but are not "read-only" by name.
const NON_MUTATING_EXPLORATION_TOOLS = new Set([
  "grep",
  "glob",
  "parse_document",
  "web_fetch",
  "count_text",
  "text_metrics",
]);

/**
 * Whether a tool can change workspace files without naming them in its input, such as
 * shell commands, code execution, sub-agents, or integrations. File-mutation tools name
 * their targets and read-only tools change nothing, so neither counts.
 */
export function toolMayChangeFilesImplicitly(toolName: string): boolean {
  const canonicalToolName = canonicalizeToolName(toolName);
  if (isFileMutationToolName(canonicalToolName)) return false;
  if (ToolCallDeduplicator.isIdempotentTool(canonicalToolName)) return false;
  return !NON_MUTATING_EXPLORATION_TOOLS.has(canonicalToolName);
}

/**
 * Tracks file operations to detect redundant reads and duplicate file creations
 * Helps prevent the agent from reading the same file multiple times or
 * creating multiple versions of the same document
 */
export class FileOperationTracker {
  // Track files that have been read (path -> { count, lastReadTime, contentSummary }).
  // Repeat-read throttling and cached results are kept per read window, so a cached
  // result is only ever served for the identical read_file call.
  private readFiles: Map<
    string,
    {
      count: number;
      lastReadTime: number;
      contentLength: number;
      windows: Map<string, { count: number; lastReadTime: number; cachedResult?: string }>;
    }
  > = new Map();
  // Track files that have been created (normalized name -> full path)
  private createdFiles: Map<string, string> = new Map();
  // Track distinct created file paths in insertion order (normalized path -> original path)
  private createdFilePaths: Map<string, string> = new Map();
  // Track file operation counts per type
  private operationCounts: Map<string, number> = new Map();
  // Track directory listings (path -> { files, lastListTime, count })
  private directoryListings: Map<string, { files: string[]; lastListTime: number; count: number }> =
    new Map();

  private readonly maxReadsPerFile: number = 2;
  private readonly readCooldownMs: number = 30000; // 30 seconds between reads of same file
  // Large enough for a budget-bounded read result (see truncateToolResult); a longer
  // result is not cached rather than cached in a cut-down, invalid form.
  private readonly maxCachedReadResultLength: number = 130_000;
  private readonly maxListingsPerDir: number = 2;
  private readonly listingCooldownMs: number = 60000; // 60 seconds between listings of same directory

  /**
   * Identity of a read_file call apart from its path: the requested window
   * (startChar/maxChars) and any other options, normalized so equivalent calls match.
   */
  private buildReadWindowKey(input?: unknown): string {
    if (!input || typeof input !== "object") return "{}";
    const params: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (key === "path") continue;
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined || value === null || value === "") continue;
      const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      params[key] = typeof numeric === "number" && Number.isFinite(numeric) ? numeric : value;
    }
    if (typeof params.startChar === "number" && params.startChar <= 0) delete params.startChar;
    return JSON.stringify(params);
  }

  /**
   * Check if a file read should be blocked (redundant read). Only an identical call
   * (same path and window) counts as a repeat, and only its own result is returned.
   * @returns Object with blocked flag and reason if blocked
   */
  checkFileRead(
    filePath: string,
    input?: unknown,
  ): {
    blocked: boolean;
    reason?: string;
    suggestion?: string;
    cachedResult?: string;
    cachedAgeMs?: number;
  } {
    const normalized = this.normalizePath(filePath);
    const existing = this.readFiles.get(normalized)?.windows.get(this.buildReadWindowKey(input));
    const now = Date.now();

    if (existing) {
      const timeSinceLastRead = now - existing.lastReadTime;

      // If the read cooldown has elapsed, reset the duplicate count so the next
      // real read can proceed without stale throttling.
      if (timeSinceLastRead > this.readCooldownMs) {
        existing.count = 1;
        existing.lastReadTime = now;
        return { blocked: false };
      }

      // If the same window was read recently (within cooldown), block
      if (existing.count >= this.maxReadsPerFile) {
        return {
          blocked: true,
          reason:
            `read_file was already called ${existing.count} times for "${filePath}" with the ` +
            `same window in the last ${this.readCooldownMs / 1000}s`,
          suggestion:
            "Use the content from the previous read instead of reading the same window again. " +
            "To read a different part of the file, call read_file with a different startChar.",
          cachedResult: existing.cachedResult,
          cachedAgeMs: timeSinceLastRead,
        };
      }
    }

    return { blocked: false };
  }

  /**
   * Record a file read operation. `input` is the read_file input that produced the
   * result, so later checks can tell windows of the same file apart.
   */
  recordFileRead(filePath: string, content: string, input?: unknown): void {
    const normalized = this.normalizePath(filePath);
    const now = Date.now();
    const safeContent = typeof content === "string" ? content : String(content ?? "");
    const contentLength = safeContent.length;

    let entry = this.readFiles.get(normalized);
    if (!entry) {
      entry = { count: 0, lastReadTime: now, contentLength, windows: new Map() };
      this.readFiles.set(normalized, entry);
    } else {
      // Re-insert so the map stays ordered from least to most recently read.
      this.readFiles.delete(normalized);
      this.readFiles.set(normalized, entry);
    }
    entry.count++;
    entry.lastReadTime = now;
    entry.contentLength = contentLength;

    const windowKey = this.buildReadWindowKey(input);
    const window = entry.windows.get(windowKey) || { count: 0, lastReadTime: now };
    window.count++;
    window.lastReadTime = now;
    window.cachedResult = contentLength <= this.maxCachedReadResultLength ? safeContent : undefined;
    entry.windows.set(windowKey, window);

    this.incrementOperation("read_file");
  }

  /**
   * Check if a directory listing should be blocked (redundant listing)
   * @returns Object with blocked flag, reason, and cached files if available
   */
  checkDirectoryListing(dirPath: string): {
    blocked: boolean;
    reason?: string;
    cachedFiles?: string[];
    suggestion?: string;
  } {
    const normalized = this.normalizePath(dirPath);
    const existing = this.directoryListings.get(normalized);
    const now = Date.now();

    if (existing) {
      const timeSinceLastList = now - existing.lastListTime;

      // If directory was listed recently (within cooldown), return cached result
      if (timeSinceLastList < this.listingCooldownMs && existing.count >= this.maxListingsPerDir) {
        return {
          blocked: true,
          reason: `Directory "${dirPath}" was already listed ${existing.count} times in the last ${this.listingCooldownMs / 1000}s`,
          cachedFiles: existing.files,
          suggestion:
            "Use the cached directory listing instead of listing again. The directory contents are unlikely to have changed.",
        };
      }
    }

    return { blocked: false };
  }

  /**
   * Record a directory listing operation
   */
  recordDirectoryListing(dirPath: string, files: string[]): void {
    const normalized = this.normalizePath(dirPath);
    const existing = this.directoryListings.get(normalized);
    const now = Date.now();

    if (existing) {
      existing.count++;
      existing.lastListTime = now;
      existing.files = files;
    } else {
      this.directoryListings.set(normalized, { count: 1, lastListTime: now, files });
    }

    this.incrementOperation("list_directory");
  }

  /**
   * Get cached directory listing if available
   */
  getCachedDirectoryListing(dirPath: string): string[] | undefined {
    const normalized = this.normalizePath(dirPath);
    return this.directoryListings.get(normalized)?.files;
  }

  /**
   * Check if creating a file would be a duplicate
   * @returns Object with isDuplicate flag and existing file path if duplicate
   */
  checkFileCreation(filename: string): {
    isDuplicate: boolean;
    existingPath?: string;
    suggestion?: string;
  } {
    const normalizedPath = this.normalizePath(filename);
    const existingByPath = this.createdFilePaths.get(normalizedPath);
    if (existingByPath) {
      return { isDuplicate: false };
    }

    const normalized = this.normalizeFilename(filename);

    // Check for exact match
    const existingPath = this.createdFiles.get(normalized);
    if (existingPath && this.normalizePath(existingPath) !== normalizedPath) {
      return {
        isDuplicate: true,
        existingPath,
        suggestion: `A similar file "${existingPath}" was already created. Consider editing that file instead of creating a new version.`,
      };
    }

    // Check for version variants (e.g., v2.4 vs v2.5, _Updated vs _Final)
    for (const [key, path] of this.createdFiles.entries()) {
      if (this.normalizePath(path) === normalizedPath) {
        continue;
      }
      if (this.areSimilarFilenames(normalized, key)) {
        return {
          isDuplicate: true,
          existingPath: path,
          suggestion: `A similar file "${path}" was already created. Avoid creating multiple versions - edit the existing file instead.`,
        };
      }
    }

    return { isDuplicate: false };
  }

  /**
   * Record a file creation
   */
  recordFileCreation(filePath: string): void {
    const filename = path.basename(filePath) || filePath;
    const normalized = this.normalizeFilename(filename);
    this.createdFiles.set(normalized, filePath);
    const normalizedPath = this.normalizePath(filePath);
    this.createdFilePaths.set(normalizedPath, filePath);
    this.incrementOperation("create_file");
  }

  /** Keep cross-step file knowledge aligned after a rename or move. */
  recordFileRename(oldPath: string, newPath: string): void {
    const oldNormalizedPath = this.normalizePath(oldPath);
    const newNormalizedPath = this.normalizePath(newPath);

    const readEntry = this.readFiles.get(oldNormalizedPath);
    if (readEntry) {
      this.readFiles.delete(oldNormalizedPath);
      this.readFiles.set(newNormalizedPath, readEntry);
    }

    const createdPath = this.createdFilePaths.get(oldNormalizedPath);
    if (createdPath) {
      this.createdFilePaths.delete(oldNormalizedPath);
      this.createdFilePaths.set(newNormalizedPath, newPath);
      const oldFilenameKey = this.normalizeFilename(createdPath);
      if (this.createdFiles.get(oldFilenameKey) === createdPath) {
        this.createdFiles.delete(oldFilenameKey);
      }
      this.createdFiles.set(this.normalizeFilename(newPath), newPath);
    }

    this.invalidateDirectoryListing(path.dirname(oldPath));
    this.invalidateDirectoryListing(path.dirname(newPath));
    this.incrementOperation("rename_file");
  }

  /**
   * Get operation statistics
   */
  getStats(): {
    totalReads: number;
    totalCreates: number;
    totalListings: number;
    uniqueFilesRead: number;
    filesCreated: number;
    dirsListed: number;
  } {
    return {
      totalReads: this.operationCounts.get("read_file") || 0,
      totalCreates: this.operationCounts.get("create_file") || 0,
      totalListings: this.operationCounts.get("list_directory") || 0,
      uniqueFilesRead: this.readFiles.size,
      filesCreated: this.createdFilePaths.size,
      dirsListed: this.directoryListings.size,
    };
  }

  private incrementOperation(operation: string): void {
    const current = this.operationCounts.get(operation) || 0;
    this.operationCounts.set(operation, current + 1);
  }

  private normalizePath(filePath: string): string {
    // Normalize path for comparison
    return filePath.toLowerCase().replace(/\\/g, "/");
  }

  private normalizeFilename(filename: string): string {
    // Normalize base name while preserving extension so different output formats
    // (for example report.csv vs report.json) are tracked independently.
    const name = filename.split("/").pop() || filename;
    const lower = name.toLowerCase();
    const extension = path.extname(lower);
    const stem = extension ? lower.slice(0, lower.length - extension.length) : lower;
    const normalizedStem = stem
      .toLowerCase()
      .replace(/[_-]v?\d+(\.\d+)?/g, "") // Remove version numbers
      .replace(/[_-](updated|final|new|copy|backup|draft|section)/g, "") // Remove common suffixes
      .replace(/[_-]+/g, "_") // Normalize separators
      .trim();
    return `${normalizedStem}${extension}`;
  }

  private areSimilarFilenames(name1: string, name2: string): boolean {
    // Check if two normalized filenames are similar enough to be duplicates
    if (name1 === name2) return true;

    // Check if one contains the other (for cases like "en400" and "en400_us_gdpr")
    const shorter = name1.length < name2.length ? name1 : name2;
    const longer = name1.length < name2.length ? name2 : name1;

    // If the shorter name is at least 10 chars and is contained in the longer, they're similar
    if (shorter.length >= 10 && longer.includes(shorter)) {
      return true;
    }

    return false;
  }

  /**
   * Invalidate cached read tracking for a file that was modified. With a workspace root,
   * absolute and workspace-relative spellings of the same file are matched too.
   */
  invalidateFileRead(filePath: string, workspaceRoot?: string): void {
    const normalized = this.normalizePath(filePath);
    this.readFiles.delete(normalized);
    const target = this.comparablePath(filePath, workspaceRoot);
    for (const key of Array.from(this.readFiles.keys())) {
      if (this.comparablePath(key, workspaceRoot) === target) {
        this.readFiles.delete(key);
      }
    }
  }

  private comparablePath(filePath: string, workspaceRoot?: string): string {
    let comparable = this.normalizePath(filePath).replace(/\/{2,}/g, "/");
    const root = workspaceRoot ? this.normalizePath(workspaceRoot).replace(/\/+$/, "") : "";
    if (root && comparable.startsWith(`${root}/`)) {
      comparable = comparable.slice(root.length + 1);
    }
    return comparable.replace(/^(?:\.\/)+/, "");
  }

  /**
   * Drop every cached read result (but keep the list of files read) after a tool
   * that can change files without naming them, such as a shell command.
   */
  invalidateAllFileReads(): void {
    for (const entry of this.readFiles.values()) {
      entry.windows.clear();
    }
  }

  /**
   * Invalidate cached directory listing tracking for a directory that changed.
   */
  invalidateDirectoryListing(dirPath: string): void {
    const normalized = this.normalizePath(dirPath);
    this.directoryListings.delete(normalized);
  }

  /**
   * Reset tracker (e.g., for a new task)
   */
  reset(): void {
    this.readFiles.clear();
    this.createdFiles.clear();
    this.createdFilePaths.clear();
    this.operationCounts.clear();
    this.directoryListings.clear();
  }

  /**
   * Get the most recently created document file (for parameter inference)
   */
  getLastCreatedDocument(): string | undefined {
    const created = Array.from(this.createdFilePaths.values());
    for (let idx = created.length - 1; idx >= 0; idx--) {
      const createdPath = created[idx];
      if (createdPath.endsWith(".docx") || createdPath.endsWith(".pdf")) {
        return createdPath;
      }
    }
    return undefined;
  }

  /**
   * Get all created file paths
   */
  getCreatedFiles(): string[] {
    return Array.from(this.createdFilePaths.values());
  }

  /**
   * Get a summary of discovered information to share across steps
   */
  getKnowledgeSummary(): string {
    const parts: string[] = [];

    // The maps are in insertion order, so the most recent entries are at the end.
    // List files that have been read (10 most recent, newest first)
    if (this.readFiles.size > 0) {
      const files = Array.from(this.readFiles.keys()).slice(-10).reverse();
      parts.push(`Files already read: ${files.join(", ")}`);
    }

    // List files that have been created
    if (this.createdFilePaths.size > 0) {
      const created = Array.from(this.createdFilePaths.values()).slice(-10).reverse();
      parts.push(`Files created: ${created.join(", ")}`);
    }

    // List directories that have been explored
    if (this.directoryListings.size > 0) {
      const dirs = Array.from(this.directoryListings.keys()).slice(-5).reverse();
      parts.push(`Directories explored: ${dirs.join(", ")}`);
    }

    return parts.join("\n");
  }

  /**
   * Serialize the tracker state for persistence in snapshots.
   * Only includes essential data, not timing info which is session-specific.
   */
  serialize(): {
    readFiles: string[];
    createdFiles: string[];
    directories: string[];
  } {
    return {
      readFiles: Array.from(this.readFiles.keys()).slice(0, 50), // Limit to prevent huge snapshots
      createdFiles: Array.from(this.createdFilePaths.values()).slice(0, 50),
      directories: Array.from(this.directoryListings.keys()).slice(0, 20),
    };
  }

  /**
   * Restore tracker state from a serialized snapshot.
   * Recreates minimal tracking info for files/directories that were previously accessed.
   */
  restore(state: { readFiles?: string[]; createdFiles?: string[]; directories?: string[] }): void {
    const now = Date.now();

    // Restore read files (minimal info - we know they were read but not full details)
    if (state.readFiles) {
      for (const filePath of state.readFiles) {
        this.readFiles.set(filePath, {
          count: 1,
          lastReadTime: now,
          contentLength: 0,
          windows: new Map(),
        });
      }
    }

    // Restore created files
    if (state.createdFiles) {
      for (const filePath of state.createdFiles) {
        const normalized = this.normalizeFilename(path.basename(filePath) || filePath);
        this.createdFiles.set(normalized, filePath);
        this.createdFilePaths.set(this.normalizePath(filePath), filePath);
      }
    }

    // Restore directory listings (minimal info)
    if (state.directories) {
      for (const dir of state.directories) {
        this.directoryListings.set(dir, { files: [], lastListTime: now, count: 1 });
      }
    }

    console.log(
      `[FileOperationTracker] Restored state: ${state.readFiles?.length || 0} files, ${state.createdFiles?.length || 0} created, ${state.directories?.length || 0} dirs`,
    );
  }
}

// ===== Async Utilities =====

/**
 * Wrap a promise with a timeout
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Best-effort timeout hook; preserve timeout error semantics.
      }
      reject(new Error(`${operation} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Calculate exponential backoff delay with jitter
 * @param attempt - The attempt number (0-indexed)
 * @param initialDelay - Initial delay in milliseconds
 * @param maxDelay - Maximum delay cap in milliseconds
 * @param multiplier - Multiplier for each subsequent attempt
 * @returns Delay in milliseconds with random jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  initialDelay = INITIAL_BACKOFF_MS,
  maxDelay = MAX_BACKOFF_MS,
  multiplier = BACKOFF_MULTIPLIER,
): number {
  // Calculate base delay: initialDelay * multiplier^attempt
  const baseDelay = initialDelay * Math.pow(multiplier, attempt);

  // Cap at max delay
  const cappedDelay = Math.min(baseDelay, maxDelay);

  // Add random jitter (±25%) to prevent thundering herd
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);

  return Math.round(cappedDelay + jitter);
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
