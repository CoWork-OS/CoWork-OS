import {
  SearchProvider,
  SearchProviderConfig,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SearchType,
} from './types';

/**
 * Google Custom Search API provider
 * https://developers.google.com/custom-search/v1/introduction
 */
export class GoogleProvider implements SearchProvider {
  readonly type = 'google' as const;
  readonly supportedSearchTypes: SearchType[] = ['web', 'images'];

  private apiKey: string;
  private searchEngineId: string;
  private baseUrl = 'https://www.googleapis.com/customsearch/v1';

  constructor(config: SearchProviderConfig) {
    const apiKey = config.googleApiKey;
    const searchEngineId = config.googleSearchEngineId;

    if (!apiKey) {
      throw new Error(
        'Google API key is required. Configure it in Settings or get one from https://console.cloud.google.com/'
      );
    }
    if (!searchEngineId) {
      throw new Error(
        'Google Search Engine ID is required. Configure it in Settings or create one at https://programmablesearchengine.google.com/'
      );
    }

    this.apiKey = apiKey;
    this.searchEngineId = searchEngineId;
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const searchType = query.searchType || 'web';

    if (!this.supportedSearchTypes.includes(searchType)) {
      throw new Error(
        `Google Custom Search does not support ${searchType} search. Use 'web' or 'images'.`
      );
    }

    const params = new URLSearchParams({
      key: this.apiKey,
      cx: this.searchEngineId,
      q: query.query,
      num: String(Math.min(query.maxResults || 10, 10)), // Google CSE max is 10
      ...(query.region && { gl: query.region }),
      ...(query.language && { lr: `lang_${query.language}` }),
      ...(query.safeSearch !== undefined && {
        safe: query.safeSearch ? 'active' : 'off',
      }),
      ...(searchType === 'images' && { searchType: 'image' }),
      ...(query.dateRange && { dateRestrict: this.mapDateRange(query.dateRange) }),
    });

    const response = await fetch(`${this.baseUrl}?${params}`);

    if (!response.ok) {
      const error = await response.json() as { error?: { message?: string } };
      throw new Error(
        `Google CSE error: ${response.status} - ${error.error?.message || 'Unknown error'}`
      );
    }

    const data = await response.json() as {
      items?: any[];
      searchInformation?: { totalResults?: string };
    };

    return {
      results: this.mapResults(data.items || [], searchType),
      query: query.query,
      searchType,
      totalResults: data.searchInformation?.totalResults
        ? parseInt(data.searchInformation.totalResults)
        : undefined,
      provider: 'google',
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.search({ query: 'test', maxResults: 1 });
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to Google Custom Search',
      };
    }
  }

  private mapDateRange(range: string): string {
    switch (range) {
      case 'day':
        return 'd1';
      case 'week':
        return 'w1';
      case 'month':
        return 'm1';
      case 'year':
        return 'y1';
      default:
        return 'w1';
    }
  }

  private mapResults(items: any[], searchType: SearchType): SearchResult[] {
    return items.map((item) => ({
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || '',
      // Image-specific fields
      ...(searchType === 'images' && {
        thumbnailUrl: item.image?.thumbnailLink,
        imageUrl: item.link,
        width: item.image?.width,
        height: item.image?.height,
      }),
      source: item.displayLink,
    }));
  }
}
