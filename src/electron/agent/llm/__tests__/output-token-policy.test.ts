import { afterEach, describe, expect, it } from "vitest";
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
        { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] as Any },
      ]),
    ).toBe("tool_followup");
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

    expect(budget.policyDefault).toBe(16_000);
    expect(budget.transport.value).toBe(2_048);
  });

  it("resolves transport param names for newer OpenAI/Azure reasoning models", () => {
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

  it("builds operator guidance for reasoning-only truncation", () => {
    expect(buildReasoningExhaustedGuidance()).toContain(
      "higher output budget",
    );
  });
});
