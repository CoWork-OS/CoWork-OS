import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeProvider } from "../opencode-go-provider";
import { getOpenCodeModelTransport, isOpenCodeBaseUrl } from "../opencode-go-routing";
import type { LLMRequest } from "../types";

const request = {
  model: "",
  maxTokens: 128,
  system: "You are helpful.",
  messages: [{ role: "user" as const, content: "Hello" }],
};

function responseJson(body: unknown): Response {
  const serialized = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(serialized),
  } as unknown as Response;
}

describe("OpenCode provider routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("recognizes Zen and Go base URLs and maps their documented transports", () => {
    expect(isOpenCodeBaseUrl("https://opencode.ai/zen/v1")).toBe(true);
    expect(isOpenCodeBaseUrl("https://opencode.ai/zen/go/v1/models")).toBe(true);
    expect(getOpenCodeModelTransport("gpt-5.5", "zen")).toBe("responses");
    expect(getOpenCodeModelTransport("qwen3.8-max", "go")).toBe("messages");
    expect(getOpenCodeModelTransport("deepseek-v4-flash", "go")).toBe("chat_completions");
    expect(getOpenCodeModelTransport("minimax-m3", "zen")).toBe("chat_completions");
    expect(getOpenCodeModelTransport("minimax-m3", "go")).toBe("messages");
  });

  it.each([
    ["gpt-6.2-astra", "openai/v1/responses"],
    ["gpt-6.2-sol", "openai/v1/responses"],
    ["claude-fable-5-2", "anthropic/v1/messages"],
  ])("uses the documented endpoint for Zen tool calls with %s", async (model, path) => {
    const isMessages = path.endsWith("/messages");
    const fetchMock = vi.fn().mockImplementation(async () =>
      Response.json(
        isMessages
          ? {
              stop_reason: "tool_use",
              content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }],
            }
          : {
              status: "completed",
              output: [
                { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
              ],
            },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenCodeProvider({
      type: "opencode",
      providerName: "OpenCode Zen",
      apiKey: "zen-key",
      baseUrl: "https://opencode.ai/zen/v1",
      defaultModel: "gpt-5.5",
    });
    const toolRequest: LLMRequest = {
      ...request,
      model,
      tools: [{ name: "lookup", description: "Read fixture", input_schema: { type: "object" } }],
    };
    const first = await provider.createMessage(toolRequest);
    expect(first.content).toEqual([{ type: "tool_use", id: "call_1", name: "lookup", input: {} }]);
    await provider.createMessage({
      ...toolRequest,
      messages: [
        ...toolRequest.messages,
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "fixture" }],
        },
      ],
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://opencode.ai/inference/${path}`,
      `https://opencode.ai/inference/${path}`,
    ]);
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.model).toBe(model);
    expect(isMessages ? body.messages.at(-1).content[0] : body.input.at(-1)).toMatchObject(
      isMessages
        ? { type: "tool_result", tool_use_id: "call_1", content: "fixture" }
        : { type: "function_call_output", call_id: "call_1", output: "fixture" },
    );
  });

  it("uses the Zen Responses endpoint for GPT models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responseJson({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Zen response" }],
          },
        ],
        status: "completed",
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenCodeProvider({
      type: "opencode",
      providerName: "OpenCode Zen",
      apiKey: "zen-key",
      baseUrl: "https://opencode.ai/zen/v1",
      defaultModel: "gpt-5.5",
    });

    await expect(
      provider.createMessage({ ...request, model: "opencode/gpt-5.5" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Zen response" }],
      stopReason: "end_turn",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/zen/v1/responses",
      expect.objectContaining({ method: "POST" }),
    );
    const responseHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(responseHeaders.get("authorization")).toBe("Bearer zen-key");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "gpt-5.5",
      // Reasoning headroom: a 128-token cap at medium effort returns no text.
      max_output_tokens: 128 + 2_048,
    });
  });

  it("uses the Go Anthropic Messages endpoint for Qwen models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responseJson({
        content: [{ type: "text", text: "Go response" }],
        stop_reason: "end_turn",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenCodeProvider({
      type: "opencode-go",
      providerName: "OpenCode Go",
      apiKey: "go-key",
      baseUrl: "https://opencode.ai/zen/go/v1",
      defaultModel: "qwen3.8-max",
    });

    await expect(
      provider.createMessage({ ...request, model: "opencode-go/qwen3.8-max" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Go response" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "go-key",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen3.8-max",
    });
  });

  it("uses Chat Completions for MiniMax on Zen", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responseJson({
        choices: [{ message: { role: "assistant", content: "Zen MiniMax response" } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenCodeProvider({
      type: "opencode",
      providerName: "OpenCode Zen",
      apiKey: "zen-key",
      baseUrl: "https://opencode.ai/zen/v1",
      defaultModel: "minimax-m3",
    });

    await expect(
      provider.createMessage({ ...request, model: "opencode/minimax-m3" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Zen MiniMax response" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/zen/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends one stable x-opencode-session header on every Go request (#889)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.endsWith("/messages")
        ? responseJson({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })
        : responseJson({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const options = {
      type: "opencode-go" as const,
      providerName: "OpenCode Go",
      apiKey: "go-key",
      baseUrl: "https://opencode.ai/zen/go/v1",
      defaultModel: "deepseek-v4-flash",
    };
    const provider = new OpenCodeProvider(options);

    await provider.createMessage({ ...request, model: "opencode-go/deepseek-v4-flash" });
    await provider.createMessage({ ...request, model: "opencode-go/deepseek-v4-flash" });
    await provider.createMessage({ ...request, model: "opencode-go/qwen3.8-max" });
    await new OpenCodeProvider(options).createMessage({ ...request, model: "deepseek-v4-flash" });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "https://opencode.ai/zen/go/v1/chat/completions",
      "https://opencode.ai/zen/go/v1/chat/completions",
      "https://opencode.ai/zen/go/v1/messages",
      "https://opencode.ai/zen/go/v1/chat/completions",
    ]);
    const sessions = fetchMock.mock.calls.map(([, init]) => sessionHeader(init));
    expect(sessions[0]).toBe(provider.sessionId);
    expect(sessions[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessions.slice(0, 3)).toEqual([sessions[0], sessions[0], sessions[0]]);
    // A new task builds a new provider and starts a new OpenCode session.
    expect(sessions[3]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessions[3]).not.toBe(sessions[0]);
  });

  it("sends the session header through the Responses SDK and model discovery", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.endsWith("/models")
        ? responseJson({ data: [{ id: "gpt-5.5" }] })
        : responseJson({
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
            status: "completed",
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenCodeProvider({
      type: "opencode",
      providerName: "OpenCode Zen",
      apiKey: "zen-key",
      baseUrl: "https://opencode.ai/zen/v1",
      defaultModel: "gpt-5.5",
    });

    await provider.createMessage({ ...request, model: "opencode/gpt-5.5" });
    await provider.getAvailableModels();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://opencode.ai/zen/v1/responses",
      "https://opencode.ai/zen/v1/models",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(sessionHeader(init)).toBe(provider.sessionId);
    }
  });
});

function sessionHeader(init: RequestInit | undefined): string | null {
  const headers = init?.headers;
  if (headers instanceof Headers) return headers.get("x-opencode-session");
  const record = (headers ?? {}) as Record<string, string>;
  return record["x-opencode-session"] ?? null;
}
