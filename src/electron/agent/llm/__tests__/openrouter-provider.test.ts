import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider } from "../openrouter-provider";

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
          "X-Title": "CoWork OS",
        }),
      }),
    );
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
        "X-Title": "CoWork OS",
      },
    });
  });
});
