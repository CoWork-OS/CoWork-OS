import { describe, it, expect, vi, beforeEach } from "vitest";
import { AzureOpenAIProvider } from "../azure-openai-provider";
import type { LLMRequest } from "../types";

const mockFetch = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as Any).fetch = mockFetch;

const baseConfig = {
  type: "azure" as const,
  model: "",
  azureApiKey: "test-key",
  azureEndpoint: "https://example.openai.azure.com/",
  azureDeployment: "my deployment",
  azureApiVersion: "2024-05-01",
  azureReasoningEffort: "extra_high" as const,
};

beforeEach(() => {
  mockFetch.mockReset();
});

function createOkResponse(data: Any) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: vi.fn().mockResolvedValue(data),
  };
}

function createErrorResponse(status: number, statusText: string, data: Any) {
  const headers = new Map<string, string>([["x-ms-request-id", "req-123"]]);
  return {
    ok: false,
    status,
    statusText,
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) || headers.get(name) || null,
    },
    json: vi.fn().mockResolvedValue(data),
  };
}

function createStreamingResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: stream,
    json: vi.fn(),
  };
}

describe("AzureOpenAIProvider", () => {
  it("builds the request URL and payload for connection tests", async () => {
    mockFetch.mockResolvedValue(createOkResponse({ choices: [] }));

    const provider = new AzureOpenAIProvider(baseConfig);
    const result = await provider.testConnection();

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://example.openai.azure.com/openai/deployments/my%20deployment/chat/completions?api-version=2024-05-01",
    );

    expect(options?.headers).toMatchObject({
      "Content-Type": "application/json",
      "api-key": "test-key",
    });

    const body = JSON.parse(options.body);
    expect(body.model).toBe("my deployment");
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(body.max_tokens).toBe(16);
  });

  it("returns Azure error details when connection fails", async () => {
    mockFetch.mockResolvedValue(
      createErrorResponse(401, "Unauthorized", { error: { message: "invalid key" } }),
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const result = await provider.testConnection();

    expect(result).toEqual({ success: false, error: "invalid key" });
  });

  it("retries connection test with max_completion_tokens when max_tokens is unsupported", async () => {
    mockFetch
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        }),
      )
      .mockResolvedValueOnce(createOkResponse({ choices: [] }));

    const provider = new AzureOpenAIProvider(baseConfig);
    const result = await provider.testConnection();

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const thirdBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(firstBody.max_tokens).toBe(16);
    expect(secondBody.max_tokens).toBe(16);
    expect(secondBody.reasoning_effort).toBe("high");
    expect(thirdBody.max_completion_tokens).toBe(16);
  });

  it("falls back to Responses API when chat completions are unsupported during connection test", async () => {
    mockFetch
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(createOkResponse({ output: [] }));

    const provider = new AzureOpenAIProvider(baseConfig);
    const result = await provider.testConnection();

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const [firstUrl] = mockFetch.mock.calls[0];
    const [secondUrl] = mockFetch.mock.calls[1];
    const [thirdUrl, thirdOptions] = mockFetch.mock.calls[2];
    expect(firstUrl).toContain("/chat/completions?api-version=2024-05-01");
    expect(secondUrl).toContain("/chat/completions?api-version=2024-05-01");
    expect(thirdUrl).toBe("https://example.openai.azure.com/openai/v1/responses");

    const body = JSON.parse(thirdOptions.body);
    expect(body.max_output_tokens).toBe(16);
    expect(body.input[0].content[0].text).toBe("Hi");
  });

  it("sends model requests and parses responses", async () => {
    mockFetch.mockResolvedValue(
      createOkResponse({
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
      }),
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-4o",
      maxTokens: 20,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
    };

    const response = await provider.createMessage(request);

    expect(response.content).toEqual([{ type: "text", text: "hello" }]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 7 });

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.model).toBe("gpt-4o");
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it("shortens replayed tool call IDs in chat-completions requests", async () => {
    mockFetch.mockResolvedValue(
      createOkResponse({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    );

    const longId =
      "call_fTqRlz9aYMXqPEzJkcc0NrzA|fc_074924a6cf3a48280169f173f70f988191b1e8342ae256b142";
    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-4o",
      maxTokens: 20,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: longId,
              name: "scratchpad_write",
              input: { key: "heartbeat", content: "done" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: longId, content: "ok" }],
        },
      ],
    };

    await provider.createMessage(request);

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    const toolCallId = body.messages[0].tool_calls[0].id;

    expect(toolCallId).not.toBe(longId);
    expect(toolCallId.length).toBeLessThanOrEqual(64);
    expect(body.messages[1]).toMatchObject({ role: "tool", tool_call_id: toolCallId });
  });

  it("sends prompt_cache_key and splits stable versus turn system prefix on chat completions", async () => {
    mockFetch.mockResolvedValue(
      createOkResponse({
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 7,
          prompt_tokens_details: {
            cached_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      }),
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-4o",
      maxTokens: 20,
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
      messages: [{ role: "user", content: "hi" }],
    };

    const response = await provider.createMessage(request);

    expect(response.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cachedTokens: 3,
      cacheWriteTokens: 2,
    });

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.prompt_cache_key).toBe("stable-prefix-hash");
    expect(body.prompt_cache_retention).toBe("24h");
    expect(body.messages).toEqual([
      { role: "system", content: "Stable instructions" },
      { role: "system", content: "Current time: 2026-04-04T10:00:00Z" },
      { role: "user", content: "hi" },
    ]);
  });

  it("streams chat completions when a stream callback is provided", async () => {
    mockFetch.mockResolvedValue(
      createStreamingResponse([
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const onStreamProgress = vi.fn();
    const request: LLMRequest = {
      model: "gpt-4o",
      maxTokens: 20,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
      onStreamProgress,
    };

    const response = await provider.createMessage(request);

    expect(response.content).toEqual([{ type: "text", text: "hello" }]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 2 });

    expect(onStreamProgress).toHaveBeenCalled();
    expect(onStreamProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      streaming: false,
      outputChars: 5,
      inputTokens: 4,
      outputTokens: 2,
    });

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.stream).toBe(true);
  });

  it("parses streamed chat-completions tool calls into tool_use blocks", async () => {
    mockFetch.mockResolvedValue(
      createStreamingResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"screenshot","arguments":"{\\"app\\":\\"Cal"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"arguments":"culator\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const response = await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 20,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
      onStreamProgress: vi.fn(),
    });

    expect(response.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "screenshot",
        input: { app: "Calculator" },
      },
    ]);
    expect(response.stopReason).toBe("tool_use");
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });

  it("falls back to Responses API when chat completions are unsupported", async () => {
    mockFetch
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createOkResponse({
          output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-5.2-codex",
      maxTokens: 20,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
    };

    const response = await provider.createMessage(request);

    expect(response.content).toEqual([{ type: "text", text: "hello" }]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({ inputTokens: 2, outputTokens: 3 });

    const [responsesUrl, responsesOptions] = mockFetch.mock.calls[2];
    expect(responsesUrl).toBe("https://example.openai.azure.com/openai/v1/responses");
    const body = JSON.parse(responsesOptions.body);
    expect(body.instructions).toBe("system prompt");
    expect(body.model).toBe("gpt-5.2-codex");
    expect(body.input[0].content[0].text).toBe("hi");
    expect(body.reasoning).toEqual({ effort: "xhigh" });
  });

  it("falls back to Responses API when chat completions reject tools with reasoning effort", async () => {
    const unsupportedToolsWithReasoning = {
      error: {
        message:
          "Function tools with reasoning_effort are not supported for gpt-5.5 in /v1/chat/completions. Please use /v1/responses instead.",
      },
    };
    mockFetch
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", unsupportedToolsWithReasoning),
      )
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", unsupportedToolsWithReasoning),
      )
      .mockResolvedValueOnce(
        createOkResponse({
          output: [{ type: "message", content: [{ type: "output_text", text: "planned" }] }],
          usage: { input_tokens: 11, output_tokens: 5 },
        }),
      );

    const provider = new AzureOpenAIProvider(baseConfig);
    const response = await provider.createMessage({
      model: "gpt-5.5",
      maxTokens: 20,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
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

    expect(response.content).toEqual([{ type: "text", text: "planned" }]);
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 5 });

    const [firstUrl, firstOptions] = mockFetch.mock.calls[0];
    const [secondUrl, secondOptions] = mockFetch.mock.calls[1];
    const [responsesUrl, responsesOptions] = mockFetch.mock.calls[2];
    expect(firstUrl).toContain("/chat/completions?api-version=2024-05-01");
    expect(secondUrl).toContain("/chat/completions?api-version=2024-05-01");
    expect(JSON.parse(firstOptions.body).reasoning_effort).toBe("xhigh");
    expect(JSON.parse(secondOptions.body).reasoning_effort).toBe("high");
    expect(responsesUrl).toBe("https://example.openai.azure.com/openai/v1/responses");

    const responsesBody = JSON.parse(responsesOptions.body);
    expect(responsesBody.model).toBe("gpt-5.5");
    expect(responsesBody.reasoning).toEqual({ effort: "xhigh" });
    expect(responsesBody.tools).toHaveLength(1);
    expect(responsesBody.tool_choice).toBe("none");
  });

  it("sends prompt_cache_key with stable instructions and volatile system input on Responses fallback", async () => {
    mockFetch
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createOkResponse({
          output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
          usage: {
            input_tokens: 2,
            output_tokens: 3,
            input_tokens_details: {
              cached_tokens: 1,
              cache_creation_input_tokens: 4,
            },
          },
        }),
      );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-5.4",
      maxTokens: 20,
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
        ttl: "5m",
        explicitRecentMessages: 3,
        cacheKey: "stable-prefix-hash",
      },
      messages: [{ role: "user", content: "hi" }],
    };

    const response = await provider.createMessage(request);

    expect(response.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      cachedTokens: 1,
      cacheWriteTokens: 4,
    });

    const [responsesUrl, responsesOptions] = mockFetch.mock.calls[2];
    expect(responsesUrl).toBe("https://example.openai.azure.com/openai/v1/responses");
    const body = JSON.parse(responsesOptions.body);
    expect(body.prompt_cache_key).toBe("stable-prefix-hash");
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(body.instructions).toBe("Stable instructions");
    expect(body.input[0]).toEqual({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "Current time: 2026-04-04T10:00:00Z" }],
    });
    expect(body.input[1].role).toBe("user");
  });

  it("honors toolChoice=none on chat completions and Responses requests", async () => {
    mockFetch
      .mockResolvedValueOnce(
        createOkResponse({
          choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        }),
      )
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createOkResponse({
          output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-5.4",
      maxTokens: 20,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
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
    };

    await provider.createMessage(request);
    const chatBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(chatBody.tool_choice).toBe("none");

    await provider.createMessage({
      ...request,
      model: "gpt-5.2-codex",
    });
    const responsesBody = JSON.parse(mockFetch.mock.calls[3][1].body);
    expect(responsesBody.tool_choice).toBe("none");
  });

  it("streams the Responses API fallback when a stream callback is provided", async () => {
    mockFetch
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createStreamingResponse([
          'data: {"type":"response.output_text.delta","delta":"hel"}\n\n',
          'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":6,"output_tokens":2}}}\n\n',
          "data: [DONE]\n\n",
        ]),
      );

    const provider = new AzureOpenAIProvider(baseConfig);
    const onStreamProgress = vi.fn();
    const request: LLMRequest = {
      model: "gpt-5.2-codex",
      maxTokens: 20,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
      onStreamProgress,
    };

    const response = await provider.createMessage(request);

    expect(response.content).toEqual([{ type: "text", text: "hello" }]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({ inputTokens: 6, outputTokens: 2 });
    expect(onStreamProgress).toHaveBeenCalled();
    expect(onStreamProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      streaming: false,
      outputChars: 5,
      inputTokens: 6,
      outputTokens: 2,
    });

    const [, firstOptions] = mockFetch.mock.calls[0];
    expect(JSON.parse(firstOptions.body).stream).toBe(true);
    const [, secondOptions] = mockFetch.mock.calls[1];
    expect(JSON.parse(secondOptions.body).stream).toBe(true);
    const [, thirdOptions] = mockFetch.mock.calls[2];
    expect(JSON.parse(thirdOptions.body).stream).toBe(true);
  });

  it("parses streamed Responses API tool calls into tool_use blocks", async () => {
    mockFetch
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createErrorResponse(400, "Bad Request", {
          error: {
            message: "The chatCompletion operation does not work with the specified model.",
          },
        }),
      )
      .mockResolvedValueOnce(
        createStreamingResponse([
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"screenshot","arguments":""}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"call_1","delta":"{\\"app\\":\\"Cal"}\n\n',
          'data: {"type":"response.function_call_arguments.done","item_id":"call_1","arguments":"{\\"app\\":\\"Calculator\\"}"}\n\n',
          'data: {"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call_1","name":"screenshot","arguments":"{\\"app\\":\\"Calculator\\"}"}],"usage":{"input_tokens":6,"output_tokens":2}}}\n\n',
          "data: [DONE]\n\n",
        ]),
      );

    const provider = new AzureOpenAIProvider(baseConfig);
    const response = await provider.createMessage({
      model: "gpt-5.2-codex",
      maxTokens: 20,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
      onStreamProgress: vi.fn(),
    });

    expect(response.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "screenshot",
        input: { app: "Calculator" },
      },
    ]);
    expect(response.stopReason).toBe("tool_use");
    expect(response.usage).toEqual({ inputTokens: 6, outputTokens: 2 });
  });

  it("throws a descriptive error on API failures", async () => {
    mockFetch.mockResolvedValue(
      createErrorResponse(400, "Bad Request", { error: { message: "bad stuff" } }),
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-4o",
      maxTokens: 20,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
    };

    await expect(provider.createMessage(request)).rejects.toThrow(
      "Azure OpenAI API error: 400 Bad Request - bad stuff",
    );
  });

  it("marks Azure 500 API failures as retryable", async () => {
    mockFetch.mockResolvedValue(
      createErrorResponse(500, "Internal Server Error", {
        error: { message: "The server had an error while processing your request. Sorry about that!" },
      }),
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-4o",
      maxTokens: 20,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
    };

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      status: 500,
    });
  });

  it("marks 'model produced invalid content' 400 as retryable", async () => {
    mockFetch.mockResolvedValue(
      createErrorResponse(400, "Bad Request", {
        error: {
          message:
            "The model produced invalid content. Consider modifying your prompt if you are seeing this error persistently. For more information, please see https://aka.ms/model-error",
        },
      }),
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-5.4",
      maxTokens: 100,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
    };

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      status: 400,
    });
  });

  it("marks Azure wrapped server-error 400s as retryable", async () => {
    mockFetch.mockResolvedValue(
      createErrorResponse(400, "Bad Request", {
        error: {
          message: "The server had an error while processing your request. Sorry about that!",
        },
      }),
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-5.4",
      maxTokens: 100,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
    };

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      status: 400,
      requestId: "req-123",
      providerMessage: "The server had an error while processing your request. Sorry about that!",
    });
  });

  it("marks ECONNRESET transport failures as retryable with a consistent structured shape", async () => {
    const transportError = new TypeError("fetch failed");
    (transportError as Any).cause = { code: "ECONNRESET" };
    mockFetch.mockRejectedValue(transportError);

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: "gpt-5.4",
      maxTokens: 100,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
    };

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      code: "ECONNRESET",
    });
  });
});
