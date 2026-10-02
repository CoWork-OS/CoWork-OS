import { beforeEach, describe, expect, it, vi } from "vitest";

import { AnthropicProvider } from "../anthropic-provider";
import type { LLMRequest } from "../types";

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
});
