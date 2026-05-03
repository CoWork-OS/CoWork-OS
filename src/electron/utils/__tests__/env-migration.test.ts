import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/app",
    getPath: () => "/userData",
  },
}));

const mocks = vi.hoisted(() => ({
  llmLoad: vi.fn(),
  llmSave: vi.fn(),
  searchLoad: vi.fn(),
  searchSave: vi.fn(),
}));

vi.mock("../../agent/llm", () => ({
  LLMProviderFactory: {
    loadSettings: mocks.llmLoad,
    saveSettings: mocks.llmSave,
  },
}));

vi.mock("../../agent/search", () => ({
  SearchProviderFactory: {
    loadSettings: mocks.searchLoad,
    saveSettings: mocks.searchSave,
  },
}));

import { importProcessEnvToSettings } from "../env-migration";

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

describe("importProcessEnvToSettings", () => {
  const ENV_SNAPSHOT = { ...process.env };

  beforeEach(() => {
    restoreEnv(ENV_SNAPSHOT);
    mocks.llmLoad.mockReset();
    mocks.llmSave.mockReset();
    mocks.searchLoad.mockReset();
    mocks.searchSave.mockReset();
  });

  afterEach(() => {
    restoreEnv(ENV_SNAPSHOT);
  });

  it("imports OpenAI key and selects openai provider when current provider is unconfigured (merge)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    mocks.llmLoad.mockReturnValue({ providerType: "anthropic", modelKey: "opus-4-5" });
    mocks.searchLoad.mockReturnValue({ primaryProvider: null, fallbackProvider: null });

    const res = await importProcessEnvToSettings({ mode: "merge" });

    expect(res.migrated).toBe(true);
    expect(res.migratedKeys).toContain("OpenAI API Key");
    expect(mocks.llmSave).toHaveBeenCalledTimes(1);

    const saved = mocks.llmSave.mock.calls[0][0];
    expect(saved.openai.apiKey).toBe("sk-test");
    expect(saved.openai.authMethod).toBe("api_key");
    expect(saved.providerType).toBe("openai");
  });

  it("does not flip provider if current provider is already configured", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    mocks.llmLoad.mockReturnValue({
      providerType: "anthropic",
      modelKey: "opus-4-5",
      anthropic: { apiKey: "existing" },
    });
    mocks.searchLoad.mockReturnValue({ primaryProvider: null, fallbackProvider: null });

    await importProcessEnvToSettings({ mode: "merge" });

    const saved = mocks.llmSave.mock.calls[0][0];
    expect(saved.providerType).toBe("anthropic");
    expect(saved.openai.apiKey).toBe("sk-test");
  });

  it("overwrites existing OpenAI key in overwrite mode", async () => {
    process.env.OPENAI_API_KEY = "sk-new";

    mocks.llmLoad.mockReturnValue({
      providerType: "openai",
      modelKey: "opus-4-5",
      openai: { apiKey: "sk-old" },
    });
    mocks.searchLoad.mockReturnValue({ primaryProvider: null, fallbackProvider: null });

    await importProcessEnvToSettings({ mode: "overwrite" });

    const saved = mocks.llmSave.mock.calls[0][0];
    expect(saved.openai.apiKey).toBe("sk-new");
  });

  it("imports DeepSeek key and base URL into built-in settings", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek";
    process.env.DEEPSEEK_BASE_URL = "https://deepseek.example/v1";

    mocks.llmLoad.mockReturnValue({ providerType: "anthropic", modelKey: "opus-4-5" });
    mocks.searchLoad.mockReturnValue({ primaryProvider: null, fallbackProvider: null });

    await importProcessEnvToSettings({ mode: "merge" });

    const saved = mocks.llmSave.mock.calls[0][0];
    expect(saved.deepseek.apiKey).toBe("sk-deepseek");
    expect(saved.deepseek.baseUrl).toBe("https://deepseek.example/v1");
    expect(saved.providerType).toBe("deepseek");
  });

  it("imports Tavily key into search settings", async () => {
    process.env.TAVILY_API_KEY = "tav-test";

    mocks.llmLoad.mockReturnValue({ providerType: "anthropic", modelKey: "opus-4-5" });
    mocks.searchLoad.mockReturnValue({ primaryProvider: null, fallbackProvider: null });

    await importProcessEnvToSettings({ mode: "merge" });

    expect(mocks.searchSave).toHaveBeenCalledTimes(1);
    const saved = mocks.searchSave.mock.calls[0][0];
    expect(saved.tavily.apiKey).toBe("tav-test");
  });

  it("imports Exa key into search settings", async () => {
    process.env.EXA_API_KEY = "exa-test";

    mocks.llmLoad.mockReturnValue({ providerType: "anthropic", modelKey: "opus-4-5" });
    mocks.searchLoad.mockReturnValue({ primaryProvider: null, fallbackProvider: null });

    await importProcessEnvToSettings({ mode: "merge" });

    expect(mocks.searchSave).toHaveBeenCalledTimes(1);
    const saved = mocks.searchSave.mock.calls[0][0];
    expect(saved.exa.apiKey).toBe("exa-test");
  });

  it("applies provider override when COWORK_LLM_PROVIDER is valid", async () => {
    process.env.COWORK_LLM_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "g-test";

    mocks.llmLoad.mockReturnValue({ providerType: "anthropic", modelKey: "opus-4-5" });
    mocks.searchLoad.mockReturnValue({ primaryProvider: null, fallbackProvider: null });

    await importProcessEnvToSettings({ mode: "merge" });

    const saved = mocks.llmSave.mock.calls[0][0];
    expect(saved.gemini.apiKey).toBe("g-test");
    expect(saved.providerType).toBe("gemini");
  });
});
