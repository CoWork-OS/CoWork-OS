import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../openai-compatible-provider";

describe("MLX-LM OpenAI-compatible provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes the legacy localhost endpoint to MLX-LM's /v1 API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] }),
    } as unknown as Response);
    const provider = new OpenAICompatibleProvider({
      type: "mlx",
      providerName: "MLX (Apple Silicon)",
      apiKey: "",
      baseUrl: "http://localhost:8080",
      defaultModel: "mlx-community/Qwen3-8B-4bit",
    });

    await expect(provider.testConnection()).resolves.toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8080/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );

    fetchSpy.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ id: "mlx-community/Qwen3-8B-4bit" }],
      }),
    } as unknown as Response);

    await expect(provider.getAvailableModels()).resolves.toEqual([
      {
        id: "mlx-community/Qwen3-8B-4bit",
        name: "mlx-community/Qwen3-8B-4bit",
      },
    ]);
    expect(fetchSpy).toHaveBeenLastCalledWith("http://localhost:8080/v1/models", {
      headers: {},
    });
  });

  it("preserves an explicitly configured /v1 endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] }),
    } as unknown as Response);
    const provider = new OpenAICompatibleProvider({
      type: "mlx",
      providerName: "MLX (Apple Silicon)",
      apiKey: "",
      baseUrl: "http://localhost:8080/v1/",
      defaultModel: "mlx-community/Qwen3-8B-4bit",
    });

    await provider.testConnection();

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8080/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("removes CoWork's internal MLX runtime marker before sending the model ID", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] }),
    } as unknown as Response);
    const provider = new OpenAICompatibleProvider({
      type: "mlx",
      providerName: "MLX (Apple Silicon)",
      apiKey: "",
      baseUrl: "http://localhost:8080/v1",
      defaultModel: "mlx://mlx-community/Qwen3-8B-4bit",
    });

    await provider.testConnection();

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "mlx-community/Qwen3-8B-4bit",
    });
  });
});
