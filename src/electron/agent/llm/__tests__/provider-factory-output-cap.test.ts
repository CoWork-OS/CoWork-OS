import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../anthropic-provider";
import { OpenAIProvider } from "../openai-provider";
import { classifyProviderError } from "../provider-error-classifier";
import { LLMProviderFactory } from "../provider-factory";
import type { LLMRequest } from "../types";

const okResponse = {
  content: [{ type: "text" as const, text: "ok" }],
  stopReason: "end_turn" as const,
};

function request(model: string, maxTokens: number): LLMRequest {
  return {
    model,
    maxTokens,
    system: "system",
    messages: [{ role: "user", content: "hello" }],
  };
}

const anthropicCapError = () =>
  Anthropic.APIError.generate(
    400,
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "max_tokens: 70000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4-5-20250929",
      },
    },
    undefined,
    new Headers(),
  );

describe("provider output-cap errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clamps to Anthropic's stated output limit, retries once, and remembers it for the model", async () => {
    const createMessage = vi
      .spyOn(AnthropicProvider.prototype, "createMessage")
      .mockRejectedValueOnce(anthropicCapError())
      .mockResolvedValue(okResponse);
    const provider = LLMProviderFactory.createProviderFromConfig({
      type: "anthropic",
      model: "output-cap-fixture-anthropic",
      anthropicApiKey: "sk-ant-api-fixture",
    });

    await expect(
      provider.createMessage(request("output-cap-fixture-anthropic", 70_000)),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage.mock.calls[1][0].maxTokens).toBeLessThanOrEqual(64_000);

    // The learned cap applies before the next request, so it does not 400 again.
    await provider.createMessage(request("output-cap-fixture-anthropic", 70_000));
    expect(createMessage).toHaveBeenCalledTimes(3);
    expect(createMessage.mock.calls[2][0].maxTokens).toBeLessThanOrEqual(64_000);
  });

  it.each([
    "max_tokens is too large: 48000. This model supports at most 16384 completion tokens, whereas you provided 48000.",
    "max_tokens (48000) exceeds the maximum of 16384 for this model",
  ])("clamps to the limit stated in %j", async (message) => {
    const { APIError } = OpenAI;
    const createMessage = vi
      .spyOn(OpenAIProvider.prototype, "createMessage")
      .mockRejectedValueOnce(
        APIError.generate(
          400,
          { error: { message, type: "invalid_request_error", code: null, param: "max_tokens" } },
          undefined,
          new Headers(),
        ),
      )
      .mockResolvedValue(okResponse);
    const model = `output-cap-fixture-openai-${message.length}`;
    const provider = LLMProviderFactory.createProviderFromConfig({
      type: "openai",
      model,
      openaiApiKey: "sk-fixture",
    });

    await provider.createMessage(request(model, 48_000));

    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage.mock.calls[1][0].maxTokens).toBeLessThanOrEqual(16_384);
  });

  it("never lets the retry loop replay an output-cap error unchanged", () => {
    expect(classifyProviderError(anthropicCapError())).toMatchObject({
      retryable: false,
      failoverEligible: false,
      reason: "invalid_request",
    });
  });
});

describe("detailed LLM call logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports cached input tokens on the success line", async () => {
    vi.spyOn(OpenAIProvider.prototype, "createMessage").mockResolvedValue({
      ...okResponse,
      usage: { inputTokens: 12_000, outputTokens: 40, cachedTokens: 11_264 },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider = LLMProviderFactory.createProviderFromConfig({
      type: "openai",
      model: "cache-telemetry-fixture",
      openaiApiKey: "sk-fixture",
    });

    await provider.createMessage(request("cache-telemetry-fixture", 1_000));

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[LLM:openai\] #\d+ success in \d+ms$/),
      expect.objectContaining({ inputTokens: 12_000, cachedTokens: 11_264, outputTokens: 40 }),
    );
  });
});
