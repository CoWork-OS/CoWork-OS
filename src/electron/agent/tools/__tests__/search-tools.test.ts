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

// Import after mocking
import { SearchTools } from "../search-tools";
import { SearchProviderFactory } from "../../search";
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

    it("should return error response when no provider is configured", async () => {
      vi.mocked(SearchProviderFactory.isAnyProviderConfigured).mockReturnValue(false);

      const result = await searchTools.webSearch({ query: "test query" });

      expect(result.results).toHaveLength(0);
      expect(result.provider).toBe("none");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.metadata?.notConfigured).toBe(true);
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

    it("should trigger auto-detection when primaryProvider is null", async () => {
      vi.mocked(SearchProviderFactory.loadSettings)
        .mockReturnValueOnce({ primaryProvider: null } as Any)
        .mockReturnValueOnce({ primaryProvider: "tavily" } as Any);
      vi.mocked(SearchProviderFactory.searchWithFallback).mockResolvedValue({
        query: "test query",
        searchType: "web",
        results: [],
        provider: "tavily",
      });

      await searchTools.webSearch({ query: "test query" });

      expect(SearchProviderFactory.clearCache).toHaveBeenCalled();
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
});
