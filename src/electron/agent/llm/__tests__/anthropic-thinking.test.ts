import { describe, expect, it } from "vitest";

import {
  anthropicReasoningFromResponse,
  anthropicThinkingPrefixSeed,
  applyAnthropicThinkingReplay,
  classifyAnthropicThinkingRejection,
  planAnthropicThinking,
  trailingToolTurnStartsWithThinking,
} from "../anthropic-thinking";
import type { LLMMessage } from "../types";

describe("planAnthropicThinking", () => {
  it("sends adaptive thinking explicitly on Opus 4.6, with the effort clamped to its levels", () => {
    expect(planAnthropicThinking({ model: "claude-opus-4-6", maxTokens: 16_000 })).toEqual({
      thinking: { type: "adaptive" },
      maxTokens: 16_000,
    });
    expect(
      planAnthropicThinking({ model: "claude-opus-4-6", maxTokens: 16_000, effort: "xhigh" }),
    ).toEqual({
      thinking: { type: "adaptive" },
      outputConfig: { effort: "high" },
      maxTokens: 16_000,
    });
  });

  it("turns thinking off on Opus 4.6 by omitting it, never with disabled", () => {
    expect(
      planAnthropicThinking({ model: "claude-opus-4-6", maxTokens: 16_000, effort: "none" }),
    ).toEqual({ maxTokens: 16_000 });
  });

  it("lowers effort instead of disabling thinking on always-thinking models", () => {
    expect(
      planAnthropicThinking({ model: "claude-opus-5-5", maxTokens: 16_000, effort: "none" }),
    ).toEqual({ outputConfig: { effort: "low" }, maxTokens: 16_000 });
  });

  it("gives small caps headroom because max_tokens includes thinking", () => {
    expect(
      planAnthropicThinking({ model: "claude-sonnet-4-6", maxTokens: 512, effort: "low" }),
    ).toMatchObject({ maxTokens: 512 + 1_024 });
    // Opus 5.5 defaults to medium effort.
    expect(planAnthropicThinking({ model: "claude-opus-5-5", maxTokens: 512 })).toMatchObject({
      maxTokens: 512 + 2_048,
    });
  });

  it("uses a token budget below max_tokens on pre-4.6 models only when an effort is chosen", () => {
    expect(planAnthropicThinking({ model: "claude-sonnet-4-5", maxTokens: 16_000 })).toEqual({
      maxTokens: 16_000,
    });
    const plan = planAnthropicThinking({
      model: "claude-sonnet-4-5",
      maxTokens: 16_000,
      effort: "medium",
    });
    expect(plan).toEqual({
      thinking: { type: "enabled", budget_tokens: 8_192 },
      maxTokens: 24_192,
    });
  });

  it("keeps the budget within the model output cap and below max_tokens", () => {
    expect(
      planAnthropicThinking({ model: "claude-haiku-4-5", maxTokens: 62_000, effort: "high" }),
    ).toEqual({ thinking: { type: "enabled", budget_tokens: 16_384 }, maxTokens: 64_000 });
    // Opus 4.1 caps output at 32K: the budget shrinks to leave visible-output room.
    expect(
      planAnthropicThinking({ model: "claude-opus-4-1", maxTokens: 30_000, effort: "max" }),
    ).toEqual({ thinking: { type: "enabled", budget_tokens: 27_904 }, maxTokens: 32_000 });
  });

  it("sends nothing for models without extended thinking", () => {
    expect(
      planAnthropicThinking({ model: "claude-3-5-haiku-20241022", maxTokens: 100, effort: "high" }),
    ).toEqual({ maxTokens: 100 });
  });
});

const seed = anthropicThinkingPrefixSeed(["system"], []);
const thinking = { type: "thinking" as const, thinking: "plan", signature: "sig-1" };
const redacted = { type: "redacted_thinking" as const, data: "opaque" };
const toolUse = { type: "tool_use" as const, id: "t1", name: "read_file", input: { path: "a" } };

function convert(messages: LLMMessage[]) {
  return messages.map((message) => ({ role: message.role, content: message.content as Any }));
}

function producedTranscript(): LLMMessage[] {
  const request: LLMMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  const prefix = applyAnthropicThinkingReplay({
    messages: request,
    converted: convert(request),
    model: "m",
    provider: "anthropic",
    seed,
    replay: true,
  }).prefixHash;
  const visible = [toolUse];
  const reasoning = anthropicReasoningFromResponse({
    content: [thinking, redacted, toolUse],
    visibleContent: visible,
    model: "m",
    provider: "anthropic",
    prefixHash: prefix,
  });
  return [
    ...request,
    { role: "assistant", content: visible, reasoning },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ];
}

describe("applyAnthropicThinkingReplay", () => {
  it("restores the blocks verbatim and in their original positions", () => {
    const messages = producedTranscript();
    const result = applyAnthropicThinkingReplay({
      messages,
      converted: convert(messages),
      model: "m",
      provider: "anthropic",
      seed,
      replay: true,
    });
    expect(result.messages[1].content).toEqual([thinking, redacted, toolUse]);
    expect(result.replayedBlocks).toBe(2);
  });

  it.each([
    ["another model", { model: "other" }],
    ["another provider", { provider: "azure-anthropic" }],
    ["a changed system prompt", { seed: anthropicThinkingPrefixSeed(["edited"], []) }],
    ["replay disabled", { replay: false }],
  ])("drops the blocks for %s", (_label, override) => {
    const messages = producedTranscript();
    const result = applyAnthropicThinkingReplay({
      messages,
      converted: convert(messages),
      model: "m",
      provider: "anthropic",
      seed,
      replay: true,
      ...override,
    });
    expect(result.messages[1].content).toEqual([toolUse]);
    expect(result.replayedBlocks).toBe(0);
  });

  it("drops the blocks when an earlier message or the turn itself was edited", () => {
    const editedEarlier = producedTranscript();
    editedEarlier[0] = { role: "user", content: [{ type: "text", text: "edited" }] };
    const editedTurn = producedTranscript();
    editedTurn[1] = {
      ...editedTurn[1],
      content: [{ ...toolUse, input: { path: "b" } }],
    };
    for (const messages of [editedEarlier, editedTurn]) {
      const result = applyAnthropicThinkingReplay({
        messages,
        converted: convert(messages),
        model: "m",
        provider: "anthropic",
        seed,
        replay: true,
      });
      expect(JSON.stringify(result.messages)).not.toContain("sig-1");
    }
  });
});

describe("trailingToolTurnStartsWithThinking", () => {
  it("checks the assistant turn answered by the trailing tool results", () => {
    const toolResult = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    };
    expect(
      trailingToolTurnStartsWithThinking([
        { role: "assistant", content: [thinking, toolUse] },
        toolResult,
      ]),
    ).toBe(true);
    expect(
      trailingToolTurnStartsWithThinking([{ role: "assistant", content: [toolUse] }, toolResult]),
    ).toBe(false);
    expect(trailingToolTurnStartsWithThinking([{ role: "user", content: "hi" }])).toBe(true);
  });
});

describe("classifyAnthropicThinkingRejection", () => {
  it("separates rejected blocks from rejected parameters", () => {
    expect(
      classifyAnthropicThinkingRejection(
        400,
        "messages.1.content.0: Invalid `signature` in `thinking` block",
      ),
    ).toBe("replay");
    expect(
      classifyAnthropicThinkingRejection(400, "thinking.type: Input tag 'adaptive' is invalid"),
    ).toBe("config");
    expect(classifyAnthropicThinkingRejection(400, "output_config: Extra inputs")).toBe("config");
    expect(classifyAnthropicThinkingRejection(400, "max_tokens too large")).toBeNull();
    expect(classifyAnthropicThinkingRejection(500, "thinking overloaded")).toBeNull();
  });
});
