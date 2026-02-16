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

// ===== Custom Error =====

export class AwaitingUserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AwaitingUserInputError';
  }
}

// ===== Types =====

export type CompletionContract = {
  requiresExecutionEvidence: boolean;
  requiresDirectAnswer: boolean;
  requiresDecisionSignal: boolean;
  requiresArtifactEvidence: boolean;
  requiredArtifactExtensions: string[];
  requiresVerificationEvidence: boolean;
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

// Default per-tool execution timeout (overrideable per tool)
export const TOOL_TIMEOUT_MS = 30 * 1000;

// Maximum consecutive failures for the same tool before giving up
export const MAX_TOOL_FAILURES = 2;

// Maximum total steps in a plan (including revisions) to prevent runaway execution
export const MAX_TOTAL_STEPS = 20;

// Exponential backoff configuration
export const INITIAL_BACKOFF_MS = 1000; // Start with 1 second
export const MAX_BACKOFF_MS = 30000;    // Cap at 30 seconds
export const BACKOFF_MULTIPLIER = 2;   // Double each time

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

// Patterns that indicate input-dependent errors (not tool failures)
// These are normal operational errors that should NOT count towards circuit breaker
export const INPUT_DEPENDENT_ERROR_PATTERNS = [
  /ENOENT/i,           // File/directory not found
  /ENOTDIR/i,          // Not a directory
  /EISDIR/i,           // Is a directory (when expecting file)
  /no such file/i,     // File not found
  /not found/i,        // Generic not found
  /does not exist/i,   // Resource doesn't exist
  /invalid path/i,     // Invalid path provided
  /path.*invalid/i,    // Path is invalid
  /cannot find/i,      // Cannot find resource
  /permission denied/i, // Permission on specific file (not API permission)
  /EACCES/i,           // Access denied to specific file
  // Missing/invalid parameter errors (LLM didn't provide required params)
  /parameter.*required/i,      // "parameter is required"
  /required.*not provided/i,   // "required but was not provided"
  /invalid.*parameter/i,       // "Invalid content" type errors
  /must be.*string/i,          // Type validation: "must be a non-empty string"
  /expected.*but received/i,   // Type validation: "expected string but received undefined"
  /cannot specify both/i,      // Parameter conflict: "Cannot specify both head and tail"
  /mutually exclusive/i,       // "parameters are mutually exclusive"
  /invalid.*argument/i,        // "Invalid argument" from tool validation
  /unexpected.*parameter/i,    // "Unexpected parameter" from strict schemas
  /not a valid/i,              // "X is not a valid value for Y"
  /timed out/i,        // Command/operation timed out (often due to slow query)
  // Network/navigation failures are often domain- or environment-specific
  /net::ERR_/i,        // Playwright/Chromium navigation errors
  /ERR_HTTP2_PROTOCOL_ERROR/i, // Common site-specific failure
  /syntax error/i,     // Script syntax errors (AppleScript, shell, etc.)
  /applescript execution failed/i, // AppleScript errors are input-related
  /user denied/i,      // User denied an approval request
];

// Keywords that imply a step wants image verification.
export const IMAGE_VERIFICATION_KEYWORDS = [
  'image',
  'photo',
  'photograph',
  'picture',
  'render',
  'illustration',
  'png',
  'jpg',
  'jpeg',
  'webp',
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

// ===== Error Classification Functions =====

/**
 * Check if an error is non-retryable (quota/rate limit related)
 * These errors indicate a systemic problem with the tool/API
 */
export function isNonRetryableError(errorMessage: string): boolean {
  return NON_RETRYABLE_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * Check if an error is input-dependent (normal operational error)
 * These errors are due to bad input, not tool failure, and should not trigger circuit breaker
 */
export function isInputDependentError(errorMessage: string): boolean {
  return INPUT_DEPENDENT_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
}

// ===== Date/Time Utilities =====

/**
 * Get current date formatted for system prompts
 * Returns: "Tuesday, January 28, 2026"
 */
export function getCurrentDateString(): string {
  const now = new Date();
  return now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

/**
 * Get current date/time with timezone for system prompts
 * Used for scheduling features to help the agent understand current time context
 */
export function getCurrentDateTimeContext(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  // Get timezone name
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezoneOffset = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();

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
  const lines = sample.split('\n').map(l => l.trim()).filter(Boolean);
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

  const looksLikeNonBlockingTail = tailLines.length > 0 && tailLines.every((line) => {
    const normalized = line.replace(/^[-*]?\s*\d*[).]?\s*/, '').trim();
    if (!normalized) return true;
    return nonBlockingQuestionPatterns.some(pattern => pattern.test(normalized));
  });
  if (looksLikeNonBlockingTail) return false;

  const blockingCuePatterns = [
    /(?:need|required)\s+(?:your|a|the)\b/i,
    /before\s+i\s+can\s+(?:proceed|continue)\b/i,
    /to\s+(?:proceed|continue|move\s+forward)\b/i,
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

  const questionWordPatterns = [
    /^(?:who|what|where|when|why|how|which)\b/i,
  ];

  const imperativePatterns = [
    /^(?:please\s+)?(?:provide|share|send|upload|enter|paste|specify|clarify|confirm|choose|pick|select|list|tell|give)\b/i,
  ];

  const decisionPatterns = [
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

  const hasBlockingCue = blockingCuePatterns.some(pattern => pattern.test(sample));
  const hasExplicitProceed = explicitProceedPatterns.some(pattern => pattern.test(sample));
  if (hasBlockingCue) return true;
  let tailRequiresResponse = false;

  for (const line of tailLines) {
    const normalized = line.replace(/^[-*]?\s*\d*[).]?\s*/, '').trim();
    if (!normalized) continue;
    if (nonBlockingQuestionPatterns.some(pattern => pattern.test(normalized))) {
      continue;
    }
    if (explicitResponseRequestPatterns.some(pattern => pattern.test(normalized))) {
      tailRequiresResponse = true;
    }
    const looksLikeQuestion =
      normalized.endsWith('?') ||
      questionWordPatterns.some(pattern => pattern.test(normalized));
    if (looksLikeQuestion && decisionQuestionPatterns.some(pattern => pattern.test(normalized))) {
      tailRequiresResponse = true;
    }
  }

  return tailRequiresResponse && !hasExplicitProceed;
}

// ===== Tool Call Deduplicator =====

/**
 * Tracks recent tool calls to detect and prevent duplicate/repetitive calls
 * This prevents the agent from getting stuck in loops calling the same tool
 *
 * Features:
 * - Exact duplicate detection (same tool + same params)
 * - Semantic duplicate detection (same tool + similar params, e.g., filename variants)
 * - Rate limiting per tool
 */
export class ToolCallDeduplicator {
  private recentCalls: Map<string, { count: number; lastCallTime: number; lastResult?: string }> = new Map();
  // Track semantic patterns (tool name -> list of recent inputs for pattern detection)
  private semanticPatterns: Map<string, Array<{ input: any; time: number }>> = new Map();
  // Rate limiting: track calls per tool per minute
  private rateLimitCounters: Map<string, { count: number; windowStart: number }> = new Map();

  private readonly maxDuplicates: number;
  private readonly windowMs: number;
  private readonly maxSemanticSimilar: number;
  private readonly rateLimit: number; // Max calls per tool per minute

  constructor(maxDuplicates = 2, windowMs = 60000, maxSemanticSimilar = 4, rateLimit = 20) {
    this.maxDuplicates = maxDuplicates;
    this.windowMs = windowMs;
    this.maxSemanticSimilar = maxSemanticSimilar;
    this.rateLimit = rateLimit;
  }

  /**
   * Generate a hash key for a tool call based on name and input
   */
  private getCallKey(toolName: string, input: any): string {
    // Normalize input by sorting keys for consistent hashing
    const normalizedInput = JSON.stringify(input, Object.keys(input || {}).sort());
    return `${toolName}:${normalizedInput}`;
  }

  /**
   * Extract semantic signature from input for pattern matching
   * This normalizes filenames, paths, etc. to detect "same operation, different target"
   */
  private getSemanticSignature(toolName: string, input: any): string {
    if (!input) return toolName;

    // For file operations, normalize the filename to detect variants
    if (toolName === 'create_document' || toolName === 'write_file') {
      const filename = input.filename || input.path || '';
      // Extract base name without version suffixes like _v2.4, _COMPLETE, _Final, etc.
      const baseName = filename
        .replace(/[_-]v?\d+(\.\d+)?/gi, '') // Remove version numbers
        .replace(/[_-](complete|final|updated|new|copy|backup|draft)/gi, '') // Remove common suffixes
        .replace(/\.[^.]+$/, ''); // Remove extension
      return `${toolName}:file:${baseName}`;
    }

    if (toolName === 'copy_file') {
      const destPath = input.destPath || input.destination || '';
      const baseName = destPath
        .replace(/[_-]v?\d+(\.\d+)?/gi, '')
        .replace(/[_-](complete|final|updated|new|copy|backup|draft)/gi, '')
        .replace(/\.[^.]+$/, '');
      return `${toolName}:copy:${baseName}`;
    }

    // For web searches, normalize the query to detect similar searches
    if (toolName === 'web_search') {
      const query = (input.query || input.search || '').toLowerCase();
      // Remove platform-specific modifiers to get the core search term
      const normalizedQuery = query
        .replace(/site:(twitter\.com|x\.com|reddit\.com|github\.com)/gi, '')
        .replace(/\b(reddit|twitter|x\.com|github)\b/gi, '')
        .replace(/["']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return `${toolName}:search:${normalizedQuery}`;
    }

    // For read operations, just use tool name (reading same file repeatedly is OK)
    if (toolName === 'read_file' || toolName === 'list_directory') {
      return `${toolName}:${input.path || ''}`;
    }

    // Default: use tool name only for semantic grouping
    return toolName;
  }

  /**
   * Check rate limit for a tool
   */
  private checkRateLimit(toolName: string): { exceeded: boolean; reason?: string } {
    const now = Date.now();
    const counter = this.rateLimitCounters.get(toolName);

    if (!counter || now - counter.windowStart > 60000) {
      // New window or first call
      return { exceeded: false };
    }

    if (counter.count >= this.rateLimit) {
      return {
        exceeded: true,
        reason: `Rate limit exceeded: "${toolName}" called ${counter.count} times in the last minute. Max allowed: ${this.rateLimit}/min.`,
      };
    }

    return { exceeded: false };
  }

  /**
   * Check for semantic duplicates (similar operations with slight variations)
   */
  private checkSemanticDuplicate(toolName: string, input: any): { isDuplicate: boolean; reason?: string } {
    const now = Date.now();
    const signature = this.getSemanticSignature(toolName, input);

    // Get recent calls with this semantic signature
    const patterns = this.semanticPatterns.get(signature) || [];

    // Clean up old entries
    const recentPatterns = patterns.filter(p => now - p.time <= this.windowMs);
    this.semanticPatterns.set(signature, recentPatterns);

    // Check if we have too many semantically similar calls
    if (recentPatterns.length >= this.maxSemanticSimilar) {
      return {
        isDuplicate: true,
        reason: `Detected ${recentPatterns.length + 1} semantically similar "${toolName}" calls within ${this.windowMs / 1000}s. ` +
          `This appears to be a retry loop with slight parameter variations. ` +
          `Please try a different approach or check if the previous operation actually succeeded.`,
      };
    }

    return { isDuplicate: false };
  }

  /**
   * Check if a tool call is a duplicate and should be blocked
   * @returns Object with isDuplicate flag and optional cached result
   */
  checkDuplicate(toolName: string, input: any): { isDuplicate: boolean; reason?: string; cachedResult?: string } {
    const now = Date.now();

    // 0. Exclude stateful browser tools from duplicate detection
    const statefulTools = [
      'browser_get_content',
      'browser_screenshot',
      'browser_get_text',
      'browser_evaluate',
      'canvas_push',
    ];
    if (statefulTools.includes(toolName)) {
      return { isDuplicate: false };
    }

    // 1. Check rate limit first
    const rateLimitCheck = this.checkRateLimit(toolName);
    if (rateLimitCheck.exceeded) {
      return { isDuplicate: true, reason: rateLimitCheck.reason };
    }

    // 2. Check exact duplicate
    const callKey = this.getCallKey(toolName, input);

    // Clean up old entries outside the time window
    for (const [key, value] of this.recentCalls.entries()) {
      if (now - value.lastCallTime > this.windowMs) {
        this.recentCalls.delete(key);
      }
    }

    const existing = this.recentCalls.get(callKey);
    if (existing && now - existing.lastCallTime <= this.windowMs && existing.count >= this.maxDuplicates) {
      return {
        isDuplicate: true,
        reason: `Tool "${toolName}" called ${existing.count + 1} times with identical parameters within ${this.windowMs / 1000}s. This appears to be a duplicate call.`,
        cachedResult: existing.lastResult,
      };
    }

    // 3. Check semantic duplicate (for tools prone to retry loops)
    const semanticTools = ['create_document', 'write_file', 'copy_file', 'create_spreadsheet', 'create_presentation', 'web_search'];
    if (semanticTools.includes(toolName)) {
      const semanticCheck = this.checkSemanticDuplicate(toolName, input);
      if (semanticCheck.isDuplicate) {
        return semanticCheck;
      }
    }

    return { isDuplicate: false };
  }

  /**
   * Record a tool call (call this after checking for duplicates)
   */
  recordCall(toolName: string, input: any, result?: string): void {
    const now = Date.now();

    // Record exact call
    const callKey = this.getCallKey(toolName, input);
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
    const signature = this.getSemanticSignature(toolName, input);
    const patterns = this.semanticPatterns.get(signature) || [];
    patterns.push({ input, time: now });
    this.semanticPatterns.set(signature, patterns);

    // Update rate limit counter
    const counter = this.rateLimitCounters.get(toolName);
    if (!counter || now - counter.windowStart > 60000) {
      this.rateLimitCounters.set(toolName, { count: 1, windowStart: now });
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
    // Don't reset rate limit counters - they should persist across steps
  }

  /**
   * Clear read/list call history after filesystem mutations.
   * This prevents stale cached read results from being reused immediately
   * after a file was updated.
   */
  clearReadOnlyHistory(): void {
    const readLikePrefixes = ['read_file:', 'read_multiple_files:', 'list_directory:', 'list_directory_with_sizes:'];
    for (const key of Array.from(this.recentCalls.keys())) {
      if (readLikePrefixes.some(prefix => key.startsWith(prefix))) {
        this.recentCalls.delete(key);
      }
    }

    for (const key of Array.from(this.semanticPatterns.keys())) {
      if (key.startsWith('read_file:') || key.startsWith('list_directory:')) {
        this.semanticPatterns.delete(key);
      }
    }

    this.rateLimitCounters.delete('read_file');
    this.rateLimitCounters.delete('read_multiple_files');
    this.rateLimitCounters.delete('list_directory');
    this.rateLimitCounters.delete('list_directory_with_sizes');
  }

  /**
   * Check if a tool is idempotent (safe to cache/skip duplicates)
   */
  static isIdempotentTool(toolName: string): boolean {
    const idempotentTools = [
      'read_file',
      'read_multiple_files',
      'list_directory',
      'directory_tree',
      'search_files',
      'search_code',
      'get_file_info',
      'canvas_list',
      'canvas_checkpoints',
      'task_history',
      'channel_list_chats',
      'channel_history',
      'web_search',
    ];
    if (idempotentTools.includes(toolName)) {
      return true;
    }

    // Treat "read-only by convention" tool names as idempotent to avoid
    // duplicate-error loops on observational tools.
    const readOnlyPrefixes = ['read_', 'list_', 'get_', 'search_', 'check_', 'describe_', 'query_'];
    if (readOnlyPrefixes.some(prefix => toolName.startsWith(prefix))) {
      return true;
    }

    const readOnlySuffixes = ['_list', '_status', '_history'];
    return readOnlySuffixes.some(suffix => toolName.endsWith(suffix));
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
  private readonly cooldownMs: number = 5 * 60 * 1000; // 5 minutes cooldown
  // Higher threshold for input-dependent errors since LLM might eventually get it right
  private readonly maxInputDependentFailures: number = 4;

  private getMaxInputDependentFailures(toolName: string): number {
    // AppleScript often needs a few iterative syntax/quoting fixes before succeeding.
    if (toolName === 'run_applescript') {
      return 8;
    }
    if (toolName.startsWith('browser_')) {
      return 6;
    }
    return this.maxInputDependentFailures;
  }

  /**
   * Record a tool failure
   * @returns true if the tool should be disabled (circuit broken)
   */
  recordFailure(toolName: string, errorMessage: string): boolean {
    // If it's a non-retryable error (quota, rate limit), disable immediately
    if (isNonRetryableError(errorMessage)) {
      this.disabledTools.set(toolName, { disabledAt: Date.now(), reason: errorMessage });
      console.log(`[ToolFailureTracker] Tool ${toolName} disabled due to non-retryable error: ${errorMessage.substring(0, 100)}`);
      return true;
    }

    // Input-dependent errors (missing params, file not found, etc.)
    // These are tracked separately with a higher threshold
    if (isInputDependentError(errorMessage)) {
      const existing = this.inputDependentFailures.get(toolName) || { count: 0, lastError: '' };
      existing.count++;
      existing.lastError = errorMessage;
      this.inputDependentFailures.set(toolName, existing);

      const maxFailuresForTool = this.getMaxInputDependentFailures(toolName);

      console.log(`[ToolFailureTracker] Input-dependent error for ${toolName} (${existing.count}/${maxFailuresForTool}): ${errorMessage.substring(0, 80)}`);

      // If LLM keeps making the same mistake, disable the tool
      if (existing.count >= maxFailuresForTool) {
        const reason = `LLM failed to provide correct parameters ${existing.count} times: ${errorMessage}`;
        this.disabledTools.set(toolName, { disabledAt: Date.now(), reason });
        console.log(`[ToolFailureTracker] Tool ${toolName} disabled after ${existing.count} consecutive input-dependent failures`);
        return true;
      }

      return false;
    }

    // Track other failures (systemic issues)
    const existing = this.failures.get(toolName) || { count: 0, lastError: '' };
    existing.count++;
    existing.lastError = errorMessage;
    this.failures.set(toolName, existing);

    // If we've hit max failures for systemic issues, disable the tool
    if (existing.count >= MAX_TOOL_FAILURES) {
      this.disabledTools.set(toolName, { disabledAt: Date.now(), reason: errorMessage });
      console.log(`[ToolFailureTracker] Tool ${toolName} disabled after ${existing.count} consecutive systemic failures`);
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
      console.log(`[ToolFailureTracker] Tool ${toolName} re-enabled after ${this.cooldownMs / 1000}s cooldown`);
      this.disabledTools.delete(toolName);
      this.failures.delete(toolName); // Also reset failure counter
      return false;
    }

    return true;
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
    if (toolName === 'run_applescript') {
      if (/syntax error/i.test(error)) {
        return 'SUGGESTION: Keep AppleScript minimal and valid. Prefer plain multi-line AppleScript, avoid malformed "with timeout ... end timeout" wrappers, and escape shell command quotes carefully.';
      }
      if (/timed out/i.test(error)) {
        return 'SUGGESTION: Break long shell operations into smaller AppleScript calls, then verify output incrementally instead of running a long installer/build in one script.';
      }
    }

    // Document editing failures - suggest manual steps or different tool
    if (toolName === 'edit_document' && (error.includes('images') || error.includes('binary') || error.includes('size'))) {
      return 'SUGGESTION: The edit_document tool cannot preserve images in DOCX files. Consider: (1) Create a separate document with the new content only, (2) Provide instructions for the user to manually merge the content, or (3) Use a different output format';
    }

    // File copy/edit loop detection
    if ((toolName === 'copy_file' || toolName === 'edit_document') && error.includes('failed')) {
      return 'SUGGESTION: If copy+edit approach is not working, try creating new content in a separate file instead';
    }

    // Missing parameter errors
    if (error.includes('parameter') && error.includes('required')) {
      return 'SUGGESTION: Ensure all required parameters are provided. Check the tool documentation for the exact parameter format';
    }

    // Content validation errors
    if (error.includes('content') && (error.includes('empty') || error.includes('required'))) {
      return 'SUGGESTION: The content parameter must be a non-empty array of content blocks. Example: [{ type: "paragraph", text: "Your text here" }]';
    }

    // Browser navigation errors (often domain-specific blocks or flaky HTTP/2)
    if (toolName === 'browser_navigate' && (/net::ERR_/i.test(error) || /http2/i.test(error))) {
      return 'SUGGESTION: This looks like a site/network-specific navigation failure. Try an alternative web tool (web_fetch/web_search) or use MCP puppeteer tools (puppeteer_navigate/puppeteer_screenshot) for JS-heavy pages.';
    }
    if (toolName.startsWith('browser_') && (/timed out/i.test(error) || /timeout/i.test(error))) {
      return 'SUGGESTION: Wait for the selector to be stable first (browser_wait), then retry with a more specific selector. Keep timeout longer with timeout_ms only when needed.';
    }

    if (/cannot be done|not available|not allowed|permission|access denied|disabled|tool .* disabled/i.test(error)) {
      return 'SUGGESTION: If the normal tool path is blocked, try a different workflow and, if needed, suggest a minimal in-repo implementation patch so the task can still be completed.';
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

/**
 * Tracks file operations to detect redundant reads and duplicate file creations
 * Helps prevent the agent from reading the same file multiple times or
 * creating multiple versions of the same document
 */
export class FileOperationTracker {
  // Track files that have been read (path -> { count, lastReadTime, contentSummary })
  private readFiles: Map<string, {
    count: number;
    lastReadTime: number;
    contentLength: number;
    cachedResult?: string;
  }> = new Map();
  // Track files that have been created (normalized name -> full path)
  private createdFiles: Map<string, string> = new Map();
  // Track file operation counts per type
  private operationCounts: Map<string, number> = new Map();
  // Track directory listings (path -> { files, lastListTime, count })
  private directoryListings: Map<string, { files: string[]; lastListTime: number; count: number }> = new Map();

  private readonly maxReadsPerFile: number = 2;
  private readonly readCooldownMs: number = 30000; // 30 seconds between reads of same file
  private readonly maxCachedReadResultLength: number = 20000;
  private readonly maxListingsPerDir: number = 2;
  private readonly listingCooldownMs: number = 60000; // 60 seconds between listings of same directory

  /**
   * Check if a file read should be blocked (redundant read)
   * @returns Object with blocked flag and reason if blocked
   */
  checkFileRead(filePath: string): { blocked: boolean; reason?: string; suggestion?: string; cachedResult?: string } {
    const normalized = this.normalizePath(filePath);
    const existing = this.readFiles.get(normalized);
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

      // If file was read recently (within cooldown), block
      if (timeSinceLastRead < this.readCooldownMs && existing.count >= this.maxReadsPerFile) {
        return {
          blocked: true,
          reason: `File "${filePath}" was already read ${existing.count} times in the last ${this.readCooldownMs / 1000}s`,
          suggestion: 'Use the content from the previous read instead of reading the file again. If you need specific parts, describe what you need.',
          cachedResult: existing.cachedResult,
        };
      }
    }

    return { blocked: false };
  }

  /**
   * Record a file read operation
   */
  recordFileRead(filePath: string, content: string): void {
    const normalized = this.normalizePath(filePath);
    const existing = this.readFiles.get(normalized);
    const now = Date.now();
    const safeContent = typeof content === 'string' ? content : String(content ?? '');
    const contentLength = safeContent.length;
    const truncatedContent = contentLength > this.maxCachedReadResultLength
      ? `${safeContent.slice(0, this.maxCachedReadResultLength)}\n\n[... cached content truncated ...]`
      : safeContent;

    if (existing) {
      existing.count++;
      existing.lastReadTime = now;
      existing.contentLength = contentLength;
      if (truncatedContent) {
        existing.cachedResult = truncatedContent;
      }
    } else {
      this.readFiles.set(normalized, {
        count: 1,
        lastReadTime: now,
        contentLength,
        cachedResult: truncatedContent,
      });
    }

    this.incrementOperation('read_file');
  }

  /**
   * Check if a directory listing should be blocked (redundant listing)
   * @returns Object with blocked flag, reason, and cached files if available
   */
  checkDirectoryListing(dirPath: string): { blocked: boolean; reason?: string; cachedFiles?: string[]; suggestion?: string } {
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
          suggestion: 'Use the cached directory listing instead of listing again. The directory contents are unlikely to have changed.',
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

    this.incrementOperation('list_directory');
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
  checkFileCreation(filename: string): { isDuplicate: boolean; existingPath?: string; suggestion?: string } {
    const normalized = this.normalizeFilename(filename);

    // Check for exact match
    const existingPath = this.createdFiles.get(normalized);
    if (existingPath) {
      return {
        isDuplicate: true,
        existingPath,
        suggestion: `A similar file "${existingPath}" was already created. Consider editing that file instead of creating a new version.`,
      };
    }

    // Check for version variants (e.g., v2.4 vs v2.5, _Updated vs _Final)
    for (const [key, path] of this.createdFiles.entries()) {
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
    const filename = filePath.split('/').pop() || filePath;
    const normalized = this.normalizeFilename(filename);
    this.createdFiles.set(normalized, filePath);
    this.incrementOperation('create_file');
  }

  /**
   * Get operation statistics
   */
  getStats(): { totalReads: number; totalCreates: number; totalListings: number; uniqueFilesRead: number; filesCreated: number; dirsListed: number } {
    return {
      totalReads: this.operationCounts.get('read_file') || 0,
      totalCreates: this.operationCounts.get('create_file') || 0,
      totalListings: this.operationCounts.get('list_directory') || 0,
      uniqueFilesRead: this.readFiles.size,
      filesCreated: this.createdFiles.size,
      dirsListed: this.directoryListings.size,
    };
  }

  private incrementOperation(operation: string): void {
    const current = this.operationCounts.get(operation) || 0;
    this.operationCounts.set(operation, current + 1);
  }

  private normalizePath(filePath: string): string {
    // Normalize path for comparison
    return filePath.toLowerCase().replace(/\\/g, '/');
  }

  private normalizeFilename(filename: string): string {
    // Remove path, extension, version numbers, and common suffixes
    const name = filename.split('/').pop() || filename;
    return name
      .toLowerCase()
      .replace(/\.[^.]+$/, '') // Remove extension
      .replace(/[_-]v?\d+(\.\d+)?/g, '') // Remove version numbers
      .replace(/[_-](updated|final|new|copy|backup|draft|section)/g, '') // Remove common suffixes
      .replace(/[_-]+/g, '_') // Normalize separators
      .trim();
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
   * Invalidate cached read tracking for a file that was modified.
   */
  invalidateFileRead(filePath: string): void {
    const normalized = this.normalizePath(filePath);
    this.readFiles.delete(normalized);
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
    this.operationCounts.clear();
    this.directoryListings.clear();
  }

  /**
   * Get the most recently created document file (for parameter inference)
   */
  getLastCreatedDocument(): string | undefined {
    // Find the most recent .docx file that was created
    for (const [_, path] of this.createdFiles.entries()) {
      if (path.endsWith('.docx') || path.endsWith('.pdf')) {
        return path;
      }
    }
    return undefined;
  }

  /**
   * Get all created file paths
   */
  getCreatedFiles(): string[] {
    return Array.from(this.createdFiles.values());
  }

  /**
   * Get a summary of discovered information to share across steps
   */
  getKnowledgeSummary(): string {
    const parts: string[] = [];

    // List files that have been read
    if (this.readFiles.size > 0) {
      const files = Array.from(this.readFiles.keys()).slice(0, 10); // Limit to 10 most recent
      parts.push(`Files already read: ${files.join(', ')}`);
    }

    // List files that have been created
    if (this.createdFiles.size > 0) {
      const created = Array.from(this.createdFiles.values()).slice(0, 10);
      parts.push(`Files created: ${created.join(', ')}`);
    }

    // List directories that have been explored
    if (this.directoryListings.size > 0) {
      const dirs = Array.from(this.directoryListings.keys()).slice(0, 5);
      parts.push(`Directories explored: ${dirs.join(', ')}`);
    }

    return parts.join('\n');
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
      createdFiles: Array.from(this.createdFiles.values()).slice(0, 50),
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
        this.readFiles.set(filePath, { count: 1, lastReadTime: now, contentLength: 0 });
      }
    }

    // Restore created files
    if (state.createdFiles) {
      for (const filePath of state.createdFiles) {
        const normalized = this.normalizeFilename(filePath.split('/').pop() || filePath);
        this.createdFiles.set(normalized, filePath);
      }
    }

    // Restore directory listings (minimal info)
    if (state.directories) {
      for (const dir of state.directories) {
        this.directoryListings.set(dir, { files: [], lastListTime: now, count: 1 });
      }
    }

    console.log(`[FileOperationTracker] Restored state: ${state.readFiles?.length || 0} files, ${state.createdFiles?.length || 0} created, ${state.directories?.length || 0} dirs`);
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
  onTimeout?: () => void
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
  multiplier = BACKOFF_MULTIPLIER
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
  return new Promise(resolve => setTimeout(resolve, ms));
}
