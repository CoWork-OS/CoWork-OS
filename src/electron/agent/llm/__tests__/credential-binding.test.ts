import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMProviderFactory, type LLMSettings } from "../provider-factory";
import { PROVIDER_DEFAULT_BASE_URLS, sameCredentialDestination } from "../credential-binding";

const savedKey = "synthetic-saved-provider-key";
const replacementKey = "synthetic-replacement-key";
const savedUrl = "https://saved.example/v1";
const changedUrl = "https://changed.example/v1";

beforeEach(() => {
  vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "deepseek-chat", name: "Model" }],
            models: [{ name: "local-model", size: 1, modified_at: "2026-01-01" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saved provider credential destination binding", () => {
  it.each(["minimax", "minimax-portal"] as const)(
    "preserves static %s catalogs without exporting a credential",
    async (provider) => {
      vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
        providerType: provider,
        modelKey: "model",
        customProviders: { [provider]: { apiKey: savedKey, baseUrl: savedUrl } },
      } as LLMSettings);
      const models = await LLMProviderFactory.getCustomProviderModels(provider, {
        baseUrl: changedUrl,
      });
      expect(models.length).toBeGreaterThan(0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  const methods = [
    ["openrouter", "getOpenRouterModels"],
    ["groq", "getGroqModels"],
    ["xai", "getXAIModels"],
    ["kimi", "getKimiModels"],
    ["deepseek", "getDeepSeekModels"],
  ] as const;

  it.each(methods)("binds %s discovery to its saved endpoint", async (provider, method) => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: provider,
      modelKey: "model",
      [provider]: { apiKey: savedKey, baseUrl: savedUrl },
    } as LLMSettings);
    for (const url of [
      changedUrl,
      "http://saved.example/v1",
      `${savedUrl}/other`,
      `${savedUrl}?tenant=other`,
    ]) {
      await expect(LLMProviderFactory[method]("", url)).rejects.toThrow(/replacement credential/);
    }
    expect(fetch).not.toHaveBeenCalled();
    await LLMProviderFactory[method](undefined, `${savedUrl}/`);
    expect(fetch).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).toContain(savedKey);
    vi.mocked(fetch).mockClear();
    await LLMProviderFactory[method](replacementKey, changedUrl);
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).toContain(replacementKey);
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(savedKey);
  });

  it.each(methods)("accepts the explicit default URL for %s", async (provider, method) => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: provider,
      modelKey: "model",
      [provider]: { apiKey: savedKey },
    } as LLMSettings);
    await LLMProviderFactory[method](undefined, PROVIDER_DEFAULT_BASE_URLS[provider]);
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).toContain(savedKey);
  });

  it("binds Ollama discovery and retains unauthenticated endpoint discovery", async () => {
    const settings = {
      providerType: "ollama",
      modelKey: "model",
      ollama: { apiKey: savedKey, baseUrl: savedUrl },
    } as LLMSettings;
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);
    await expect(LLMProviderFactory.getOllamaModels(changedUrl)).rejects.toThrow(
      /replacement credential/,
    );
    expect(fetch).not.toHaveBeenCalled();
    await LLMProviderFactory.getOllamaModels(savedUrl);
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).toContain(savedKey);
    vi.mocked(fetch).mockClear();
    settings.ollama!.apiKey = undefined;
    await LLMProviderFactory.getOllamaModels(changedUrl);
    expect(fetch).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(savedKey);
  });

  it.each(["omlx", "atomic-chat", "kimi-coding"] as const)(
    "binds custom %s discovery and aliases",
    async (provider) => {
      const canonical = provider === "kimi-coding" ? "kimi-code" : provider;
      vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
        providerType: provider,
        modelKey: "model",
        customProviders: { [canonical]: { apiKey: savedKey, baseUrl: savedUrl } },
      } as LLMSettings);
      await expect(
        LLMProviderFactory.getCustomProviderModels(provider, { baseUrl: changedUrl }),
      ).rejects.toThrow(/replacement credential/);
      expect(fetch).not.toHaveBeenCalled();
      await LLMProviderFactory.getCustomProviderModels(provider, {
        baseUrl: changedUrl,
        apiKey: replacementKey,
      });
      expect(fetch).toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(savedKey);
    },
  );

  it("binds detailed Atomic Chat discovery before any native or compatible request", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "atomic-chat",
      modelKey: "model",
      customProviders: { "atomic-chat": { apiKey: savedKey, baseUrl: savedUrl } },
    } as LLMSettings);
    await expect(
      LLMProviderFactory.getAtomicChatModelsDetailed({ baseUrl: changedUrl }),
    ).rejects.toThrow(/replacement credential/);
    expect(fetch).not.toHaveBeenCalled();
    await LLMProviderFactory.getAtomicChatModelsDetailed({ baseUrl: savedUrl });
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).toContain(savedKey);
  });

  it("does not send the main OpenRouter key to a separately configured image endpoint", async () => {
    const settings = {
      providerType: "openrouter",
      modelKey: "model",
      openrouter: { apiKey: savedKey, baseUrl: savedUrl },
      imageGeneration: { openrouter: { baseUrl: changedUrl } },
    } as LLMSettings;
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);
    await expect(LLMProviderFactory.getOpenRouterImageModels()).rejects.toThrow(
      /replacement credential/,
    );
    expect(fetch).not.toHaveBeenCalled();
    await LLMProviderFactory.getOpenRouterImageModels(replacementKey);
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(savedKey);
    vi.mocked(fetch).mockClear();
    settings.imageGeneration!.openrouter!.apiKey = replacementKey;
    await expect(LLMProviderFactory.getOpenRouterImageModels(undefined, savedUrl)).rejects.toThrow(
      /replacement credential/,
    );
    expect(fetch).not.toHaveBeenCalled();
    await LLMProviderFactory.getOpenRouterImageModels();
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).toContain(replacementKey);
  });

  it("compares canonical URLs without treating query credentials as a new destination", () => {
    expect(
      sameCredentialDestination(
        "https://EXAMPLE.com:443/v1/?api_key=hidden",
        "https://example.com/v1",
      ),
    ).toBe(true);
    expect(
      sameCredentialDestination(`${savedUrl}?token=hidden&tenant=one`, `${savedUrl}?tenant=two`),
    ).toBe(false);
    expect(sameCredentialDestination("https://saved.example@changed.example/v1", savedUrl)).toBe(
      false,
    );
    expect(sameCredentialDestination("not-a-url", "not-a-url")).toBe(false);
  });
});
