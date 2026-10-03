import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatibleProvider } from "../openai-compatible-provider";
import { OpenCodeProvider } from "../opencode-go-provider";
import { resetTextToolCallFallbackStatsForTests } from "../text-tool-call-parser";
import { clearNativeToolSupportCacheForTests } from "../text-tool-protocol";
import type { LLMProviderType, LLMRequest, LLMTool } from "../types";

const tools: LLMTool[] = [
  {
    name: "read_file",
    description: "Read a file from the workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function toolRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "qwen2.5-coder-7b",
    maxTokens: 256,
    system: "You are helpful.",
    messages: [{ role: "user", content: "Read README.md" }],
    tools,
    ...overrides,
  };
}

function completion(message: Record<string, unknown>, finishReason = "stop"): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: vi.fn().mockResolvedValue({
      choices: [{ message: { role: "assistant", ...message }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  } as unknown as Response;
}

function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: vi.fn().mockResolvedValue({ error: { message } }),
  } as unknown as Response;
}

function provider(type: LLMProviderType, baseUrl: string, textToolCallFallback?: boolean) {
  return new OpenAICompatibleProvider({
    type,
    providerName: type,
    apiKey: "",
    baseUrl,
    defaultModel: "qwen2.5-coder-7b",
    ...(textToolCallFallback === undefined ? {} : { textToolCallFallback }),
  });
}

const TEXT_CALL =
  '<tool_call>{"name": "read_file", "arguments": {"path": "README.md"}}</tool_call>';

function requestBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, Any>> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("OpenAI-compatible text tool-call fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearNativeToolSupportCacheForTests();
    resetTextToolCallFallbackStatsForTests();
  });

  it.each([
    ["mlx", "http://localhost:8080/v1"],
    ["openai-compatible", "http://localhost:1234/v1"],
    ["omlx", "http://localhost:8000/v1"],
  ] as const)("recovers a text tool call from %s", async (type, baseUrl) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ content: TEXT_CALL })));

    const response = await provider(type, baseUrl).createMessage(toolRequest());

    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      expect.objectContaining({
        type: "tool_use",
        name: "read_file",
        input: { path: "README.md" },
      }),
    ]);
  });

  it("leaves native tool calls untouched", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        completion(
          {
            content: TEXT_CALL,
            tool_calls: [
              {
                id: "call_native",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.md"}' },
              },
            ],
          },
          "tool_calls",
        ),
      ),
    );

    const response = await provider("mlx", "http://localhost:8080/v1").createMessage(toolRequest());

    expect(response.content).toEqual([
      { type: "text", text: TEXT_CALL },
      { type: "tool_use", id: "call_native", name: "read_file", input: { path: "a.md" } },
    ]);
  });

  it("does not parse text tool calls from cloud providers or when disabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ content: TEXT_CALL })));

    const cloud = await provider("mistral", "https://api.mistral.ai/v1").createMessage(
      toolRequest(),
    );
    const disabled = await provider("mlx", "http://localhost:8080/v1", false).createMessage(
      toolRequest(),
    );

    for (const response of [cloud, disabled]) {
      expect(response.stopReason).toBe("end_turn");
      expect(response.content).toEqual([{ type: "text", text: TEXT_CALL }]);
    }
  });

  it("does not parse text tool calls on the OpenCode chat-completions route", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ content: TEXT_CALL })));
    const openCode = new OpenCodeProvider({
      type: "openai-compatible",
      providerName: "OpenAI-Compatible",
      apiKey: "key",
      baseUrl: "https://opencode.ai/zen/go/v1",
      defaultModel: "deepseek-v4-flash",
    });

    const response = await openCode.createMessage(toolRequest({ model: "deepseek-v4-flash" }));

    expect(response.content).toEqual([{ type: "text", text: TEXT_CALL }]);
  });

  it("retries with the text tool protocol when the server rejects native tools", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500, "tools param requires --jinja flag"))
      .mockResolvedValueOnce(completion({ content: TEXT_CALL }))
      .mockResolvedValueOnce(completion({ content: "It says hello." }));
    vi.stubGlobal("fetch", fetchMock);
    const llamaCpp = provider("openai-compatible", "http://localhost:8080/v1");

    const first = await llamaCpp.createMessage(toolRequest());

    expect(first.stopReason).toBe("tool_use");
    const toolUse = first.content.find((block) => block.type === "tool_use");
    expect(toolUse).toMatchObject({ name: "read_file", input: { path: "README.md" } });
    const [nativeAttempt, textAttempt] = requestBodies(fetchMock);
    expect(nativeAttempt.tools).toHaveLength(1);
    expect(textAttempt).not.toHaveProperty("tools");
    expect(textAttempt).not.toHaveProperty("tool_choice");
    // The protocol joins the existing leading system message instead of adding
    // another one, since many local chat templates accept only one.
    expect(textAttempt.messages.filter((m: Any) => m.role === "system")).toHaveLength(1);
    expect(textAttempt.messages[0].content).toMatch(/^You are helpful\.\n\n# Tool calling/);

    await llamaCpp.createMessage(
      toolRequest({
        messages: [
          { role: "user", content: "Read README.md" },
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUse!.id, content: "hello" }],
          },
        ],
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const followUp = requestBodies(fetchMock)[2];
    expect(followUp).not.toHaveProperty("tools");
    expect(followUp.messages.slice(1)).toEqual([
      { role: "user", content: "Read README.md" },
      {
        role: "assistant",
        content: '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>',
      },
      { role: "user", content: '<tool_response name="read_file">\nhello\n</tool_response>' },
    ]);
  });

  it("keeps the original error when the fallback is disabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorResponse(500, "tools param requires --jinja flag"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider("openai-compatible", "http://localhost:8080/v1", false).createMessage(toolRequest()),
    ).rejects.toThrow("--jinja");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
