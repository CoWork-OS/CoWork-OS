import {
  SearchProvider,
  SearchProviderConfig,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SearchType,
} from './types';

/**
 * Brave Search API provider
 * https://brave.com/search/api/
 */
export class BraveProvider implements SearchProvider {
  readonly type = 'brave' as const;
  readonly supportedSearchTypes: SearchType[] = ['web', 'news', 'images'];

  private apiKey: string;
  private baseUrl = 'https://api.search.brave.com/res/v1';

  constructor(config: SearchProviderConfig) {
    const apiKey = config.braveApiKey;
    if (!apiKey) {
      throw new Error(
        'Brave API key is required. Configure it in Settings or get one from https://brave.com/search/api/'
      );
    }
    this.apiKey = apiKey;
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const searchType = query.searchType || 'web';

    if (!this.supportedSearchTypes.includes(searchType)) {
      throw new Error(`Brave does not support ${searchType} search`);
    }

    const endpoint = this.getEndpoint(searchType);
    const params = new URLSearchParams({
      q: query.query,
      count: String(query.maxResults || 10),
      ...(query.region && { country: query.region }),
      ...(query.language && { search_lang: query.language }),
      ...(query.safeSearch !== undefined && {
        safesearch: query.safeSearch ? 'strict' : 'off',
      }),
      ...(query.dateRange && { freshness: this.mapDateRange(query.dateRange) }),
    });

    const response = await fetch(`${this.baseUrl}/${endpoint}?${params}`, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Brave API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    return {
      results: this.mapResults(data, searchType),
      query: query.query,
      searchType,
      provider: 'brave',
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.search({ query: 'test', maxResults: 1 });
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to Brave Search API',
      };
    }
  }

  private getEndpoint(searchType: SearchType): string {
    switch (searchType) {
      case 'news':
        return 'news/search';
      case 'images':
        return 'images/search';
      default:
        return 'web/search';
    }
  }

  private mapDateRange(range: string): string {
    switch (range) {
      case 'day':
        return 'pd'; // past day
      case 'week':
        return 'pw'; // past week
      case 'month':
        return 'pm'; // past month
      case 'year':
        return 'py'; // past year
      default:
        return 'pw';
    }
  }

  private mapResults(data: any, searchType: SearchType): SearchResult[] {
    if (searchType === 'images') {
      return (data.results || []).map((r: any) => ({
        title: r.title || '',
        url: r.url || r.page_url || '',
        snippet: r.description || '',
        thumbnailUrl: r.thumbnail?.src,
        imageUrl: r.properties?.url || r.url,
        width: r.properties?.width,
        height: r.properties?.height,
      }));
    }

    if (searchType === 'news') {
      return (data.results || []).map((r: any) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.description || '',
        publishedDate: r.age,
        source: r.meta_url?.hostname,
      }));
    }

    // Web results
    return (data.web?.results || []).map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
      source: r.meta_url?.hostname,
    }));
  }
}
