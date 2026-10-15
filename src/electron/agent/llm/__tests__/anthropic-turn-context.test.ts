import { describe, expect, it } from "vitest";
import { anthropicReasoningFromResponse } from "../anthropic-thinking";
import {
  anthropicContextFromResponse,
  isAnthropicTurnContextUnsupported,
  prepareAnthropicConversation,
  supportsAnthropicTurnContext,
} from "../anthropic-turn-context";
import type { LLMMessage, LLMRequest } from "../types";

const base: LLMRequest = {
  model: "claude-opus-5-5",
  maxTokens: 64,
  system: "Stable\n\nCurrent",
  systemBlocks: [
    { text: "Stable", scope: "session", cacheable: true, stableKey: "stable" },
    { text: "Current", scope: "turn", cacheable: false, stableKey: "turn" },
  ],
  messages: [{ role: "user", content: [{ type: "text", text: "Go" }] }],
};

function prepare(request: LLMRequest, provider = "anthropic", enabled = true) {
  return prepareAnthropicConversation({
    request,
    messages: request.messages,
    converted: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    tools: request.tools,
    model: request.model,
    provider,
    replay: true,
    enableTurnContext: enabled,
  });
}

function transcript(): LLMMessage[] {
  const first = prepare(base);
  const content = [{ type: "text" as const, text: "Done" }];
  return [
    ...base.messages,
    {
      role: "assistant",
      content,
      providerContext: anthropicContextFromResponse(first.pendingContext, content),
      reasoning: anthropicReasoningFromResponse({
        content: [{ type: "thinking", thinking: "Plan", signature: "signed" }, ...content],
        visibleContent: content,
        model: base.model,
        provider: "anthropic",
        prefixHash: first.prefixHash,
      }),
    },
    { role: "user", content: "Next" },
  ];
}

describe("Claude scoped context capability", () => {
  it.each([
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-mythos-5",
    "claude-mythos-5-1",
    "opus-5-5",
    "anthropic/claude-opus-4.8",
    "claude-opus-5-5-20261001",
  ])("recognizes documented model %s", (model) => {
    expect(supportsAnthropicTurnContext(model)).toBe(true);
  });
  it.each([
    "claude-sonnet-5",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-6",
    "gpt-6",
    "unknown",
  ])("does not guess support for %s", (model) => {
    expect(supportsAnthropicTurnContext(model)).toBe(false);
  });
});

describe("Claude scoped context replay", () => {
  it("retains original context and thinking while replacing only the current context", () => {
    const request = {
      ...base,
      messages: JSON.parse(JSON.stringify(transcript())),
      systemBlocks: [base.systemBlocks![0], { ...base.systemBlocks![1], text: "Fresh" }],
    };
    const saved = structuredClone(request);
    const result = prepare(request);
    expect(result.messages[1].content).toEqual([{ type: "text", text: "Current" }]);
    expect(result.messages[2].content[0].signature).toBe("signed");
    expect(result.messages.at(-1)?.content).toEqual([{ type: "text", text: "Fresh" }]);
    expect(result.systemRequest.system).toBe("Stable");
    expect(request).toEqual(saved);
  });

  it.each([
    "earlier message",
    "assistant content",
    "removed turn",
    "system prefix",
    "tools",
    "model",
    "provider",
  ])("drops stale privileged context and thinking after changing %s", (change) => {
    const request = structuredClone({ ...base, messages: transcript() });
    if (change === "earlier message") request.messages[0].content = "Edited";
    if (change === "assistant content")
      request.messages[1].content = [{ type: "text", text: "Edited" }];
    if (change === "removed turn") request.messages.shift();
    if (change === "system prefix") request.systemBlocks![0].text = "Edited";
    if (change === "tools")
      request.tools = [
        { name: "new_tool", description: "New", input_schema: { type: "object", properties: {} } },
      ];
    if (change === "model") request.model = "claude-opus-4-8";
    const result = prepare(request, change === "provider" ? "azure-anthropic" : "anthropic");
    expect(result.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(JSON.stringify(result.messages)).not.toContain("signed");
  });

  it("retains cleared contexts when the current context is empty", () => {
    const result = prepare({
      ...base,
      messages: transcript(),
      systemBlocks: [base.systemBlocks![0]],
    });
    expect(result.usesTurnContext).toBe(true);
    expect(result.pendingContext).toBeUndefined();
    expect(result.replayedBlocks).toBe(1);
    expect(result.messages.at(-1)?.role).toBe("user");
  });

  it.each(["unsupported model", "disabled feature", "no stable prefix", "pending tool use"])(
    "uses the complete legacy system prompt for %s",
    (change) => {
      const request = structuredClone(base);
      if (change === "unsupported model") request.model = "claude-sonnet-5";
      if (change === "no stable prefix") request.systemBlocks = [request.systemBlocks![1]];
      if (change === "pending tool use")
        request.messages.push({
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "read", input: {} }],
        });
      const result = prepare(request, "anthropic", change !== "disabled feature");
      expect(result.usesTurnContext).toBe(false);
      expect(result.systemRequest).toEqual({
        system: request.system,
        systemBlocks: request.systemBlocks,
      });
      expect(result.messages.some((message) => message.role === "system")).toBe(false);
    },
  );
});

describe("scoped context fallback classification", () => {
  it.each([400, 404, 422, 501])("recognizes feature rejection with status %s", (status) => {
    expect(
      isAnthropicTurnContextUnsupported(
        status,
        "messages.2.clear_at: Extra inputs are not permitted",
      ),
    ).toBe(true);
    expect(
      isAnthropicTurnContextUnsupported(
        status,
        "messages.2.role: Input should be 'user' or 'assistant', got 'system'",
      ),
    ).toBe(true);
    expect(
      isAnthropicTurnContextUnsupported(
        status,
        "unsupported anthropic-beta: mid-conversation-system-clear-at-2026-08-21",
      ),
    ).toBe(true);
  });
  it.each([401, 403, 429, 500, 503, undefined])(
    "does not hide auth or transient failure %s",
    (status) => {
      expect(isAnthropicTurnContextUnsupported(status, "clear_at not supported")).toBe(false);
    },
  );
  it("does not retry unrelated validation errors", () => {
    expect(isAnthropicTurnContextUnsupported(400, "max_tokens must be positive")).toBe(false);
  });
});
