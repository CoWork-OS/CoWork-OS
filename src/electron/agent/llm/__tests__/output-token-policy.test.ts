import { afterEach, describe, expect, it } from "vitest";
import { handleMaxTokensRecovery } from "../../executor-loop-utils";
import {
  buildReasoningExhaustedGuidance,
  classifyOutputTruncation,
  inferOutputBudgetRequestKind,
  resolveOutputTokenBudget,
  resolveOutputTokenParamName,
} from "../output-token-policy";

describe("output-token-policy", () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it("infers tool follow-up turns from tool_result history", () => {
    expect(
      inferOutputBudgetRequestKind([
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] as Any,
        },
      ]),
    ).toBe("tool_followup");
  });

  it("gives the first agentic call room for a large tool call", () => {
    const resolve = (providerType: string, modelId: string) =>
      resolveOutputTokenBudget({
        providerType,
        modelId,
        messages: [{ role: "user", content: "step context" }],
        system: "system",
        contextManager: { estimateMaxOutputTokens: () => 500_000 } as Any,
        taskMaxTokens: null,
        requestKind: "agentic_main",
        phase: "initial",
      }).transport.value;

    expect(resolve("anthropic", "claude-sonnet-4-5")).toBeGreaterThanOrEqual(16_000);
    // Thinking/reasoning models spend part of the budget before the answer.
    expect(resolve("openai", "gpt-5.5")).toBeGreaterThanOrEqual(32_000);
    expect(resolve("anthropic", "claude-opus-5-5")).toBeGreaterThanOrEqual(32_000);
    // Known model caps still apply.
    expect(resolve("anthropic", "claude-3-5-sonnet-20241022")).toBe(8_192);
  });

  it("escalates the request that follows a max_tokens recovery prompt", () => {
    const messages = [{ role: "user", content: "step context" }] as Any[];
    handleMaxTokensRecovery({
      response: { stopReason: "max_tokens", content: [{ type: "text", text: "partial" }] },
      messages,
      recoveryCount: 0,
      maxRecoveries: 3,
      log: () => undefined,
      emitMaxTokensRecovery: () => undefined,
    });

    const requestKind = inferOutputBudgetRequestKind(messages);
    expect(requestKind).toBe("continuation");
    const budget = resolveOutputTokenBudget({
      providerType: "anthropic",
      modelId: "claude-sonnet-4-5",
      messages,
      system: "system",
      contextManager: { estimateMaxOutputTokens: () => 500_000 } as Any,
      taskMaxTokens: null,
      requestKind,
      phase: "initial",
    });
    expect(budget.transport.value).toBe(64_000);
  });

  it("routes OpenRouter Anthropic models through Anthropic-style defaults", () => {
    const budget = resolveOutputTokenBudget({
      providerType: "openrouter",
      modelId: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: "hello" }],
      system: "system",
      contextManager: { estimateMaxOutputTokens: () => 200_000 } as Any,
      taskMaxTokens: null,
      requestKind: "agentic_main",
      phase: "escalated",
    });

    expect(budget.providerFamily).toBe("openrouter");
    expect(budget.routedFamily).toBe("anthropic");
    expect(budget.transport.value).toBe(64_000);
  });

  it("gives task-level maxTokens precedence over env and policy defaults", () => {
    process.env.COWORK_LLM_OUTPUT_POLICY = "adaptive";
    process.env.COWORK_LLM_MAX_OUTPUT_TOKENS = "32000";

    const budget = resolveOutputTokenBudget({
      providerType: "openai",
      modelId: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      system: "system",
      contextManager: { estimateMaxOutputTokens: () => 100_000 } as Any,
      taskMaxTokens: 12_345,
      requestKind: "agentic_main",
      phase: "initial",
    });

    expect(budget.capSource).toBe("task");
    expect(budget.transport.value).toBe(12_345);
  });

  it("caps env overrides at a sane upper bound", () => {
    process.env.COWORK_LLM_OUTPUT_POLICY = "adaptive";
    process.env.COWORK_LLM_MAX_OUTPUT_TOKENS = "9999999";

    const budget = resolveOutputTokenBudget({
      providerType: "openai",
      modelId: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      system: "system",
      contextManager: { estimateMaxOutputTokens: () => 500_000 } as Any,
      taskMaxTokens: null,
      requestKind: "agentic_main",
      phase: "initial",
    });

    expect(budget.capSource).toBe("env");
    expect(budget.envLimit).toBe(128_000);
    expect(budget.transport.value).toBe(128_000);
  });

  it("clamps by context headroom after selecting the budget source", () => {
    process.env.COWORK_LLM_OUTPUT_POLICY = "adaptive";

    const budget = resolveOutputTokenBudget({
      providerType: "openai",
      modelId: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      system: "system",
      contextManager: { estimateMaxOutputTokens: () => 2048 } as Any,
      taskMaxTokens: null,
      requestKind: "tool_followup",
      phase: "initial",
    });

    // gpt-5.4 reasons before answering, so its tool follow-up default is 32K.
    expect(budget.policyDefault).toBe(32_000);
    expect(budget.transport.value).toBe(2_048);
  });

  it("resolves transport param names for newer OpenAI/Azure reasoning models", () => {
    expect(
      resolveOutputTokenParamName({
        providerType: "openai",
        modelId: "gpt-6-astra",
        apiMode: "chat_completions",
      }),
    ).toBe("max_completion_tokens");
    expect(
      resolveOutputTokenParamName({
        providerType: "openai",
        modelId: "gpt-5.4",
        apiMode: "chat_completions",
      }),
    ).toBe("max_completion_tokens");
    expect(
      resolveOutputTokenParamName({
        providerType: "azure",
        modelId: "gpt-5.4",
        apiMode: "responses",
      }),
    ).toBe("max_output_tokens");
  });

  it.each(["gpt-6-astra", "gpt-6.1-sol", "openai-codex/gpt-6.1-sol@fast"])(
    "caps %s output budgets at the documented 128K limit",
    (modelId) => {
      process.env.COWORK_LLM_OUTPUT_POLICY = "adaptive";
      process.env.COWORK_LLM_MAX_OUTPUT_TOKENS = "9999999";

      const budget = resolveOutputTokenBudget({
        providerType: "openai",
        modelId,
        messages: [{ role: "user", content: "hello" }],
        system: "system",
        contextManager: { estimateMaxOutputTokens: () => 500_000 } as Any,
        taskMaxTokens: null,
        requestKind: "agentic_main",
        phase: "initial",
      });

      expect(budget.knownHardCap).toBe(128_000);
      expect(budget.transport.value).toBe(128_000);
    },
  );

  it("classifies thinking-only truncation as reasoning exhausted", () => {
    expect(
      classifyOutputTruncation([
        { type: "text", text: "<think>internal chain of thought</think>" } as Any,
      ]),
    ).toBe("reasoning_exhausted");
    expect(
      classifyOutputTruncation([{ type: "text", text: "<think>x</think>Answer" } as Any]),
    ).toBe("visible_partial_output");
  });

  it("classifies a cut-off tool call as visible output rather than exhausted reasoning", () => {
    expect(
      classifyOutputTruncation([
        { type: "tool_use", id: "t1", name: "write_file", input: { path: "a.md" } } as Any,
      ]),
    ).toBe("visible_partial_output");
  });

  it("builds operator guidance for reasoning-only truncation", () => {
    expect(buildReasoningExhaustedGuidance()).toContain("higher output budget");
  });
});
