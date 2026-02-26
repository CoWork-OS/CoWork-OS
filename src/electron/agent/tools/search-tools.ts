import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import {
  SearchProviderFactory,
  SearchQuery,
  SearchResponse,
  SearchType,
  SearchProviderType,
} from "../search";

/**
 * SearchTools implements web search operations for the agent
 */
export class SearchTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Perform a web search with automatic fallback support
   */
  async webSearch(input: {
    query: string;
    searchType?: SearchType;
    maxResults?: number;
    provider?: SearchProviderType;
    dateRange?: "day" | "week" | "month" | "year";
    region?: string;
  }): Promise<SearchResponse> {
    // DuckDuckGo is always available as a free fallback, so web_search never
    // needs to return "not configured". searchWithFallback handles the full
    // provider chain including DDG as last resort.
    const searchQuery: SearchQuery = {
      query: input.query,
      searchType: input.searchType || "web",
      maxResults: Math.min(input.maxResults || 10, 20), // Cap at 20 results
      dateRange: input.dateRange,
      region: input.region,
      provider: input.provider,
    };

    const settings = SearchProviderFactory.loadSettings();
    const providerName = input.provider || settings.primaryProvider || "duckduckgo";
    this.daemon.logEvent(this.taskId, "log", {
      message: `Searching ${searchQuery.searchType}: "${input.query}" via ${providerName}`,
    });

    try {
      const response = await SearchProviderFactory.searchWithFallback(searchQuery);

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "web_search",
        result: {
          query: input.query,
          searchType: searchQuery.searchType,
          resultCount: response.results.length,
          provider: response.provider,
        },
      });

      return {
        ...response,
        success: true,
      };
    } catch (error: Any) {
      const message = error?.message || "Web search failed";
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "web_search",
        error: message,
      });

      return {
        success: false,
        error: message,
        query: input.query,
        searchType: input.searchType || "web",
        results: [],
        provider: (input.provider || settings.primaryProvider || "none") as
          | SearchProviderType
          | "none",
        metadata: {
          error: message,
        },
      };
    }
  }
}
