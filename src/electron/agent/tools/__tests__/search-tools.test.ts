/**
 * Tests for SearchTools - web search operations
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Mock the search provider factory
vi.mock("../../search", () => ({
  SearchProviderFactory: {
    isAnyProviderConfigured: vi.fn().mockReturnValue(true),
    loadSettings: vi.fn().mockReturnValue({ primaryProvider: "tavily" }),
    clearCache: vi.fn(),
    searchWithFallback: vi.fn(),
  },
}));

vi.mock("../../../guardrails/guardrail-manager", () => ({
  GuardrailManager: {
    loadSettings: vi.fn().mockReturnValue({
      webSearchAllowedDomains: [],
      webSearchBlockedDomains: [],
    }),
  },
}));

// Import after mocking
import { SearchTools } from "../search-tools";
import { SearchProviderFactory } from "../../search";
import { GuardrailManager } from "../../../guardrails/guardrail-manager";
import { Workspace } from "../../../../shared/types";

// Mock daemon
const mockDaemon = {
  logEvent: vi.fn(),
  registerArtifact: vi.fn(),
};

// Mock workspace
const mockWorkspace: Workspace = {
  id: "test-workspace",
  name: "Test Workspace",
  path: "/test/workspace",
  permissions: {
    fileRead: true,
    fileWrite: true,
    shell: false,
  },
  createdAt: new Date().toISOString(),
  lastAccessed: new Date().toISOString(),
};

describe("SearchTools", () => {
  let searchTools: SearchTools;

  beforeEach(() => {
    vi.clearAllMocks();
    searchTools = new SearchTools(mockWorkspace, mockDaemon as Any, "test-task-id");

    // Reset to default mock behavior
    vi.mocked(SearchProviderFactory.isAnyProviderConfigured).mockReturnValue(true);
    vi.mocked(SearchProviderFactory.loadSettings).mockReturnValue({
      primaryProvider: "tavily",
    } as Any);
    vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
      query: "test query",
      searchType: "web",
      results: [],
      provider: "tavily",
    } as Any);
    vi.mocked(GuardrailManager.loadSettings).mockReturnValue({
      webSearchAllowedDomains: [],
      webSearchBlockedDomains: [],
    } as Any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("webSearch", () => {
    it("should return results from provider", async () => {
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "test query",
        searchType: "web",
        results: [{ title: "Test Result", url: "https://example.com", snippet: "Test snippet" }],
        provider: "tavily",
      });

      const result = await searchTools.webSearch({ query: "test query" });

      expect(result.results).toHaveLength(1);
      expect(result.provider).toBe("tavily");
      expect(result.success).toBe(true);
      expect(mockDaemon.logEvent).toHaveBeenCalledWith(
        "test-task-id",
        "tool_result",
        expect.any(Object),
      );
    });

    it("should fallback to DuckDuckGo when no paid provider is configured", async () => {
      vi.mocked(SearchProviderFactory.loadSettings).mockReturnValue({
        primaryProvider: null,
      } as Any);
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "test query",
        searchType: "web",
        results: [
          { title: "DDG Result", url: "https://duckduckgo.com", snippet: "Fallback result" },
        ],
        provider: "duckduckgo",
      } as Any);

      const result = await searchTools.webSearch({ query: "test query" });

      expect(result.results).toHaveLength(1);
      expect(result.provider).toBe("duckduckgo");
      expect(result.success).toBe(true);
    });

    it("should handle search errors gracefully", async () => {
      vi.mocked(SearchProviderFactory.searchWithFallback).mockRejectedValue(
        new Error("Rate limit exceeded"),
      );

      const result = await searchTools.webSearch({ query: "test query" });

      expect(result.results).toHaveLength(0);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Rate limit exceeded");
      expect(result.metadata?.error).toBe("Rate limit exceeded");
      expect(mockDaemon.logEvent).toHaveBeenCalledWith(
        "test-task-id",
        "tool_result",
        expect.objectContaining({ error: "Rate limit exceeded" }),
      );
    });

    it("should handle timeout errors gracefully", async () => {
      vi.mocked(SearchProviderFactory.searchWithFallback).mockRejectedValue(new Error("ETIMEDOUT"));

      const result = await searchTools.webSearch({ query: "test query" });

      expect(result.results).toHaveLength(0);
      expect(result.metadata?.error).toBe("ETIMEDOUT");
    });

    it("should handle unknown errors with default message", async () => {
      vi.mocked(SearchProviderFactory.searchWithFallback).mockRejectedValue({});

      const result = await searchTools.webSearch({ query: "test query" });

      expect(result.metadata?.error).toBe("Web search failed");
    });

    it("should cap maxResults at 20", async () => {
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "test query",
        searchType: "web",
        results: [],
        provider: "tavily",
      });

      await searchTools.webSearch({ query: "test query", maxResults: 100 });

      expect(SearchProviderFactory.searchWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 20 }),
      );
    });

    it("should pass search type to provider", async () => {
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "test query",
        searchType: "news",
        results: [],
        provider: "tavily",
      });

      await searchTools.webSearch({ query: "test query", searchType: "news" });

      expect(SearchProviderFactory.searchWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({ searchType: "news" }),
      );
    });

    it("passes locale, safe-search, and the effective workspace policy to the provider", async () => {
      searchTools.setDomainPolicy({
        allowedDomains: ["search.example.com"],
        blockedDomains: ["blocked.example.com"],
      });

      await searchTools.webSearch({
        query: "test query",
        region: "tr",
        language: "tr-TR",
        safeSearch: true,
      });

      expect(SearchProviderFactory.searchWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          region: "tr",
          language: "tr-TR",
          safeSearch: true,
          endpointDomainPolicy: {
            allowedDomains: ["search.example.com"],
            blockedDomains: ["blocked.example.com"],
          },
        }),
      );
    });

    it("should log search request", async () => {
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "test query",
        searchType: "web",
        results: [],
        provider: "tavily",
      });

      await searchTools.webSearch({ query: "test query" });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith("test-task-id", "log", {
        message: expect.stringContaining("Searching web"),
      });
    });

    it("should use specified provider over primary", async () => {
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "test query",
        searchType: "web",
        results: [],
        provider: "brave",
      });

      await searchTools.webSearch({ query: "test query", provider: "brave" });

      expect(SearchProviderFactory.searchWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "brave" }),
      );
    });

    it("should preserve provider in error response", async () => {
      vi.mocked(SearchProviderFactory.loadSettings).mockReturnValue({
        primaryProvider: "serpapi",
      } as Any);
      vi.mocked(SearchProviderFactory.searchWithFallback).mockRejectedValue(new Error("API error"));

      const result = await searchTools.webSearch({ query: "test query" });

      expect(result.provider).toBe("serpapi");
    });

    it("should handle error with object message property", async () => {
      vi.mocked(SearchProviderFactory.searchWithFallback).mockRejectedValue({
        message: { code: "ERR_NETWORK" },
      });

      const result = await searchTools.webSearch({ query: "test query" });

      // The object is passed through as-is since it's truthy
      expect(result.metadata?.error).toEqual({ code: "ERR_NETWORK" });
    });

    it("should still execute search when primaryProvider is null", async () => {
      vi.mocked(SearchProviderFactory.loadSettings).mockReturnValue({
        primaryProvider: null,
      } as Any);
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "test query",
        searchType: "web",
        results: [],
        provider: "tavily",
      });

      await searchTools.webSearch({ query: "test query" });

      expect(SearchProviderFactory.searchWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({ query: "test query" }),
      );
      expect(SearchProviderFactory.clearCache).not.toHaveBeenCalled();
      expect(mockDaemon.logEvent).toHaveBeenCalledWith("test-task-id", "log", {
        message: expect.stringContaining("via duckduckgo"),
      });
    });

    it("applies blocked domains before allowlist when filtering search results", async () => {
      vi.mocked(GuardrailManager.loadSettings).mockReturnValue({
        webSearchAllowedDomains: ["example.com", "trusted.com"],
        webSearchBlockedDomains: ["example.com"],
      } as Any);
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "policy test",
        searchType: "web",
        provider: "tavily",
        results: [
          { title: "Blocked", url: "https://example.com/a", snippet: "blocked" },
          { title: "Allowed", url: "https://trusted.com/b", snippet: "allowed" },
          { title: "Filtered by allowlist", url: "https://other.com/c", snippet: "other" },
        ],
      } as Any);

      const result = await searchTools.webSearch({ query: "policy test" });

      expect(result.success).toBe(true);
      expect(result.results.map((item) => item.url)).toEqual(["https://trusted.com/b"]);
      expect(mockDaemon.logEvent).toHaveBeenCalledWith(
        "test-task-id",
        "log",
        expect.objectContaining({
          metric: "web_search_domain_filtered_result_count",
          originalCount: 3,
          filteredCount: 1,
          filteredOutCount: 2,
        }),
      );
    });

    it("returns structured policy error when domain filtering removes all results", async () => {
      vi.mocked(GuardrailManager.loadSettings).mockReturnValue({
        webSearchAllowedDomains: ["trusted.com"],
        webSearchBlockedDomains: [],
      } as Any);
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "policy empty",
        searchType: "web",
        provider: "tavily",
        results: [{ title: "Filtered", url: "https://other.com/a", snippet: "other" }],
      } as Any);

      const result = await searchTools.webSearch({ query: "policy empty" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("filtered by domain policy");
      expect(result.metadata?.policyReason).toBe("domain_policy_filtered");
      expect(result.metadata?.originalResultCount).toBe(1);
      expect(result.metadata?.filteredOutCount).toBe(1);
    });
  });

  describe("setWorkspace", () => {
    it("should update the workspace", () => {
      const newWorkspace: Workspace = {
        ...mockWorkspace,
        id: "new-workspace",
        path: "/new/path",
      };

      searchTools.setWorkspace(newWorkspace);

      // The workspace should be updated (internal state)
      expect((searchTools as Any).workspace).toBe(newWorkspace);
    });
  });

  describe("domain policy override", () => {
    it("uses executor-provided domain policy override when set", async () => {
      vi.mocked(GuardrailManager.loadSettings).mockReturnValue({
        webSearchAllowedDomains: ["from-settings.com"],
        webSearchBlockedDomains: [],
      } as Any);
      searchTools.setDomainPolicy({
        allowedDomains: ["from-executor.com"],
        blockedDomains: [],
      });
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "policy override",
        searchType: "web",
        provider: "tavily",
        results: [
          { title: "Executor", url: "https://from-executor.com/a", snippet: "ok" },
          { title: "Settings", url: "https://from-settings.com/b", snippet: "filtered" },
        ],
      } as Any);

      const result = await searchTools.webSearch({ query: "policy override" });

      expect(result.success).toBe(true);
      expect(result.results.map((item) => item.url)).toEqual(["https://from-executor.com/a"]);
    });
  });
});
