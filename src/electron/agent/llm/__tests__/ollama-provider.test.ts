import { afterEach, describe, expect, it, vi } from "vitest";

import { OllamaProvider } from "../ollama-provider";
import type { LLMRequest } from "../types";

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

describe("OllamaProvider reasoning handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("disables Ollama thinking so reasoning cannot consume the final-answer budget", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockOllamaResponse({ role: "assistant", content: "Done" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({
      type: "ollama",
      model: "qwen3.8:27b-q8_0",
      ollamaBaseUrl: "http://localhost:11434",
    });

    const response = await provider.createMessage(createRequest());

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      model: "qwen3.8:27b-q8_0",
      think: false,
      options: { num_predict: 1024 },
    });
    expect(response.content).toEqual([{ type: "text", text: "Done" }]);
    expect(response.stopReason).toBe("end_turn");
  });

  it("omits the think field for models without known reasoning support", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockOllamaResponse({ role: "assistant", content: "Done" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "llama3.3:70b" });
    const request = { ...createRequest(), model: "llama3.3:70b" };

    await provider.createMessage(request);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(requestInit.body))).not.toHaveProperty("think");
  });

  it("retries a reasoning model without think when the server rejects the field", async () => {
    const unsupportedResponse = {
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue("qwen3.8 does not support thinking"),
    } as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unsupportedResponse)
      .mockResolvedValueOnce(mockOllamaResponse({ role: "assistant", content: "Recovered" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider({ type: "ollama", model: "qwen3.8:27b-q8_0" });

    const response = await provider.createMessage(createRequest());

    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
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
});
