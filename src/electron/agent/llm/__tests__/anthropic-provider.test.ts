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
        model: "claude-haiku-4-5",
      }),
      undefined,
    );
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
        model: "claude-haiku-4-5",
        max_tokens: 48000,
      }),
      undefined,
    );
    expect(anthropicStreamFinalMessageMock).toHaveBeenCalledTimes(1);
  });
});
