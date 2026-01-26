import {
  SearchProvider,
  SearchProviderConfig,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SearchType,
} from './types';

/**
 * Tavily Search API provider
 * https://docs.tavily.com/
 */
export class TavilyProvider implements SearchProvider {
  readonly type = 'tavily' as const;
  readonly supportedSearchTypes: SearchType[] = ['web', 'news'];

  private apiKey: string;
  private baseUrl = 'https://api.tavily.com';

  constructor(config: SearchProviderConfig) {
    const apiKey = config.tavilyApiKey;
    if (!apiKey) {
      throw new Error('Tavily API key is required. Configure it in Settings or get one from https://tavily.com/');
    }
    this.apiKey = apiKey;
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const searchType = query.searchType || 'web';

    if (!this.supportedSearchTypes.includes(searchType)) {
      throw new Error(
        `Tavily does not support ${searchType} search. Supported: ${this.supportedSearchTypes.join(', ')}`
      );
    }

    const response = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: this.apiKey,
        query: query.query,
        search_depth: 'advanced',
        max_results: query.maxResults || 10,
        include_answer: false,
        include_raw_content: false,
        // Tavily-specific: topic for news
        topic: searchType === 'news' ? 'news' : 'general',
        // Date filter if specified
        ...(query.dateRange && { days: this.dateRangeToDays(query.dateRange) }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Tavily API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as { results?: any[] };

    return {
      results: this.mapResults(data.results || []),
      query: query.query,
      searchType,
      provider: 'tavily',
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.search({ query: 'test', maxResults: 1 });
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to Tavily API',
      };
    }
  }

  private mapResults(results: any[]): SearchResult[] {
    return results.map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content || r.snippet || '',
      publishedDate: r.published_date,
      source: r.source,
    }));
  }

  private dateRangeToDays(range: string): number {
    switch (range) {
      case 'day':
        return 1;
      case 'week':
        return 7;
      case 'month':
        return 30;
      case 'year':
        return 365;
      default:
        return 7;
    }
  }
}
