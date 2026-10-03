import { beforeEach, describe, expect, it, vi } from "vitest";

import { appendAssistantResponseToConversation } from "../../executor-loop-utils";
import { ContextManager } from "../../context-manager";
import { AnthropicProvider } from "../anthropic-provider";
import type { LLMMessage, LLMRequest } from "../types";

const anthropicCreateMock = vi.fn();
const anthropicStreamFinalMessageMock = vi.fn();
const anthropicStreamMock = vi.fn();
const anthropicConstructorMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function AnthropicMock(options: Any) {
    anthropicConstructorMock(options);
    return {
      messages: {
        create: (...args: Any[]) => anthropicCreateMock(...args),
        stream: (...args: Any[]) => anthropicStreamMock(...args),
      },
    };
  }),
}));

function makeRequest(): LLMRequest {
  return {
    model: "claude-sonnet-4-6",
    maxTokens: 128,
    system: "system",
    messages: [{ role: "user", content: "hello" }],
  };
}

describe("AnthropicProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anthropicCreateMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    anthropicStreamFinalMessageMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    anthropicStreamMock.mockReturnValue({
      finalMessage: anthropicStreamFinalMessageMock,
    });
  });

  it("uses API key auth for standard Claude API keys", async () => {
    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-sonnet-4-6",
      anthropicApiKey: "sk-ant-api-test",
    });

    await provider.createMessage(makeRequest());

    expect(anthropicConstructorMock).toHaveBeenCalledWith({
      apiKey: "sk-ant-api-test",
    });
  });

  it("uses authToken headers for Claude subscription tokens", async () => {
    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-sonnet-4-6",
      anthropicApiKey: "sk-ant-oat01-subscription-token",
    });

    await provider.createMessage(makeRequest());

    expect(anthropicConstructorMock).toHaveBeenCalledWith({
      apiKey: null,
      authToken: "sk-ant-oat01-subscription-token",
      defaultHeaders: {
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "x-app": "cli",
      },
    });
  });

  it("uses the same cache-write request controls for Claude subscription tokens", async () => {
    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-sonnet-4-6",
      anthropicApiKey: "sk-ant-oat01-subscription-token",
    });

    await provider.createMessage({
      ...makeRequest(),
      promptCache: {
        mode: "anthropic_auto",
        ttl: "1h",
        explicitRecentMessages: 3,
      },
    });

    expect(anthropicCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ cache_control: { type: "ephemeral", ttl: "1h" } }),
      undefined,
    );
  });

  it("normalizes legacy Claude snapshot IDs before making requests", async () => {
    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-haiku-4-5-20250514",
      anthropicApiKey: "sk-ant-api-test",
    });

    await provider.createMessage({
      ...makeRequest(),
      model: "claude-haiku-4-5-20250514",
    });

    expect(anthropicCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
      }),
      undefined,
    );
  });

  it("tests the configured Claude model instead of the retired Haiku 3.5 health check", async () => {
    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-3-5-haiku-20241022",
      anthropicApiKey: "sk-ant-api-test",
    });

    const result = await provider.testConnection();

    expect(result).toEqual({ success: true });
    expect(anthropicCreateMock).toHaveBeenCalledWith({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: "Hi" }],
    });
  });

  it("retries with streaming when Anthropic SDK rejects a long non-streaming request", async () => {
    anthropicCreateMock.mockRejectedValueOnce(
      new Error(
        "Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details",
      ),
    );

    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-haiku-4-5",
      anthropicApiKey: "sk-ant-api-test",
    });

    await provider.createMessage({
      ...makeRequest(),
      model: "claude-haiku-4-5",
      maxTokens: 48000,
      tools: [
        {
          name: "test_tool",
          description: "test tool",
          input_schema: {
            type: "object",
            properties: {},
          },
        },
      ],
    });

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(anthropicStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 48000,
      }),
      undefined,
    );
    expect(anthropicStreamFinalMessageMock).toHaveBeenCalledTimes(1);
  });

  it.each(["claude-opus-4-6", "claude-sonnet-5"])(
    "never ends a %s request with an assistant prefill turn",
    async (model) => {
      const provider = new AnthropicProvider({
        type: "anthropic",
        model,
        anthropicApiKey: "sk-ant-api-test",
      });

      await provider.createMessage({
        ...makeRequest(),
        model,
        messages: [
          { role: "user", content: "Write the report" },
          { role: "assistant", content: [{ type: "text", text: "Section one is" }] },
        ],
      });

      const sent = anthropicCreateMock.mock.calls[0][0].messages;
      expect(sent.at(-1).role).toBe("user");
      expect(sent.at(-2)).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "Section one is" }],
      });
    },
  );

  it("keeps assistant prefill for models that still support it", async () => {
    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-haiku-4-5",
      anthropicApiKey: "sk-ant-api-test",
    });

    await provider.createMessage({
      ...makeRequest(),
      model: "claude-haiku-4-5",
      messages: [
        { role: "user", content: "Return JSON" },
        { role: "assistant", content: [{ type: "text", text: "{" }] },
      ],
    });

    expect(anthropicCreateMock.mock.calls[0][0].messages.at(-1).role).toBe("assistant");
  });

  it.each([
    ["refusal", "refusal"],
    ["model_context_window_exceeded", "max_tokens"],
    ["pause_turn", "max_tokens"],
    ["end_turn", "end_turn"],
  ])("maps the %s stop reason to %s", async (stopReason, expected) => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "partial" }],
      stop_reason: stopReason,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-sonnet-4-6",
      anthropicApiKey: "sk-ant-api-test",
    });

    const response = await provider.createMessage(makeRequest());

    expect(response.stopReason).toBe(expected);
  });

  it.each(["5m", "1h"] as const)(
    "pins the static system prefix with an explicit breakpoint under automatic caching (%s)",
    async (ttl) => {
      const provider = new AnthropicProvider({
        type: "anthropic",
        model: "claude-sonnet-4-6",
        anthropicApiKey: "sk-ant-api-test",
      });

      await provider.createMessage({
        ...makeRequest(),
        system: "Stable instructions\n\nCurrent time: now",
        systemBlocks: [
          { text: "Stable instructions", scope: "session", cacheable: true, stableKey: "id:1" },
          { text: "Current time: now", scope: "turn", cacheable: false, stableKey: "time:1" },
        ],
        promptCache: { mode: "anthropic_auto", ttl, explicitRecentMessages: 3 },
      });

      const payload = anthropicCreateMock.mock.calls[0][0];
      const marker = ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
      // Automatic caching follows the conversation tail; the explicit marker keeps
      // a guaranteed read point on the stable system prefix (same TTL, so the
      // longer-TTL-first ordering rule holds).
      expect(payload.cache_control).toEqual(marker);
      expect(payload.system[0]).toEqual({
        type: "text",
        text: "Stable instructions",
        cache_control: marker,
      });
      expect(payload.system[1].cache_control).toBeUndefined();
      const breakpoints = JSON.stringify(payload).split('"cache_control"').length - 1;
      expect(breakpoints).toBeLessThanOrEqual(4);
    },
  );

  describe("thinking and effort", () => {
    function providerFor(model: string, effort?: LLMRequest["reasoningEffort"]) {
      return new AnthropicProvider({
        type: "anthropic",
        model,
        anthropicApiKey: "sk-ant-api-test",
        ...(effort ? { anthropicReasoningEffort: effort } : {}),
      });
    }

    function sentPayload(callIndex = 0) {
      return anthropicCreateMock.mock.calls[callIndex][0];
    }

    function expectNoSamplingOrForcedToolChoice(payload: Any) {
      expect(payload).not.toHaveProperty("temperature");
      expect(payload).not.toHaveProperty("top_p");
      expect(payload).not.toHaveProperty("top_k");
      expect(payload).not.toHaveProperty("tool_choice");
      expect(JSON.stringify(payload)).not.toContain('"disabled"');
    }

    it("sends adaptive thinking explicitly and the saved effort on Opus 4.6", async () => {
      await providerFor("claude-opus-4-6", "high").createMessage({
        ...makeRequest(),
        model: "claude-opus-4-6",
        maxTokens: 16_000,
      });

      const payload = sentPayload();
      expect(payload.thinking).toEqual({ type: "adaptive" });
      expect(payload.output_config).toEqual({ effort: "high" });
      expect(payload.max_tokens).toBe(16_000);
      expectNoSamplingOrForcedToolChoice(payload);
    });

    it("allows xhigh on Opus 4.8 and clamps it to high on Opus 4.6", async () => {
      await providerFor("claude-opus-4-8", "xhigh").createMessage({
        ...makeRequest(),
        model: "claude-opus-4-8",
        maxTokens: 16_000,
      });
      await providerFor("claude-opus-4-6", "xhigh").createMessage({
        ...makeRequest(),
        model: "claude-opus-4-6",
        maxTokens: 16_000,
      });

      expect(sentPayload(0).output_config).toEqual({ effort: "xhigh" });
      expect(sentPayload(1).output_config).toEqual({ effort: "high" });
    });

    it("leaves Opus 5.5 on its medium default effort and never disables its thinking", async () => {
      await providerFor("claude-opus-5-5").createMessage({
        ...makeRequest(),
        model: "claude-opus-5-5",
        maxTokens: 16_000,
      });
      await providerFor("claude-opus-5-5", "none").createMessage({
        ...makeRequest(),
        model: "claude-opus-5-5",
        maxTokens: 16_000,
      });

      expect(sentPayload(0).thinking).toEqual({ type: "adaptive" });
      expect(sentPayload(0)).not.toHaveProperty("output_config");
      expect(sentPayload(1)).not.toHaveProperty("thinking");
      expect(sentPayload(1).output_config).toEqual({ effort: "low" });
      expectNoSamplingOrForcedToolChoice(sentPayload(0));
      expectNoSamplingOrForcedToolChoice(sentPayload(1));
    });

    it("prefers the per-request effort over the saved one", async () => {
      await providerFor("claude-opus-4-8", "max").createMessage({
        ...makeRequest(),
        model: "claude-opus-4-8",
        maxTokens: 16_000,
        reasoningEffort: "low",
      });

      expect(sentPayload().output_config).toEqual({ effort: "low" });
    });

    it("uses budget thinking on Sonnet 4.5 only when an effort is chosen", async () => {
      await providerFor("claude-sonnet-4-5").createMessage({
        ...makeRequest(),
        model: "claude-sonnet-4-5",
        maxTokens: 16_000,
      });
      await providerFor("claude-sonnet-4-5", "high").createMessage({
        ...makeRequest(),
        model: "claude-sonnet-4-5",
        maxTokens: 16_000,
      });

      expect(sentPayload(0)).not.toHaveProperty("thinking");
      const enabled = sentPayload(1);
      expect(enabled.thinking).toEqual({ type: "enabled", budget_tokens: 16_384 });
      expect(enabled.max_tokens).toBeGreaterThan(enabled.thinking.budget_tokens);
      // Sonnet 4.5 rejects effort.
      expect(enabled).not.toHaveProperty("output_config");
      expectNoSamplingOrForcedToolChoice(enabled);
    });

    it("never sends effort to Haiku 4.5", async () => {
      await providerFor("claude-haiku-4-5", "medium").createMessage({
        ...makeRequest(),
        model: "claude-haiku-4-5",
        maxTokens: 16_000,
      });

      expect(sentPayload()).not.toHaveProperty("output_config");
      expect(sentPayload().thinking).toEqual({ type: "enabled", budget_tokens: 8_192 });
    });

    it("keeps thinking and redacted thinking with their signatures out of the visible content", async () => {
      anthropicCreateMock.mockResolvedValueOnce({
        content: [
          { type: "thinking", thinking: "", signature: "sig-a" },
          { type: "redacted_thinking", data: "redacted-a" },
          { type: "text", text: "Reading the file." },
          { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.ts" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const response = await providerFor("claude-opus-4-8").createMessage({
        ...makeRequest(),
        model: "claude-opus-4-8",
      });

      expect(response.content).toEqual([
        { type: "text", text: "Reading the file." },
        { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.ts" } },
      ]);
      expect(response.reasoning?.map((item) => [item.format, item.model])).toEqual([
        ["anthropic", "claude-opus-4-8"],
        ["anthropic", "claude-opus-4-8"],
      ]);
      expect(response.reasoning?.map((item) => (item.data as Any).block)).toEqual([
        { type: "thinking", thinking: "", signature: "sig-a" },
        { type: "redacted_thinking", data: "redacted-a" },
      ]);
    });

    it("keeps thinking blocks from streamed responses", async () => {
      anthropicCreateMock.mockRejectedValueOnce(
        new Error("Streaming is required for operations that may take longer than 10 minutes"),
      );
      anthropicStreamFinalMessageMock.mockResolvedValueOnce({
        content: [
          { type: "thinking", thinking: "summary", signature: "sig-stream" },
          { type: "text", text: "done" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const response = await providerFor("claude-opus-4-8").createMessage({
        ...makeRequest(),
        model: "claude-opus-4-8",
        maxTokens: 64_000,
      });

      expect(anthropicStreamMock.mock.calls[0][0].thinking).toEqual({ type: "adaptive" });
      expect(response.reasoning).toHaveLength(1);
      expect((response.reasoning![0].data as Any).block.signature).toBe("sig-stream");
    });

    const firstTurnContent = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "text", text: "Checking." },
      { type: "redacted_thinking", data: "redacted-1" },
      { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.ts" } },
    ];

    async function runFirstToolRound(model: string, effort?: LLMRequest["reasoningEffort"]) {
      const provider = providerFor(model, effort);
      const messages: LLMMessage[] = [{ role: "user", content: "Read a.ts" }];
      anthropicCreateMock.mockResolvedValueOnce({
        content: firstTurnContent,
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const response = await provider.createMessage({ ...makeRequest(), model, messages });
      appendAssistantResponseToConversation(messages, response, 0);
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents" }],
      });
      return { provider, messages };
    }

    it("replays the exact thinking blocks before tool_use in the next tool-loop request", async () => {
      const { provider, messages } = await runFirstToolRound("claude-opus-4-8");

      await provider.createMessage({ ...makeRequest(), model: "claude-opus-4-8", messages });

      expect(sentPayload(1).messages[1]).toEqual({ role: "assistant", content: firstTurnContent });
      expect(sentPayload(1).messages[2].content[0].type).toBe("tool_result");
    });

    it("replays thinking blocks under explicit prompt caching without marking them", async () => {
      const { provider, messages } = await runFirstToolRound("claude-opus-4-8");

      await provider.createMessage({
        ...makeRequest(),
        model: "claude-opus-4-8",
        messages,
        promptCache: { mode: "anthropic_explicit", ttl: "5m", explicitRecentMessages: 3 },
      });

      const assistant = sentPayload(1).messages[1];
      expect(assistant.content.map((block: Any) => block.type)).toEqual([
        "thinking",
        "text",
        "redacted_thinking",
        "tool_use",
      ]);
      expect(assistant.content[0]).toEqual(firstTurnContent[0]);
      expect(assistant.content[2]).toEqual(firstTurnContent[2]);
    });

    it("strips the blocks when the conversation moves to another model", async () => {
      const { messages } = await runFirstToolRound("claude-opus-4-8");

      await providerFor("claude-sonnet-4-6").createMessage({
        ...makeRequest(),
        model: "claude-sonnet-4-6",
        messages,
      });

      expect(sentPayload(1).messages[1]).toEqual({
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.ts" } },
        ],
      });
    });

    it("strips the blocks when history before them was edited", async () => {
      const { provider, messages } = await runFirstToolRound("claude-opus-4-8");
      messages[0] = { role: "user", content: "Read a.ts (edited reminder)" };

      await provider.createMessage({ ...makeRequest(), model: "claude-opus-4-8", messages });

      expect(JSON.stringify(sentPayload(1))).not.toContain("sig-1");
    });

    it("keeps compacted turns whole and drops blocks whose earlier turns were removed", async () => {
      const { provider, messages } = await runFirstToolRound("claude-opus-4-8");
      anthropicCreateMock.mockResolvedValueOnce({
        content: [
          { type: "thinking", thinking: "", signature: "sig-2" },
          { type: "tool_use", id: "tool-2", name: "read_file", input: { path: "b.ts" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const second = await provider.createMessage({
        ...makeRequest(),
        model: "claude-opus-4-8",
        messages,
      });
      appendAssistantResponseToConversation(messages, second, 0);
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-2", content: "x".repeat(400) }],
      });

      // Without compaction both turns replay their blocks.
      await provider.createMessage({ ...makeRequest(), model: "claude-opus-4-8", messages });
      expect(JSON.stringify(sentPayload(2))).toContain("sig-1");
      expect(JSON.stringify(sentPayload(2))).toContain("sig-2");

      // Compaction removes the first tool round as a whole and keeps the latest
      // one unchanged, reasoning included.
      const manager = new ContextManager("claude-opus-4-8");
      const kept: LLMMessage[] = (manager as Any).removeOlderMessagesWithMeta(
        messages,
        50,
      ).messages;
      expect(kept).toEqual([messages[0], messages[3], messages[4]]);
      expect(kept[1].reasoning).toBe(messages[3].reasoning);

      await provider.createMessage({ ...makeRequest(), model: "claude-opus-4-8", messages: kept });

      // Turn 2's block was produced with turn 1 in its prefix, so it is not replayed.
      const compacted = sentPayload(3);
      expect(JSON.stringify(compacted)).not.toContain("sig-2");
      expect(compacted.messages[1].content).toEqual([
        { type: "tool_use", id: "tool-2", name: "read_file", input: { path: "b.ts" } },
      ]);
    });

    it("sends budget thinking only when the tool turn can start with its thinking", async () => {
      const { messages } = await runFirstToolRound("claude-opus-4-8", "high");

      await providerFor("claude-haiku-4-5", "high").createMessage({
        ...makeRequest(),
        model: "claude-haiku-4-5",
        messages,
      });

      expect(sentPayload(1)).not.toHaveProperty("thinking");
    });

    it("retries without thinking when the API rejects a replayed block", async () => {
      const { provider, messages } = await runFirstToolRound("claude-opus-4-8");
      anthropicCreateMock.mockRejectedValueOnce(
        Object.assign(
          new Error(
            "400 messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
          ),
          { status: 400 },
        ),
      );

      const response = await provider.createMessage({
        ...makeRequest(),
        model: "claude-opus-4-8",
        messages,
      });

      expect(response.content).toEqual([{ type: "text", text: "ok" }]);
      expect(JSON.stringify(sentPayload(1))).toContain("sig-1");
      const retry = sentPayload(2);
      expect(JSON.stringify(retry)).not.toContain("sig-1");
      expect(retry).not.toHaveProperty("thinking");
      // A rejected block is a property of this history, not of the model: the
      // next request sends thinking parameters again.
      await provider.createMessage({ ...makeRequest(), model: "claude-opus-4-8" });
      expect(sentPayload(3).thinking).toEqual({ type: "adaptive" });
    });

    it("stops sending thinking parameters a model's endpoint rejects", async () => {
      const provider = providerFor("claude-opus-4-6", "high");
      anthropicCreateMock.mockRejectedValueOnce(
        Object.assign(new Error("400 output_config: Extra inputs are not permitted"), {
          status: 400,
        }),
      );

      await provider.createMessage({ ...makeRequest(), model: "claude-opus-4-6" });
      await provider.createMessage({ ...makeRequest(), model: "claude-opus-4-6" });

      expect(sentPayload(0).output_config).toEqual({ effort: "high" });
      expect(sentPayload(1)).not.toHaveProperty("output_config");
      expect(sentPayload(2)).not.toHaveProperty("output_config");
      expect(sentPayload(2)).not.toHaveProperty("thinking");
    });
  });
});
