import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProviderConfig, LLMRequest } from "../types";
import { OpenAIProvider, resetPromptCacheRejectionsForTests } from "../openai-provider";

const responsesCreateMock = vi.fn();
const openAIConstructorMock = vi.fn();
const getAccessTokenMock = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function OpenAIClientMock(options: Any) {
    openAIConstructorMock(options);
    this.responses = {
      create: (...args: Any[]) => responsesCreateMock(...args),
    };
  }),
}));

vi.mock("../pi-ai-loader", () => ({
  loadPiAiModule: vi.fn(),
}));

vi.mock("../openai-siwc-oauth", () => ({
  SIWC_RESOURCE: "https://api.openai.com/v1",
  siwcFetch: (url: string, init?: RequestInit) => fetch(url, init),
  OpenAISiwcError: class OpenAISiwcError extends Error {},
  OpenAISiwcOAuth: {
    getAccessToken: (...args: Any[]) => getAccessTokenMock(...args),
  },
}));

function makeConfig(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    type: "openai",
    model: "gpt-6-astra",
    openaiAccessToken: "siwc-access",
    openaiRefreshToken: "siwc-refresh",
    openaiTokenExpiresAt: Date.now() + 3_600_000,
    openaiSiwcClientId: "oaiapp_test",
    ...overrides,
  };
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "gpt-6-astra",
    maxTokens: 512,
    system: "stable system prompt",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

async function* streamOf(events: Any[]) {
  for (const event of events) yield event;
}

describe("OpenAIProvider Sign in with ChatGPT", () => {
  beforeEach(() => {
    resetPromptCacheRejectionsForTests();
    vi.clearAllMocks();
    getAccessTokenMock.mockResolvedValue({ accessToken: "siwc-access" });
  });

  it("builds a Responses body that satisfies the SIWC preview route", () => {
    const provider = new OpenAIProvider(makeConfig());
    const body = provider.buildSiwcResponsesBody(
      makeRequest({
        systemBlocks: [
          { text: "stable", scope: "session", cacheable: true, stableKey: "a" },
          { text: "volatile turn context", scope: "turn", cacheable: false, stableKey: "b" },
        ] as Any,
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            input_schema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "contents" }],
          },
        ],
      }),
    );

    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("prompt_cache_retention");
    expect(body.input.some((item: Any) => item.role === "system")).toBe(false);
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: "namespace",
        name: "cowork",
        tools: [expect.objectContaining({ type: "function", name: "read_file" })],
      }),
    ]);
    const call = body.input.find((item: Any) => item.type === "function_call");
    const output = body.input.find((item: Any) => item.type === "function_call_output");
    expect(call).toMatchObject({ namespace: "cowork", call_id: "call_1" });
    expect(output).toMatchObject({ namespace: "cowork", call_id: "call_1" });
  });

  it("maps the ChatGPT-only ultra effort to the public max effort", () => {
    const provider = new OpenAIProvider(makeConfig({ openaiReasoningEffort: "ultra" }));
    const body = provider.buildSiwcResponsesBody(makeRequest());
    expect(body.reasoning).toEqual({ effort: "max" });
  });

  it("streams from the public Responses API and returns the completed response", async () => {
    responsesCreateMock.mockResolvedValue(
      streamOf([
        { type: "response.created", response: { id: "resp_1" } },
        {
          type: "response.completed",
          response: {
            output: [
              { type: "message", content: [{ type: "output_text", text: "Hello!" }] },
              {
                type: "function_call",
                namespace: "cowork",
                call_id: "call_2",
                name: "read_file",
                arguments: '{"path":"b"}',
              },
            ],
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        },
      ]),
    );
    const provider = new OpenAIProvider(makeConfig());

    const response = await provider.createMessage(makeRequest());

    expect(openAIConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "siwc-access",
        baseURL: "https://api.openai.com/v1",
        maxRetries: 0,
      }),
    );
    expect(getAccessTokenMock).toHaveBeenCalledWith(
      "oaiapp_test",
      expect.objectContaining({ refresh_token: "siwc-refresh" }),
    );
    expect(response.content).toEqual([
      { type: "text", text: "Hello!" },
      { type: "tool_use", id: "call_2", name: "read_file", input: { path: "b" } },
    ]);
    expect(response.stopReason).toBe("tool_use");
  });

  it("rebuilds output from streamed items when response.completed omits it", async () => {
    responsesCreateMock.mockResolvedValue(
      streamOf([
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "message", content: [{ type: "output_text", text: "Streamed answer" }] },
        },
        { type: "response.completed", response: { output: [], usage: { output_tokens: 3 } } },
      ]),
    );
    const provider = new OpenAIProvider(makeConfig());

    const response = await provider.createMessage(makeRequest());

    expect(response.content).toEqual([{ type: "text", text: "Streamed answer" }]);
  });

  it("falls back to streamed text deltas when no output items arrive", async () => {
    responsesCreateMock.mockResolvedValue(
      streamOf([
        { type: "response.output_text.delta", delta: "Hel" },
        { type: "response.output_text.delta", delta: "lo" },
        { type: "response.completed", response: {} },
      ]),
    );
    const provider = new OpenAIProvider(makeConfig());

    const response = await provider.createMessage(makeRequest());

    expect(response.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("stops sending prompt-cache fields after the route rejects the key itself", async () => {
    responsesCreateMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Unsupported parameter: prompt_cache_key"), { status: 400 }),
      )
      .mockImplementation(async () =>
        streamOf([{ type: "response.completed", response: { output: [] } }]),
      );
    const request = makeRequest({
      promptCache: { mode: "openai_key", cacheKey: "task-1", ttl: "5m" } as Any,
    });

    // Separate provider instances, as CoWork creates one per task.
    await new OpenAIProvider(makeConfig()).createMessage(request);
    await new OpenAIProvider(makeConfig()).createMessage(request);

    // One rejected attempt, then cache-free requests only.
    expect(responsesCreateMock).toHaveBeenCalledTimes(3);
    expect(responsesCreateMock.mock.calls[1][0]).not.toHaveProperty("prompt_cache_key");
    expect(responsesCreateMock.mock.calls[2][0]).not.toHaveProperty("prompt_cache_key");
  });

  it("keeps prompt_cache_key when only the modern cache options are rejected", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      responsesCreateMock
        .mockRejectedValueOnce(
          Object.assign(new Error("400 Unsupported parameter: 'prompt_cache_options'."), {
            status: 400,
          }),
        )
        .mockImplementation(async () =>
          streamOf([
            {
              type: "response.completed",
              response: {
                output: [],
                usage: {
                  input_tokens: 9_000,
                  output_tokens: 10,
                  input_tokens_details: { cached_tokens: 8_192 },
                },
              },
            },
          ]),
        );
      const request = makeRequest({
        model: "gpt-5.6-luna",
        promptCache: { mode: "openai_key", cacheKey: "task-1", ttl: "5m" } as Any,
      });

      await new OpenAIProvider(makeConfig({ model: "gpt-5.6-luna" })).createMessage(request);
      const response = await new OpenAIProvider(
        makeConfig({ model: "gpt-5.6-luna" }),
      ).createMessage(request);

      expect(responsesCreateMock).toHaveBeenCalledTimes(3);
      expect(responsesCreateMock.mock.calls[0][0]).toHaveProperty("prompt_cache_options");
      for (const call of responsesCreateMock.mock.calls.slice(1)) {
        expect(call[0].prompt_cache_key).toBe("task-1");
        expect(call[0]).not.toHaveProperty("prompt_cache_options");
      }
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SIWC prompt cache controls rejected"),
        expect.objectContaining({
          model: "gpt-5.6-luna",
          status: 400,
          nextTier: "key_only",
          providerMessage: expect.stringContaining("prompt_cache_options"),
        }),
      );
      // Cached input tokens reach LLMResponse usage for cost accounting.
      expect(response.usage).toMatchObject({ inputTokens: 9_000, cachedTokens: 8_192 });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("remembers SIWC cache tiers per model", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      responsesCreateMock
        .mockRejectedValueOnce(
          Object.assign(new Error("Unsupported parameter: prompt_cache_options"), { status: 400 }),
        )
        .mockImplementation(async () =>
          streamOf([{ type: "response.completed", response: { output: [] } }]),
        );
      const cache = { mode: "openai_key", cacheKey: "task-1", ttl: "5m" } as Any;

      await new OpenAIProvider(makeConfig({ model: "gpt-5.6-luna" })).createMessage(
        makeRequest({ model: "gpt-5.6-luna", promptCache: cache }),
      );
      await new OpenAIProvider(makeConfig()).createMessage(makeRequest({ promptCache: cache }));

      // A rejection for gpt-5.6-luna does not downgrade gpt-6-astra.
      expect(responsesCreateMock.mock.calls[2][0]).toMatchObject({
        model: "gpt-6-astra",
        prompt_cache_key: "task-1",
        prompt_cache_options: { mode: "implicit", ttl: "30m" },
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("lists the plan catalog plus known-working unlisted models", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          models: [
            { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
            { slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list" },
            { slug: "gpt-reserve", display_name: "Reserve", visibility: "hide" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const models = await new OpenAIProvider(makeConfig()).getAvailableModels();
      expect(models.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-5.5"]);
      expect(models[1].description).toContain("not in OpenAI's list");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces usage-limit failures as non-retryable actionable errors", async () => {
    responsesCreateMock.mockResolvedValue(
      streamOf([
        {
          type: "response.failed",
          response: {
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "limit reached",
            },
          },
        },
      ]),
    );
    const provider = new OpenAIProvider(makeConfig());

    await expect(provider.createMessage(makeRequest())).rejects.toMatchObject({
      code: "subscription_sharing_usage_limit_exceeded",
      retryable: false,
      message: expect.stringContaining("usage limit"),
    });
  });

  it("treats a stream that never completes as a retryable interruption", async () => {
    responsesCreateMock.mockResolvedValue(streamOf([{ type: "response.created" }]));
    const provider = new OpenAIProvider(makeConfig());

    await expect(provider.createMessage(makeRequest())).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("persists rotated tokens after a refresh", async () => {
    const updater = vi.fn();
    getAccessTokenMock.mockResolvedValue({
      accessToken: "new-access",
      newTokens: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_at: 123,
        id_token: "new-id",
      },
    });
    responsesCreateMock.mockResolvedValue(
      streamOf([{ type: "response.completed", response: { output: [] } }]),
    );
    const provider = new OpenAIProvider(makeConfig({ openaiOAuthTokenUpdater: updater }));

    await provider.createMessage(makeRequest());

    expect(updater).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_at: 123,
        id_token: "new-id",
      }),
    );
  });
});
