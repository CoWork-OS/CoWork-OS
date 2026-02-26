import type { LLMMessage } from "./llm";

export async function requestLLMResponseWithAdaptiveBudget(opts: {
  messages: LLMMessage[];
  retryLabel: string;
  operation: string;
  llmTimeoutMs: number;
  modelId: string;
  systemPrompt: string;
  getAvailableTools: () => Any[];
  resolveLLMMaxTokens: (args: { messages: LLMMessage[]; system: string }) => number;
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
    },
    timeoutMs: number,
    operation: string,
  ) => Promise<Any>;
  updateTracking: (inputTokens: number, outputTokens: number) => void;
  log: (message: string) => void;
}): Promise<{ response: Any; availableTools: Any[] }> {
  const availableTools = opts.getAvailableTools();
  const maxTokens = opts.resolveLLMMaxTokens({
    messages: opts.messages,
    system: opts.systemPrompt,
  });

  const llmCallStart = Date.now();
  const effectiveMaxTokensLog = opts.applyRetryTokenCap(maxTokens, 0, opts.llmTimeoutMs, true);
  const effectiveTimeoutLog = opts.getRetryTimeoutMs(
    opts.llmTimeoutMs,
    0,
    true,
    effectiveMaxTokensLog,
  );
  opts.log(
    `  │ LLM call start | budget=${maxTokens} | effectiveMaxTokens=${effectiveMaxTokensLog} | ` +
      `timeout=${(effectiveTimeoutLog / 1000).toFixed(0)}s | tools=${availableTools.length} | ` +
      `msgCount=${opts.messages.length}`,
  );

  const response = await opts.callLLMWithRetry((attempt) => {
    const effectiveMaxTokens = opts.applyRetryTokenCap(maxTokens, attempt, opts.llmTimeoutMs, true);
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
      },
      requestTimeoutMs,
      opts.operation,
    );
  }, opts.retryLabel);

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
      `inputTokens=${response.usage?.inputTokens ?? "?"} | outputTokens=${response.usage?.outputTokens ?? "?"}`,
  );

  if (response.usage) {
    opts.updateTracking(response.usage.inputTokens, response.usage.outputTokens);
  }

  return { response, availableTools };
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
  }) => Promise<string>;
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
  const improvedTrimmed = String(improved || "").trim();
  if (!improvedTrimmed || improvedTrimmed === draftText) {
    return opts.response;
  }

  return {
    ...opts.response,
    content: [{ type: "text", text: improvedTrimmed }],
    stopReason: "end_turn",
  };
}
