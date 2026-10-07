import { afterEach, describe, expect, it, vi } from "vitest";

import { OllamaProvider, getOllamaEffectiveContextWindow } from "../ollama-provider";
import {
  getTextToolCallFallbackStats,
  resetTextToolCallFallbackStatsForTests,
} from "../text-tool-call-parser";
import { clearNativeToolSupportCacheForTests } from "../text-tool-protocol";
import type { LLMRequest, LLMTool } from "../types";

function createRequest(): LLMRequest {
  return {
    model: "qwen3.8:27b-q8_0",
    maxTokens: 1024,
    system: "You are helpful.",
    messages: [{ role: "user", content: "Hello" }],
  };
}

function mockOllamaResponse(message: Record<string, unknown>, doneReason = "stop"): Response {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      model: "qwen3.8:27b-q8_0",
      created_at: "2026-08-14T20:00:00Z",
      message,
      done: true,
      done_reason: doneReason,
      prompt_eval_count: 12,
      eval_count: 34,
    }),
  } as unknown as Response;
}

function mockShowResponse(body: Record<string, unknown>): Response {
  return { ok: true, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

/** Answers /api/show with `show` (404 by default) and /api/chat from `chat` in order. */
function routeOllamaFetch(chat: Response | Response[], show?: Response) {
  const queue = Array.isArray(chat) ? [...chat] : null;
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (String(url).endsWith("/api/show")) {
      return show ?? ({ ok: false, status: 404, json: vi.fn() } as unknown as Response);
    }
    return queue ? queue.shift() : chat;
  });
}

function chatCalls(fetchMock: ReturnType<typeof vi.fn>): Array<[string, RequestInit]> {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/chat")) as Array<
    [string, RequestInit]
  >;
}

describe("OllamaProvider reasoning handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("disables Ollama thinking so reasoning cannot consume the final-answer budget", async () => {
    const fetchMock = routeOllamaFetch(mockOllamaResponse({ role: "assistant", content: "Done" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({
      type: "ollama",
      model: "qwen3.8:27b-q8_0",
      ollamaBaseUrl: "http://localhost:11434",
    });

    const response = await provider.createMessage(createRequest());

    const requestInit = chatCalls(fetchMock)[0]?.[1];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      model: "qwen3.8:27b-q8_0",
      think: false,
      options: { num_predict: 1024 },
    });
    expect(response.content).toEqual([{ type: "text", text: "Done" }]);
    expect(response.stopReason).toBe("end_turn");
  });

  it("omits the think field for models without known reasoning support", async () => {
    const fetchMock = routeOllamaFetch(mockOllamaResponse({ role: "assistant", content: "Done" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "llama3.3:70b" });
    const request = { ...createRequest(), model: "llama3.3:70b" };

    await provider.createMessage(request);

    const requestInit = chatCalls(fetchMock)[0]?.[1];
    expect(JSON.parse(String(requestInit.body))).not.toHaveProperty("think");
  });

  it("does not mislabel caller-signal aborts as user cancellations", async () => {
    const requestController = new AbortController();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    const provider = new OllamaProvider({ type: "ollama", model: "qwen3.5:latest" });

    const request = provider.createMessage({
      ...createRequest(),
      signal: requestController.signal,
    });
    requestController.abort();

    await expect(request).rejects.toThrow("Request cancelled");
    expect(console.log).toHaveBeenCalledWith("[Ollama] Request aborted by caller signal");
  });

  it("retries a reasoning model without think when the server rejects the field", async () => {
    const unsupportedResponse = {
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue("qwen3.8 does not support thinking"),
    } as unknown as Response;
    const fetchMock = routeOllamaFetch([
      unsupportedResponse,
      mockOllamaResponse({ role: "assistant", content: "Recovered" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "qwen3.8:27b-q8_0" });

    const response = await provider.createMessage(createRequest());

    const retryInit = chatCalls(fetchMock)[1]?.[1];
    expect(JSON.parse(String(retryInit.body))).not.toHaveProperty("think");
    expect(response.content).toEqual([{ type: "text", text: "Recovered" }]);
  });

  it("treats a reasoning-only response as token exhaustion without exposing its contents", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockOllamaResponse({
          role: "assistant",
          content: "",
          thinking: "private model reasoning",
        }),
      ),
    );
    const provider = new OllamaProvider({
      type: "ollama",
      model: "qwen3.8:27b-q8_0",
    });

    const response = await provider.createMessage(createRequest());

    expect(response.content).toEqual([]);
    expect(response.stopReason).toBe("max_tokens");
    expect(JSON.stringify(response)).not.toContain("private model reasoning");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("reasoning without a final answer"),
      expect.objectContaining({ thinkingChars: 23, doneReason: "stop" }),
    );
  });

  it("rejects malformed and non-object tool arguments while preserving valid siblings", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockOllamaResponse({
          role: "assistant",
          content: "Inspecting the files",
          tool_calls: [
            { function: { name: "write_file", arguments: "{" } },
            { function: { name: "read_file", arguments: { path: "src/app.ts" } } },
            { function: { name: "glob", arguments: "[]" } },
            { function: { name: "list_dir", arguments: "{}" } },
          ],
        }),
      ),
    );
    const provider = new OllamaProvider({ type: "ollama", model: "llama3.3:70b" });

    const response = await provider.createMessage({ ...createRequest(), model: "llama3.3:70b" });

    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toHaveLength(5);
    expect(response.content[0]).toEqual({ type: "text", text: "Inspecting the files" });

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    expect(toolUses).toHaveLength(4);
    expect(toolUses.map((toolUse) => toolUse.name)).toEqual([
      "write_file",
      "read_file",
      "glob",
      "list_dir",
    ]);

    const malformed = toolUses[0];
    expect(malformed.input).toEqual({});
    expect(malformed.inputError).toEqual({
      code: "malformed_json",
      message: "Tool call arguments must be valid JSON.",
    });

    const nativeObject = toolUses[1];
    expect(nativeObject.input).toEqual({ path: "src/app.ts" });
    expect(nativeObject.inputError).toBeUndefined();

    const array = toolUses[2];
    expect(array.input).toEqual({});
    expect(array.inputError).toEqual({
      code: "invalid_shape",
      message: "Tool call arguments must be a JSON object.",
    });

    const explicitEmptyObject = toolUses[3];
    expect(explicitEmptyObject.input).toEqual({});
    expect(explicitEmptyObject.inputError).toBeUndefined();
  });
});

describe("OllamaProvider context window", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.COWORK_OLLAMA_NUM_CTX;
  });

  it("sends num_ctx from the model's /api/show context length, looked up once per model", async () => {
    const fetchMock = routeOllamaFetch(
      mockOllamaResponse({ role: "assistant", content: "Done" }),
      mockShowResponse({
        model_info: { "general.architecture": "gemma3", "gemma3.context_length": 16_384 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "gemma3:12b" });
    const request = { ...createRequest(), model: "gemma3:12b" };

    await provider.createMessage(request);
    await provider.createMessage(request);

    const showCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/show"));
    expect(showCalls).toHaveLength(1);
    expect(JSON.parse(String(showCalls[0][1]?.body))).toMatchObject({ model: "gemma3:12b" });
    for (const [, init] of chatCalls(fetchMock)) {
      expect(JSON.parse(String(init.body))).toMatchObject({
        options: { num_predict: 1024, num_ctx: 16_384 },
        keep_alive: "30m",
      });
    }
    expect(getOllamaEffectiveContextWindow("gemma3:12b")).toBe(16_384);
  });

  it("caps long-context models at the default window instead of the server default", async () => {
    const fetchMock = routeOllamaFetch(
      mockOllamaResponse({ role: "assistant", content: "Done" }),
      mockShowResponse({
        model_info: { "general.architecture": "qwen3", "qwen3.context_length": 262_144 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "qwen3:32b" });

    await provider.createMessage({ ...createRequest(), model: "qwen3:32b" });

    expect(JSON.parse(String(chatCalls(fetchMock)[0][1].body)).options.num_ctx).toBe(32_768);
    expect(getOllamaEffectiveContextWindow("qwen3:32b")).toBe(32_768);
  });

  it("honours COWORK_OLLAMA_NUM_CTX as the cap", async () => {
    process.env.COWORK_OLLAMA_NUM_CTX = "65536";
    const fetchMock = routeOllamaFetch(
      mockOllamaResponse({ role: "assistant", content: "Done" }),
      mockShowResponse({
        model_info: { "general.architecture": "llama", "llama.context_length": 131_072 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "llama3.3:70b" });

    await provider.createMessage({ ...createRequest(), model: "llama3.3:70b" });

    expect(JSON.parse(String(chatCalls(fetchMock)[0][1].body)).options.num_ctx).toBe(65_536);
  });

  it("falls back to the default window when /api/show fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/show")) throw new TypeError("fetch failed");
      return mockOllamaResponse({ role: "assistant", content: "Done" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "mistral-small:24b" });

    const response = await provider.createMessage({
      ...createRequest(),
      model: "mistral-small:24b",
    });

    expect(response.content).toEqual([{ type: "text", text: "Done" }]);
    expect(JSON.parse(String(chatCalls(fetchMock as Any)[0][1].body)).options.num_ctx).toBe(32_768);
  });
});

describe("OllamaProvider text tool-call fallback", () => {
  const tools: LLMTool[] = [
    {
      name: "read_file",
      description: "Read a file from the workspace. Large files are truncated.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ];

  function toolRequest(model: string, overrides: Partial<LLMRequest> = {}): LLMRequest {
    return { ...createRequest(), model, tools, ...overrides };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearNativeToolSupportCacheForTests();
    resetTextToolCallFallbackStatsForTests();
  });

  it("turns a <tool_call> written as text into a tool_use block", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      routeOllamaFetch(
        mockOllamaResponse({
          role: "assistant",
          content:
            'I will read it.\n<tool_call>{"name": "read_file", "arguments": {"path": "README.md"}}</tool_call>',
        }),
      ),
    );
    const provider = new OllamaProvider({ type: "ollama", model: "qwen2.5:7b" });

    const response = await provider.createMessage(toolRequest("qwen2.5:7b"));

    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "text", text: "I will read it." },
      expect.objectContaining({
        type: "tool_use",
        name: "read_file",
        input: { path: "README.md" },
      }),
    ]);
    expect(getTextToolCallFallbackStats().recoveredCalls).toBe(1);
  });

  it("leaves native tool calls and their text untouched", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const text = '<tool_call>{"name": "read_file", "arguments": {"path": "other.md"}}</tool_call>';
    vi.stubGlobal(
      "fetch",
      routeOllamaFetch(
        mockOllamaResponse({
          role: "assistant",
          content: text,
          tool_calls: [{ function: { name: "read_file", arguments: { path: "a.md" } } }],
        }),
      ),
    );
    const provider = new OllamaProvider({ type: "ollama", model: "qwen2.5:7b" });

    const response = await provider.createMessage(toolRequest("qwen2.5:7b"));

    expect(response.content).toEqual([
      { type: "text", text },
      expect.objectContaining({ type: "tool_use", name: "read_file", input: { path: "a.md" } }),
    ]);
    expect(getTextToolCallFallbackStats().recoveredCalls).toBe(0);
  });

  it("does not parse text tool calls when the fallback is disabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      routeOllamaFetch(
        mockOllamaResponse({
          role: "assistant",
          content: '<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>',
        }),
      ),
    );
    const provider = new OllamaProvider(
      { type: "ollama", model: "qwen2.5:7b" },
      { textToolCallFallback: false },
    );

    const response = await provider.createMessage(toolRequest("qwen2.5:7b"));

    expect(response.stopReason).toBe("end_turn");
    expect(response.content.some((block) => block.type === "tool_use")).toBe(false);
  });

  it("retries once with the text tool protocol when the model does not support tools", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = routeOllamaFetch([
      {
        ok: false,
        status: 400,
        text: vi
          .fn()
          .mockResolvedValue(
            '{"error":"registry.ollama.ai/library/gemma2:2b does not support tools"}',
          ),
      } as unknown as Response,
      mockOllamaResponse({
        role: "assistant",
        content: '<tool_call>{"name": "read_file", "arguments": {"path": "notes.md"}}</tool_call>',
      }),
      mockOllamaResponse({ role: "assistant", content: "The notes say hello." }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "gemma2:2b" });

    const first = await provider.createMessage(toolRequest("gemma2:2b"));

    expect(first.stopReason).toBe("tool_use");
    const toolUse = first.content.find((block) => block.type === "tool_use");
    expect(toolUse).toMatchObject({ name: "read_file", input: { path: "notes.md" } });

    const [nativeAttempt, textAttempt] = chatCalls(fetchMock).map(([, init]) =>
      JSON.parse(String(init.body)),
    );
    expect(nativeAttempt.tools).toHaveLength(1);
    expect(textAttempt).not.toHaveProperty("tools");
    expect(textAttempt.messages[0].role).toBe("system");
    expect(textAttempt.messages[0].content).toContain("You are helpful.");
    expect(textAttempt.messages[0].content).toContain(
      '<tool_call>{"name": "<tool name>", "arguments": {<JSON object>}}</tool_call>',
    );
    expect(textAttempt.messages[0].content).toContain(
      '- read_file: Read a file from the workspace. Arguments: {"path": string (required)}',
    );
    expect(getTextToolCallFallbackStats().textProtocolActivations).toBe(1);

    // The model is remembered: the follow-up goes straight to the text protocol
    // and replays the call and its result as plain text the model understands.
    const second = await provider.createMessage(
      toolRequest("gemma2:2b", {
        messages: [
          { role: "user", content: "Summarize notes.md" },
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUse!.id, content: "hello" }],
          },
        ],
      }),
    );

    expect(second.content).toEqual([{ type: "text", text: "The notes say hello." }]);
    const calls = chatCalls(fetchMock);
    expect(calls).toHaveLength(3);
    const followUp = JSON.parse(String(calls[2][1].body));
    expect(followUp).not.toHaveProperty("tools");
    expect(followUp.messages.slice(1)).toEqual([
      { role: "user", content: "Summarize notes.md" },
      {
        role: "assistant",
        content: '<tool_call>{"name":"read_file","arguments":{"path":"notes.md"}}</tool_call>',
      },
      { role: "user", content: '<tool_response name="read_file">\nhello\n</tool_response>' },
    ]);
    expect(followUp.messages.some((message: { role: string }) => message.role === "tool")).toBe(
      false,
    );
  });

  it("surfaces the unsupported-tools error when the fallback is disabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = routeOllamaFetch([
      {
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue('{"error":"gemma2:2b does not support tools"}'),
      } as unknown as Response,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider(
      { type: "ollama", model: "gemma2:2b" },
      { textToolCallFallback: false },
    );

    await expect(provider.createMessage(toolRequest("gemma2:2b"))).rejects.toThrow(
      "does not support tools",
    );
    expect(chatCalls(fetchMock)).toHaveLength(1);
  });
});
