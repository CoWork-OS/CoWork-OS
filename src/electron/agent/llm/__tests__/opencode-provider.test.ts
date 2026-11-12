import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeProvider } from "../opencode-go-provider";
import { getOpenCodeModelTransport, isOpenCodeBaseUrl } from "../opencode-go-routing";

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

  describe("x-opencode-session header (issue #889)", () => {
    const goOptions = {
      type: "opencode-go" as const,
      providerName: "OpenCode Go",
      apiKey: "go-key",
      baseUrl: "https://opencode.ai/zen/go/v1",
    };

    function sessionHeaderOf(init: RequestInit | undefined): string | null {
      return new Headers(init?.headers).get("x-opencode-session");
    }

    it("sends a stable session header on every Go transport and the connection test", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith("/messages")) {
          return responseJson({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
        }
        if (url.endsWith("/responses")) {
          return responseJson({
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
            status: "completed",
          });
        }
        if (url.endsWith("/models")) {
          return responseJson({ data: [{ id: "deepseek-v4-flash" }] });
        }
        return responseJson({ choices: [{ message: { role: "assistant", content: "ok" } }] });
      });
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenCodeProvider({ ...goOptions, defaultModel: "deepseek-v4-flash" });
      expect(provider.sessionId).toMatch(/^[0-9a-f-]{36}$/);

      await provider.testConnection();
      await provider.createMessage({ ...request, model: "deepseek-v4-flash" });
      await provider.createMessage({ ...request, model: "deepseek-v4-flash" });
      await provider.createMessage({ ...request, model: "qwen3.8-max" });
      await provider.createMessage({ ...request, model: "gpt-5.5" });
      await provider.getAvailableModels();

      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls).toEqual(
        expect.arrayContaining([
          "https://opencode.ai/zen/go/v1/chat/completions",
          "https://opencode.ai/zen/go/v1/messages",
          "https://opencode.ai/zen/go/v1/responses",
          "https://opencode.ai/zen/go/v1/models",
        ]),
      );
      const sessions = fetchMock.mock.calls.map((call) => sessionHeaderOf(call[1]));
      expect(sessions.length).toBeGreaterThanOrEqual(6);
      expect(new Set(sessions)).toEqual(new Set([provider.sessionId]));
    });

    it("sends the header on the Messages connection test", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        responseJson({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenCodeProvider({ ...goOptions, defaultModel: "qwen3.8-max" });
      await expect(provider.testConnection()).resolves.toEqual({ success: true });
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://opencode.ai/zen/go/v1/messages");
      expect(sessionHeaderOf(fetchMock.mock.calls[0]?.[1])).toBe(provider.sessionId);
    });

    it("sends the header through the diagnostic fetch connection test", async () => {
      const diagnosticFetch = vi.fn().mockResolvedValue(
        responseJson({ data: [{ id: "deepseek-v4-flash" }] }),
      );
      const provider = new OpenCodeProvider({
        ...goOptions,
        defaultModel: "deepseek-v4-flash",
        diagnosticFetch,
      });
      await expect(provider.testConnection()).resolves.toEqual({ success: true });
      expect(sessionHeaderOf(diagnosticFetch.mock.calls[0]?.[1])).toBe(provider.sessionId);
    });

    it("uses a caller-provided session id and differs between provider instances", () => {
      const pinned = new OpenCodeProvider({
        ...goOptions,
        defaultModel: "deepseek-v4-flash",
        sessionId: "task-123",
      });
      expect(pinned.sessionId).toBe("task-123");

      const a = new OpenCodeProvider({ ...goOptions, defaultModel: "deepseek-v4-flash" });
      const b = new OpenCodeProvider({ ...goOptions, defaultModel: "deepseek-v4-flash" });
      expect(a.sessionId).not.toBe(b.sessionId);
    });

    it("does not send the header to Zen", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        responseJson({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenCodeProvider({
        type: "opencode",
        providerName: "OpenCode Zen",
        apiKey: "zen-key",
        baseUrl: "https://opencode.ai/zen/v1",
        defaultModel: "minimax-m3",
      });
      expect(provider.sessionId).toBeUndefined();
      await provider.createMessage({ ...request, model: "minimax-m3" });
      expect(sessionHeaderOf(fetchMock.mock.calls[0]?.[1])).toBeNull();
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
