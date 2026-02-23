import type { LLMMessage, LLMToolResult } from "./llm";

export function appendRecoveryAssistantMessage(
  messages: LLMMessage[],
  response: any,
  allowPlaceholder = true,
): void {
  const textBlocks = (response.content || []).filter((c: any) => c.type === "text");
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
          "2. Call only ONE tool at a time instead of multiple parallel calls.\n" +
          "3. Write shorter, more concise content.\n" +
          "Continue from where you left off.",
      },
    ],
  });
}

export function handleMaxTokensRecovery(opts: {
  response: any;
  messages: LLMMessage[];
  recoveryCount: number;
  maxRecoveries: number;
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
    ...(opts.eventPayload || {}),
  });

  if (nextRecoveryCount > opts.maxRecoveries) {
    opts.log(`${messagePrefix}max_tokens recovery exhausted after ${opts.maxRecoveries} attempts`);
    appendRecoveryAssistantMessage(opts.messages, opts.response, false);
    return { action: "exhausted", recoveryCount: nextRecoveryCount };
  }

  appendRecoveryAssistantMessage(opts.messages, opts.response);
  appendMaxTokensRecoveryUserMessage(opts.messages);
  return { action: "retry", recoveryCount: nextRecoveryCount };
}

export function appendAssistantResponseToConversation(
  messages: LLMMessage[],
  response: any,
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
  const allToolsFailed = opts.toolResults.every((r) => r.is_error);
  const shouldStopFromFailures =
    (opts.hasDisabledToolAttempt ||
      opts.hasDuplicateToolAttempt ||
      opts.hasUnavailableToolAttempt ||
      opts.hasHardToolFailureAttempt) &&
    allToolsFailed;
  const shouldStopFromHardFailure = opts.hasHardToolFailureAttempt && allToolsFailed;
  const duplicateOnlyFailure =
    opts.hasDuplicateToolAttempt &&
    !opts.hasDisabledToolAttempt &&
    !opts.hasUnavailableToolAttempt &&
    !opts.hasHardToolFailureAttempt;
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
    !duplicateOnlyFailure &&
    (opts.hasDisabledToolAttempt ||
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
    ...(opts.eventPayload || {}),
  });

  opts.messages.push({
    role: "user",
    content: [{ type: "text", text: recoveryInstruction }],
  });
}

export function maybeInjectToolLoopBreak(opts: {
  responseContent: any[] | undefined;
  recentToolCalls: Array<{ tool: string; target: string }>;
  messages: LLMMessage[];
  loopBreakInjected: boolean;
  detectToolLoop: (
    recentToolCalls: Array<{ tool: string; target: string }>,
    toolName: string,
    input: any,
    threshold?: number,
  ) => boolean;
  log: (message: string) => void;
}): boolean {
  if (opts.loopBreakInjected) return true;

  for (const content of opts.responseContent || []) {
    if (content.type !== "tool_use") continue;
    const isLoop = opts.detectToolLoop(opts.recentToolCalls, content.name, content.input, 3);
    if (!isLoop) continue;

    opts.log(
      `  │ ⚠ Loop detected: ${content.name} called ${3}+ times on same target — injecting break message`,
    );
    opts.messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            "You are stuck in a loop calling the same tool repeatedly on the same target without making progress. " +
            "STOP using this tool and respond directly with what you have found so far. " +
            "If you need different information, try a completely different approach or tool.",
        },
      ],
    });
    return true;
  }

  return false;
}

const FILE_WRITING_TOOLS = new Set([
  "write_file",
  "create_document",
  "copy_file",
  "create_spreadsheet",
  "create_presentation",
]);

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

    const isFileWritingTool = FILE_WRITING_TOOLS.has(failedToolName);
    const fileWritingFallback = isFileWritingTool
      ? "\n\nFILE WRITING FALLBACK: Output your deliverable content directly as text in your response. " +
        "The system automatically captures your text response as the task deliverable. " +
        "You do NOT need to successfully write a file."
      : "";

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
            "3) If no alternative exists, report the blocker to the user and move on to the next part of the task." +
            fileWritingFallback,
        },
      ],
    });
    return true;
  }

  return false;
}
