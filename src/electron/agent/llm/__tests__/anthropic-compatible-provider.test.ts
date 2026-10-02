import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnthropicCompatibleProvider } from "../anthropic-compatible-provider";
import type { LLMRequest } from "../types";

function mockUnauthorizedResponse(message = "unauthorized"): Response {
  return {
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    json: vi.fn().mockResolvedValue({ error: { message } }),
  } as unknown as Response;
}

describe("AnthropicCompatibleProvider URL resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses /v1/messages when base URL has no version segment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockUnauthorizedResponse());
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider({
      type: "minimax-portal",
      providerName: "MiniMax Portal",
      apiKey: "minimax-test",
      baseUrl: "https://api.minimax.io/anthropic",
      defaultModel: "MiniMax-M2.1",
    });

    await provider.testConnection();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimax.io/anthropic/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses /messages when base URL already ends with /v1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockUnauthorizedResponse());
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider({
      type: "qwen-portal",
      providerName: "Qwen",
      apiKey: "qwen-test",
      baseUrl: "https://portal.qwen.ai/v1",
      defaultModel: "qwen-model",
    });

    await provider.testConnection();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://portal.qwen.ai/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses the base URL directly when it already ends with /messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockUnauthorizedResponse());
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider({
      type: "anthropic-compatible",
      providerName: "Anthropic-Compatible",
      apiKey: "test-key",
      baseUrl: "https://example.com/custom/messages",
      defaultModel: "custom-model",
    });

    await provider.testConnection();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/custom/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends bearer auth alongside x-api-key for compatible gateways", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockUnauthorizedResponse());
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider({
      type: "anthropic-compatible",
      providerName: "Anthropic-Compatible",
      apiKey: "test-key",
      baseUrl: "https://example.com/anthropic",
      defaultModel: "custom-model",
    });

    await provider.testConnection();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/anthropic/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "test-key",
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it("surfaces simple gateway error strings during connection tests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        statusText: "Payment Required",
        json: vi.fn().mockResolvedValue({
          error: "Insufficient balance",
          status: 402,
        }),
      } as unknown as Response),
    );

    const provider = new AnthropicCompatibleProvider({
      type: "anthropic-compatible",
      providerName: "Anthropic-Compatible",
      apiKey: "test-key",
      baseUrl: "https://example.com/anthropic",
      defaultModel: "custom-model",
    });

    await expect(provider.testConnection()).resolves.toEqual({
      success: false,
      error: "Insufficient balance",
    });
  });

  it("uses /v1/models when refreshing models from an unversioned Anthropic-compatible base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ id: "MiniMax-M2.5", display_name: "MiniMax M2.5" }],
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider({
      type: "minimax-portal",
      providerName: "MiniMax Portal",
      apiKey: "minimax-test",
      baseUrl: "https://api.minimax.io/anthropic",
      defaultModel: "MiniMax-M2.1",
    });

    await expect(provider.getAvailableModels()).resolves.toEqual([
      { id: "MiniMax-M2.5", name: "MiniMax M2.5" },
    ]);

    expect(fetchMock).toHaveBeenCalledWith("https://api.minimax.io/anthropic/v1/models", {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": "minimax-test",
        Authorization: "Bearer minimax-test",
      },
    });
  });
});

describe("AnthropicCompatibleProvider tool sequencing", () => {
  let capturedBody: Any = null;

  beforeEach(() => {
    capturedBody = null;
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits orphan tool_result blocks before provider conversion", async () => {
    const provider = new AnthropicCompatibleProvider({
      type: "minimax-portal",
      providerName: "MiniMax Portal",
      apiKey: "test-key",
      baseUrl: "https://example.com/anthropic",
      defaultModel: "MiniMax-M2.5-highspeed",
    });

    const request: LLMRequest = {
      model: "MiniMax-M2.5-highspeed",
      maxTokens: 64,
      system: "system",
      messages: [
        { role: "user", content: "start" },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "missing_tool_use",
              content: '{"error":"orphan"}',
              is_error: true,
            },
          ],
        },
      ],
    };

    await provider.createMessage(request);

    expect(capturedBody.messages).toHaveLength(2);
    expect(capturedBody.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
  });

  it("never ends a request with an assistant prefill turn for Claude models that reject it", async () => {
    const provider = new AnthropicCompatibleProvider({
      type: "anthropic-compatible",
      providerName: "Anthropic-Compatible",
      apiKey: "test-key",
      baseUrl: "https://example.com/anthropic",
      defaultModel: "claude-opus-4-6",
    });

    await provider.createMessage({
      model: "claude-opus-4-6",
      maxTokens: 64,
      system: "system",
      messages: [
        { role: "user", content: "start" },
        { role: "assistant", content: [{ type: "text", text: "partial" }] },
      ],
    });

    expect(capturedBody.messages.at(-1).role).toBe("user");
    expect(capturedBody.messages.at(-2)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
    });
  });

  it("omits assistant tool_use blocks when the next user turn does not immediately return a matching tool_result", async () => {
    const provider = new AnthropicCompatibleProvider({
      type: "minimax-portal",
      providerName: "MiniMax Portal",
      apiKey: "test-key",
      baseUrl: "https://example.com/anthropic",
      defaultModel: "MiniMax-M2.5-highspeed",
    });

    const request: LLMRequest = {
      model: "MiniMax-M2.5-highspeed",
      maxTokens: 64,
      system: "system",
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_missing_result",
              name: "read_file",
              input: { path: "a.ts" },
            },
          ],
        },
        { role: "user", content: "no tool results here" },
      ],
    };

    await provider.createMessage(request);

    expect(capturedBody.messages).toEqual([
      { role: "user", content: "start" },
      { role: "user", content: "no tool results here" },
    ]);
  });
});

describe("AnthropicCompatibleProvider prompt caching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serializes automatic prompt caching and normalizes cache usage", async () => {
    let capturedBody: Any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 100,
              output_tokens: 25,
              cache_read_input_tokens: 60,
              cache_creation_input_tokens: 40,
            },
          }),
        } as Response;
      }),
    );

    const provider = new AnthropicCompatibleProvider({
      type: "anthropic-compatible",
      providerName: "Anthropic-Compatible",
      apiKey: "test-key",
      baseUrl: "https://example.com/anthropic",
      defaultModel: "claude-sonnet-4-5",
    });

    const response = await provider.createMessage({
      model: "claude-sonnet-4-5",
      maxTokens: 128,
      system: "legacy system",
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
        mode: "anthropic_auto",
        ttl: "5m",
        explicitRecentMessages: 3,
      },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(capturedBody.cache_control).toEqual({ type: "ephemeral" });
    expect(capturedBody.system).toEqual([
      { type: "text", text: "Stable instructions" },
      { type: "text", text: "Current time: 2026-04-04T10:00:00Z" },
    ]);
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cachedTokens: 60,
      cacheWriteTokens: 40,
    });
  });

  it("downgrades unsupported automatic caching to explicit cache breakpoints", async () => {
    const requestBodies: Any[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        requestBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: async () => ({
            error: {
              message: "cache_control is not supported on this endpoint",
            },
          }),
        } as Response;
      })
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        requestBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        } as Response;
      });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider({
      type: "anthropic-compatible",
      providerName: "Anthropic-Compatible",
      apiKey: "test-key",
      baseUrl: "https://example.com/anthropic",
      defaultModel: "claude-sonnet-4-5",
    });

    await provider.createMessage({
      model: "claude-sonnet-4-5",
      maxTokens: 128,
      system: "legacy system",
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
        mode: "anthropic_auto",
        ttl: "5m",
        explicitRecentMessages: 3,
      },
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: "continue" },
      ],
    });

    expect(requestBodies[0].cache_control).toEqual({ type: "ephemeral" });
    expect(requestBodies[1].cache_control).toBeUndefined();
    expect(requestBodies[1].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(requestBodies[1].messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(requestBodies[1].messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(requestBodies[1].messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not send managed prompt-cache controls to NanoGPT", async () => {
    let capturedBody: Any = null;
    let capturedHeaders: HeadersInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        capturedHeaders = init?.headers;
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        } as Response;
      }),
    );

    const provider = new AnthropicCompatibleProvider({
      type: "anthropic-compatible",
      providerName: "Anthropic-Compatible",
      apiKey: "test-key",
      baseUrl: "https://nano-gpt.com/api/v1",
      defaultModel: "moonshotai/kimi-k2.6:thinking",
    });

    await provider.createMessage({
      model: "moonshotai/kimi-k2.6:thinking",
      maxTokens: 4096,
      system: "legacy system",
      systemBlocks: [
        {
          text: "Stable instructions",
          scope: "session",
          cacheable: true,
          stableKey: "identity:1",
        },
      ],
      promptCache: {
        mode: "anthropic_auto",
        ttl: "5m",
        explicitRecentMessages: 3,
      },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(capturedBody.cache_control).toBeUndefined();
    expect(capturedBody.system).toEqual([{ type: "text", text: "Stable instructions" }]);
    expect(capturedBody.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(capturedHeaders).toEqual(
      expect.objectContaining({
        "x-api-key": "test-key",
        Authorization: "Bearer test-key",
      }),
    );
  });
});
