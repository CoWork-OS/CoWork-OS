import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPENROUTER_DEFAULT_MODEL,
  OpenRouterProvider,
} from "../openrouter-provider";

function countCacheMarkers(messages: Any[]): number {
  return messages.reduce((count, message) => {
    let next = count + ((message as Any)?.cache_control ? 1 : 0);
    const content = (message as Any)?.content;
    if (Array.isArray(content)) {
      next += content.filter((block: Any) => block?.cache_control).length;
    } else if (content && typeof content === "object" && "cache_control" in content) {
      next += 1;
    }
    return next;
  }, 0);
}

describe("OpenRouterProvider attribution headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends default attribution headers on chat completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "openrouter/free",
      openrouterApiKey: "test-key",
    });

    await provider.createMessage({
      model: "openrouter/free",
      maxTokens: 32,
      system: "",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/CoWork-OS/CoWork-OS",
          "X-OpenRouter-Title": "CoWork OS",
          "X-OpenRouter-Categories": "personal-agent,programming-app",
          "X-Title": "CoWork OS",
        }),
      }),
    );
  });

  it("uses the shared OpenRouter default model when no model is configured", () => {
    const provider = new OpenRouterProvider({
      type: "openrouter",
      openrouterApiKey: "test-key",
    } as Any);

    expect((provider as Any).defaultModel).toBe(OPENROUTER_DEFAULT_MODEL);
  });

  it("sends attribution headers for model discovery", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000 }],
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "openai/gpt-4o",
      openrouterApiKey: "test-key",
    });

    await expect(provider.getAvailableModels()).resolves.toEqual([
      { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000 },
    ]);

    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: "Bearer test-key",
        "HTTP-Referer": "https://github.com/CoWork-OS/CoWork-OS",
        "X-OpenRouter-Title": "CoWork OS",
        "X-OpenRouter-Categories": "personal-agent,programming-app",
        "X-Title": "CoWork OS",
      },
    });
  });

  it("marks the system message plus the last three non-system messages for Claude caching", async () => {
    let capturedBody: Any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
        } as unknown as Response;
      }),
    );

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "anthropic/claude-sonnet-4-5",
      openrouterApiKey: "test-key",
    });

    await provider.createMessage({
      model: "anthropic/claude-sonnet-4-5",
      maxTokens: 32,
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
        mode: "anthropic_explicit",
        ttl: "5m",
        explicitRecentMessages: 3,
      },
      messages: [
        { role: "user", content: "m1" },
        { role: "assistant", content: [{ type: "text", text: "m2" }] },
        { role: "user", content: "m3" },
        { role: "assistant", content: [{ type: "text", text: "m4" }] },
        { role: "user", content: "m5" },
      ],
    });

    expect(capturedBody.messages[0].role).toBe("system");
    expect(capturedBody.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(capturedBody.messages[1].content).toBe("m1");
    expect(capturedBody.messages[2].content).toBe("m2");
    expect(capturedBody.messages[3].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(capturedBody.messages[4].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(capturedBody.messages[5].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(countCacheMarkers(capturedBody.messages)).toBe(4);
  });

  it("never applies cache_control to OpenRouter tool messages", async () => {
    let capturedBody: Any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
        } as unknown as Response;
      }),
    );

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "anthropic/claude-sonnet-4-5",
      openrouterApiKey: "test-key",
    });

    await provider.createMessage({
      model: "anthropic/claude-sonnet-4-5",
      maxTokens: 32,
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
        mode: "anthropic_explicit",
        ttl: "5m",
        explicitRecentMessages: 3,
      },
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "read_file",
              input: { path: "a.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "{\"ok\":true}",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "after tool" }] },
        { role: "user", content: "final" },
      ],
    });

    const toolMessage = capturedBody.messages.find((message: Any) => message.role === "tool");
    expect(toolMessage).toBeTruthy();
    expect(toolMessage.cache_control).toBeUndefined();
    expect(typeof toolMessage.content).toBe("string");
    expect(capturedBody.messages.at(-2).content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(capturedBody.messages.at(-1).content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(countCacheMarkers(capturedBody.messages)).toBe(3);
  });

  it("splits stable and turn system prefix for OpenAI-family implicit caching", async () => {
    let capturedBody: Any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
        } as unknown as Response;
      }),
    );

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "openai/gpt-5.4",
      openrouterApiKey: "test-key",
    });

    await provider.createMessage({
      model: "openai/gpt-5.4",
      maxTokens: 32,
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
        mode: "openrouter_implicit",
        ttl: "5m",
        explicitRecentMessages: 3,
        cacheKey: "stable-prefix-hash",
      },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(capturedBody.messages).toEqual([
      { role: "system", content: "Stable instructions" },
      { role: "system", content: "Current time: 2026-04-04T10:00:00Z" },
      { role: "user", content: "hello" },
    ]);
    expect(countCacheMarkers(capturedBody.messages)).toBe(0);
  });

  it("honors toolChoice=none for OpenAI-family requests", async () => {
    let capturedBody: Any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
        } as unknown as Response;
      }),
    );

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "openai/gpt-5.4",
      openrouterApiKey: "test-key",
    });

    await provider.createMessage({
      model: "openai/gpt-5.4",
      maxTokens: 32,
      system: "system",
      promptCache: {
        mode: "openrouter_implicit",
        ttl: "5m",
        explicitRecentMessages: 3,
        cacheKey: "session-key",
      },
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

    expect(capturedBody.tool_choice).toBe("none");
  });

  it("marks OpenInference moderation 403 errors as retryable route failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: vi.fn().mockResolvedValue({
          error: {
            message:
              'minimax/minimax-m2.5-20260211:free requires moderation on OpenInference. Your input was flagged for "violence/graphic". No credits were charged.',
          },
        }),
      } as unknown as Response),
    );

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "minimax/minimax-m2.5:free",
      openrouterApiKey: "test-key",
    });

    await expect(
      provider.createMessage({
        model: "minimax/minimax-m2.5:free",
        maxTokens: 32,
        system: "",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toMatchObject({
      status: 403,
      retryable: true,
      providerMessage:
        'minimax/minimax-m2.5-20260211:free requires moderation on OpenInference. Your input was flagged for "violence/graphic". No credits were charged.',
    });
  });

  it("marks generic OpenRouter provider 400 errors as retryable route failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: vi.fn().mockResolvedValue({
          error: {
            message: "Provider returned error",
          },
        }),
      } as unknown as Response),
    );

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "minimax/minimax-m2.5:free",
      openrouterApiKey: "test-key",
    });

    await expect(
      provider.createMessage({
        model: "minimax/minimax-m2.5:free",
        maxTokens: 32,
        system: "",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toMatchObject({
      status: 400,
      retryable: true,
      providerMessage: "Provider returned error",
    });
  });

  it("marks text-only OpenRouter models with image input as retryable route failures", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models?output_modalities=all")) {
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: [
              {
                id: "minimax/minimax-m2.5:free",
                architecture: { input_modalities: ["text"], output_modalities: ["text"] },
              },
            ],
          }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch call: ${url} ${String(init?.method || "GET")}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "minimax/minimax-m2.5:free",
      openrouterApiKey: "test-key",
    });

    await expect(
      provider.createMessage({
        model: "minimax/minimax-m2.5:free",
        maxTokens: 32,
        system: "",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Review this screenshot." },
              { type: "image", mimeType: "image/png", data: "AA==" },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 404,
      retryable: true,
      providerMessage: "No endpoints found that support image input for model minimax/minimax-m2.5:free",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks OpenRouter image-input 404s as retryable route failures", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models?output_modalities=all")) {
        return {
          ok: false,
          status: 500,
          statusText: "Server Error",
          json: vi.fn().mockResolvedValue({}),
        } as unknown as Response;
      }

      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const userMessage = body.messages[0];
      expect(Array.isArray(userMessage.content)).toBe(true);
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: vi.fn().mockResolvedValue({
          error: { message: "No endpoints found that support image input" },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "openai/gpt-4o",
      openrouterApiKey: "test-key",
    });

    await expect(
      provider.createMessage({
        model: "openai/gpt-4o",
        maxTokens: 32,
        system: "",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe the image." },
              { type: "image", mimeType: "image/png", data: "AA==" },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 404,
      retryable: true,
      providerMessage: "No endpoints found that support image input",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches runtime image-input 404s and fast-fails subsequent image requests for the same model", async () => {
    const modelId = "acme/runtime-404-cache-test";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models?output_modalities=all")) {
        return {
          ok: false,
          status: 500,
          statusText: "Server Error",
          json: vi.fn().mockResolvedValue({}),
        } as unknown as Response;
      }

      const body = init?.body ? JSON.parse(String(init.body)) : null;
      expect(body.model).toBe(modelId);
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: vi.fn().mockResolvedValue({
          error: { message: "No endpoints found that support image input" },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: modelId,
      openrouterApiKey: "test-key",
    });

    const request = {
      model: modelId,
      maxTokens: 32,
      system: "",
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Describe the image." },
            { type: "image" as const, mimeType: "image/png", data: "AA==" },
          ],
        },
      ],
    };

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      status: 404,
      retryable: true,
      providerMessage: "No endpoints found that support image input",
    });

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      status: 404,
      retryable: true,
      providerMessage: `No endpoints found that support image input for model ${modelId}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off model capability discovery after a transient catalog failure", async () => {
    const modelId = "acme/vision-retry-test";
    let catalogCalls = 0;
    let chatCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/models?output_modalities=all")) {
        catalogCalls += 1;
        if (catalogCalls === 1) {
          return {
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            json: vi.fn().mockResolvedValue({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: [
              {
                id: modelId,
                architecture: {
                  input_modalities: ["text", "image"],
                  output_modalities: ["text"],
                },
              },
            ],
          }),
        } as unknown as Response;
      }

      chatCalls += 1;
      return {
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: modelId,
      openrouterApiKey: "test-key",
    });

    const request = {
      model: modelId,
      maxTokens: 32,
      system: "",
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Describe the image." },
            { type: "image" as const, mimeType: "image/png", data: "AA==" },
          ],
        },
      ],
    };

    await expect(provider.createMessage(request)).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    await expect(provider.createMessage(request)).resolves.toMatchObject({
      stopReason: "end_turn",
    });

    expect(catalogCalls).toBe(1);
    expect(chatCalls).toBe(2);
  });

  it("retries model capability discovery again after the cooldown window passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T10:00:00Z"));

    const modelId = "acme/vision-retry-after-cooldown";
    let catalogCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/models?output_modalities=all")) {
        catalogCalls += 1;
        if (catalogCalls === 1) {
          return {
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            json: vi.fn().mockResolvedValue({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            data: [
              {
                id: modelId,
                architecture: {
                  input_modalities: ["text", "image"],
                  output_modalities: ["text"],
                },
              },
            ],
          }),
        } as unknown as Response;
      }

      return {
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: modelId,
      openrouterApiKey: "test-key",
    });

    const request = {
      model: modelId,
      maxTokens: 32,
      system: "",
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Describe the image." },
            { type: "image" as const, mimeType: "image/png", data: "AA==" },
          ],
        },
      ],
    };

    await expect(provider.createMessage(request)).resolves.toMatchObject({
      stopReason: "end_turn",
    });

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await expect(provider.createMessage(request)).resolves.toMatchObject({
      stopReason: "end_turn",
    });

    expect(catalogCalls).toBe(2);
    vi.useRealTimers();
  });

  it("does not emit provider error logs for retryable OpenRouter route failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: vi.fn().mockResolvedValue({
          error: {
            message: "Provider returned error",
          },
        }),
      } as unknown as Response),
    );

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "minimax/minimax-m2.5:free",
      openrouterApiKey: "test-key",
    });

    await expect(
      provider.createMessage({
        model: "minimax/minimax-m2.5:free",
        maxTokens: 32,
        system: "",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toMatchObject({
      status: 400,
      retryable: true,
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("treats tool_choice capability route failures as retryable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: vi.fn().mockResolvedValue({
          error: {
            message:
              "No endpoints found that support the provided 'tool_choice' value. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
          },
        }),
      } as unknown as Response),
    );

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      openrouterApiKey: "test-key",
    });

    await expect(
      provider.createMessage({
        model: "nvidia/nemotron-3-super-120b-a12b:free",
        maxTokens: 32,
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        ],
        toolChoice: "none",
      }),
    ).rejects.toMatchObject({
      status: 404,
      retryable: true,
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("still emits provider error logs for non-retryable OpenRouter failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: vi.fn().mockResolvedValue({
          error: {
            message: "Invalid API key",
          },
        }),
      } as unknown as Response),
    );

    const provider = new OpenRouterProvider({
      type: "openrouter",
      model: "openrouter/free",
      openrouterApiKey: "bad-key",
    });

    await expect(
      provider.createMessage({
        model: "openrouter/free",
        maxTokens: 32,
        system: "",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toMatchObject({
      status: 401,
      retryable: false,
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
