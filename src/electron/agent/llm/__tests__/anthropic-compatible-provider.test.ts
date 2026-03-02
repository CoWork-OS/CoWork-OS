import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicCompatibleProvider } from "../anthropic-compatible-provider";

function mockUnauthorizedResponse(message = "unauthorized"): Response {
  return {
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    json: vi.fn().mockResolvedValue({ error: { message } }),
  } as unknown as Response;
}

describe("AnthropicCompatibleProvider URL resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses /v1/messages when base URL has no version segment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockUnauthorizedResponse());
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider({
      type: "minimax-portal",
      providerName: "MiniMax Portal",
      apiKey: "minimax-test",
      baseUrl: "https://api.minimax.io/anthropic",
      defaultModel: "MiniMax-M2.1",
    });

    await provider.testConnection();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimax.io/anthropic/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses /messages when base URL already ends with /v1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockUnauthorizedResponse());
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider({
      type: "qwen-portal",
      providerName: "Qwen",
      apiKey: "qwen-test",
      baseUrl: "https://portal.qwen.ai/v1",
      defaultModel: "qwen-model",
    });

    await provider.testConnection();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://portal.qwen.ai/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses the base URL directly when it already ends with /messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockUnauthorizedResponse());
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicCompatibleProvider({
      type: "anthropic-compatible",
      providerName: "Anthropic-Compatible",
      apiKey: "test-key",
      baseUrl: "https://example.com/custom/messages",
      defaultModel: "custom-model",
    });

    await provider.testConnection();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/custom/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
