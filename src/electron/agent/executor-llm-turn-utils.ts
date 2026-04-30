import type { LLMMessage } from "./llm";
import {
  buildReasoningExhaustedGuidance,
  classifyOutputTruncation,
  inferOutputBudgetRequestKind,
  isAdaptiveOutputTokenPolicyEnabled,
  responseHasToolUse,
  resolveOutputTokenBudget,
  type OutputTruncationClassification,
} from "./llm/output-token-policy";

export interface QualityPassDraftResult {
  text: string;
  accepted: boolean;
}

export interface AdaptiveOutputBudgetState {
  mode: "legacy" | "adaptive";
  requestKind: "agentic_main" | "tool_followup" | "continuation";
  providerFamily: string;
  routedFamily: string | null;
  initialBudget: number;
  finalBudget: number;
  capSource: "task" | "env" | "policy";
  escalationAttempted: boolean;
  truncationClassification: OutputTruncationClassification | null;
  continuationAllowed: boolean;
  guidanceMessage?: string;
}

export async function requestLLMResponseWithAdaptiveBudget(opts: {
  messages: LLMMessage[];
  retryLabel: string;
  operation: string;
  llmTimeoutMs: number;
  providerType: string;
  modelId: string;
  systemPrompt: string;
  getTaskMaxTokens: () => number | null;
  getContextManager: () => Any;
  getAvailableTools: () => Any[];
  applyRetryTokenCap: (
    baseMaxTokens: number,
    attempt: number,
    timeoutMs: number,
    hasTools?: boolean,
  ) => number;
  getRetryTimeoutMs: (
    baseTimeoutMs: number,
    attempt: number,
    hasTools?: boolean,
    maxTokensBudget?: number,
  ) => number;
  callLLMWithRetry: (
    requestFn: (attempt: number) => Promise<Any>,
    operation: string,
  ) => Promise<Any>;
  createMessageWithTimeout: (
    request: {
      model: string;
      maxTokens: number;
      system: string;
      tools: Any[];
      messages: LLMMessage[];
      systemBlocks?: Any[];
      promptCache?: Any;
    },
    timeoutMs: number,
    operation: string,
  ) => Promise<Any>;
  buildPromptCacheRequestExtras?: (args: { systemPrompt: string; tools: Any[] }) => {
    systemBlocks?: Any[];
    promptCache?: Any;
  };
  updateTracking: (
    inputTokens: number,
    outputTokens: number,
    cachedTokens?: number,
    cacheWriteTokens?: number,
  ) => void;
  emitEvent?: (type: string, payload: Record<string, unknown>) => void;
  log: (message: string) => void;
}): Promise<{ response: Any; availableTools: Any[]; outputBudget: AdaptiveOutputBudgetState }> {
  const availableTools = opts.getAvailableTools();
  const promptCacheExtras = opts.buildPromptCacheRequestExtras
    ? opts.buildPromptCacheRequestExtras({
        systemPrompt: opts.systemPrompt,
        tools: availableTools,
      })
    : {};
  const requestKind = inferOutputBudgetRequestKind(opts.messages);
  const initialBudget = resolveOutputTokenBudget({
    providerType: opts.providerType,
    modelId: opts.modelId,
    messages: opts.messages,
    system: opts.systemPrompt,
    contextManager: opts.getContextManager(),
    taskMaxTokens: opts.getTaskMaxTokens(),
    requestKind,
    phase: "initial",
  });
  const adaptiveMode = isAdaptiveOutputTokenPolicyEnabled();
  const applyTokenCap = (
    budget: number,
    attempt: number,
    timeoutMs: number,
    hasTools = true,
  ): number =>
    adaptiveMode ? budget : opts.applyRetryTokenCap(budget, attempt, timeoutMs, hasTools);

  const recordUsage = (response: Any) => {
    if (!response?.usage) return;
    opts.updateTracking(
      response.usage.inputTokens,
      response.usage.outputTokens,
      response.usage.cachedTokens,
      response.usage.cacheWriteTokens,
    );
  };

  const issueRequest = async (
    budget: number,
    labelSuffix: string,
  ): Promise<{ response: Any; effectiveMaxTokens: number; requestTimeoutMs: number }> => {
    const retryLabel = labelSuffix ? `${opts.retryLabel} ${labelSuffix}` : opts.retryLabel;
    const response = await opts.callLLMWithRetry((attempt) => {
      const effectiveMaxTokens = applyTokenCap(budget, attempt, opts.llmTimeoutMs, true);
      const requestTimeoutMs = opts.getRetryTimeoutMs(
        opts.llmTimeoutMs,
        attempt,
        true,
        effectiveMaxTokens,
      );
      return opts.createMessageWithTimeout(
        {
          model: opts.modelId,
          maxTokens: effectiveMaxTokens,
          system: opts.systemPrompt,
          tools: availableTools,
          messages: opts.messages,
          ...promptCacheExtras,
        },
        requestTimeoutMs,
        labelSuffix ? `${opts.operation} ${labelSuffix}` : opts.operation,
      );
    }, retryLabel);

    const effectiveMaxTokens = applyTokenCap(budget, 0, opts.llmTimeoutMs, true);
    const requestTimeoutMs = opts.getRetryTimeoutMs(opts.llmTimeoutMs, 0, true, effectiveMaxTokens);
    return { response, effectiveMaxTokens, requestTimeoutMs };
  };

  const llmCallStart = Date.now();
  const effectiveMaxTokensLog = applyTokenCap(
    initialBudget.transport.value,
    0,
    opts.llmTimeoutMs,
    true,
  );
  const effectiveTimeoutLog = opts.getRetryTimeoutMs(
    opts.llmTimeoutMs,
    0,
    true,
    effectiveMaxTokensLog,
  );
  opts.log(
    `  │ LLM call start | family=${initialBudget.providerFamily}` +
      `${initialBudget.routedFamily ? `/${initialBudget.routedFamily}` : ""} | ` +
      `kind=${requestKind} | budget=${initialBudget.transport.value} | ` +
      `tokenParam=${initialBudget.transport.paramName} | ` +
      `effectiveMaxTokens=${effectiveMaxTokensLog} | capSource=${initialBudget.capSource} | ` +
      `timeout=${(effectiveTimeoutLog / 1000).toFixed(0)}s | tools=${availableTools.length} | msgCount=${opts.messages.length}`,
  );
  opts.emitEvent?.("llm_output_budget", {
    family: initialBudget.providerFamily,
    routedFamily: initialBudget.routedFamily,
    requestKind,
    chosenBudget: initialBudget.transport.value,
    effectiveMaxTokens: effectiveMaxTokensLog,
    capSource: initialBudget.capSource,
    contextLimit: initialBudget.contextLimit,
    knownHardCap: initialBudget.knownHardCap,
  });

  const firstAttempt = await issueRequest(initialBudget.transport.value, "");
  recordUsage(firstAttempt.response);

  let response = firstAttempt.response;
  let finalBudget = initialBudget.transport.value;
  let escalationAttempted = false;
  let truncationClassification: OutputTruncationClassification | null = null;
  let continuationAllowed = true;
  let guidanceMessage: string | undefined;

  if (adaptiveMode && response?.stopReason === "max_tokens") {
    truncationClassification = classifyOutputTruncation(response.content);
    const escalatedBudget = resolveOutputTokenBudget({
      providerType: opts.providerType,
      modelId: opts.modelId,
      messages: opts.messages,
      system: opts.systemPrompt,
      contextManager: opts.getContextManager(),
      taskMaxTokens: opts.getTaskMaxTokens(),
      requestKind,
      phase: "escalated",
    });
    if (escalatedBudget.transport.value > initialBudget.transport.value) {
      escalationAttempted = true;
      opts.log(
        `  │ Adaptive output escalation | from=${initialBudget.transport.value} to=${escalatedBudget.transport.value} | classification=${truncationClassification}`,
      );
      opts.emitEvent?.("llm_output_budget_escalation", {
        family: initialBudget.providerFamily,
        routedFamily: initialBudget.routedFamily,
        requestKind,
        fromBudget: initialBudget.transport.value,
        toBudget: escalatedBudget.transport.value,
        classification: truncationClassification,
      });
      const secondAttempt = await issueRequest(escalatedBudget.transport.value, "[adaptive-escalation]");
      recordUsage(secondAttempt.response);
      response = secondAttempt.response;
      finalBudget = escalatedBudget.transport.value;
      if (response?.stopReason === "max_tokens") {
        truncationClassification = classifyOutputTruncation(response.content);
        const hasToolUse = responseHasToolUse(response.content);
        continuationAllowed =
          truncationClassification === "visible_partial_output" && !hasToolUse;
        if (!continuationAllowed && truncationClassification === "reasoning_exhausted") {
          guidanceMessage = buildReasoningExhaustedGuidance();
        }
        opts.log(
          `  │ Adaptive output escalation incomplete | finalBudget=${finalBudget} | classification=${truncationClassification} | continuation=${continuationAllowed ? "allowed" : "skipped"}`,
        );
      }
    } else if (truncationClassification === "reasoning_exhausted") {
      continuationAllowed = false;
      guidanceMessage = buildReasoningExhaustedGuidance();
      opts.log(
        `  │ Adaptive output escalation unavailable | budget=${initialBudget.transport.value} | classification=${truncationClassification} | continuation=skipped`,
      );
    }
  }

  const llmCallDuration = ((Date.now() - llmCallStart) / 1000).toFixed(1);
  const toolUseBlocks = (response.content || []).filter((c: Any) => c.type === "tool_use");
  const textBlocksLog = (response.content || []).filter((c: Any) => c.type === "text");
  const textLen = textBlocksLog.reduce(
    (sum: number, block: Any) => sum + (block.text?.length || 0),
    0,
  );
  opts.log(
      `  │ LLM call done | duration=${llmCallDuration}s | stopReason=${response.stopReason} | ` +
      `toolUseBlocks=${toolUseBlocks.length} | textLen=${textLen} | ` +
      `inputTokens=${response.usage?.inputTokens ?? "?"} | outputTokens=${response.usage?.outputTokens ?? "?"} | cachedTokens=${response.usage?.cachedTokens ?? 0}`,
  );

  return {
    response,
    availableTools,
    outputBudget: {
      mode: initialBudget.mode,
      requestKind,
      providerFamily: initialBudget.providerFamily,
      routedFamily: initialBudget.routedFamily,
      initialBudget: initialBudget.transport.value,
      finalBudget,
      capSource: initialBudget.capSource,
      escalationAttempted,
      truncationClassification,
      continuationAllowed,
      ...(guidanceMessage ? { guidanceMessage } : {}),
    },
  };
}

export async function maybeApplyQualityPasses(opts: {
  response: Any;
  enabled: boolean;
  contextLabel: string;
  userIntent: string;
  getQualityPassCount: () => number;
  extractTextFromLLMContent: (content: Any) => string;
  applyQualityPassesToDraft: (args: {
    passes: 2 | 3;
    contextLabel: string;
    userIntent: string;
    draft: string;
  }) => Promise<QualityPassDraftResult>;
}): Promise<Any> {
  if (!opts.enabled) return opts.response;

  const qualityPasses = opts.getQualityPassCount();
  if (qualityPasses <= 1 || opts.response.stopReason !== "end_turn") {
    return opts.response;
  }

  const hasToolUse = (opts.response.content || []).some((c: Any) => c && c.type === "tool_use");
  if (hasToolUse) return opts.response;

  const draftText = opts.extractTextFromLLMContent(opts.response.content).trim();
  if (!draftText) return opts.response;

  const passes: 2 | 3 = qualityPasses === 2 ? 2 : 3;
  const improved = await opts.applyQualityPassesToDraft({
    passes,
    contextLabel: opts.contextLabel,
    userIntent: opts.userIntent,
    draft: draftText,
  });
  if (!improved.accepted) {
    return opts.response;
  }
  const improvedTrimmed = String(improved.text || "").trim();
  if (!improvedTrimmed || improvedTrimmed === draftText) {
    return opts.response;
  }

  return {
    ...opts.response,
    content: [{ type: "text", text: improvedTrimmed }],
    stopReason: "end_turn",
  };
}
