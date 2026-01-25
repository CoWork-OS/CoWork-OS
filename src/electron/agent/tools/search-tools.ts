import { Workspace } from '../../../shared/types';
import { AgentDaemon } from '../daemon';
import {
  SearchProviderFactory,
  SearchQuery,
  SearchResponse,
  SearchType,
  SearchProviderType,
} from '../search';

/**
 * SearchTools implements web search operations for the agent
 */
export class SearchTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string
  ) {}

  /**
   * Perform a web search with automatic fallback support
   */
  async webSearch(input: {
    query: string;
    searchType?: SearchType;
    maxResults?: number;
    provider?: SearchProviderType;
    dateRange?: 'day' | 'week' | 'month' | 'year';
    region?: string;
  }): Promise<SearchResponse> {
    // Check if any provider is configured
    if (!SearchProviderFactory.isAnyProviderConfigured()) {
      // Return a helpful response instead of throwing an error
      // This allows the LLM to inform the user gracefully
      this.daemon.logEvent(this.taskId, 'log', {
        message: 'Web search is not available - no search provider configured',
      });
      return {
        query: input.query,
        searchType: input.searchType || 'web',
        results: [],
        provider: 'none',
        metadata: {
          error: 'Web search is not configured. To enable web search, please configure a search provider in Settings > Web Search. Supported providers: Tavily, Brave Search, SerpAPI, or Google Custom Search.',
          notConfigured: true,
        },
      };
    }

    const settings = SearchProviderFactory.loadSettings();
    if (!settings.primaryProvider && !input.provider) {
      // This shouldn't happen after the loadSettings auto-detection fix,
      // but keep as a safety net
      this.daemon.logEvent(this.taskId, 'log', {
        message: 'Web search provider not selected - auto-selecting...',
      });
      // Clear cache and reload to trigger auto-detection
      SearchProviderFactory.clearCache();
      const reloadedSettings = SearchProviderFactory.loadSettings();
      if (!reloadedSettings.primaryProvider) {
        return {
          query: input.query,
          searchType: input.searchType || 'web',
          results: [],
          provider: 'none',
          metadata: {
            error: 'No search provider is selected. Please configure one in Settings > Web Search.',
            notConfigured: true,
          },
        };
      }
    }

    const searchQuery: SearchQuery = {
      query: input.query,
      searchType: input.searchType || 'web',
      maxResults: Math.min(input.maxResults || 10, 20), // Cap at 20 results
      dateRange: input.dateRange,
      region: input.region,
      provider: input.provider,
    };

    const providerName = input.provider || settings.primaryProvider || 'unknown';
    this.daemon.logEvent(this.taskId, 'log', {
      message: `Searching ${searchQuery.searchType}: "${input.query}" via ${providerName}`,
    });

    // Use searchWithFallback for automatic fallback support
    const response = await SearchProviderFactory.searchWithFallback(searchQuery);

    this.daemon.logEvent(this.taskId, 'tool_result', {
      tool: 'web_search',
      result: {
        query: input.query,
        searchType: searchQuery.searchType,
        resultCount: response.results.length,
        provider: response.provider,
      },
    });

    return response;
  }
}
