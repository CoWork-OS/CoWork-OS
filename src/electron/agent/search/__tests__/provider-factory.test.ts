/**
 * Tests for SearchProviderFactory - retry and fallback logic
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock SecureSettingsRepository
vi.mock("../../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn().mockReturnValue(true),
    getInstance: vi.fn().mockReturnValue({
      exists: vi.fn().mockReturnValue(false),
      load: vi.fn().mockReturnValue(null),
      save: vi.fn(),
    }),
  },
}));

// Import after mocking
import { SearchProviderFactory } from "../provider-factory";
import { SecureSettingsRepository } from "../../../database/SecureSettingsRepository";

describe("SearchProviderFactory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SearchProviderFactory.clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isTransientSearchError", () => {
    // Access the private method through any cast
    const isTransient = (error: Any) =>
      (SearchProviderFactory as Any).isTransientSearchError(error);

    it("should detect rate limit errors", () => {
      expect(isTransient({ message: "Rate limit exceeded" })).toBe(true);
      expect(isTransient({ message: "Error 429: Too many requests" })).toBe(true);
      expect(isTransient({ message: "too many requests" })).toBe(true);
    });

    it("should detect timeout errors", () => {
      expect(isTransient({ message: "Request timeout" })).toBe(true);
      expect(isTransient({ message: "ETIMEDOUT" })).toBe(true);
    });

    it("should detect connection errors", () => {
      expect(isTransient({ message: "ECONNRESET" })).toBe(true);
      expect(isTransient({ message: "EAI_AGAIN" })).toBe(true);
    });

    it("should detect server errors", () => {
      expect(isTransient({ message: "Error 503" })).toBe(true);
      expect(isTransient({ message: "Error 502" })).toBe(true);
      expect(isTransient({ message: "Error 504" })).toBe(true);
      expect(isTransient({ message: "Service unavailable" })).toBe(true);
    });

    it("should not detect permanent errors", () => {
      expect(isTransient({ message: "Invalid API key" })).toBe(false);
      expect(isTransient({ message: "Authentication failed" })).toBe(false);
      expect(isTransient({ message: "Bad request" })).toBe(false);
      expect(isTransient({ message: "Not found" })).toBe(false);
    });

    it("should handle null or undefined errors", () => {
      expect(isTransient(null)).toBe(false);
      expect(isTransient(undefined)).toBe(false);
      expect(isTransient({})).toBe(false);
    });
  });

  describe("sleep", () => {
    it("should delay for specified milliseconds", async () => {
      const start = Date.now();
      await (SearchProviderFactory as Any).sleep(100);
      const elapsed = Date.now() - start;

      // Allow some tolerance for timing
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe("searchWithRetry", () => {
    it("should return result on first success", async () => {
      const mockProvider = {
        search: vi.fn().mockResolvedValue({
          query: "test",
          searchType: "web",
          results: [{ title: "Result", url: "https://example.com" }],
          provider: "tavily",
        }),
      };

      const result = await (SearchProviderFactory as Any).searchWithRetry(mockProvider, {
        query: "test",
        searchType: "web",
      });

      expect(result.results).toHaveLength(1);
      expect(mockProvider.search).toHaveBeenCalledTimes(1);
    });

    it("should retry on transient errors", async () => {
      const mockProvider = {
        search: vi
          .fn()
          .mockRejectedValueOnce(new Error("Rate limit exceeded"))
          .mockResolvedValueOnce({
            query: "test",
            searchType: "web",
            results: [],
            provider: "tavily",
          }),
      };

      const result = await (SearchProviderFactory as Any).searchWithRetry(mockProvider, {
        query: "test",
        searchType: "web",
      });

      expect(result).toBeDefined();
      expect(mockProvider.search).toHaveBeenCalledTimes(2);
    });

    it("should not retry on permanent errors", async () => {
      const mockProvider = {
        search: vi.fn().mockRejectedValue(new Error("Invalid API key")),
      };

      await expect(
        (SearchProviderFactory as Any).searchWithRetry(mockProvider, {
          query: "test",
          searchType: "web",
        }),
      ).rejects.toThrow("Invalid API key");

      expect(mockProvider.search).toHaveBeenCalledTimes(1);
    });

    it("should throw after max retry attempts", async () => {
      const mockProvider = {
        search: vi.fn().mockRejectedValue(new Error("Rate limit exceeded")),
      };

      await expect(
        (SearchProviderFactory as Any).searchWithRetry(
          mockProvider,
          { query: "test", searchType: "web" },
          2,
        ),
      ).rejects.toThrow("Rate limit exceeded");

      expect(mockProvider.search).toHaveBeenCalledTimes(2);
    });

    it("should use exponential backoff delay", async () => {
      const sleepSpy = vi.spyOn(SearchProviderFactory as Any, "sleep").mockResolvedValue(undefined);
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

      const mockProvider = {
        search: vi
          .fn()
          .mockRejectedValueOnce(new Error("Rate limit exceeded"))
          .mockResolvedValueOnce({
            query: "test",
            searchType: "web",
            results: [],
            provider: "tavily",
          }),
      };

      await (SearchProviderFactory as Any).searchWithRetry(mockProvider, {
        query: "test",
        searchType: "web",
      });

      // First retry should use 1000ms delay (1000 * 1) with zero jitter
      expect(sleepSpy).toHaveBeenCalledWith(1000);
      randomSpy.mockRestore();
    });

    it("should not retry when maxAttempts is 1", async () => {
      const mockProvider = {
        search: vi.fn().mockRejectedValue(new Error("Rate limit exceeded")),
      };

      await expect(
        (SearchProviderFactory as Any).searchWithRetry(
          mockProvider,
          { query: "test", searchType: "web" },
          1,
        ),
      ).rejects.toThrow("Rate limit exceeded");

      // Should only attempt once with maxAttempts = 1
      expect(mockProvider.search).toHaveBeenCalledTimes(1);
    });

    it("should increase delay on subsequent retries", async () => {
      const sleepSpy = vi.spyOn(SearchProviderFactory as Any, "sleep").mockResolvedValue(undefined);
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

      const mockProvider = {
        search: vi
          .fn()
          .mockRejectedValueOnce(new Error("Rate limit exceeded"))
          .mockRejectedValueOnce(new Error("Rate limit exceeded"))
          .mockResolvedValueOnce({
            query: "test",
            searchType: "web",
            results: [],
            provider: "tavily",
          }),
      };

      await (SearchProviderFactory as Any).searchWithRetry(
        mockProvider,
        { query: "test", searchType: "web" },
        3,
      );

      // First retry: 1000 * 1 = 1000ms, Second retry: 1000 * 2 = 2000ms (zero jitter)
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 1000);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 2000);
      randomSpy.mockRestore();
    });

    it("should throw fallback error when lastError is undefined", async () => {
      const mockProvider = {
        search: vi.fn().mockRejectedValue(undefined),
      };

      await expect(
        (SearchProviderFactory as Any).searchWithRetry(
          mockProvider,
          { query: "test", searchType: "web" },
          1,
        ),
      ).rejects.toThrow("Search failed");
    });
  });

  describe("clearCache", () => {
    it("should clear cached settings", () => {
      // Access private cachedSettings
      (SearchProviderFactory as Any).cachedSettings = { primaryProvider: "tavily" };

      SearchProviderFactory.clearCache();

      expect((SearchProviderFactory as Any).cachedSettings).toBeNull();
    });
  });

  describe("SearXNG settings lifecycle", () => {
    it("clears the saved endpoint and invalid routing when an empty SearXNG object is saved", () => {
      const repository = SecureSettingsRepository.getInstance() as Any;
      repository.load.mockReturnValue({
        primaryProvider: "searxng",
        fallbackProvider: "brave",
        brave: { apiKey: "brave" },
        searxng: { baseUrl: "https://search.example.com", allowPrivate: false },
      });

      SearchProviderFactory.saveSettings({
        primaryProvider: "searxng",
        fallbackProvider: "brave",
        searxng: {},
      });

      expect(repository.save).toHaveBeenCalledWith(
        "search",
        expect.objectContaining({
          primaryProvider: "brave",
          fallbackProvider: null,
          searxng: undefined,
        }),
      );
    });

    it("never synthesizes a fallback when the saved fallback is None", () => {
      const repository = SecureSettingsRepository.getInstance() as Any;
      repository.load.mockReturnValue({
        primaryProvider: null,
        fallbackProvider: null,
        tavily: { apiKey: "tavily" },
        brave: { apiKey: "brave" },
      });

      const settings = SearchProviderFactory.loadSettings();

      expect(settings.primaryProvider).toBe("tavily");
      expect(settings.fallbackProvider).toBeNull();
    });

    it("returns the saved endpoint state so the UI can inspect and edit it", () => {
      vi.spyOn(SearchProviderFactory, "loadSettings").mockReturnValue({
        primaryProvider: "searxng",
        fallbackProvider: null,
        searxng: { baseUrl: "https://search.example.com", allowPrivate: true },
      });

      expect(SearchProviderFactory.getConfigStatus().searxng).toEqual({
        baseUrl: "https://search.example.com",
        allowPrivate: true,
      });
    });
  });

  describe("provider execution order", () => {
    it("uses only the explicit primary and fallback", () => {
      const settings = {
        primaryProvider: "tavily",
        fallbackProvider: "google",
        tavily: { apiKey: "tavily" },
        brave: { apiKey: "brave" },
        serpapi: { apiKey: "serpapi" },
        google: { apiKey: "google", searchEngineId: "id" },
      } as Any;

      const order = (SearchProviderFactory as Any).getProviderExecutionOrder(settings);

      expect(order).toEqual(["tavily", "google"]);
    });

    it("uses no alternate provider when fallback is None", () => {
      const settings = {
        primaryProvider: "tavily",
        fallbackProvider: null,
        tavily: { apiKey: "tavily" },
        google: { apiKey: "google", searchEngineId: "id" },
      } as Any;

      const order = (SearchProviderFactory as Any).getProviderExecutionOrder(settings);

      expect(order).toEqual(["tavily"]);
    });

    it("enforces SearXNG isolation even if a fallback is stored", () => {
      const settings = {
        primaryProvider: "searxng",
        fallbackProvider: "brave",
        tavily: { apiKey: "tavily" },
        brave: { apiKey: "brave" },
        searxng: { baseUrl: "https://search.example.com" },
      } as Any;

      const order = (SearchProviderFactory as Any).getProviderExecutionOrder(settings);

      expect(order).toEqual(["searxng"]);
    });

    it("uses DuckDuckGo only when no configured provider exists", () => {
      const order = (SearchProviderFactory as Any).getProviderExecutionOrder({
        primaryProvider: null,
        fallbackProvider: null,
      });

      expect(order).toEqual(["duckduckgo"]);
    });
  });

  describe("searchWithFallback", () => {
    it("rejects provider overrides while SearXNG isolation is active", async () => {
      vi.spyOn(SearchProviderFactory, "loadSettings").mockReturnValue({
        primaryProvider: "searxng",
        fallbackProvider: null,
        searxng: { baseUrl: "https://search.example.com" },
        brave: { apiKey: "brave" },
      });
      const createProviderSpy = vi.spyOn(SearchProviderFactory as Any, "createProviderFromConfig");

      await expect(
        SearchProviderFactory.searchWithFallback({
          query: "private query",
          provider: "brave",
        }),
      ).rejects.toThrow("provider overrides cannot route queries elsewhere");
      expect(createProviderSpy).not.toHaveBeenCalled();
    });

    it("should try providers in order and stop on first successful result", async () => {
      const braveProvider = { search: vi.fn().mockResolvedValue({ provider: "brave" }) };
      const tavilyProvider = { search: vi.fn().mockResolvedValue({ provider: "tavily" }) };

      vi.spyOn(SearchProviderFactory, "loadSettings").mockReturnValue({
        primaryProvider: "tavily",
        fallbackProvider: "google",
        tavily: { apiKey: "tavily" },
        brave: { apiKey: "brave" },
      } as Any);

      vi.spyOn(SearchProviderFactory as Any, "getProviderExecutionOrder").mockReturnValue([
        "brave",
        "tavily",
      ]);

      const getConfigSpy = vi.spyOn(SearchProviderFactory as Any, "getProviderConfig");
      getConfigSpy.mockImplementation((providerType: string) => ({ type: providerType }));

      const createProviderSpy = vi.spyOn(SearchProviderFactory as Any, "createProviderFromConfig");
      createProviderSpy.mockImplementation((config: Any) => {
        if (config.type === "brave") return braveProvider;
        return tavilyProvider;
      });

      const searchRetrySpy = vi.spyOn(SearchProviderFactory as Any, "searchWithRetry");
      searchRetrySpy.mockImplementation(async (provider: Any) => provider.search());

      const response = await SearchProviderFactory.searchWithFallback({
        query: "f1 latest",
        searchType: "web",
      });

      expect(searchRetrySpy).toHaveBeenCalledTimes(1);
      expect(response.provider).toBe("brave");
      expect(braveProvider.search).toHaveBeenCalledTimes(1);
      expect(tavilyProvider.search).not.toHaveBeenCalled();
    });

    it("should fallback to next configured provider when prior provider fails", async () => {
      const braveProvider = { search: vi.fn().mockRejectedValue(new Error("Brave failed")) };
      const tavilyProvider = { search: vi.fn().mockResolvedValue({ provider: "tavily" }) };

      vi.spyOn(SearchProviderFactory, "loadSettings").mockReturnValue({
        primaryProvider: "tavily",
        fallbackProvider: "google",
        tavily: { apiKey: "tavily" },
        brave: { apiKey: "brave" },
      } as Any);

      vi.spyOn(SearchProviderFactory as Any, "getProviderExecutionOrder").mockReturnValue([
        "brave",
        "tavily",
      ]);

      vi.spyOn(SearchProviderFactory as Any, "getProviderConfig").mockImplementation(
        (providerType: string) => ({
          type: providerType,
        }),
      );

      vi.spyOn(SearchProviderFactory as Any, "createProviderFromConfig").mockImplementation(
        (config: Any) => {
          if (config.type === "brave") return braveProvider;
          return tavilyProvider;
        },
      );

      vi.spyOn(SearchProviderFactory as Any, "searchWithRetry").mockImplementation(
        async (provider: Any) => {
          return provider.search();
        },
      );

      const response = await SearchProviderFactory.searchWithFallback({
        query: "f1 latest",
        searchType: "web",
      });

      expect(response.provider).toBe("tavily");
      expect(braveProvider.search).toHaveBeenCalledTimes(1);
      expect(tavilyProvider.search).toHaveBeenCalledTimes(1);
    });

    it("should honor explicit provider and not attempt fallback", async () => {
      const braveProvider = { search: vi.fn().mockResolvedValue({ provider: "brave" }) };
      const tavilyProvider = { search: vi.fn().mockResolvedValue({ provider: "tavily" }) };

      vi.spyOn(SearchProviderFactory, "loadSettings").mockReturnValue({
        primaryProvider: "tavily",
        fallbackProvider: "google",
        tavily: { apiKey: "tavily" },
        brave: { apiKey: "brave" },
      } as Any);

      vi.spyOn(SearchProviderFactory as Any, "getProviderExecutionOrder").mockReturnValue([
        "brave",
        "tavily",
      ]);

      const getConfigSpy = vi.spyOn(SearchProviderFactory as Any, "getProviderConfig");
      getConfigSpy.mockImplementation((providerType: string) => ({ type: providerType }));

      const createProviderSpy = vi.spyOn(SearchProviderFactory as Any, "createProviderFromConfig");
      createProviderSpy.mockImplementation((config: Any) => {
        if (config.type === "brave") return braveProvider;
        return tavilyProvider;
      });

      const searchRetrySpy = vi.spyOn(SearchProviderFactory as Any, "searchWithRetry");
      searchRetrySpy.mockImplementation(async (provider: Any) => provider.search());

      const response = await SearchProviderFactory.searchWithFallback({
        query: "f1 latest",
        searchType: "web",
        provider: "tavily",
      });

      expect(response.provider).toBe("tavily");
      expect(searchRetrySpy).toHaveBeenCalledTimes(1);
      expect(tavilyProvider.search).toHaveBeenCalledTimes(1);
      expect(braveProvider.search).not.toHaveBeenCalled();
    });

    it("does not fall back when an explicit provider hits quota or rate limits", async () => {
      const tavilyProvider = {
        search: vi.fn().mockRejectedValue(new Error("Tavily API error: 432")),
      };
      const braveProvider = { search: vi.fn().mockResolvedValue({ provider: "brave" }) };

      vi.spyOn(SearchProviderFactory, "loadSettings").mockReturnValue({
        primaryProvider: "tavily",
        fallbackProvider: "brave",
        tavily: { apiKey: "tavily" },
        brave: { apiKey: "brave" },
      } as Any);

      vi.spyOn(SearchProviderFactory as Any, "getProviderExecutionOrder").mockReturnValue([
        "brave",
        "tavily",
      ]);

      vi.spyOn(SearchProviderFactory as Any, "getProviderConfig").mockImplementation(
        (providerType: string) => ({
          type: providerType,
        }),
      );

      vi.spyOn(SearchProviderFactory as Any, "createProviderFromConfig").mockImplementation(
        (config: Any) => {
          if (config.type === "tavily") return tavilyProvider;
          return braveProvider;
        },
      );

      vi.spyOn(SearchProviderFactory as Any, "searchWithRetry").mockImplementation(
        async (provider: Any) => provider.search(),
      );

      await expect(
        SearchProviderFactory.searchWithFallback({
          query: "f1 latest",
          searchType: "web",
          provider: "tavily",
        }),
      ).rejects.toThrow("Search provider (tavily) failed");
      expect(tavilyProvider.search).toHaveBeenCalledTimes(1);
      expect(braveProvider.search).not.toHaveBeenCalled();
    });

    it("does not fallback when requested provider fails for non-quota reasons", async () => {
      const tavilyProvider = { search: vi.fn().mockRejectedValue(new Error("Invalid API key")) };
      const braveProvider = { search: vi.fn().mockResolvedValue({ provider: "brave" }) };

      vi.spyOn(SearchProviderFactory, "loadSettings").mockReturnValue({
        primaryProvider: "tavily",
        fallbackProvider: "brave",
        tavily: { apiKey: "tavily" },
        brave: { apiKey: "brave" },
      } as Any);

      vi.spyOn(SearchProviderFactory as Any, "getProviderExecutionOrder").mockReturnValue([
        "brave",
        "tavily",
      ]);

      vi.spyOn(SearchProviderFactory as Any, "getProviderConfig").mockImplementation(
        (providerType: string) => ({
          type: providerType,
        }),
      );

      vi.spyOn(SearchProviderFactory as Any, "createProviderFromConfig").mockImplementation(
        (config: Any) => {
          if (config.type === "tavily") return tavilyProvider;
          return braveProvider;
        },
      );

      vi.spyOn(SearchProviderFactory as Any, "searchWithRetry").mockImplementation(
        async (provider: Any) => provider.search(),
      );

      await expect(
        SearchProviderFactory.searchWithFallback({
          query: "f1 latest",
          searchType: "web",
          provider: "tavily",
        }),
      ).rejects.toThrow("Search provider (tavily) failed: Invalid API key");

      expect(tavilyProvider.search).toHaveBeenCalledTimes(1);
      expect(braveProvider.search).not.toHaveBeenCalled();
    });

    it("labels an explicit-provider failure as provider-scoped", async () => {
      const tavilyProvider = {
        search: vi.fn().mockRejectedValue(new Error("Tavily API error: 432")),
      };
      const braveProvider = { search: vi.fn().mockRejectedValue(new Error("Brave unavailable")) };

      vi.spyOn(SearchProviderFactory, "loadSettings").mockReturnValue({
        primaryProvider: "tavily",
        fallbackProvider: "brave",
        tavily: { apiKey: "tavily" },
        brave: { apiKey: "brave" },
      } as Any);

      vi.spyOn(SearchProviderFactory as Any, "getProviderExecutionOrder").mockReturnValue([
        "brave",
        "tavily",
      ]);

      vi.spyOn(SearchProviderFactory as Any, "getProviderConfig").mockImplementation(
        (providerType: string) => ({ type: providerType }),
      );

      vi.spyOn(SearchProviderFactory as Any, "createProviderFromConfig").mockImplementation(
        (config: Any) => {
          if (config.type === "tavily") return tavilyProvider;
          return braveProvider;
        },
      );

      vi.spyOn(SearchProviderFactory as Any, "searchWithRetry").mockImplementation(
        async (provider: Any) => provider.search(),
      );

      try {
        await SearchProviderFactory.searchWithFallback({
          query: "f1 latest",
          searchType: "web",
          provider: "tavily",
        });
        throw new Error("Expected searchWithFallback to throw");
      } catch (error: Any) {
        expect(error.providerErrorScope).toBe("provider");
        expect(Array.isArray(error.failedProviders)).toBe(true);
        expect(error.failedProviders).toHaveLength(1);
        expect(braveProvider.search).not.toHaveBeenCalled();
      }
    });

    it("skips a cooled-down quota-limited provider on subsequent searches", async () => {
      const tavilyProvider = {
        search: vi.fn().mockRejectedValue(new Error("Tavily API error: 432")),
      };
      const braveProvider = { search: vi.fn().mockResolvedValue({ provider: "brave" }) };

      vi.spyOn(SearchProviderFactory, "loadSettings").mockReturnValue({
        primaryProvider: "tavily",
        fallbackProvider: "brave",
        tavily: { apiKey: "tavily" },
        brave: { apiKey: "brave" },
      } as Any);

      vi.spyOn(SearchProviderFactory as Any, "getProviderExecutionOrder").mockReturnValue([
        "tavily",
        "brave",
      ]);

      vi.spyOn(SearchProviderFactory as Any, "getProviderConfig").mockImplementation(
        (providerType: string) => ({ type: providerType }),
      );

      vi.spyOn(SearchProviderFactory as Any, "createProviderFromConfig").mockImplementation(
        (config: Any) => {
          if (config.type === "tavily") return tavilyProvider;
          return braveProvider;
        },
      );

      vi.spyOn(SearchProviderFactory as Any, "searchWithRetry").mockImplementation(
        async (provider: Any) => provider.search(),
      );

      const first = await SearchProviderFactory.searchWithFallback({
        query: "f1 latest",
        searchType: "web",
      });
      const second = await SearchProviderFactory.searchWithFallback({
        query: "f1 latest",
        searchType: "web",
      });

      expect(first.provider).toBe("brave");
      expect(second.provider).toBe("brave");
      expect(tavilyProvider.search).toHaveBeenCalledTimes(1);
      expect(braveProvider.search).toHaveBeenCalledTimes(2);
    });
  });
});
