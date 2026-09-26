import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProviderConfig, LLMRequest } from "../types";
import { OpenAIProvider } from "../openai-provider";

const completeMock = vi.fn();
const getModelsMock = vi.fn();
const getApiKeyFromTokensMock = vi.fn();
const loadPiAiModuleMock = vi.fn();
const chatCompletionsCreateMock = vi.fn();
const responsesCreateMock = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function OpenAIClientMock() {
    this.chat = {
      completions: {
        create: (...args: Any[]) => chatCompletionsCreateMock(...args),
      },
    };
    this.responses = {
      create: (...args: Any[]) => responsesCreateMock(...args),
    };
  }),
}));

vi.mock("../pi-ai-loader", () => ({
  loadPiAiModule: (...args: Any[]) => loadPiAiModuleMock(...args),
}));

vi.mock("../openai-oauth", () => ({
  OpenAIOAuth: {
    getApiKeyFromTokens: (...args: Any[]) => getApiKeyFromTokensMock(...args),
  },
}));

function makeConfig(): LLMProviderConfig {
  return {
    type: "openai",
    model: "gpt-5.3-codex-spark",
    openaiAccessToken: "header.payload.signature",
    openaiRefreshToken: "refresh-token",
    openaiTokenExpiresAt: Date.now() + 60_000,
  };
}

function makeRequest(): LLMRequest {
  return {
    model: "gpt-5.3-codex-spark",
    maxTokens: 512,
    system: "system",
    messages: [{ role: "user", content: "test" }],
  };
}

describe("OpenAIProvider structured errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getModelsMock.mockReturnValue([{ id: "gpt-5.3-codex-spark" }]);
    getApiKeyFromTokensMock.mockResolvedValue({ apiKey: "test-key", newTokens: null });
    loadPiAiModuleMock.mockResolvedValue({
      getModels: (...args: Any[]) => getModelsMock(...args),
      complete: (...args: Any[]) => completeMock(...args),
    });
  });

  it("returns and replays encrypted reasoning within the current turn", async () => {
    responsesCreateMock.mockResolvedValue({
      model: "gpt-5.5",
      output: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.5",
      openaiApiKey: "sk-test",
      openaiReasoningEffort: "high",
    });

    const first = await provider.createMessage({
      model: "gpt-5.5",
      maxTokens: 64,
      messages: [{ role: "user", content: "check status" }],
    });
    expect(responsesCreateMock.mock.calls[0][0].include).toEqual(["reasoning.encrypted_content"]);
    expect(first.reasoning).toHaveLength(1);

    await provider.createMessage({
      model: "gpt-5.5",
      maxTokens: 64,
      messages: [
        { role: "user", content: "check status" },
        { role: "assistant", content: first.content, reasoning: first.reasoning },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
      ],
    });
    const replayed = responsesCreateMock.mock.calls[1][0].input;
    expect(replayed).toContainEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "enc-1",
    });
    expect(replayed.findIndex((item: Any) => item.type === "reasoning")).toBeLessThan(
      replayed.findIndex((item: Any) => item.type === "function_call"),
    );
  });

  it("uses Responses API with reasoning, verbosity, tools, prompt cache, and replayed phase for API-key GPT-5 models", async () => {
    responsesCreateMock.mockResolvedValue({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "checking" }],
        },
        {
          type: "function_call",
          call_id: "call_lookup",
          name: "lookup",
          arguments: '{"query":"status"}',
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        input_tokens_details: {
          cached_tokens: 60,
          cache_creation_input_tokens: 40,
        },
      },
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.5",
      openaiApiKey: "sk-test",
      openaiReasoningEffort: "high",
      openaiTextVerbosity: "low",
    });

    const response = await provider.createMessage({
      model: "gpt-5.5",
      maxTokens: 128,
      system: "Stable instructions\n\nCurrent time: 2026-04-04T10:00:00Z",
      systemBlocks: [
        {
          text: "Stable instructions",
          scope: "session",
          cacheable: true,
          stableKey: "identity:1",
        },
        {
          text: "Current time: 2026-04-04T10:00:00Z",
          scope: "turn",
          cacheable: false,
          stableKey: "time:1",
        },
      ],
      promptCache: {
        mode: "openai_key",
        ttl: "1h",
        explicitRecentMessages: 3,
        cacheKey: "stable-prefix-hash",
        retention: "24h",
      },
      messages: [
        {
          role: "assistant",
          phase: "commentary",
          content: [{ type: "text", text: "I will check status." }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", data: "base64-image", mimeType: "image/png" },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Lookup status",
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      ],
    });

    expect(chatCompletionsCreateMock).not.toHaveBeenCalled();
    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.5",
        instructions: "Stable instructions",
        max_output_tokens: 128,
        reasoning: { effort: "high" },
        text: { verbosity: "low" },
        prompt_cache_key: "stable-prefix-hash",
        prompt_cache_retention: "24h",
        tool_choice: "auto",
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Lookup status",
            parameters: expect.objectContaining({ type: "object" }),
          },
        ],
        input: [
          {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: "Current time: 2026-04-04T10:00:00Z" }],
          },
          {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "I will check status." }],
          },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "hello" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,base64-image",
              },
            ],
          },
        ],
      }),
      undefined,
    );
    expect(response).toEqual({
      content: [
        { type: "text", text: "checking" },
        {
          type: "tool_use",
          id: "call_lookup",
          name: "lookup",
          input: { query: "status" },
        },
      ],
      stopReason: "tool_use",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cachedTokens: 60,
        cacheWriteTokens: 40,
      },
    });
  });

  it("uses Responses API controls for other GPT-5-family OpenAI API-key models", async () => {
    responsesCreateMock.mockResolvedValue({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.4",
      openaiApiKey: "sk-test",
      openaiReasoningEffort: "low",
      openaiTextVerbosity: "high",
    });

    await provider.createMessage({
      model: "gpt-5.4",
      maxTokens: 64,
      messages: [{ role: "user", content: "test" }],
    });

    expect(chatCompletionsCreateMock).not.toHaveBeenCalled();
    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        reasoning: { effort: "low" },
        text: { verbosity: "high" },
      }),
      undefined,
    );
  });

  it("preserves OpenAI Responses tool siblings when one has rejected arguments", async () => {
    responsesCreateMock.mockResolvedValue({
      output: [
        {
          type: "function_call",
          call_id: "call_bad",
          name: "write_file",
          arguments: '{"path":',
        },
        {
          type: "function_call",
          call_id: "call_good",
          name: "read_file",
          arguments: '{"path":"a.ts"}',
        },
        {
          type: "function_call",
          call_id: "call_scalar",
          name: "glob",
          arguments: "42",
        },
      ],
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.5",
      openaiApiKey: "sk-test",
    });

    const response = await provider.createMessage({
      model: "gpt-5.5",
      maxTokens: 64,
      messages: [{ role: "user", content: "inspect the file" }],
    });

    expect(response.content).toEqual([
      {
        type: "tool_use",
        id: "call_bad",
        name: "write_file",
        input: {},
        inputError: {
          code: "malformed_json",
          message: "Tool call arguments must be valid JSON.",
        },
      },
      {
        type: "tool_use",
        id: "call_good",
        name: "read_file",
        input: { path: "a.ts" },
      },
      {
        type: "tool_use",
        id: "call_scalar",
        name: "glob",
        input: {},
        inputError: {
          code: "invalid_shape",
          message: "Tool call arguments must be a JSON object.",
        },
      },
    ]);
    expect(response.stopReason).toBe("tool_use");
  });

  it("rejects malformed OpenAI Chat Completions arguments without dropping valid siblings", async () => {
    chatCompletionsCreateMock.mockResolvedValue({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              {
                type: "function",
                id: "call_bad",
                function: { name: "write_file", arguments: "null" },
              },
              {
                type: "function",
                id: "call_good",
                function: { name: "read_file", arguments: '{"path":"a.ts"}' },
              },
            ],
          },
        },
      ],
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-4o",
      openaiApiKey: "sk-test",
    });

    const response = await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 64,
      messages: [{ role: "user", content: "inspect the file" }],
    });

    expect(response.content).toEqual([
      {
        type: "tool_use",
        id: "call_bad",
        name: "write_file",
        input: {},
        inputError: {
          code: "invalid_shape",
          message: "Tool call arguments must be a JSON object.",
        },
      },
      {
        type: "tool_use",
        id: "call_good",
        name: "read_file",
        input: { path: "a.ts" },
      },
    ]);
  });

  it("routes GPT-6 Astra API-key calls through Responses with modern cache controls", async () => {
    responsesCreateMock.mockResolvedValue({
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: 15_000,
        output_tokens: 12,
        input_tokens_details: { cached_tokens: 12_000, cache_write_tokens: 3_000 },
      },
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-6-astra",
      openaiApiKey: "sk-test",
      openaiReasoningEffort: "ultra",
    });

    const response = await provider.createMessage({
      model: "gpt-6-astra",
      maxTokens: 128,
      system: "Stable instructions",
      promptCache: {
        mode: "openai_key",
        ttl: "1h",
        explicitRecentMessages: 3,
        cacheKey: "astra-session",
        retention: "24h",
      },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(chatCompletionsCreateMock).not.toHaveBeenCalled();
    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-6-astra",
        reasoning: { effort: "max" },
        prompt_cache_key: "astra-session",
        prompt_cache_options: { mode: "implicit", ttl: "30m" },
      }),
      undefined,
    );
    expect(responsesCreateMock.mock.calls[0][0].prompt_cache_retention).toBeUndefined();
    expect(response.usage).toEqual({
      inputTokens: 15_000,
      outputTokens: 12,
      cachedTokens: 12_000,
      cacheWriteTokens: 3_000,
    });
  });

  it.each(["gpt-6-sol", "gpt-6-luna"])(
    "routes %s API-key tool calls through Responses",
    async (model) => {
      responsesCreateMock.mockResolvedValue({
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      });
      const provider = new OpenAIProvider({
        type: "openai",
        model,
        openaiApiKey: "sk-test",
        openaiReasoningEffort: "max",
      });

      await provider.createMessage({
        model: `openai/${model}@fast`,
        maxTokens: 128,
        messages: [{ role: "user", content: "hello" }],
      });

      expect(chatCompletionsCreateMock).not.toHaveBeenCalled();
      expect(responsesCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({ model, reasoning: { effort: "max" } }),
        undefined,
      );
    },
  );

  it("retries a Responses request without cache controls when the endpoint rejects them", async () => {
    responsesCreateMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Unknown parameter: prompt_cache_options"), { status: 400 }),
      )
      .mockResolvedValueOnce({
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.6-sol",
      openaiApiKey: "sk-test",
    });

    await provider.createMessage({
      model: "gpt-5.6-sol",
      maxTokens: 64,
      system: "system",
      promptCache: {
        mode: "openai_key",
        ttl: "5m",
        explicitRecentMessages: 3,
        cacheKey: "stable-prefix",
      },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(responsesCreateMock).toHaveBeenCalledTimes(2);
    expect(responsesCreateMock.mock.calls[0][0]).toHaveProperty("prompt_cache_key");
    expect(responsesCreateMock.mock.calls[1][0]).not.toHaveProperty("prompt_cache_key");
  });

  it("strips provider and profile routing suffixes before an Astra API request", async () => {
    responsesCreateMock.mockResolvedValue({
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-6-astra",
      openaiApiKey: "sk-test",
    });

    await provider.createMessage({
      model: "openai/gpt-6-astra@fast",
      maxTokens: 64,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-6-astra" }),
      undefined,
    );
  });

  it("sends prompt_cache_key with a split stable/turn system prefix for API-key requests", async () => {
    chatCompletionsCreateMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 25,
        prompt_tokens_details: {
          cached_tokens: 60,
          cache_creation_input_tokens: 40,
        },
      },
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-4o",
      openaiApiKey: "sk-test",
    });

    const response = await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 128,
      system: "Stable instructions\n\nCurrent time: 2026-04-04T10:00:00Z",
      systemBlocks: [
        {
          text: "Stable instructions",
          scope: "session",
          cacheable: true,
          stableKey: "identity:1",
        },
        {
          text: "Current time: 2026-04-04T10:00:00Z",
          scope: "turn",
          cacheable: false,
          stableKey: "time:1",
        },
      ],
      promptCache: {
        mode: "openai_key",
        ttl: "1h",
        explicitRecentMessages: 3,
        cacheKey: "stable-prefix-hash",
        retention: "24h",
      },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(chatCompletionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o",
        prompt_cache_key: "stable-prefix-hash",
        prompt_cache_retention: "24h",
        messages: [
          { role: "system", content: "Stable instructions" },
          { role: "system", content: "Current time: 2026-04-04T10:00:00Z" },
          { role: "user", content: "hello" },
        ],
      }),
      undefined,
    );
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cachedTokens: 60,
      cacheWriteTokens: 40,
    });
  });

  it("uses max_completion_tokens for newer OpenAI chat-completions models", async () => {
    chatCompletionsCreateMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
      },
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "o1",
      openaiApiKey: "sk-test",
    });

    await provider.createMessage({
      model: "o1",
      maxTokens: 128,
      system: "system",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(chatCompletionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        max_completion_tokens: 128,
      }),
      undefined,
    );
  });

  it("honors toolChoice=none for API-key requests", async () => {
    chatCompletionsCreateMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
      },
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-4o",
      openaiApiKey: "sk-test",
    });

    await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 128,
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "write_file",
          description: "Write a file",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      ],
      toolChoice: "none",
    });

    expect(chatCompletionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: "none",
        tools: expect.any(Array),
      }),
      undefined,
    );
  });

  it("marks terminated OAuth stopReason errors as retryable", async () => {
    completeMock.mockResolvedValue({
      stopReason: "error",
      errorMessage: "terminated",
      content: [],
    });

    const provider = new OpenAIProvider(makeConfig());
    const request = makeRequest();

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      phase: "oauth",
      code: "PI_AI_ERROR",
    });
  });

  it("wraps stream interruption exceptions with retryable metadata", async () => {
    completeMock.mockRejectedValue(new Error("stream disconnected by upstream"));

    const provider = new OpenAIProvider(makeConfig());
    const request = makeRequest();

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      phase: "oauth",
    });
  });

  it("marks OAuth fetch transport failures as retryable", async () => {
    completeMock.mockResolvedValue({
      stopReason: "error",
      errorMessage: "fetch failed",
      content: [],
    });

    const provider = new OpenAIProvider(makeConfig());
    const request = makeRequest();

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      phase: "oauth",
      code: "PI_AI_ERROR",
    });
  });

  it("marks overloaded Codex service errors as retryable", async () => {
    completeMock.mockRejectedValue(
      new Error(
        'Codex error: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null},"sequence_number":2}',
      ),
    );

    const provider = new OpenAIProvider(makeConfig());
    const request = makeRequest();

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      phase: "oauth",
    });
  });

  it("marks temporarily unavailable provider errors as retryable", async () => {
    completeMock.mockRejectedValue(new Error("The provider is temporarily unavailable"));

    const provider = new OpenAIProvider(makeConfig());
    const request = makeRequest();

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      phase: "oauth",
    });
  });

  it("accepts OpenClaw-style openai-codex model refs for ChatGPT subscription requests", async () => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    getModelsMock.mockReturnValue([{ id: "gpt-5.1-codex-mini" }]);

    const provider = new OpenAIProvider({
      ...makeConfig(),
      model: "openai-codex/gpt-5.4",
    });

    await provider.createMessage({
      ...makeRequest(),
      model: "openai-codex/gpt-5.4",
      promptCache: {
        mode: "openai_key",
        ttl: "1h",
        explicitRecentMessages: 3,
        cacheKey: "codex-session",
      },
    });

    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gpt-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
      }),
      expect.any(Object),
      expect.objectContaining({
        sessionId: "codex-session",
        cacheRetention: "long",
      }),
    );
  });

  it.each([
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ])("routes ChatGPT subscription model %s through the Codex compatibility shim", async (model) => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    getModelsMock.mockReturnValue([{ id: "gpt-5.5" }]);
    const provider = new OpenAIProvider({ ...makeConfig(), model });

    await provider.createMessage({ ...makeRequest(), model });

    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: model,
        api: "openai-codex-responses",
        provider: "openai-codex",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("forwards GPT-5.6 Ultra reasoning and response verbosity to the ChatGPT backend", async () => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    getModelsMock.mockReturnValue([{ id: "gpt-5.5" }]);
    const provider = new OpenAIProvider({
      ...makeConfig(),
      model: "gpt-5.6-sol",
      openaiReasoningEffort: "ultra",
      openaiTextVerbosity: "high",
    });

    await provider.createMessage({
      ...makeRequest(),
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      textVerbosity: "high",
    });

    expect(completeMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        reasoningEffort: "ultra",
        textVerbosity: "high",
      }),
    );
  });

  it.each(["absent", "disabled", "rejected"] as const)(
    "preserves every system block when OAuth cache controls are %s",
    async (cacheState) => {
      completeMock.mockResolvedValue({
        stopReason: "stop",
        content: [{ type: "text", text: "ok" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      });
      if (cacheState === "rejected") {
        completeMock.mockResolvedValueOnce({
          stopReason: "error",
          errorMessage: "Unsupported parameter: prompt_cache_key",
        });
      }
      const provider = new OpenAIProvider(makeConfig());
      const request: LLMRequest = {
        ...makeRequest(),
        system: "Stable instructions\n\nCurrent turn: only modify the scratch CSV.",
        systemBlocks: [
          { text: "Stable instructions", scope: "session", cacheable: true },
          { text: "Current turn: only modify the scratch CSV.", scope: "turn", cacheable: false },
        ],
        promptCache:
          cacheState === "absent"
            ? undefined
            : {
                mode: cacheState === "disabled" ? "disabled" : "openai_key",
                ttl: "1h",
                explicitRecentMessages: 3,
                cacheKey: "test-context",
              },
      };
      await provider.createMessage(request);
      const context = completeMock.mock.calls.at(-1)?.[1];
      expect(context.systemPrompt).toBe(request.system);
      expect(JSON.stringify(context.messages)).not.toContain("Current turn:");
      expect(completeMock).toHaveBeenCalledTimes(cacheState === "rejected" ? 2 : 1);
      expect(request.messages).toEqual(makeRequest().messages);
    },
  );

  it("remembers an OAuth prompt-cache rejection for later turns", async () => {
    completeMock
      .mockResolvedValueOnce({
        stopReason: "error",
        errorMessage: "Unsupported parameter: prompt_cache_key",
      })
      .mockResolvedValue({
        stopReason: "stop",
        content: [{ type: "text", text: "ok" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      });
    const provider = new OpenAIProvider(makeConfig());
    const cachedRequest: LLMRequest = {
      ...makeRequest(),
      promptCache: {
        mode: "openai_key",
        ttl: "1h",
        explicitRecentMessages: 3,
        cacheKey: "unsupported-session",
      },
    };

    await provider.createMessage(cachedRequest);
    await provider.createMessage(cachedRequest);

    expect(completeMock).toHaveBeenCalledTimes(3);
    const secondTurnOptions = completeMock.mock.calls[2]?.[2] as Any;
    expect(secondTurnOptions.cacheRetention).toBe("none");
    expect(secondTurnOptions.sessionId).toBeUndefined();
    expect(secondTurnOptions.onPayload).toBeUndefined();
  });

  it("includes turn-only context once when cache prefix splitting is enabled", async () => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    const provider = new OpenAIProvider(makeConfig());
    await provider.createMessage({
      ...makeRequest(),
      system: "Current turn context",
      systemBlocks: [{ text: "Current turn context", scope: "turn", cacheable: false }],
      promptCache: {
        mode: "openai_key",
        ttl: "1h",
        explicitRecentMessages: 3,
        cacheKey: "turn-only",
      },
    });
    const context = completeMock.mock.calls.at(-1)?.[1];
    expect(context.systemPrompt).toBeUndefined();
    expect(JSON.stringify(context.messages).match(/Current turn context/g)).toHaveLength(1);
  });

  it("injects modern cache-write options into the subscription transport payload", async () => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    getModelsMock.mockReturnValue([{ id: "gpt-5.6-sol" }]);
    const provider = new OpenAIProvider({ ...makeConfig(), model: "gpt-5.6-sol" });

    await provider.createMessage({
      ...makeRequest(),
      model: "gpt-5.6-sol",
      promptCache: {
        mode: "openai_key",
        ttl: "1h",
        explicitRecentMessages: 3,
        cacheKey: "codex-session",
      },
    });

    const options = completeMock.mock.calls.at(-1)?.[2] as Any;
    expect(options.cacheRetention).toBe("long");
    expect(options.sessionId).toBe("codex-session");
    expect(options.onPayload({ prompt_cache_key: "codex-session" })).toEqual({
      prompt_cache_key: "codex-session",
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
    });
  });

  it("forwards GPT-6 Astra Ultra reasoning and response verbosity to the ChatGPT backend", async () => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    getModelsMock.mockReturnValue([{ id: "gpt-5.5" }]);
    const provider = new OpenAIProvider({
      ...makeConfig(),
      model: "gpt-6-astra",
      openaiReasoningEffort: "ultra",
      openaiTextVerbosity: "high",
    });

    await provider.createMessage({
      ...makeRequest(),
      model: "gpt-6-astra",
      reasoningEffort: "ultra",
      textVerbosity: "high",
    });

    expect(completeMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        reasoningEffort: "ultra",
        textVerbosity: "high",
      }),
    );
  });

  it("includes GPT-6 and GPT-5.6 variants in the ChatGPT subscription model catalog", async () => {
    getModelsMock.mockReturnValue([{ id: "gpt-5.5", name: "GPT-5.5" }]);
    const provider = new OpenAIProvider(makeConfig());

    const models = await provider.getAvailableModels();

    expect(models.slice(0, 6).map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  it("persists refreshed ChatGPT OAuth credentials after an OAuth request", async () => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    const tokenUpdater = vi.fn();
    const newTokens = {
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_at: Date.now() + 120_000,
      accountId: "acct_new",
      email: "user@example.com",
    };
    getApiKeyFromTokensMock.mockResolvedValue({ apiKey: "test-key", newTokens });

    const provider = new OpenAIProvider({
      ...makeConfig(),
      openaiOAuthTokenUpdater: tokenUpdater,
    });

    await provider.createMessage(makeRequest());

    expect(tokenUpdater).toHaveBeenCalledWith(newTokens);
  });

  it("passes images through to ChatGPT subscription models and suppresses tools when requested", async () => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });

    const provider = new OpenAIProvider({
      ...makeConfig(),
      model: "gpt-5.4",
    });

    await provider.createMessage({
      ...makeRequest(),
      model: "gpt-5.4",
      toolChoice: "none",
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", data: "base64-image", mimeType: "image/png" },
          ],
        },
      ],
    });

    expect(completeMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: [
              { type: "text", text: "describe" },
              { type: "image", data: "base64-image", mimeType: "image/png" },
            ],
          }),
        ],
        tools: undefined,
      }),
      expect.any(Object),
    );
  });

  it("does not derive OAuth expiry from the JWT payload", () => {
    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.3-codex-spark",
      openaiAccessToken: "not-a-real-jwt",
      openaiRefreshToken: "refresh-token",
    });

    expect((provider as Any).oauthTokens?.expires_at).toBe(0);
  });
});
