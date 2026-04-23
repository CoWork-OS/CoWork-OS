import type { LLMMessage, LLMToolResult } from "./llm";

export interface ToolLoopCall {
  tool: string;
  target: string;
  baseTarget?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${key}:${stableStringify(obj[key])}`).join(",")}}`;
}

function isPackagingRelatedToolCall(toolName: string, input: unknown): boolean {
  const normalizedToolName = String(toolName || "").trim().toLowerCase();
  if (
    /^(create_document|generate_document|compile_latex|generate_epub|nano-pdf|nano_pdf)$/i.test(
      normalizedToolName,
    )
  ) {
    return true;
  }
  if (!/^(run_command|execute_code|bash)$/i.test(normalizedToolName)) {
    return false;
  }
  const serializedInput = stableStringify(input).toLowerCase();
  return /\b(pdf|epub|docx|ebook|manuscript|cover|fpdf|pdfkit|pandoc)\b/.test(serializedInput);
}

function extractPackagingTarget(input: unknown): string {
  if (!input || typeof input !== "object") {
    return stableStringify(input).slice(0, 400);
  }
  const obj = input as Record<string, unknown>;
  const prioritizedKeys = [
    "filename",
    "path",
    "outputPath",
    "output_path",
    "file",
    "format",
    "command",
    "cmd",
    "script",
  ];
  const parts: string[] = [];
  for (const key of prioritizedKeys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      parts.push(`${key}:${value.trim()}`);
    }
  }
  if (parts.length === 0) {
    return stableStringify(input).slice(0, 400);
  }
  return parts.join("|").slice(0, 400);
}

function normalizePackagingFailureMessage(message: string): string {
  return String(message || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\b\d+(?:\.\d+)?s\b/g, "<duration>")
    .replace(/\bcall_[a-z0-9]+\b/g, "<call>")
    .replace(/\bpid[:=]?\d+\b/g, "pid:<id>")
    .trim()
    .slice(0, 400);
}

export function recordPackagingFailureFingerprint(opts: {
  toolName: string;
  input: unknown;
  error: string;
  counts: Map<string, number>;
  threshold?: number;
}): { isPackagingFailure: boolean; fingerprint?: string; count: number; thresholdReached: boolean } {
  if (!isPackagingRelatedToolCall(opts.toolName, opts.input)) {
    return { isPackagingFailure: false, count: 0, thresholdReached: false };
  }

  const fingerprint = [
    String(opts.toolName || "").trim().toLowerCase(),
    extractPackagingTarget(opts.input),
    normalizePackagingFailureMessage(opts.error),
  ].join("::");
  const count = (opts.counts.get(fingerprint) || 0) + 1;
  opts.counts.set(fingerprint, count);
  const threshold = opts.threshold ?? 2;
  return {
    isPackagingFailure: true,
    fingerprint,
    count,
    thresholdReached: count >= threshold,
  };
}

export function appendRecoveryAssistantMessage(
  messages: LLMMessage[],
  response: Any,
  allowPlaceholder = true,
): void {
  const textBlocks = (response.content || []).filter((c: Any) => c.type === "text");
  if (textBlocks.length > 0) {
    messages.push({ role: "assistant", content: textBlocks });
    return;
  }

  if (!allowPlaceholder) return;

  messages.push({
    role: "assistant",
    content: [{ type: "text", text: "I understand. Let me continue." }],
  });
}

export function appendMaxTokensRecoveryUserMessage(messages: LLMMessage[]): void {
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text:
          "Your response was cut off because it exceeded the output token limit. " +
          "You MUST reduce the size of your next response. Strategies:\n" +
          "1. If writing a file, split the content across MULTIPLE write_file calls " +
          "(e.g., write the first half now, then the second half in the next turn).\n" +
          "2. Reduce parallel tool calls to only what is necessary (use serial calls when output pressure is high).\n" +
          "3. Write shorter, more concise content.\n" +
          "Continue from where you left off.",
      },
    ],
  });
}

export function handleMaxTokensRecovery(opts: {
  response: Any;
  messages: LLMMessage[];
  recoveryCount: number;
  maxRecoveries: number;
  remainingTurns?: number;
  minTurnsRequiredForRetry?: number;
  allowRetry?: boolean;
  logPrefix?: string;
  eventPayload?: Record<string, unknown>;
  log: (message: string) => void;
  emitMaxTokensRecovery: (payload: Record<string, unknown>) => void;
}): { action: "none" | "retry" | "exhausted"; recoveryCount: number } {
  if (opts.response.stopReason !== "max_tokens") {
    return { action: "none", recoveryCount: 0 };
  }

  const nextRecoveryCount = opts.recoveryCount + 1;
  const prefix = opts.logPrefix || "";
  const messagePrefix = prefix ? `${prefix} ` : "";

  opts.log(
    `${messagePrefix}max_tokens hit (recovery ${nextRecoveryCount}/${opts.maxRecoveries}), ` +
      "stripping truncated tool calls",
  );

  opts.emitMaxTokensRecovery({
    attempt: nextRecoveryCount,
    maxAttempts: opts.maxRecoveries,
    ...opts.eventPayload,
  });

  if (nextRecoveryCount > opts.maxRecoveries) {
    opts.log(`${messagePrefix}max_tokens recovery exhausted after ${opts.maxRecoveries} attempts`);
    appendRecoveryAssistantMessage(opts.messages, opts.response, false);
    return { action: "exhausted", recoveryCount: nextRecoveryCount };
  }

  const minTurnsRequiredForRetry = opts.minTurnsRequiredForRetry ?? 1;
  const remainingTurns =
    typeof opts.remainingTurns === "number" && Number.isFinite(opts.remainingTurns)
      ? opts.remainingTurns
      : Number.POSITIVE_INFINITY;
  if (opts.allowRetry === false) {
    opts.log(`${messagePrefix}max_tokens retry skipped: adaptive continuation disabled`);
    appendRecoveryAssistantMessage(opts.messages, opts.response, false);
    return { action: "exhausted", recoveryCount: nextRecoveryCount };
  }
  if (remainingTurns <= minTurnsRequiredForRetry) {
    opts.log(
      `${messagePrefix}max_tokens retry skipped: only ${remainingTurns} turn(s) remaining ` +
        `(need > ${minTurnsRequiredForRetry})`,
    );
    appendRecoveryAssistantMessage(opts.messages, opts.response, false);
    return { action: "exhausted", recoveryCount: nextRecoveryCount };
  }

  appendRecoveryAssistantMessage(opts.messages, opts.response);
  appendMaxTokensRecoveryUserMessage(opts.messages);
  return { action: "retry", recoveryCount: nextRecoveryCount };
}

export function appendAssistantResponseToConversation(
  messages: LLMMessage[],
  response: Any,
  emptyResponseCount: number,
): number {
  if (response.content && response.content.length > 0) {
    messages.push({
      role: "assistant",
      content: response.content,
    });
    return 0;
  }

  messages.push({
    role: "assistant",
    content: [{ type: "text", text: "I understand. Let me continue." }],
  });
  return emptyResponseCount + 1;
}

export function shouldRetryEmptyFollowUpEndTurn(opts: {
  wantsToEnd: boolean;
  hasTextInThisResponse: boolean;
  hasProvidedTextResponse: boolean;
  hadToolCalls: boolean;
}): boolean {
  return (
    opts.wantsToEnd &&
    !opts.hasTextInThisResponse &&
    !opts.hasProvidedTextResponse &&
    !opts.hadToolCalls
  );
}

export function computeToolFailureDecision(opts: {
  toolResults: LLMToolResult[];
  hasDisabledToolAttempt: boolean;
  hasDuplicateToolAttempt: boolean;
  hasUnavailableToolAttempt: boolean;
  hasHardToolFailureAttempt: boolean;
  toolRecoveryHintInjected: boolean;
  iterationCount: number;
  maxIterations: number;
  allowRecoveryHint: boolean;
}): {
  allToolsFailed: boolean;
  shouldStopFromFailures: boolean;
  shouldStopFromHardFailure: boolean;
  shouldInjectRecoveryHint: boolean;
} {
  const hasRecoverableUnavailableAlternative =
    opts.hasUnavailableToolAttempt &&
    opts.toolResults.some((result) => {
      if (!result?.is_error || typeof result.content !== "string") return false;
      try {
        const parsed = JSON.parse(result.content);
        return (
          parsed?.unavailable === true &&
          Array.isArray(parsed?.alternatives) &&
          parsed.alternatives.length > 0
        );
      } catch {
        return false;
      }
    });
  const allToolsFailed = opts.toolResults.every((r) => r.is_error);
  const duplicateOnlyFailure =
    opts.hasDuplicateToolAttempt &&
    !opts.hasDisabledToolAttempt &&
    !opts.hasUnavailableToolAttempt &&
    !opts.hasHardToolFailureAttempt;
  const shouldStopFromFailures =
    allToolsFailed &&
    !hasRecoverableUnavailableAlternative &&
    (opts.hasDisabledToolAttempt ||
      opts.hasUnavailableToolAttempt ||
      opts.hasHardToolFailureAttempt ||
      (opts.hasDuplicateToolAttempt && !duplicateOnlyFailure));
  const shouldStopFromHardFailure = opts.hasHardToolFailureAttempt && allToolsFailed;
  const onlyHardFailures =
    opts.hasHardToolFailureAttempt &&
    !opts.hasDisabledToolAttempt &&
    !opts.hasDuplicateToolAttempt &&
    !opts.hasUnavailableToolAttempt;
  const shouldInjectRecoveryHint =
    allToolsFailed &&
    opts.allowRecoveryHint &&
    !opts.toolRecoveryHintInjected &&
    opts.iterationCount < opts.maxIterations &&
    (hasRecoverableUnavailableAlternative ||
      opts.hasDisabledToolAttempt ||
      opts.hasDuplicateToolAttempt ||
      opts.hasUnavailableToolAttempt ||
      (opts.hasHardToolFailureAttempt && !onlyHardFailures));

  return {
    allToolsFailed,
    shouldStopFromFailures,
    shouldStopFromHardFailure,
    shouldInjectRecoveryHint,
  };
}

export function injectToolRecoveryHint(opts: {
  messages: LLMMessage[];
  toolResults: LLMToolResult[];
  hasDisabledToolAttempt: boolean;
  hasDuplicateToolAttempt: boolean;
  hasUnavailableToolAttempt: boolean;
  hasHardToolFailureAttempt: boolean;
  eventPayload?: Record<string, unknown>;
  extractErrorSummaries: (toolResults: LLMToolResult[]) => string[];
  buildRecoveryInstruction: (opts: {
    disabled: boolean;
    duplicate: boolean;
    unavailable: boolean;
    hardFailure: boolean;
    errors: string[];
  }) => string;
  emitToolRecoveryPrompted: (payload: Record<string, unknown>) => void;
}): void {
  const errorSummaries = opts.extractErrorSummaries(opts.toolResults);
  const recoveryInstruction = opts.buildRecoveryInstruction({
    disabled: opts.hasDisabledToolAttempt,
    duplicate: opts.hasDuplicateToolAttempt,
    unavailable: opts.hasUnavailableToolAttempt,
    hardFailure: opts.hasHardToolFailureAttempt,
    errors: errorSummaries,
  });

  opts.emitToolRecoveryPrompted({
    disabled: opts.hasDisabledToolAttempt,
    duplicate: opts.hasDuplicateToolAttempt,
    unavailable: opts.hasUnavailableToolAttempt,
    hardFailure: opts.hasHardToolFailureAttempt,
    ...opts.eventPayload,
  });

  opts.messages.push({
    role: "user",
    content: [{ type: "text", text: recoveryInstruction }],
  });
}

export function maybeInjectToolLoopBreak(opts: {
  responseContent: Any[] | undefined;
  recentToolCalls: ToolLoopCall[];
  messages: LLMMessage[];
  loopBreakInjected: boolean;
  mutationRequired?: boolean;
  mutationSatisfied?: boolean;
  requiredActionText?: string;
  sanitizeMessageText?: (text: string) => string;
  detectToolLoop: (
    recentToolCalls: ToolLoopCall[],
    toolName: string,
    input: Any,
    threshold?: number,
  ) => boolean;
  log: (message: string) => void;
}): boolean {
  if (opts.loopBreakInjected) return true;

  for (const content of opts.responseContent || []) {
    if (content.type !== "tool_use") continue;
    const isLoop = opts.detectToolLoop(opts.recentToolCalls, content.name, content.input, 5);
    if (!isLoop) continue;

    opts.log(
      `  │ ⚠ Loop detected: ${content.name} called ${5}+ times on same target — injecting break message`,
    );
    const messageText =
      opts.mutationRequired && !opts.mutationSatisfied
        ? opts.requiredActionText ||
          "You are stuck retrying the same target. Switch approach and perform the required write/canvas mutation now."
        : "You are stuck in a loop calling the same tool repeatedly on the same target without making progress. " +
          "STOP using this tool and respond directly with what you have found so far. " +
          "If you need different information, try a completely different approach or tool.";
    opts.messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: opts.sanitizeMessageText ? opts.sanitizeMessageText(messageText) : messageText,
        },
      ],
    });
    return true;
  }

  return false;
}

export function maybeInjectLowProgressNudge(opts: {
  recentToolCalls: ToolLoopCall[];
  messages: LLMMessage[];
  lowProgressNudgeInjected: boolean;
  phaseLabel: "step" | "follow-up";
  mutationRequired?: boolean;
  mutationSatisfied?: boolean;
  requiredActionText?: string;
  sanitizeMessageText?: (text: string) => string;
  windowSize?: number;
  minCallsOnSameTarget?: number;
  log: (message: string) => void;
  emitLowProgressEvent?: (payload: {
    target: string;
    callCount: number;
    windowSize: number;
    phase: "step" | "follow-up";
    escalated?: boolean;
  }) => void;
}): boolean {
  const windowSize = opts.windowSize ?? 8;
  const minCallsOnSameTarget = opts.minCallsOnSameTarget ?? 6;
  if (opts.recentToolCalls.length < windowSize) return false;

  const recent = opts.recentToolCalls.slice(-windowSize);
  const byTarget = new Map<
    string,
    { count: number; tools: Set<string>; signatures: Set<string>; rawTarget: string }
  >();

  for (const call of recent) {
    const targetKey = (call.baseTarget || call.target || "").trim();
    if (!targetKey) continue;

    const bucket = byTarget.get(targetKey) ?? {
      count: 0,
      tools: new Set<string>(),
      signatures: new Set<string>(),
      rawTarget: call.baseTarget || call.target,
    };
    bucket.count += 1;
    bucket.tools.add(call.tool);
    bucket.signatures.add(call.target);
    byTarget.set(targetKey, bucket);
  }

  let topTarget = "";
  let topCount = 0;
  let topTools = 0;
  let topSignatures = 0;

  for (const [target, bucket] of byTarget) {
    if (bucket.count > topCount) {
      topTarget = target;
      topCount = bucket.count;
      topTools = bucket.tools.size;
      topSignatures = bucket.signatures.size;
    }
  }

  const detected =
    topCount >= minCallsOnSameTarget &&
    // Mixed-tool probing on the same target is a common low-progress churn pattern.
    topTools >= 2 &&
    topSignatures >= 3;

  if (!detected) return false;

  const escalationTag = "[LOW_PROGRESS_ESCALATION]";
  const escalationAlreadyInjected = opts.messages.some((message) => {
    if (!Array.isArray(message.content)) return false;
    return message.content.some(
      (block: Any) =>
        block?.type === "text" &&
        typeof block?.text === "string" &&
        block.text.includes(escalationTag),
    );
  });

  if (opts.lowProgressNudgeInjected) {
    if (escalationAlreadyInjected) return true;

    opts.log(
      `  │ ⚠ Low-progress loop persists: ${topCount}/${windowSize} recent calls target "${topTarget}"`,
    );
    opts.emitLowProgressEvent?.({
      target: topTarget,
      callCount: topCount,
      windowSize,
      phase: opts.phaseLabel,
      escalated: true,
    });
    opts.messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: (() => {
            if (opts.mutationRequired && !opts.mutationSatisfied) {
              const message =
                `${escalationTag}\n` +
                `Low-progress looping is still occurring on "${topTarget}". ` +
                (opts.requiredActionText ||
                  "This step cannot complete with text-only output. Perform the required write/canvas mutation now.");
              return opts.sanitizeMessageText ? opts.sanitizeMessageText(message) : message;
            }
            const message =
              `${escalationTag}\n` +
              `Low-progress looping is still occurring on "${topTarget}". ` +
              "This is your final warning: stop all additional probing and provide the best final answer now, with a blocker list for anything still unknown.";
            return opts.sanitizeMessageText ? opts.sanitizeMessageText(message) : message;
          })(),
        },
      ],
    });
    return true;
  }

  opts.log(
    `  │ ⚠ Low-progress loop: ${topCount}/${windowSize} recent calls target "${topTarget}" ` +
      `across ${topTools} tool categories`,
  );
  opts.emitLowProgressEvent?.({
    target: topTarget,
    callCount: topCount,
    windowSize,
    phase: opts.phaseLabel,
  });
  opts.messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: (() => {
          const message =
          opts.mutationRequired && !opts.mutationSatisfied
            ? opts.requiredActionText ||
              `You are repeatedly probing the same target ("${topTarget}") without meaningful progress. ` +
                "Stop probing and perform the required write/canvas mutation now."
            : `You are repeatedly probing the same target ("${topTarget}") without meaningful progress. ` +
              "Stop additional probing now. Synthesize the best answer from current evidence, and explicitly list any missing data as blockers.";
          return opts.sanitizeMessageText ? opts.sanitizeMessageText(message) : message;
        })(),
      },
    ],
  });
  return true;
}

export function maybeInjectStopReasonNudge(opts: {
  stopReason: string | undefined;
  consecutiveToolUseStops: number;
  consecutiveMaxTokenStops: number;
  remainingTurns: number;
  messages: LLMMessage[];
  phaseLabel: "step" | "follow-up";
  stopReasonNudgeInjected: boolean;
  suppressToolUseStopNudge?: boolean;
  requiredToolNames?: string[];
  sanitizeMessageText?: (text: string) => string;
  minToolUseStreak?: number;
  minMaxTokenStreak?: number;
  log: (message: string) => void;
  emitStopReasonEvent?: (payload: {
    phase: "step" | "follow-up";
    stopReason: string;
    consecutiveCount: number;
    remainingTurns: number;
  }) => void;
}): boolean {
  if (opts.stopReasonNudgeInjected) return true;

  const stopReason = String(opts.stopReason || "");
  if (!stopReason) return false;

  const minToolUseStreak = opts.minToolUseStreak ?? 6;
  const minMaxTokenStreak = opts.minMaxTokenStreak ?? 2;
  const toolUseStreakTriggered =
    stopReason === "tool_use" &&
    (opts.consecutiveToolUseStops >= minToolUseStreak || opts.remainingTurns <= 1);
  const maxTokenStreakTriggered =
    stopReason === "max_tokens" && opts.consecutiveMaxTokenStops >= minMaxTokenStreak;
  if (!toolUseStreakTriggered && !maxTokenStreakTriggered) {
    return false;
  }

  const consecutiveCount =
    stopReason === "tool_use" ? opts.consecutiveToolUseStops : opts.consecutiveMaxTokenStops;
  opts.log(
    `  │ ⚠ Stop-reason nudge (${opts.phaseLabel}): ${stopReason} x${consecutiveCount}, ` +
      `remainingTurns=${opts.remainingTurns}`,
  );
  opts.emitStopReasonEvent?.({
    phase: opts.phaseLabel,
    stopReason,
    consecutiveCount,
    remainingTurns: opts.remainingTurns,
  });

  if (stopReason === "tool_use") {
    if (opts.suppressToolUseStopNudge) {
      const requiredTools =
        Array.isArray(opts.requiredToolNames) && opts.requiredToolNames.length > 0
          ? opts.requiredToolNames.map((name) => `"${name}"`).join(", ")
          : "required write/mutation tool(s)";
      opts.messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: (() => {
              const message =
              "This step requires an artifact mutation and it has not happened yet. " +
              `Do not stop tool calls yet. Perform ${requiredTools} now, then continue.`;
              return opts.sanitizeMessageText ? opts.sanitizeMessageText(message) : message;
            })(),
          },
        ],
      });
      return true;
    }

    opts.messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: (() => {
            const message =
            "You have been in repeated tool-use turns. Stop calling tools unless absolutely required for correctness. " +
            "Produce a concise, direct answer from gathered evidence, and list unresolved gaps explicitly.";
            return opts.sanitizeMessageText ? opts.sanitizeMessageText(message) : message;
          })(),
        },
      ],
    });
    return true;
  }

  opts.messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: (() => {
          const message =
            "Your recent responses keep hitting output limits. Keep the next response compact: no long dumps, no repeated context, and only the essential final result.";
          return opts.sanitizeMessageText ? opts.sanitizeMessageText(message) : message;
        })(),
      },
    ],
  });
  return true;
}

export function shouldLockFollowUpToolCalls(opts: {
  stopReason: string | undefined;
  consecutiveToolUseStops: number;
  followUpToolCallCount: number;
  stopReasonNudgeInjected: boolean;
  repeatedPackagingFailureCount?: number;
  repeatedPackagingFailureThreshold?: number;
  remainingTurns?: number;
  immediateTurnBudgetThreshold?: number;
  allowImmediateTurnBudgetLock?: boolean;
  minStreak?: number;
  minToolCalls?: number;
}): boolean {
  const minStreak = opts.minStreak ?? 10;
  const minToolCalls = opts.minToolCalls ?? 10;
  const immediateTurnBudgetThreshold = opts.immediateTurnBudgetThreshold ?? 2;
  const allowImmediateTurnBudgetLock = opts.allowImmediateTurnBudgetLock ?? true;
  const repeatedPackagingFailureThreshold = opts.repeatedPackagingFailureThreshold ?? 2;
  const forceByTurnBudget =
    allowImmediateTurnBudgetLock &&
    opts.stopReason === "tool_use" &&
    typeof opts.remainingTurns === "number" &&
    opts.remainingTurns <= immediateTurnBudgetThreshold &&
    opts.followUpToolCallCount > 0;
  if (forceByTurnBudget) return true;
  if (
    opts.stopReason === "tool_use" &&
    (opts.repeatedPackagingFailureCount || 0) >= repeatedPackagingFailureThreshold
  ) {
    return true;
  }
  return (
    opts.stopReason === "tool_use" &&
    opts.stopReasonNudgeInjected &&
    opts.consecutiveToolUseStops >= minStreak &&
    opts.followUpToolCallCount >= minToolCalls
  );
}

export function updateSkippedToolOnlyTurnStreak(opts: {
  skippedToolCalls: number;
  hasTextInThisResponse: boolean;
  previousStreak: number;
}): number {
  if (opts.skippedToolCalls <= 0 || opts.hasTextInThisResponse) {
    return 0;
  }
  return opts.previousStreak + 1;
}

export function shouldForceStopAfterSkippedToolOnlyTurns(
  skippedToolOnlyTurnStreak: number,
  threshold = 2,
): boolean {
  return skippedToolOnlyTurnStreak >= threshold;
}

export function maybeInjectVariedFailureNudge(opts: {
  persistentToolFailures: Map<string, number>;
  variedFailureNudgeInjected: boolean;
  threshold: number;
  messages: LLMMessage[];
  phaseLabel: "step" | "follow-up";
  emitVariedFailureEvent: (tool: string, failureCount: number) => void;
  log: (message: string) => void;
}): boolean {
  if (opts.variedFailureNudgeInjected) return true;

  for (const [failedToolName, failCount] of opts.persistentToolFailures) {
    if (failCount < opts.threshold) continue;

    opts.log(
      `  │ ⚠ Varied failure loop: ${failedToolName} failed ${failCount} times this ${opts.phaseLabel} — injecting nudge`,
    );
    opts.emitVariedFailureEvent(failedToolName, failCount);

    opts.messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            `IMPORTANT: The tool "${failedToolName}" has now failed ${failCount} times during this ${opts.phaseLabel}, each time with different inputs. ` +
            "You are stuck in a retry loop with variations that are not working. " +
            `STOP retrying "${failedToolName}" for this goal. Instead:\n` +
            "1) Accept that this specific approach is not working in the current environment.\n" +
            "2) Try a FUNDAMENTALLY different approach (different tool, different strategy, or skip this sub-goal).\n" +
            "3) If no alternative exists, report the blocker to the user and move on to the next part of the task.",
        },
      ],
    });
    return true;
  }

  return false;
}
