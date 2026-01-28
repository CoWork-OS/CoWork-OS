import { Task, Workspace, Plan, PlanStep, TaskEvent, SuccessCriteria } from '../../shared/types';
import * as fs from 'fs';
import * as path from 'path';
import { AgentDaemon } from './daemon';
import { ToolRegistry } from './tools/registry';
import { SandboxRunner } from './sandbox/runner';
import {
  LLMProvider,
  LLMProviderFactory,
  LLMMessage,
  LLMToolResult,
} from './llm';
import {
  ContextManager,
  truncateToolResult,
  estimateTokens,
} from './context-manager';
import { GuardrailManager } from '../guardrails/guardrail-manager';
import { calculateCost, formatCost } from './llm/pricing';
import { getCustomSkillLoader } from './custom-skill-loader';

// Timeout for LLM API calls (2 minutes)
const LLM_TIMEOUT_MS = 2 * 60 * 1000;

// Per-step timeout (5 minutes max per step)
const STEP_TIMEOUT_MS = 5 * 60 * 1000;

// Per-tool execution timeout (60 seconds - increased for browser tools which need time to launch)
const TOOL_TIMEOUT_MS = 60 * 1000;

// Maximum consecutive failures for the same tool before giving up
const MAX_TOOL_FAILURES = 2;

// Maximum total steps in a plan (including revisions) to prevent runaway execution
const MAX_TOTAL_STEPS = 20;

// Exponential backoff configuration
const INITIAL_BACKOFF_MS = 1000; // Start with 1 second
const MAX_BACKOFF_MS = 30000;    // Cap at 30 seconds
const BACKOFF_MULTIPLIER = 2;   // Double each time

// Patterns that indicate non-retryable errors (quota, rate limits, etc.)
// These errors should immediately disable the tool
const NON_RETRYABLE_ERROR_PATTERNS = [
  /quota.*exceeded/i,
  /rate.*limit/i,
  /exceeded.*quota/i,
  /too many requests/i,
  /429/i,
  /resource.*exhausted/i,
  /billing/i,
  /payment.*required/i,
];

// Patterns that indicate input-dependent errors (not tool failures)
// These are normal operational errors that should NOT count towards circuit breaker
const INPUT_DEPENDENT_ERROR_PATTERNS = [
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
];

/**
 * Check if an error is non-retryable (quota/rate limit related)
 * These errors indicate a systemic problem with the tool/API
 */
function isNonRetryableError(errorMessage: string): boolean {
  return NON_RETRYABLE_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * Check if an error is input-dependent (normal operational error)
 * These errors are due to bad input, not tool failure, and should not trigger circuit breaker
 */
function isInputDependentError(errorMessage: string): boolean {
  return INPUT_DEPENDENT_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * Get current date formatted for system prompts
 * Returns: "Tuesday, January 28, 2026"
 */
function getCurrentDateString(): string {
  const now = new Date();
  return now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

/**
 * Check if the assistant's response is asking a question and waiting for user input
 */
function isAskingQuestion(text: string): boolean {
  const questionPatterns = [
    /would you like me to/i,
    /would you prefer/i,
    /should I/i,
    /do you want me to/i,
    /please (let me know|confirm|specify|choose)/i,
    /which (option|approach|method)/i,
    /options.*:/i,
    /\?\s*$/,  // Ends with question mark
  ];

  // Check if text contains question patterns AND doesn't also contain tool calls
  const hasQuestion = questionPatterns.some(pattern => pattern.test(text));
  const isShort = text.length < 1000; // Questions are usually concise

  return hasQuestion && isShort;
}

/**
 * Tracks recent tool calls to detect and prevent duplicate/repetitive calls
 * This prevents the agent from getting stuck in loops calling the same tool
 *
 * Features:
 * - Exact duplicate detection (same tool + same params)
 * - Semantic duplicate detection (same tool + similar params, e.g., filename variants)
 * - Rate limiting per tool
 */
class ToolCallDeduplicator {
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
    // These tools depend on current page state, not just parameters
    // browser_get_content, browser_screenshot have no/minimal params but return different results per page
    const statefulBrowserTools = [
      'browser_get_content',
      'browser_screenshot',
      'browser_get_text',
      'browser_evaluate',
    ];
    if (statefulBrowserTools.includes(toolName)) {
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
   * Check if a tool is idempotent (safe to cache/skip duplicates)
   */
  static isIdempotentTool(toolName: string): boolean {
    const idempotentTools = [
      'read_file',
      'list_directory',
      'search_files',
      'search_code',
      'get_file_info',
      'web_search',
    ];
    return idempotentTools.includes(toolName);
  }
}

/**
 * Tracks tool failures to implement circuit breaker pattern
 * Tools are automatically re-enabled after a cooldown period
 *
 * IMPORTANT: This now tracks ALL consecutive failures, including input-dependent ones.
 * If the LLM consistently fails to provide correct parameters, it's a sign it's stuck
 * in a loop and we should disable the tool to force a different approach.
 */
class ToolFailureTracker {
  private failures: Map<string, { count: number; lastError: string }> = new Map();
  // Separate tracker for input-dependent errors (higher threshold before disabling)
  private inputDependentFailures: Map<string, { count: number; lastError: string }> = new Map();
  private disabledTools: Map<string, { disabledAt: number; reason: string }> = new Map();
  private readonly cooldownMs: number = 5 * 60 * 1000; // 5 minutes cooldown
  // Higher threshold for input-dependent errors since LLM might eventually get it right
  private readonly maxInputDependentFailures: number = 4;

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

      console.log(`[ToolFailureTracker] Input-dependent error for ${toolName} (${existing.count}/${this.maxInputDependentFailures}): ${errorMessage.substring(0, 80)}`);

      // If LLM keeps making the same mistake, disable the tool
      if (existing.count >= this.maxInputDependentFailures) {
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

/**
 * Tracks file operations to detect redundant reads and duplicate file creations
 * Helps prevent the agent from reading the same file multiple times or
 * creating multiple versions of the same document
 */
class FileOperationTracker {
  // Track files that have been read (path -> { count, lastReadTime, contentSummary })
  private readFiles: Map<string, { count: number; lastReadTime: number; contentLength: number }> = new Map();
  // Track files that have been created (normalized name -> full path)
  private createdFiles: Map<string, string> = new Map();
  // Track file operation counts per type
  private operationCounts: Map<string, number> = new Map();
  // Track directory listings (path -> { files, lastListTime, count })
  private directoryListings: Map<string, { files: string[]; lastListTime: number; count: number }> = new Map();

  private readonly maxReadsPerFile: number = 2;
  private readonly readCooldownMs: number = 30000; // 30 seconds between reads of same file
  private readonly maxListingsPerDir: number = 2;
  private readonly listingCooldownMs: number = 60000; // 60 seconds between listings of same directory

  /**
   * Check if a file read should be blocked (redundant read)
   * @returns Object with blocked flag and reason if blocked
   */
  checkFileRead(filePath: string): { blocked: boolean; reason?: string; suggestion?: string } {
    const normalized = this.normalizePath(filePath);
    const existing = this.readFiles.get(normalized);
    const now = Date.now();

    if (existing) {
      const timeSinceLastRead = now - existing.lastReadTime;

      // If file was read recently (within cooldown), block
      if (timeSinceLastRead < this.readCooldownMs && existing.count >= this.maxReadsPerFile) {
        return {
          blocked: true,
          reason: `File "${filePath}" was already read ${existing.count} times in the last ${this.readCooldownMs / 1000}s`,
          suggestion: 'Use the content from the previous read instead of reading the file again. If you need specific parts, describe what you need.',
        };
      }
    }

    return { blocked: false };
  }

  /**
   * Record a file read operation
   */
  recordFileRead(filePath: string, contentLength: number): void {
    const normalized = this.normalizePath(filePath);
    const existing = this.readFiles.get(normalized);
    const now = Date.now();

    if (existing) {
      existing.count++;
      existing.lastReadTime = now;
      existing.contentLength = contentLength;
    } else {
      this.readFiles.set(normalized, { count: 1, lastReadTime: now, contentLength });
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
}

/**
 * Wrap a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
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
function calculateBackoffDelay(
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
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * TaskExecutor handles the execution of a single task
 * It implements the plan-execute-observe agent loop
 * Supports both Anthropic API and AWS Bedrock
 */
export class TaskExecutor {
  private provider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private sandboxRunner: SandboxRunner;
  private contextManager: ContextManager;
  private toolFailureTracker: ToolFailureTracker;
  private toolCallDeduplicator: ToolCallDeduplicator;
  private fileOperationTracker: FileOperationTracker;
  private cancelled = false;
  private paused = false;
  private taskCompleted = false;  // Prevents any further processing after task completes
  private plan?: Plan;
  private modelId: string;
  private modelKey: string;
  private conversationHistory: LLMMessage[] = [];
  private systemPrompt: string = '';

  // Plan revision tracking to prevent infinite revision loops
  private planRevisionCount: number = 0;
  private readonly maxPlanRevisions: number = 5;

  // Failed approach tracking to prevent retrying the same failed strategies
  private failedApproaches: Set<string> = new Set();

  // Abort controller for cancelling LLM requests
  private abortController: AbortController = new AbortController();

  // Guardrail tracking
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;
  private totalCost: number = 0;
  private iterationCount: number = 0;

  // Global turn tracking (across all steps) - similar to Claude Agent SDK's maxTurns
  private globalTurnCount: number = 0;
  private readonly maxGlobalTurns: number = 100; // Configurable global limit

  constructor(
    private task: Task,
    private workspace: Workspace,
    private daemon: AgentDaemon
  ) {
    // Initialize LLM provider using factory (respects user settings)
    this.provider = LLMProviderFactory.createProvider();

    // Get the model ID from settings
    const settings = LLMProviderFactory.loadSettings();
    this.modelId = LLMProviderFactory.getModelId(
      settings.modelKey,
      settings.providerType,
      settings.ollama?.model,
      settings.gemini?.model,
      settings.openrouter?.model,
      settings.openai?.model
    );
    this.modelKey = settings.modelKey;

    // Initialize context manager for handling long conversations
    this.contextManager = new ContextManager(settings.modelKey);

    // Initialize tool registry
    this.toolRegistry = new ToolRegistry(workspace, daemon, task.id);

    // Set up plan revision handler
    this.toolRegistry.setPlanRevisionHandler((newSteps, reason) => {
      this.handlePlanRevision(newSteps, reason);
    });

    // Initialize sandbox runner
    this.sandboxRunner = new SandboxRunner(workspace);

    // Initialize tool failure tracker for circuit breaker pattern
    this.toolFailureTracker = new ToolFailureTracker();

    // Initialize tool call deduplicator to prevent repetitive calls
    // Max 2 identical calls within 60 seconds before blocking
    // Max 2 semantically similar calls (e.g., similar web searches) within the window
    this.toolCallDeduplicator = new ToolCallDeduplicator(2, 60000, 2);

    // Initialize file operation tracker to detect redundant reads and duplicate creations
    this.fileOperationTracker = new FileOperationTracker();

    console.log(`TaskExecutor initialized with ${settings.providerType} provider, model: ${this.modelId}`);
  }

  /**
   * Make an LLM API call with exponential backoff retry
   * @param requestFn - Function that returns the LLM request promise
   * @param operation - Description of the operation for logging
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   */
  private async callLLMWithRetry(
    requestFn: () => Promise<any>,
    operation: string,
    maxRetries = 3
  ): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = calculateBackoffDelay(attempt - 1);
          console.log(`[TaskExecutor] Retry attempt ${attempt}/${maxRetries} for ${operation} after ${delay}ms`);
          this.daemon.logEvent(this.task.id, 'llm_retry', {
            operation,
            attempt,
            maxRetries,
            delayMs: delay,
          });
          await sleep(delay);
        }

        // Check for cancellation before retry
        if (this.cancelled) {
          throw new Error('Request cancelled');
        }

        return await requestFn();
      } catch (error: any) {
        lastError = error;

        // Don't retry on cancellation or non-retryable errors
        if (
          error.message === 'Request cancelled' ||
          error.name === 'AbortError' ||
          isNonRetryableError(error.message)
        ) {
          throw error;
        }

        // Check if it's a retryable error (rate limit, timeout, network error)
        const isRetryable =
          error.message?.includes('timeout') ||
          error.message?.includes('429') ||
          error.message?.includes('rate limit') ||
          error.message?.includes('ECONNRESET') ||
          error.message?.includes('ETIMEDOUT') ||
          error.message?.includes('network') ||
          error.status === 429 ||
          error.status === 503 ||
          error.status === 502;

        if (!isRetryable || attempt === maxRetries) {
          throw error;
        }

        console.log(`[TaskExecutor] ${operation} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`);
      }
    }

    throw lastError || new Error(`${operation} failed after ${maxRetries + 1} attempts`);
  }

  /**
   * Check guardrail budgets before making an LLM call
   * @throws Error if any budget is exceeded
   */
  private checkBudgets(): void {
    // Check global turn limit (similar to Claude Agent SDK's maxTurns)
    if (this.globalTurnCount >= this.maxGlobalTurns) {
      throw new Error(
        `Global turn limit exceeded: ${this.globalTurnCount}/${this.maxGlobalTurns} turns. ` +
        `Task stopped to prevent infinite loops. Consider breaking this task into smaller parts.`
      );
    }

    // Check iteration limit
    const iterationCheck = GuardrailManager.isIterationLimitExceeded(this.iterationCount);
    if (iterationCheck.exceeded) {
      throw new Error(
        `Iteration limit exceeded: ${iterationCheck.iterations}/${iterationCheck.limit} iterations. ` +
        `Task stopped to prevent runaway execution.`
      );
    }

    // Check token budget
    const totalTokens = this.totalInputTokens + this.totalOutputTokens;
    const tokenCheck = GuardrailManager.isTokenBudgetExceeded(totalTokens);
    if (tokenCheck.exceeded) {
      throw new Error(
        `Token budget exceeded: ${tokenCheck.used.toLocaleString()}/${tokenCheck.limit.toLocaleString()} tokens. ` +
        `Estimated cost: ${formatCost(this.totalCost)}`
      );
    }

    // Check cost budget
    const costCheck = GuardrailManager.isCostBudgetExceeded(this.totalCost);
    if (costCheck.exceeded) {
      throw new Error(
        `Cost budget exceeded: ${formatCost(costCheck.cost)}/${formatCost(costCheck.limit)}. ` +
        `Total tokens used: ${totalTokens.toLocaleString()}`
      );
    }
  }

  /**
   * Update tracking after an LLM response
   */
  private updateTracking(inputTokens: number, outputTokens: number): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCost += calculateCost(this.modelId, inputTokens, outputTokens);
    this.iterationCount++;
    this.globalTurnCount++; // Track global turns across all steps
  }

  /**
   * Check if a file operation should be blocked (redundant read or duplicate creation)
   * @returns Object with blocked flag, reason, and suggestion if blocked, plus optional cached result
   */
  private checkFileOperation(toolName: string, input: any): { blocked: boolean; reason?: string; suggestion?: string; cachedResult?: string } {
    // Check for redundant file reads
    if (toolName === 'read_file' && input?.path) {
      const check = this.fileOperationTracker.checkFileRead(input.path);
      if (check.blocked) {
        console.log(`[TaskExecutor] Blocking redundant file read: ${input.path}`);
        return check;
      }
    }

    // Check for redundant directory listings
    if (toolName === 'list_directory' && input?.path) {
      const check = this.fileOperationTracker.checkDirectoryListing(input.path);
      if (check.blocked && check.cachedFiles) {
        console.log(`[TaskExecutor] Returning cached directory listing for: ${input.path}`);
        return {
          blocked: true,
          reason: check.reason,
          suggestion: check.suggestion,
          cachedResult: `Directory contents (cached): ${check.cachedFiles.join(', ')}`,
        };
      }
    }

    // Check for duplicate file creations
    const fileCreationTools = ['create_document', 'write_file', 'copy_file'];
    if (fileCreationTools.includes(toolName)) {
      const filename = input?.filename || input?.path || input?.destPath || input?.destination;
      if (filename) {
        const check = this.fileOperationTracker.checkFileCreation(filename);
        if (check.isDuplicate) {
          console.log(`[TaskExecutor] Warning: Duplicate file creation detected: ${filename}`);
          // Don't block, but log warning - the LLM might have a good reason
          this.daemon.logEvent(this.task.id, 'tool_warning', {
            tool: toolName,
            warning: check.suggestion,
            existingFile: check.existingPath,
          });
        }
      }
    }

    return { blocked: false };
  }

  /**
   * Record a file operation after successful execution
   */
  private recordFileOperation(toolName: string, input: any, result: any): void {
    // Record file reads
    if (toolName === 'read_file' && input?.path) {
      const contentLength = typeof result === 'string' ? result.length : JSON.stringify(result).length;
      this.fileOperationTracker.recordFileRead(input.path, contentLength);
    }

    // Record directory listings
    if (toolName === 'list_directory' && input?.path) {
      // Extract file names from the result
      let files: string[] = [];
      if (Array.isArray(result)) {
        files = result.map(f => typeof f === 'string' ? f : f.name || f.path || String(f));
      } else if (typeof result === 'string') {
        // Parse string result (e.g., "file1, file2, file3" or "file1\nfile2\nfile3")
        files = result.split(/[,\n]/).map(f => f.trim()).filter(f => f);
      } else if (result?.files) {
        files = result.files;
      }
      this.fileOperationTracker.recordDirectoryListing(input.path, files);
    }

    // Record file creations
    const fileCreationTools = ['create_document', 'write_file', 'copy_file'];
    if (fileCreationTools.includes(toolName)) {
      const filename = result?.path || result?.filename || input?.filename || input?.path || input?.destPath;
      if (filename) {
        this.fileOperationTracker.recordFileCreation(filename);
      }
    }
  }

  /**
   * Infer missing parameters for tool calls (helps weaker models)
   * This auto-fills parameters when the LLM fails to provide them but context is available
   */
  private inferMissingParameters(toolName: string, input: any): { input: any; modified: boolean; inference?: string } {
    // Handle edit_document - infer sourcePath from recently created documents
    if (toolName === 'edit_document') {
      let modified = false;
      let inference = '';

      // Infer sourcePath if missing
      if (!input?.sourcePath) {
        const lastDoc = this.fileOperationTracker.getLastCreatedDocument();
        if (lastDoc) {
          input = input || {};
          input.sourcePath = lastDoc;
          modified = true;
          inference = `Inferred sourcePath="${lastDoc}" from recently created document`;
          console.log(`[TaskExecutor] Parameter inference: ${inference}`);
        }
      }

      // Provide helpful example for newContent if missing
      if (!input?.newContent || !Array.isArray(input.newContent) || input.newContent.length === 0) {
        // Can't infer content, but log helpful message
        console.log(`[TaskExecutor] edit_document called without newContent - LLM needs to provide content blocks`);
      }

      return { input, modified, inference: modified ? inference : undefined };
    }

    // Handle copy_file - normalize path parameters
    if (toolName === 'copy_file') {
      // Some LLMs use 'source'/'destination' instead of 'sourcePath'/'destPath'
      if (!input?.sourcePath && input?.source) {
        input.sourcePath = input.source;
        return { input, modified: true, inference: 'Normalized source -> sourcePath' };
      }
      if (!input?.destPath && input?.destination) {
        input.destPath = input.destination;
        return { input, modified: true, inference: 'Normalized destination -> destPath' };
      }
    }

    return { input, modified: false };
  }

  /**
   * Get available tools, filtering out disabled ones
   * This prevents the LLM from trying to use tools that have been disabled by the circuit breaker
   */
  private getAvailableTools() {
    const allTools = this.toolRegistry.getTools();
    const disabledTools = this.toolFailureTracker.getDisabledTools();

    if (disabledTools.length === 0) {
      return allTools;
    }

    const filtered = allTools.filter(tool => !disabledTools.includes(tool.name));
    console.log(`[TaskExecutor] Filtered out ${disabledTools.length} disabled tools: ${disabledTools.join(', ')}`);
    return filtered;
  }

  /**
   * Rebuild conversation history from saved events
   * This is used when recreating an executor for follow-up messages
   */
  rebuildConversationFromEvents(events: TaskEvent[]): void {
    // Build a summary of the previous conversation
    const conversationParts: string[] = [];

    // Add the original task as context
    conversationParts.push(`Original task: ${this.task.title}`);
    conversationParts.push(`Task details: ${this.task.prompt}`);
    conversationParts.push('');
    conversationParts.push('Previous conversation summary:');

    for (const event of events) {
      switch (event.type) {
        case 'log':
          if (event.payload?.message) {
            // User messages are logged as "User: message"
            if (event.payload.message.startsWith('User: ')) {
              conversationParts.push(`User: ${event.payload.message.slice(6)}`);
            } else {
              conversationParts.push(`System: ${event.payload.message}`);
            }
          }
          break;
        case 'assistant_message':
          if (event.payload?.message) {
            // Truncate long messages in summary
            const msg = event.payload.message.length > 500
              ? event.payload.message.slice(0, 500) + '...'
              : event.payload.message;
            conversationParts.push(`Assistant: ${msg}`);
          }
          break;
        case 'tool_call':
          if (event.payload?.tool) {
            conversationParts.push(`[Used tool: ${event.payload.tool}]`);
          }
          break;
        case 'plan_created':
          if (event.payload?.plan?.description) {
            conversationParts.push(`[Created plan: ${event.payload.plan.description}]`);
          }
          break;
        case 'error':
          if (event.payload?.message || event.payload?.error) {
            conversationParts.push(`[Error: ${event.payload.message || event.payload.error}]`);
          }
          break;
      }
    }

    // Only rebuild if there's meaningful history
    if (conversationParts.length > 4) { // More than just the task header
      this.conversationHistory = [
        {
          role: 'user',
          content: conversationParts.join('\n'),
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I understand the context from our previous conversation. How can I help you now?' }],
        },
      ];
      console.log('Rebuilt conversation history from', events.length, 'events');
    }

    // Set system prompt
    this.systemPrompt = `You are an AI assistant helping with tasks. Use the available tools to complete the work.
Today's date: ${getCurrentDateString()}
Workspace: ${this.workspace.path}
Always ask for approval before deleting files or making destructive changes.
Be concise in your responses. When reading files, only read what you need.

WEB ACCESS: Prefer browser_navigate for web access. If browser tools are unavailable, use web_search as an alternative. If any tool category is disabled, try alternative tools that can accomplish the same goal.

You are continuing a previous conversation. The context from the previous conversation has been provided.`;
  }

  /**
   * Update the workspace and recreate tool registry with new permissions
   * This is used when permissions change during an active task
   */
  updateWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    // Recreate tool registry to pick up new permissions (e.g., shell enabled)
    this.toolRegistry = new ToolRegistry(workspace, this.daemon, this.task.id);
    console.log(`Workspace updated for task ${this.task.id}, permissions:`, workspace.permissions);
  }

  /**
   * Verify success criteria for Goal Mode
   * @returns Object with success status and message
   */
  private async verifySuccessCriteria(): Promise<{ success: boolean; message: string }> {
    const criteria = this.task.successCriteria;
    if (!criteria) {
      return { success: true, message: 'No criteria defined' };
    }

    this.daemon.logEvent(this.task.id, 'verification_started', { criteria });

    if (criteria.type === 'shell_command' && criteria.command) {
      try {
        // Execute verification command via tool registry
        const result = await this.toolRegistry.executeTool('run_command', {
          command: criteria.command,
        }) as { success: boolean; exitCode: number | null; stdout: string; stderr: string };

        return {
          success: result.exitCode === 0,
          message: result.exitCode === 0
            ? 'Verification command passed'
            : `Verification failed (exit code ${result.exitCode}): ${result.stderr || result.stdout || 'Command failed'}`,
        };
      } catch (error: any) {
        return {
          success: false,
          message: `Verification command error: ${error.message}`,
        };
      }
    }

    if (criteria.type === 'file_exists' && criteria.filePaths) {
      const missing = criteria.filePaths.filter(p => {
        const fullPath = path.resolve(this.workspace.path, p);
        return !fs.existsSync(fullPath);
      });
      return {
        success: missing.length === 0,
        message: missing.length === 0
          ? 'All required files exist'
          : `Missing files: ${missing.join(', ')}`,
      };
    }

    return { success: true, message: 'Unknown criteria type' };
  }

  /**
   * Reset state for retry attempt in Goal Mode
   */
  private resetForRetry(): void {
    // Reset plan steps to pending
    if (this.plan) {
      for (const step of this.plan.steps) {
        step.status = 'pending';
        step.startedAt = undefined;
        step.completedAt = undefined;
        step.error = undefined;
      }
    }

    // Reset tool failure tracker (tools might work on retry)
    this.toolFailureTracker = new ToolFailureTracker();

    // Add context for LLM about retry
    this.conversationHistory.push({
      role: 'user',
      content: `The previous attempt did not meet the success criteria. Please try a different approach. This is attempt ${this.task.currentAttempt}.`,
    });
  }

  /**
   * Handle plan revision request from the LLM
   * Adds new steps to the plan after the current step
   * Enforces a maximum revision limit to prevent infinite loops
   */
  private handlePlanRevision(newSteps: Array<{ description: string }>, reason: string): void {
    if (!this.plan) {
      console.warn('[TaskExecutor] Cannot revise plan - no plan exists');
      return;
    }

    // Check plan revision limit to prevent infinite loops
    this.planRevisionCount++;
    if (this.planRevisionCount > this.maxPlanRevisions) {
      console.warn(`[TaskExecutor] Plan revision limit reached (${this.maxPlanRevisions}). Ignoring revision request.`);
      this.daemon.logEvent(this.task.id, 'plan_revision_blocked', {
        reason: `Maximum plan revisions (${this.maxPlanRevisions}) reached. The current approach may not be working - consider completing with available results or trying a fundamentally different strategy.`,
        attemptedRevision: reason,
        revisionCount: this.planRevisionCount,
      });
      return;
    }

    // Check for similar steps that have already failed (prevent retrying same approach)
    const newStepDescriptions = newSteps.map(s => s.description.toLowerCase());
    const existingFailedSteps = this.plan.steps.filter(s => s.status === 'failed');
    const duplicateApproach = existingFailedSteps.some(failedStep => {
      const failedDesc = failedStep.description.toLowerCase();
      return newStepDescriptions.some(newDesc =>
        // Check if new step is similar to a failed step
        newDesc.includes(failedDesc.substring(0, 30)) ||
        failedDesc.includes(newDesc.substring(0, 30)) ||
        // Check for common patterns like "copy file", "edit document", "verify"
        (failedDesc.includes('copy') && newDesc.includes('copy')) ||
        (failedDesc.includes('edit') && newDesc.includes('edit')) ||
        (failedDesc.includes('verify') && newDesc.includes('verify'))
      );
    });

    if (duplicateApproach) {
      console.warn('[TaskExecutor] Blocking plan revision - similar approach already failed');
      this.daemon.logEvent(this.task.id, 'plan_revision_blocked', {
        reason: 'Similar steps have already failed. The current approach is not working - try a fundamentally different strategy.',
        attemptedRevision: reason,
        failedSteps: existingFailedSteps.map(s => s.description),
      });
      return;
    }

    // Check if adding new steps would exceed the maximum total steps limit
    if (this.plan.steps.length + newSteps.length > MAX_TOTAL_STEPS) {
      const allowedNewSteps = MAX_TOTAL_STEPS - this.plan.steps.length;
      if (allowedNewSteps <= 0) {
        console.warn(`[TaskExecutor] Maximum total steps limit (${MAX_TOTAL_STEPS}) reached. Cannot add more steps.`);
        this.daemon.logEvent(this.task.id, 'plan_revision_blocked', {
          reason: `Maximum total steps (${MAX_TOTAL_STEPS}) reached. Complete the task with current progress or simplify the approach.`,
          attemptedSteps: newSteps.length,
          currentSteps: this.plan.steps.length,
        });
        return;
      }
      // Truncate to allowed number
      console.warn(`[TaskExecutor] Truncating revision from ${newSteps.length} to ${allowedNewSteps} steps due to limit`);
      newSteps = newSteps.slice(0, allowedNewSteps);
    }

    // Create new PlanStep objects for each new step
    const newPlanSteps: PlanStep[] = newSteps.map((step, index) => ({
      id: `revised-${Date.now()}-${index}`,
      description: step.description,
      status: 'pending' as const,
    }));

    // Find the current step (in_progress) and insert new steps after it
    const currentStepIndex = this.plan.steps.findIndex(s => s.status === 'in_progress');
    if (currentStepIndex === -1) {
      // No step in progress, append to end
      this.plan.steps.push(...newPlanSteps);
    } else {
      // Insert after current step
      this.plan.steps.splice(currentStepIndex + 1, 0, ...newPlanSteps);
    }

    // Log the plan revision
    this.daemon.logEvent(this.task.id, 'plan_revised', {
      reason,
      newStepsCount: newSteps.length,
      newSteps: newSteps.map(s => s.description),
      totalSteps: this.plan.steps.length,
      revisionNumber: this.planRevisionCount,
      revisionsRemaining: this.maxPlanRevisions - this.planRevisionCount,
    });

    console.log(`[TaskExecutor] Plan revised (${this.planRevisionCount}/${this.maxPlanRevisions}): added ${newSteps.length} steps. Reason: ${reason}`);
  }

  /**
   * Pre-task Analysis Phase (inspired by Cowork's AskUserQuestion pattern)
   * Analyzes the task to understand what's involved and gather helpful context
   * This helps the LLM create better plans by understanding the workspace context first
   */
  private async analyzeTask(): Promise<{ additionalContext?: string; taskType: string }> {
    this.daemon.logEvent(this.task.id, 'log', { message: 'Analyzing task requirements...' });

    const prompt = this.task.prompt.toLowerCase();

    // Detect task types and gather relevant context
    const isDocumentModification = prompt.includes('modify') || prompt.includes('edit') || prompt.includes('update') ||
      prompt.includes('change') || prompt.includes('add to') || prompt.includes('append') ||
      prompt.includes('duplicate') || prompt.includes('copy') || prompt.includes('version');

    const isDocumentCreation = prompt.includes('create') || prompt.includes('make') || prompt.includes('generate') ||
      prompt.includes('write a document') || prompt.includes('write a report');

    const mentionsSpecificFile = /\.(docx|pdf|xlsx|pptx|txt|md)/.test(prompt);

    let additionalContext = '';
    let taskType = 'general';

    try {
      // If the task mentions modifying documents or specific files, list workspace contents
      if (isDocumentModification || mentionsSpecificFile) {
        taskType = 'document_modification';

        // List workspace to find relevant files
        const files = await this.toolRegistry.executeTool('list_directory', { path: '.' });
        const fileList = Array.isArray(files) ? files : [];

        // Filter for relevant document files
        const documentFiles = fileList.filter((f: string) =>
          /\.(docx|pdf|xlsx|pptx|txt|md)$/i.test(f)
        );

        if (documentFiles.length > 0) {
          additionalContext += `WORKSPACE FILES FOUND:\n${documentFiles.join('\n')}\n\n`;

          // Record this listing to prevent duplicate list_directory calls
          this.fileOperationTracker.recordDirectoryListing('.', fileList);
        }

        // Add document modification best practices
        additionalContext += `DOCUMENT MODIFICATION BEST PRACTICES:
1. ALWAYS read the source document first to understand its structure
2. Use copy_file to create a new version (e.g., v2.4) before editing
3. Use edit_document with 'sourcePath' pointing to the copied file
4. edit_document REQUIRES: sourcePath (string) and newContent (array of {type, text} blocks)
5. DO NOT create new documents from scratch when modifying existing ones`;
      } else if (isDocumentCreation) {
        taskType = 'document_creation';

        additionalContext += `DOCUMENT CREATION BEST PRACTICES:
1. Use create_document for new Word/PDF files
2. Required parameters: filename, format ('docx' or 'pdf'), content (array of blocks)
3. Content blocks: { type: 'heading'|'paragraph'|'list', text: '...', level?: 1-6 }`;
      }

      // Log the analysis result
      this.daemon.logEvent(this.task.id, 'task_analysis', {
        taskType,
        hasAdditionalContext: !!additionalContext,
      });

    } catch (error: any) {
      console.warn(`[TaskExecutor] Task analysis error (non-fatal): ${error.message}`);
    }

    return { additionalContext: additionalContext || undefined, taskType };
  }

  /**
   * Main execution loop
   */
  async execute(): Promise<void> {
    try {
      // Phase 0: Pre-task Analysis (like Cowork's AskUserQuestion)
      // Analyze task complexity and check if clarification is needed
      const taskAnalysis = await this.analyzeTask();

      if (this.cancelled) return;

      // If task needs clarification, add context to the task prompt
      if (taskAnalysis.additionalContext) {
        this.task.prompt = `${this.task.prompt}\n\nADDITIONAL CONTEXT:\n${taskAnalysis.additionalContext}`;
      }

      // Phase 1: Planning
      this.daemon.updateTaskStatus(this.task.id, 'planning');
      await this.createPlan();

      if (this.cancelled) return;

      // Phase 2: Execution with Goal Mode retry loop
      const maxAttempts = this.task.maxAttempts || 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this.cancelled) break;

        // Update attempt tracking
        this.task.currentAttempt = attempt;
        this.daemon.updateTask(this.task.id, { currentAttempt: attempt });

        if (attempt > 1) {
          this.daemon.logEvent(this.task.id, 'retry_started', { attempt, maxAttempts });
          this.resetForRetry();
        }

        // Execute plan
        this.daemon.updateTaskStatus(this.task.id, 'executing');
        this.daemon.logEvent(this.task.id, 'executing', {
          message: maxAttempts > 1 ? `Executing plan (attempt ${attempt}/${maxAttempts})` : 'Executing plan',
        });
        await this.executePlan();

        if (this.cancelled) break;

        // Verify success criteria if defined (Goal Mode)
        if (this.task.successCriteria) {
          const result = await this.verifySuccessCriteria();

          if (result.success) {
            this.daemon.logEvent(this.task.id, 'verification_passed', {
              attempt,
              message: result.message,
            });
            break; // Success - exit retry loop
          } else {
            this.daemon.logEvent(this.task.id, 'verification_failed', {
              attempt,
              maxAttempts,
              message: result.message,
              willRetry: attempt < maxAttempts,
            });

            if (attempt === maxAttempts) {
              throw new Error(`Failed to meet success criteria after ${maxAttempts} attempts: ${result.message}`);
            }
          }
        }
      }

      if (this.cancelled) return;

      // Phase 3: Completion
      this.taskCompleted = true;  // Mark task as completed to prevent any further processing
      this.daemon.completeTask(this.task.id);
    } catch (error: any) {
      // Don't log cancellation as an error - it's intentional
      const isCancellation = this.cancelled ||
        error.message === 'Request cancelled' ||
        error.name === 'AbortError' ||
        error.message?.includes('aborted');

      if (isCancellation) {
        console.log(`[TaskExecutor] Task cancelled - not logging as error`);
        // Status will be updated by the daemon's cancelTask method
        return;
      }

      console.error(`Task execution failed:`, error);
      this.daemon.updateTaskStatus(this.task.id, 'failed');
      this.daemon.logEvent(this.task.id, 'error', {
        message: error.message,
        stack: error.stack,
      });
    } finally {
      // Cleanup resources (e.g., close browser)
      await this.toolRegistry.cleanup().catch(e => {
        console.error('Cleanup error:', e);
      });
    }
  }

  /**
   * Create execution plan using LLM
   */
  private async createPlan(): Promise<void> {
    console.log(`[Task ${this.task.id}] Creating plan with model: ${this.modelId}`);
    this.daemon.logEvent(this.task.id, 'log', { message: `Creating execution plan (model: ${this.modelId})...` });

    // Get enabled guidelines from custom skills
    const skillLoader = getCustomSkillLoader();
    const guidelinesPrompt = skillLoader.getEnabledGuidelinesPrompt();

    const systemPrompt = `You are an autonomous task executor. Your job is to:
1. Analyze the user's request thoroughly - understand what files are involved and what changes are needed
2. Create a detailed, step-by-step plan with specific actions
3. Execute each step using the available tools
4. Produce high-quality outputs

Today's date: ${getCurrentDateString()}
You have access to a workspace folder at: ${this.workspace.path}
Workspace permissions: ${JSON.stringify(this.workspace.permissions)}

Available tools:
${this.toolRegistry.getToolDescriptions()}

PLANNING RULES:
- Create a plan with 3-7 SPECIFIC steps. Each step must describe a concrete action.
- Each step should accomplish ONE clear objective with specific file names when known.
- DO NOT include redundant "verify" or "review" steps for each action.
- DO NOT plan to create multiple versions of files - pick ONE target file.
- DO NOT plan to read the same file multiple times in different steps.

WEB ACCESS & CONTENT EXTRACTION (IMPORTANT):
- For web access: browser_navigate THEN browser_get_content (both required).
- ALWAYS plan to extract content after navigating - never just navigate and stop.
- If browser_get_content returns insufficient info, plan to use browser_screenshot.
- If browser tools are unavailable, use web_search as an alternative.
- NEVER use run_command with curl, wget, or other network commands for web access.
- NEVER create a plan that says "cannot be done" if alternative tools are available.
- NEVER plan to ask the user for content you can extract yourself.

COMMON WORKFLOWS (follow these patterns):

1. MODIFY EXISTING DOCUMENT (CRITICAL):
   Step 1: Read the original document to understand its structure
   Step 2: Copy the document to a new version (e.g., v2.4)
   Step 3: Edit the copied document with edit_document tool, adding new content sections
   IMPORTANT: edit_document requires 'sourcePath' (the file to edit) and 'newContent' (array of content blocks)

2. CREATE NEW DOCUMENT:
   Step 1: Gather/research the required information
   Step 2: Create the document with create_document tool

3. WEB RESEARCH (MANDATORY PATTERN when needing current information):
   FOR EACH SOURCE - process completely before moving to next:
   Step 1: browser_navigate to URL
   Step 2: browser_get_content IMMEDIATELY after navigate (these are ONE ATOMIC operation)
   Step 3: Process and store the relevant information
   Step 4: Repeat steps 1-3 for additional sources
   Step 5: Compile all findings into your response

   If content is insufficient: use browser_screenshot to see visual layout
   If browser tools unavailable: use web_search as alternative

   CRITICAL:
   - NEVER navigate to multiple pages first and then try to extract. Process each page fully.
   - NEVER ask the user for content you can extract with browser_get_content.
   - NEVER say "I opened the pages but need access to the content" - you HAVE access via browser_get_content.

4. FILE ORGANIZATION:
   Step 1: List directory contents to see current structure
   Step 2: Create necessary directories
   Step 3: Move/rename files as needed

TOOL PARAMETER REMINDERS:
- edit_document: REQUIRES sourcePath (path to existing doc) and newContent (array of {type, text} blocks)
- copy_file: REQUIRES sourcePath and destPath
- read_file: REQUIRES path

VERIFICATION STEP (REQUIRED):
- For non-trivial tasks, include a FINAL verification step
- Verification can include: reading the output file to confirm changes, checking file exists, summarizing what was done
- Example: "Verify: Read the modified document and confirm new sections were added correctly"

Format your plan as a JSON object with this structure:
{
  "description": "Overall plan description",
  "steps": [
    {"id": "1", "description": "Specific action with file names when applicable", "status": "pending"},
    {"id": "N", "description": "Verify: [describe what to check]", "status": "pending"}
  ]
}${guidelinesPrompt ? `\n\n${guidelinesPrompt}` : ''}`;

    let response;
    try {
      // Check budgets before LLM call
      this.checkBudgets();

      const startTime = Date.now();
      console.log(`[Task ${this.task.id}] Calling LLM API for plan creation...`);

      // Use retry wrapper for resilient API calls
      response = await this.callLLMWithRetry(
        () => withTimeout(
          this.provider.createMessage({
            model: this.modelId,
            maxTokens: 4096,
            system: systemPrompt,
            messages: [
              {
                role: 'user',
                content: `Task: ${this.task.title}\n\nDetails: ${this.task.prompt}\n\nCreate an execution plan.`,
              },
            ],
            signal: this.abortController.signal,
          }),
          LLM_TIMEOUT_MS,
          'Plan creation'
        ),
        'Plan creation'
      );

      // Update tracking after response
      if (response.usage) {
        this.updateTracking(response.usage.inputTokens, response.usage.outputTokens);
      }

      console.log(`[Task ${this.task.id}] LLM response received in ${Date.now() - startTime}ms`);
    } catch (llmError: any) {
      console.error(`[Task ${this.task.id}] LLM API call failed:`, llmError);
      this.daemon.logEvent(this.task.id, 'error', {
        message: `LLM API error: ${llmError.message}`,
        details: llmError.status ? `Status: ${llmError.status}` : undefined,
      });
      throw llmError;
    }

    // Extract plan from response
    const textContent = response.content.find((c: { type: string }) => c.type === 'text');
    if (textContent && textContent.type === 'text') {
      try {
        // Try to extract and parse JSON from the response
        const json = this.extractJsonObject(textContent.text);
        // Validate that the JSON has a valid steps array
        if (json && Array.isArray(json.steps) && json.steps.length > 0) {
          // Ensure each step has required fields
          this.plan = {
            description: json.description || 'Execution plan',
            steps: json.steps.map((s: any, i: number) => ({
              id: s.id || String(i + 1),
              description: s.description || s.step || s.task || String(s),
              status: 'pending' as const,
            })),
          };
          this.daemon.logEvent(this.task.id, 'plan_created', { plan: this.plan });
        } else {
          // Fallback: create simple plan from text
          this.plan = {
            description: 'Execution plan',
            steps: [
              {
                id: '1',
                description: textContent.text.slice(0, 500),
                status: 'pending',
              },
            ],
          };
          this.daemon.logEvent(this.task.id, 'plan_created', { plan: this.plan });
        }
      } catch (error) {
        console.error('Failed to parse plan:', error);
        // Use fallback plan instead of throwing
        this.plan = {
          description: 'Execute task',
          steps: [
            {
              id: '1',
              description: this.task.prompt,
              status: 'pending',
            },
          ],
        };
        this.daemon.logEvent(this.task.id, 'plan_created', { plan: this.plan });
      }
    }
  }

  /**
   * Extract first valid JSON object from text
   */
  private extractJsonObject(text: string): any {
    // Find the first { and try to find matching }
    const startIndex = text.indexOf('{');
    if (startIndex === -1) return null;

    let braceCount = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;

        if (braceCount === 0) {
          const jsonStr = text.slice(startIndex, i + 1);
          try {
            return JSON.parse(jsonStr);
          } catch {
            return null;
          }
        }
      }
    }

    return null;
  }

  /**
   * Execute the plan step by step
   */
  private async executePlan(): Promise<void> {
    if (!this.plan) {
      throw new Error('No plan available');
    }

    const totalSteps = this.plan.steps.length;
    let completedSteps = 0;

    // Emit initial progress event
    this.daemon.logEvent(this.task.id, 'progress_update', {
      phase: 'execution',
      completedSteps,
      totalSteps,
      progress: 0,
      message: `Starting execution of ${totalSteps} steps`,
    });

    for (const step of this.plan.steps) {
      if (this.cancelled) break;

      // Wait if paused
      while (this.paused && !this.cancelled) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Emit step starting progress
      this.daemon.logEvent(this.task.id, 'progress_update', {
        phase: 'execution',
        currentStep: step.id,
        currentStepDescription: step.description,
        completedSteps,
        totalSteps,
        progress: Math.round((completedSteps / totalSteps) * 100),
        message: `Executing step ${completedSteps + 1}/${totalSteps}: ${step.description}`,
      });

      // Execute step with timeout enforcement
      // Create a step-specific timeout that will abort ongoing LLM requests
      const stepTimeoutId = setTimeout(() => {
        console.log(`[TaskExecutor] Step "${step.description}" timed out after ${STEP_TIMEOUT_MS / 1000}s - aborting`);
        // Abort any in-flight LLM requests for this step
        this.abortController.abort();
        // Create new controller for next step
        this.abortController = new AbortController();
      }, STEP_TIMEOUT_MS);

      try {
        await this.executeStep(step);
        clearTimeout(stepTimeoutId);
      } catch (error: any) {
        clearTimeout(stepTimeoutId);

        // If step was aborted due to timeout or cancellation
        if (error.name === 'AbortError' || error.message.includes('aborted') || error.message.includes('timed out')) {
          step.status = 'failed';
          step.error = `Step timed out after ${STEP_TIMEOUT_MS / 1000}s`;
          step.completedAt = Date.now();
          this.daemon.logEvent(this.task.id, 'step_timeout', {
            step,
            timeout: STEP_TIMEOUT_MS,
            message: `Step timed out after ${STEP_TIMEOUT_MS / 1000}s`,
          });
          // Continue with next step instead of failing entire task
          completedSteps++;
          continue;
        }
        throw error;
      }

      completedSteps++;

      // Emit step completed progress
      this.daemon.logEvent(this.task.id, 'progress_update', {
        phase: 'execution',
        currentStep: step.id,
        completedSteps,
        totalSteps,
        progress: Math.round((completedSteps / totalSteps) * 100),
        message: `Completed step ${completedSteps}/${totalSteps}`,
      });
    }

    // Check if any steps failed
    const failedSteps = this.plan.steps.filter(s => s.status === 'failed');
    const successfulSteps = this.plan.steps.filter(s => s.status === 'completed');

    if (failedSteps.length > 0) {
      // Log warning about failed steps
      const failedDescriptions = failedSteps.map(s => s.description).join(', ');
      console.log(`[TaskExecutor] ${failedSteps.length} step(s) failed: ${failedDescriptions}`);

      // If critical steps failed (not just verification), this should be marked
      const criticalFailures = failedSteps.filter(s => !s.description.toLowerCase().includes('verify'));
      if (criticalFailures.length > 0) {
        this.daemon.logEvent(this.task.id, 'progress_update', {
          phase: 'execution',
          completedSteps: successfulSteps.length,
          totalSteps,
          progress: Math.round((successfulSteps.length / totalSteps) * 100),
          message: `Completed with ${criticalFailures.length} failed step(s)`,
          hasFailures: true,
        });
        // Throw error to mark task as failed
        throw new Error(`Task partially completed: ${criticalFailures.length} step(s) failed - ${criticalFailures.map(s => s.description).join('; ')}`);
      }
    }

    // Emit completion progress (only if no critical failures)
    this.daemon.logEvent(this.task.id, 'progress_update', {
      phase: 'execution',
      completedSteps,
      totalSteps,
      progress: 100,
      message: 'All steps completed',
    });
  }

  /**
   * Execute a single plan step
   */
  private async executeStep(step: PlanStep): Promise<void> {
    this.daemon.logEvent(this.task.id, 'step_started', { step });

    step.status = 'in_progress';
    step.startedAt = Date.now();

    // Get enabled guidelines from custom skills
    const skillLoader = getCustomSkillLoader();
    const guidelinesPrompt = skillLoader.getEnabledGuidelinesPrompt();

    // Define system prompt once so we can track its token usage
    this.systemPrompt = `You are an autonomous task executor. Use the available tools to complete each step.
Today's date: ${getCurrentDateString()}
Workspace: ${this.workspace.path}

IMPORTANT INSTRUCTIONS:
- Always use tools to accomplish tasks. Do not just describe what you would do - actually call the tools.
- The delete_file tool has a built-in approval mechanism that will prompt the user. Just call the tool directly.
- Do NOT ask "Should I proceed?" or wait for permission in text - the tools handle approvals automatically.

TOOL CALL STYLE:
- Default: do NOT narrate routine, low-risk tool calls. Just call the tool silently.
- Narrate only when it helps: multi-step work, complex problems, or sensitive actions (e.g., deletions).
- Keep narration brief and value-dense; avoid repeating obvious steps.
- For web research: navigate and extract in rapid succession without commentary between each step.

AUTONOMOUS OPERATION (CRITICAL):
- You are an AUTONOMOUS agent. You have tools to gather information yourself.
- NEVER ask the user to provide content, URLs, or data that you can extract using your available tools.
- If you navigated to a website, USE browser_get_content to read it - don't ask the user what's on the page.
- If you need information from a page, USE your tools to extract it - don't ask the user to find it for you.
- Your job is to DO the work, not to tell the user what they need to do.

CRITICAL - FINAL ANSWER REQUIREMENT:
- You MUST ALWAYS output a text response at the end. NEVER finish silently with just tool calls.
- After using tools, IMMEDIATELY provide your findings as TEXT. Don't keep calling tools indefinitely.
- For research tasks: summarize what you found and directly answer the user's question.
- If you couldn't find the information, SAY SO explicitly (e.g., "I couldn't find lap times for today's testing").
- After 2-3 tool calls, you MUST provide a text answer summarizing what you found or didn't find.

WEB ACCESS & CONTENT EXTRACTION (CRITICAL):
- Treat browser_navigate + browser_get_content as ONE ATOMIC OPERATION. Never navigate without immediately extracting.
- For EACH page you visit: navigate -> browser_get_content -> process the result. Then move to next page.
- If browser_get_content returns insufficient info, use browser_screenshot to see the visual layout.
- For dynamic content (JavaScript-heavy pages), wait with browser_wait then try browser_get_content again.
- If browser tools are unavailable, use web_search as an alternative.
- NEVER use run_command with curl, wget, or other network commands.

MULTI-PAGE RESEARCH PATTERN:
- When researching from multiple sources, process each source COMPLETELY before moving to the next:
  1. browser_navigate to source 1 -> browser_get_content -> extract relevant info
  2. browser_navigate to source 2 -> browser_get_content -> extract relevant info
  3. browser_navigate to source 3 -> browser_get_content -> extract relevant info
  4. Compile findings from all sources into your response
- Do NOT navigate to all sources first and then try to extract. Process each one fully.

ANTI-PATTERNS (NEVER DO THESE):
- DO NOT: Navigate to multiple pages without extracting content from each
- DO NOT: Navigate to page then ask user for URLs or content
- DO NOT: Open multiple sources then claim you can't access them
- DO NOT: Say "I need access to the articles" when you already navigated there
- DO: Navigate -> browser_get_content -> process -> repeat for each source -> summarize all findings

CRITICAL TOOL PARAMETER REQUIREMENTS:
- edit_document: MUST provide 'sourcePath' (path to existing DOCX file) and 'newContent' (array of content blocks)
  Example: edit_document({ sourcePath: "document.docx", newContent: [{ type: "heading", text: "New Section", level: 2 }, { type: "paragraph", text: "Content here" }] })
- copy_file: MUST provide 'sourcePath' and 'destPath'
- read_file: MUST provide 'path'
- create_document: MUST provide 'filename', 'format', and 'content'

EFFICIENCY RULES (CRITICAL):
- DO NOT read the same file multiple times. If you've already read a file, use the content from memory.
- DO NOT create multiple versions of the same file (e.g., v2.4, v2.5, _Updated, _Final). Pick ONE target file and work with it.
- DO NOT repeatedly verify/check the same thing. Trust your previous actions.
- If a tool fails, try a DIFFERENT approach - don't retry the same approach multiple times.
- Minimize file operations: read once, modify once, verify once.

ADAPTIVE PLANNING:
- If you discover the current plan is insufficient, use the revise_plan tool to add new steps.
- Do not silently skip necessary work - if something new is needed, add it to the plan.
- If an approach keeps failing, revise the plan with a fundamentally different strategy.${guidelinesPrompt ? `\n\n${guidelinesPrompt}` : ''}`;

    const systemPromptTokens = estimateTokens(this.systemPrompt);

    try {
      // Each step gets fresh context with its specific instruction
      // Build context from previous steps if any were completed
      const completedSteps = this.plan?.steps.filter(s => s.status === 'completed') || [];
      let stepContext = `Execute this step: ${step.description}\n\nTask context: ${this.task.prompt}`;

      if (completedSteps.length > 0) {
        stepContext += `\n\nPrevious steps already completed:\n${completedSteps.map(s => `- ${s.description}`).join('\n')}`;
        stepContext += `\n\nDo NOT repeat work from previous steps. Focus only on: ${step.description}`;
      }

      // Add accumulated knowledge from previous steps (discovered files, directories, etc.)
      const knowledgeSummary = this.fileOperationTracker.getKnowledgeSummary();
      if (knowledgeSummary) {
        stepContext += `\n\nKNOWLEDGE FROM PREVIOUS STEPS (use this instead of re-reading/re-listing):\n${knowledgeSummary}`;
      }

      // Start fresh messages for this step
      let messages: LLMMessage[] = [
        {
          role: 'user',
          content: stepContext,
        },
      ];

      let continueLoop = true;
      let iterationCount = 0;
      let emptyResponseCount = 0;
      let stepFailed = false;  // Track if step failed due to all tools being disabled/erroring
      let lastFailureReason = '';  // Track the reason for failure
      const maxIterations = 5;  // Reduced from 10 to prevent excessive iterations per step
      const maxEmptyResponses = 3;

      while (continueLoop && iterationCount < maxIterations) {
        // Check if task is cancelled or already completed
        if (this.cancelled || this.taskCompleted) {
          console.log(`[TaskExecutor] Step loop terminated: cancelled=${this.cancelled}, completed=${this.taskCompleted}`);
          break;
        }

        iterationCount++;

        // Check for too many empty responses
        if (emptyResponseCount >= maxEmptyResponses) {
          break;
        }

        // Check guardrail budgets before each LLM call
        this.checkBudgets();

        // Compact messages if context is getting too large
        messages = this.contextManager.compactMessages(messages, systemPromptTokens);

        // Use retry wrapper for resilient API calls
        const response = await this.callLLMWithRetry(
          () => withTimeout(
            this.provider.createMessage({
              model: this.modelId,
              maxTokens: 4096,
              system: this.systemPrompt,
              tools: this.getAvailableTools(),
              messages,
              signal: this.abortController.signal,
            }),
            LLM_TIMEOUT_MS,
            'LLM execution step'
          ),
          `Step execution (iteration ${iterationCount})`
        );

        // Update tracking after response
        if (response.usage) {
          this.updateTracking(response.usage.inputTokens, response.usage.outputTokens);
        }

        // Process response - only stop if we have actual content AND it's end_turn
        // Empty responses should not terminate the loop
        if (response.stopReason === 'end_turn' && response.content && response.content.length > 0) {
          continueLoop = false;
        }

        // Log any text responses from the assistant and check if asking a question
        let assistantAskedQuestion = false;
        if (response.content) {
          for (const content of response.content) {
            if (content.type === 'text' && content.text) {
              this.daemon.logEvent(this.task.id, 'assistant_message', {
                message: content.text,
              });

              // Check if the assistant is asking a question (waiting for user input)
              if (isAskingQuestion(content.text)) {
                assistantAskedQuestion = true;
              }
            }
          }
        }

        // Add assistant response to conversation (ensure content is not empty)
        if (response.content && response.content.length > 0) {
          messages.push({
            role: 'assistant',
            content: response.content,
          });
          // Reset empty response counter on valid response
          emptyResponseCount = 0;
        } else {
          // Bedrock API requires non-empty content, add placeholder and continue
          emptyResponseCount++;
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'I understand. Let me continue.' }],
          });
        }

        // Handle tool calls
        const toolResults: LLMToolResult[] = [];
        let hasDisabledToolAttempt = false;
        let hasDuplicateToolAttempt = false;

        for (const content of response.content || []) {
          if (content.type === 'tool_use') {
            // Check if this tool is disabled (circuit breaker tripped)
            if (this.toolFailureTracker.isDisabled(content.name)) {
              const lastError = this.toolFailureTracker.getLastError(content.name);
              console.log(`[TaskExecutor] Skipping disabled tool: ${content.name}`);
              this.daemon.logEvent(this.task.id, 'tool_error', {
                tool: content.name,
                error: `Tool disabled due to repeated failures: ${lastError}`,
                skipped: true,
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: JSON.stringify({
                  error: `Tool "${content.name}" is temporarily unavailable due to: ${lastError}. Please try a different approach or wait and try again later.`,
                  disabled: true,
                }),
                is_error: true,
              });
              hasDisabledToolAttempt = true;
              continue;
            }

            // Check for duplicate tool calls (prevents stuck loops)
            const duplicateCheck = this.toolCallDeduplicator.checkDuplicate(content.name, content.input);
            if (duplicateCheck.isDuplicate) {
              console.log(`[TaskExecutor] Blocking duplicate tool call: ${content.name}`);
              this.daemon.logEvent(this.task.id, 'tool_blocked', {
                tool: content.name,
                reason: 'duplicate_call',
                message: duplicateCheck.reason,
              });

              // If we have a cached result for idempotent tools, return it
              if (duplicateCheck.cachedResult && ToolCallDeduplicator.isIdempotentTool(content.name)) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: content.id,
                  content: duplicateCheck.cachedResult,
                });
              } else {
                // For non-idempotent tools, return an error explaining the duplicate
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: content.id,
                  content: JSON.stringify({
                    error: duplicateCheck.reason,
                    suggestion: 'This tool was already called with these exact parameters. The previous call succeeded. Please proceed to the next step or try a different approach.',
                    duplicate: true,
                  }),
                  is_error: true,
                });
                hasDuplicateToolAttempt = true;
              }
              continue;
            }

            // Check for cancellation or completion before executing tool
            if (this.cancelled || this.taskCompleted) {
              console.log(`[TaskExecutor] Stopping tool execution: cancelled=${this.cancelled}, completed=${this.taskCompleted}`);
              break;
            }

            // Check for redundant file operations
            const fileOpCheck = this.checkFileOperation(content.name, content.input);
            if (fileOpCheck.blocked) {
              console.log(`[TaskExecutor] Blocking redundant file operation: ${content.name}`);
              this.daemon.logEvent(this.task.id, 'tool_blocked', {
                tool: content.name,
                reason: 'redundant_file_operation',
                message: fileOpCheck.reason,
              });

              // If we have a cached result (e.g., for directory listings), return it instead of an error
              if (fileOpCheck.cachedResult) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: content.id,
                  content: fileOpCheck.cachedResult,
                  is_error: false,
                });
              } else {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: content.id,
                  content: JSON.stringify({
                    error: fileOpCheck.reason,
                    suggestion: fileOpCheck.suggestion,
                    blocked: true,
                  }),
                  is_error: true,
                });
              }
              continue;
            }

            // Infer missing parameters for weaker models
            const inference = this.inferMissingParameters(content.name, content.input);
            if (inference.modified) {
              content.input = inference.input;
              this.daemon.logEvent(this.task.id, 'parameter_inference', {
                tool: content.name,
                inference: inference.inference,
              });
            }

            this.daemon.logEvent(this.task.id, 'tool_call', {
              tool: content.name,
              input: content.input,
            });

            try {
              // Execute tool with timeout to prevent hanging
              const result = await withTimeout(
                this.toolRegistry.executeTool(
                  content.name,
                  content.input as any
                ),
                TOOL_TIMEOUT_MS,
                `Tool ${content.name}`
              );

              // Tool succeeded - reset failure counter
              this.toolFailureTracker.recordSuccess(content.name);

              // Record this call for deduplication
              const resultStr = JSON.stringify(result);
              this.toolCallDeduplicator.recordCall(content.name, content.input, resultStr);

              // Record file operation for tracking
              this.recordFileOperation(content.name, content.input, result);

              // Check if the result indicates an error (some tools return error in result)
              if (result && result.success === false && result.error) {
                // Check if this is a non-retryable error
                const shouldDisable = this.toolFailureTracker.recordFailure(content.name, result.error);
                if (shouldDisable) {
                  this.daemon.logEvent(this.task.id, 'tool_error', {
                    tool: content.name,
                    error: result.error,
                    disabled: true,
                  });
                }
              }

              // Truncate large tool results to avoid context overflow
              const truncatedResult = truncateToolResult(resultStr);

              this.daemon.logEvent(this.task.id, 'tool_result', {
                tool: content.name,
                result: result,
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: truncatedResult,
              });
            } catch (error: any) {
              console.error(`Tool execution failed:`, error);

              // Track the failure
              const shouldDisable = this.toolFailureTracker.recordFailure(content.name, error.message);

              this.daemon.logEvent(this.task.id, 'tool_error', {
                tool: content.name,
                error: error.message,
                disabled: shouldDisable,
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: JSON.stringify({
                  error: error.message,
                  ...(shouldDisable ? { disabled: true, message: 'Tool has been disabled due to repeated failures.' } : {}),
                }),
                is_error: true,
              });
            }
          }
        }

        if (toolResults.length > 0) {
          messages.push({
            role: 'user',
            content: toolResults,
          });

          // If all tool attempts were for disabled or duplicate tools, don't continue looping
          // This prevents infinite retry loops
          const allToolsFailed = toolResults.every(r => r.is_error);
          if ((hasDisabledToolAttempt || hasDuplicateToolAttempt) && allToolsFailed) {
            console.log('[TaskExecutor] All tool calls failed, were disabled, or duplicates - stopping iteration');
            if (hasDuplicateToolAttempt) {
              // Duplicate detection triggered - step is likely complete
              stepFailed = false;
              lastFailureReason = '';
            } else {
              stepFailed = true;
              lastFailureReason = 'All required tools are unavailable or failed. Unable to complete this step.';
            }
            continueLoop = false;
          } else {
            continueLoop = true;
          }
        }

        // If assistant asked a question and there are no tool calls, stop and wait for user
        if (assistantAskedQuestion && toolResults.length === 0) {
          console.log('[TaskExecutor] Assistant asked a question, pausing for user input');
          continueLoop = false;
        }
      }

      // Step completed or failed

      // Save conversation history for follow-up messages
      this.conversationHistory = messages;

      // Mark step as failed if all tools failed/were disabled
      if (stepFailed) {
        step.status = 'failed';
        step.error = lastFailureReason;
        step.completedAt = Date.now();
        this.daemon.logEvent(this.task.id, 'step_failed', {
          step,
          reason: lastFailureReason,
        });
      } else {
        step.status = 'completed';
        step.completedAt = Date.now();
        this.daemon.logEvent(this.task.id, 'step_completed', { step });
      }
    } catch (error: any) {
      step.status = 'failed';
      step.error = error.message;
      step.completedAt = Date.now();
      this.daemon.logEvent(this.task.id, 'error', {
        step: step.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Send a follow-up message to continue the conversation
   */
  async sendMessage(message: string): Promise<void> {
    this.daemon.updateTaskStatus(this.task.id, 'executing');
    this.daemon.logEvent(this.task.id, 'executing', { message: 'Processing follow-up message' });
    this.daemon.logEvent(this.task.id, 'user_message', { message });

    // Get enabled guidelines from custom skills
    const skillLoader = getCustomSkillLoader();
    const guidelinesPrompt = skillLoader.getEnabledGuidelinesPrompt();

    // Ensure system prompt is set
    if (!this.systemPrompt) {
      this.systemPrompt = `You are an autonomous task executor. Use the available tools to complete each step.
Today's date: ${getCurrentDateString()}
Workspace: ${this.workspace.path}

IMPORTANT INSTRUCTIONS:
- Always use tools to accomplish tasks. Do not just describe what you would do - actually call the tools.
- The delete_file tool has a built-in approval mechanism that will prompt the user. Just call the tool directly.
- Do NOT ask "Should I proceed?" or wait for permission in text - the tools handle approvals automatically.

TOOL CALL STYLE:
- Default: do NOT narrate routine, low-risk tool calls. Just call the tool silently.
- Narrate only when it helps: multi-step work, complex problems, or sensitive actions (e.g., deletions).
- Keep narration brief and value-dense; avoid repeating obvious steps.
- For web research: navigate and extract in rapid succession without commentary between each step.

AUTONOMOUS OPERATION (CRITICAL):
- You are an AUTONOMOUS agent. You have tools to gather information yourself.
- NEVER ask the user to provide content, URLs, or data that you can extract using your available tools.
- If you navigated to a website, USE browser_get_content to read it - don't ask the user what's on the page.
- If you need information from a page, USE your tools to extract it - don't ask the user to find it for you.
- Your job is to DO the work, not to tell the user what they need to do.

FOLLOW-UP MESSAGE HANDLING (CRITICAL):
- This is a FOLLOW-UP message. The user is continuing an existing conversation.
- FIRST: Review the conversation history above - you already have context and findings from previous messages.
- USE EXISTING KNOWLEDGE: If you already found information in this conversation, USE IT. Do not start fresh research.
- NEVER CONTRADICT YOURSELF: If you found information earlier, do not claim it doesn't exist in follow-ups.
- BUILD ON PREVIOUS FINDINGS: Your follow-up should extend/refine what you already found, not ignore it.
- DO NOT ask clarifying questions - just do the work based on context from the conversation.
- DO NOT say "Would you like me to..." or "Should I..." - just DO IT.
- If tools fail, USE THE KNOWLEDGE YOU ALREADY HAVE from this conversation instead of hallucinating.
- ONLY do new research if the follow-up asks for information you DON'T already have.

CRITICAL - FINAL ANSWER REQUIREMENT:
- You MUST ALWAYS output a text response at the end. NEVER finish silently with just tool calls.
- After using tools, IMMEDIATELY provide your findings as TEXT. Don't keep calling tools indefinitely.
- For research tasks: summarize what you found and directly answer the user's question.
- If you couldn't find the information, SAY SO explicitly (e.g., "I couldn't find lap times for today's testing").
- After 2-3 tool calls, you MUST provide a text answer summarizing what you found or didn't find.

WEB ACCESS & CONTENT EXTRACTION (CRITICAL):
- Treat browser_navigate + browser_get_content as ONE ATOMIC OPERATION. Never navigate without immediately extracting.
- For EACH page you visit: navigate -> browser_get_content -> process the result. Then move to next page.
- If browser_get_content returns insufficient info, use browser_screenshot to see the visual layout.
- If browser tools are unavailable, use web_search as an alternative.
- NEVER use run_command with curl, wget, or other network commands.

MULTI-PAGE RESEARCH PATTERN:
- When researching from multiple sources, process each source COMPLETELY before moving to the next:
  1. browser_navigate to source 1 -> browser_get_content -> extract relevant info
  2. browser_navigate to source 2 -> browser_get_content -> extract relevant info
  3. Compile findings from all sources into your response
- Do NOT navigate to all sources first and then try to extract. Process each one fully.

ANTI-PATTERNS (NEVER DO THESE):
- DO NOT: Contradict information you found earlier in this conversation
- DO NOT: Claim "no information found" when you already found information in previous messages
- DO NOT: Hallucinate or make up information when tools fail - use existing knowledge instead
- DO NOT: Start fresh research when you already have the answer in conversation history
- DO NOT: Navigate to multiple pages without extracting content from each
- DO NOT: Navigate to page then ask user for URLs or content
- DO NOT: Open multiple sources then claim you can't access them
- DO NOT: Ask "Would you like me to..." or "Should I..." - just do it
- DO: Review conversation history FIRST before doing new research
- DO: Use information you already gathered before claiming it doesn't exist
- DO: Navigate -> browser_get_content -> process -> repeat for each source -> summarize all findings

EFFICIENCY RULES (CRITICAL):
- DO NOT read the same file multiple times. If you've already read a file, use the content from memory.
- DO NOT create multiple versions of the same file. Pick ONE target file and work with it.
- If a tool fails, try a DIFFERENT approach - don't retry the same approach multiple times.${guidelinesPrompt ? `\n\n${guidelinesPrompt}` : ''}`;
    }

    const systemPromptTokens = estimateTokens(this.systemPrompt);

    // Build message with knowledge context from previous steps
    let messageWithContext = message;
    const knowledgeSummary = this.fileOperationTracker.getKnowledgeSummary();
    if (knowledgeSummary) {
      messageWithContext = `${message}\n\nKNOWLEDGE FROM PREVIOUS STEPS (use this context):\n${knowledgeSummary}`;
    }

    // Add user message to conversation history
    this.conversationHistory.push({
      role: 'user',
      content: messageWithContext,
    });

    let messages = this.conversationHistory;
    let continueLoop = true;
    let iterationCount = 0;
    let emptyResponseCount = 0;
    let hasProvidedTextResponse = false;  // Track if agent has given a text answer
    let hadToolCalls = false;  // Track if any tool calls were made
    const maxIterations = 5;  // Reduced from 10 to prevent excessive iterations
    const maxEmptyResponses = 3;

    try {
      // For follow-up messages, reset taskCompleted flag to allow processing
      // The user explicitly sent a message, so we should handle it
      if (this.taskCompleted) {
        console.log(`[TaskExecutor] Processing follow-up message after task completion`);
        this.taskCompleted = false;  // Allow this follow-up to be processed
      }

      while (continueLoop && iterationCount < maxIterations) {
        // Only check cancelled - taskCompleted should not block follow-ups
        if (this.cancelled) {
          console.log(`[TaskExecutor] sendMessage loop terminated: cancelled=${this.cancelled}`);
          break;
        }

        iterationCount++;

        // Check for too many empty responses
        if (emptyResponseCount >= maxEmptyResponses) {
          break;
        }

        // Check guardrail budgets before each LLM call
        this.checkBudgets();

        // Compact messages if context is getting too large
        messages = this.contextManager.compactMessages(messages, systemPromptTokens);

        // Use retry wrapper for resilient API calls
        const response = await this.callLLMWithRetry(
          () => withTimeout(
            this.provider.createMessage({
              model: this.modelId,
              maxTokens: 4096,
              system: this.systemPrompt,
              tools: this.getAvailableTools(),
              messages,
              signal: this.abortController.signal,
            }),
            LLM_TIMEOUT_MS,
            'LLM message processing'
          ),
          `Message processing (iteration ${iterationCount})`
        );

        // Update tracking after response
        if (response.usage) {
          this.updateTracking(response.usage.inputTokens, response.usage.outputTokens);
        }

        // Process response - don't immediately stop, check for text response first
        let wantsToEnd = response.stopReason === 'end_turn';

        // Log any text responses from the assistant and check if asking a question
        let assistantAskedQuestion = false;
        let hasTextInThisResponse = false;
        if (response.content) {
          for (const content of response.content) {
            if (content.type === 'text' && content.text && content.text.trim().length > 0) {
              hasTextInThisResponse = true;
              hasProvidedTextResponse = true;  // Track that we got a meaningful text response
              this.daemon.logEvent(this.task.id, 'assistant_message', {
                message: content.text,
              });

              // Check if the assistant is asking a question (waiting for user input)
              if (isAskingQuestion(content.text)) {
                assistantAskedQuestion = true;
              }
            }
          }
        }

        // Add assistant response to conversation (ensure content is not empty)
        if (response.content && response.content.length > 0) {
          messages.push({
            role: 'assistant',
            content: response.content,
          });
          // Reset empty response counter on valid response
          emptyResponseCount = 0;
        } else {
          // Bedrock API requires non-empty content, add placeholder
          emptyResponseCount++;
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'I understand. Let me continue.' }],
          });
        }

        // Handle tool calls
        const toolResults: LLMToolResult[] = [];
        let hasDisabledToolAttempt = false;
        let hasDuplicateToolAttempt = false;

        for (const content of response.content || []) {
          if (content.type === 'tool_use') {
            // Check if this tool is disabled (circuit breaker tripped)
            if (this.toolFailureTracker.isDisabled(content.name)) {
              const lastError = this.toolFailureTracker.getLastError(content.name);
              console.log(`[TaskExecutor] Skipping disabled tool: ${content.name}`);
              this.daemon.logEvent(this.task.id, 'tool_error', {
                tool: content.name,
                error: `Tool disabled due to repeated failures: ${lastError}`,
                skipped: true,
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: JSON.stringify({
                  error: `Tool "${content.name}" is temporarily unavailable due to: ${lastError}. Please try a different approach or wait and try again later.`,
                  disabled: true,
                }),
                is_error: true,
              });
              hasDisabledToolAttempt = true;
              continue;
            }

            // Check for duplicate tool calls (prevents stuck loops)
            const duplicateCheck = this.toolCallDeduplicator.checkDuplicate(content.name, content.input);
            if (duplicateCheck.isDuplicate) {
              console.log(`[TaskExecutor] Blocking duplicate tool call: ${content.name}`);
              this.daemon.logEvent(this.task.id, 'tool_blocked', {
                tool: content.name,
                reason: 'duplicate_call',
                message: duplicateCheck.reason,
              });

              if (duplicateCheck.cachedResult && ToolCallDeduplicator.isIdempotentTool(content.name)) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: content.id,
                  content: duplicateCheck.cachedResult,
                });
              } else {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: content.id,
                  content: JSON.stringify({
                    error: duplicateCheck.reason,
                    suggestion: 'This tool was already called with these exact parameters. Please proceed or try a different approach.',
                    duplicate: true,
                  }),
                  is_error: true,
                });
                hasDuplicateToolAttempt = true;
              }
              continue;
            }

            // Check for cancellation or completion before executing tool
            if (this.cancelled || this.taskCompleted) {
              console.log(`[TaskExecutor] Stopping tool execution: cancelled=${this.cancelled}, completed=${this.taskCompleted}`);
              break;
            }

            // Check for redundant file operations
            const fileOpCheck = this.checkFileOperation(content.name, content.input);
            if (fileOpCheck.blocked) {
              console.log(`[TaskExecutor] Blocking redundant file operation: ${content.name}`);
              this.daemon.logEvent(this.task.id, 'tool_blocked', {
                tool: content.name,
                reason: 'redundant_file_operation',
                message: fileOpCheck.reason,
              });

              // If we have a cached result (e.g., for directory listings), return it instead of an error
              if (fileOpCheck.cachedResult) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: content.id,
                  content: fileOpCheck.cachedResult,
                  is_error: false,
                });
              } else {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: content.id,
                  content: JSON.stringify({
                    error: fileOpCheck.reason,
                    suggestion: fileOpCheck.suggestion,
                    blocked: true,
                  }),
                  is_error: true,
                });
              }
              continue;
            }

            // Infer missing parameters for weaker models
            const inference = this.inferMissingParameters(content.name, content.input);
            if (inference.modified) {
              content.input = inference.input;
              this.daemon.logEvent(this.task.id, 'parameter_inference', {
                tool: content.name,
                inference: inference.inference,
              });
            }

            this.daemon.logEvent(this.task.id, 'tool_call', {
              tool: content.name,
              input: content.input,
            });

            try {
              // Execute tool with timeout to prevent hanging
              const result = await withTimeout(
                this.toolRegistry.executeTool(
                  content.name,
                  content.input as any
                ),
                TOOL_TIMEOUT_MS,
                `Tool ${content.name}`
              );

              // Tool succeeded - reset failure counter
              this.toolFailureTracker.recordSuccess(content.name);

              // Record this call for deduplication
              const resultStr = JSON.stringify(result);
              this.toolCallDeduplicator.recordCall(content.name, content.input, resultStr);

              // Record file operation for tracking
              this.recordFileOperation(content.name, content.input, result);

              // Check if the result indicates an error (some tools return error in result)
              if (result && result.success === false && result.error) {
                // Check if this is a non-retryable error
                const shouldDisable = this.toolFailureTracker.recordFailure(content.name, result.error);
                if (shouldDisable) {
                  this.daemon.logEvent(this.task.id, 'tool_error', {
                    tool: content.name,
                    error: result.error,
                    disabled: true,
                  });
                }
              }

              const truncatedResult = truncateToolResult(resultStr);

              this.daemon.logEvent(this.task.id, 'tool_result', {
                tool: content.name,
                result: result,
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: truncatedResult,
              });
            } catch (error: any) {
              console.error(`Tool execution failed:`, error);

              // Track the failure
              const shouldDisable = this.toolFailureTracker.recordFailure(content.name, error.message);

              this.daemon.logEvent(this.task.id, 'tool_error', {
                tool: content.name,
                error: error.message,
                disabled: shouldDisable,
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: JSON.stringify({
                  error: error.message,
                  ...(shouldDisable ? { disabled: true, message: 'Tool has been disabled due to repeated failures.' } : {}),
                }),
                is_error: true,
              });
            }
          }
        }

        if (toolResults.length > 0) {
          hadToolCalls = true;  // Track that tools were used
          messages.push({
            role: 'user',
            content: toolResults,
          });

          // If all tool attempts were for disabled or duplicate tools, don't continue looping
          const allToolsFailed = toolResults.every(r => r.is_error);
          if ((hasDisabledToolAttempt || hasDuplicateToolAttempt) && allToolsFailed) {
            console.log('[TaskExecutor] All tool calls failed, were disabled, or duplicates - stopping iteration');
            continueLoop = false;
          } else {
            continueLoop = true;
          }
        }

        // Check if agent wants to end but hasn't provided a text response yet
        // If tools were called but no summary was given, request one
        if (wantsToEnd && !hasTextInThisResponse && hadToolCalls && !hasProvidedTextResponse) {
          console.log('[TaskExecutor] Agent ending without text response after tool calls - requesting summary');
          messages.push({
            role: 'user',
            content: [{
              type: 'text',
              text: 'You used tools but did not provide a summary of your findings. Please summarize what you found or explain if you could not find the information.'
            }],
          });
          continueLoop = true;  // Force another iteration to get the summary
          wantsToEnd = false;
        }

        // Only end the loop if the agent wants to AND has provided a response
        if (wantsToEnd && (hasProvidedTextResponse || !hadToolCalls)) {
          continueLoop = false;
        }
      }

      // Save updated conversation history
      this.conversationHistory = messages;
      this.daemon.updateTaskStatus(this.task.id, 'completed');
      // Emit follow_up_completed event to signal the follow-up is done
      this.daemon.logEvent(this.task.id, 'follow_up_completed', {
        message: 'Follow-up message processed',
      });
    } catch (error: any) {
      // Don't log cancellation as an error - it's intentional
      const isCancellation = this.cancelled ||
        error.message === 'Request cancelled' ||
        error.name === 'AbortError' ||
        error.message?.includes('aborted');

      if (isCancellation) {
        console.log(`[TaskExecutor] sendMessage cancelled - not logging as error`);
        return;
      }

      console.error('sendMessage failed:', error);
      this.daemon.logEvent(this.task.id, 'error', {
        message: error.message,
      });
      this.daemon.updateTaskStatus(this.task.id, 'failed');
      // Emit follow_up_failed event for the gateway
      this.daemon.logEvent(this.task.id, 'follow_up_failed', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Cancel execution
   */
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.taskCompleted = true;  // Also mark as completed to prevent any further processing

    // Abort any in-flight LLM requests immediately
    this.abortController.abort();

    // Create a new controller for any future requests (in case of resume)
    this.abortController = new AbortController();

    this.sandboxRunner.cleanup();
  }

  /**
   * Pause execution
   */
  async pause(): Promise<void> {
    this.paused = true;
  }

  /**
   * Resume execution
   */
  async resume(): Promise<void> {
    this.paused = false;
  }
}
