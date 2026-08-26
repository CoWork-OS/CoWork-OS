import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeProvider } from "../opencode-go-provider";
import {
  getOpenCodeModelTransport,
  isOpenCodeBaseUrl,
} from "../opencode-go-routing";

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
      max_output_tokens: 128,
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
});
