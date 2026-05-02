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
            content: [
              { type: "input_text", text: "Current time: 2026-04-04T10:00:00Z" },
            ],
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
      }),
    );
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
