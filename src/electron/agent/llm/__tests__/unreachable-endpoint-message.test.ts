import { afterEach, describe, expect, it, vi } from "vitest";
import { unreachableEndpointMessage } from "../unreachable-endpoint-message";
import { OpenAICompatibleProvider } from "../openai-compatible-provider";
import { LLMProviderFactory } from "../provider-factory";

/** What Node's fetch rejects with when the server cannot be reached. */
function fetchFailed(code?: string): TypeError {
  const error = new TypeError("fetch failed");
  if (code)
    (error as TypeError & { cause: unknown }).cause = Object.assign(new Error(code), { code });
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("unreachableEndpointMessage", () => {
  it("says which host could not be reached and why", () => {
    expect(
      unreachableEndpointMessage(fetchFailed("ECONNREFUSED"), "http://127.0.0.1:1/v1/models"),
    ).toBe(
      "Couldn't reach 127.0.0.1:1: the connection was refused. Check that the server is running and the base URL is correct.",
    );
    expect(
      unreachableEndpointMessage(fetchFailed("ENOTFOUND"), "https://llm.invalid/v1"),
    ).toContain("Couldn't reach llm.invalid: the host name was not found.");
    expect(unreachableEndpointMessage(fetchFailed(), "http://localhost:1234/v1")).toBe(
      "Couldn't reach localhost:1234. Check that the server is running and the base URL is correct.",
    );
  });

  it("names the host only, never credentials or the path", () => {
    const message = unreachableEndpointMessage(
      fetchFailed("ECONNREFUSED"),
      "https://user:secret@gateway.example:8443/v1/chat/completions?key=abc",
    );
    expect(message).toContain("gateway.example:8443");
    expect(message).not.toMatch(/secret|user|key=abc|chat\/completions/);
  });

  it("leaves other errors to their own message", () => {
    expect(unreachableEndpointMessage(new Error("Invalid API key"), "http://localhost/v1")).toBe(
      undefined,
    );
  });
});

describe("OpenAI-compatible endpoint that cannot be reached", () => {
  const config = {
    type: "openai-compatible" as const,
    providerName: "OpenAI-Compatible",
    apiKey: "",
    baseUrl: "http://127.0.0.1:1/v1",
    defaultModel: "local-model",
  };

  it("explains the failed connection test instead of saying 'fetch failed'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed("ECONNREFUSED")));
    const result = await new OpenAICompatibleProvider(config).testConnection();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Couldn't reach 127\.0\.0\.1:1: the connection was refused\./);
  });

  it("rejects a failed model fetch and keeps the saved model list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed("ECONNREFUSED")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.spyOn(LLMProviderFactory, "saveCachedModels").mockImplementation(() => {});
    await expect(LLMProviderFactory.getOpenAICompatibleModels(config.baseUrl)).rejects.toThrow(
      /^Couldn't reach 127\.0\.0\.1:1: the connection was refused\./,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("still saves the models a reachable endpoint lists", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: "local-model" }] }), { status: 200 }),
        ),
    );
    const save = vi.spyOn(LLMProviderFactory, "saveCachedModels").mockImplementation(() => {});
    await expect(LLMProviderFactory.getOpenAICompatibleModels(config.baseUrl)).resolves.toEqual([
      { key: "local-model", displayName: "local-model", description: "OpenAI-compatible model" },
    ]);
    expect(save).toHaveBeenCalledWith("openai-compatible", [
      { key: "local-model", displayName: "local-model", description: "OpenAI-compatible model" },
    ]);
  });
});
