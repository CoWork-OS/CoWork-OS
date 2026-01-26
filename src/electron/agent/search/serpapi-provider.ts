import {
  SearchProvider,
  SearchProviderConfig,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SearchType,
} from './types';

/**
 * SerpAPI provider - aggregates multiple search engines
 * https://serpapi.com/
 */
export class SerpApiProvider implements SearchProvider {
  readonly type = 'serpapi' as const;
  readonly supportedSearchTypes: SearchType[] = ['web', 'news', 'images'];

  private apiKey: string;
  private baseUrl = 'https://serpapi.com/search.json';

  constructor(config: SearchProviderConfig) {
    const apiKey = config.serpApiKey;
    if (!apiKey) {
      throw new Error('SerpAPI key is required. Configure it in Settings or get one from https://serpapi.com/');
    }
    this.apiKey = apiKey;
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const searchType = query.searchType || 'web';

    if (!this.supportedSearchTypes.includes(searchType)) {
      throw new Error(`SerpAPI does not support ${searchType} search`);
    }

    const params = new URLSearchParams({
      api_key: this.apiKey,
      q: query.query,
      engine: 'google',
      num: String(query.maxResults || 10),
      ...(query.region && { gl: query.region }),
      ...(query.language && { hl: query.language }),
      ...(query.safeSearch !== undefined && {
        safe: query.safeSearch ? 'active' : 'off',
      }),
      ...(searchType === 'images' && { tbm: 'isch' }),
      ...(searchType === 'news' && { tbm: 'nws' }),
      ...(query.dateRange && { tbs: this.mapDateRange(query.dateRange) }),
    });

    const response = await fetch(`${this.baseUrl}?${params}`);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`SerpAPI error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      error?: string;
      search_information?: { total_results?: number };
      organic_results?: any[];
      news_results?: any[];
      images_results?: any[];
    };

    if (data.error) {
      throw new Error(`SerpAPI error: ${data.error}`);
    }

    return {
      results: this.mapResults(data, searchType),
      query: query.query,
      searchType,
      totalResults: data.search_information?.total_results,
      provider: 'serpapi',
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.search({ query: 'test', maxResults: 1 });
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to SerpAPI',
      };
    }
  }

  private mapDateRange(range: string): string {
    switch (range) {
      case 'day':
        return 'qdr:d';
      case 'week':
        return 'qdr:w';
      case 'month':
        return 'qdr:m';
      case 'year':
        return 'qdr:y';
      default:
        return 'qdr:w';
    }
  }

  private mapResults(data: any, searchType: SearchType): SearchResult[] {
    if (searchType === 'images') {
      return (data.images_results || []).map((r: any) => ({
        title: r.title || '',
        url: r.link || r.original || '',
        snippet: r.snippet || '',
        thumbnailUrl: r.thumbnail,
        imageUrl: r.original,
        width: r.original_width,
        height: r.original_height,
        source: r.source,
      }));
    }

    if (searchType === 'news') {
      return (data.news_results || []).map((r: any) => ({
        title: r.title || '',
        url: r.link || '',
        snippet: r.snippet || '',
        publishedDate: r.date,
        source: r.source,
      }));
    }

    // Web (organic) results
    return (data.organic_results || []).map((r: any) => ({
      title: r.title || '',
      url: r.link || '',
      snippet: r.snippet || '',
      source: r.displayed_link,
    }));
  }
}
