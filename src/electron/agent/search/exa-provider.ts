import {
  SearchProvider,
  SearchProviderConfig,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SearchType,
} from "./types";
import { assertNetworkPolicyAllowed } from "../../security/network-policy";

interface ExaResult {
  title?: string;
  url?: string;
  publishedDate?: string | null;
  author?: string | null;
  text?: string;
  summary?: string;
  highlights?: string[];
}

interface ExaSearchResponse {
  results?: ExaResult[];
}

/**
 * Exa Search API provider
 * https://docs.exa.ai/reference/search
 */
export class ExaProvider implements SearchProvider {
  readonly type = "exa" as const;
  readonly supportedSearchTypes: SearchType[] = ["web", "news"];

  private readonly apiKey: string;
  private readonly baseUrl = "https://api.exa.ai";

  constructor(config: SearchProviderConfig) {
    const apiKey = config.exaApiKey;
    if (!apiKey) {
      throw new Error(
        "Exa API key is required. Configure it in Settings or get one from https://exa.ai/",
      );
    }
    this.apiKey = apiKey;
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const searchType = query.searchType || "web";
    if (!this.supportedSearchTypes.includes(searchType)) {
      throw new Error(
        `Exa does not support ${searchType} search. Supported: ${this.supportedSearchTypes.join(", ")}`,
      );
    }

    const endpointUrl = `${this.baseUrl}/search`;
    assertNetworkPolicyAllowed({
      url: endpointUrl,
      toolName: "web_search",
      networkEnabled: query.networkEnabled,
      accessNetworkMode: query.accessNetworkMode,
      profileDomainRules: query.profileDomainRules,
    });
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        query: query.query,
        type: "auto",
        category: searchType === "news" ? "news" : undefined,
        numResults: Math.min(Math.max(query.maxResults || 10, 1), 25),
        highlights: {
          highlightsPerUrl: 1,
          maxCharacters: 400,
          query: query.query,
        },
        ...(query.dateRange ? this.buildPublishedDateFilter(query.dateRange) : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Exa API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as ExaSearchResponse;
    return {
      results: this.mapResults(data.results || []),
      query: query.query,
      searchType,
      totalResults: data.results?.length,
      provider: "exa",
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.search({ query: "test", maxResults: 1 });
      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to connect to Exa API",
      };
    }
  }

  private mapResults(results: ExaResult[]): SearchResult[] {
    return results.map((result) => ({
      title: result.title || "",
      url: result.url || "",
      snippet:
        result.highlights?.find((entry) => typeof entry === "string" && entry.trim().length > 0) ||
        result.summary ||
        result.text ||
        "",
      publishedDate: result.publishedDate || undefined,
      source: result.author || undefined,
    }));
  }

  private buildPublishedDateFilter(range: SearchQuery["dateRange"]): {
    startPublishedDate: string;
  } {
    const now = Date.now();
    const ms =
      range === "day"
        ? 24 * 60 * 60 * 1000
        : range === "week"
          ? 7 * 24 * 60 * 60 * 1000
          : range === "month"
            ? 30 * 24 * 60 * 60 * 1000
            : 365 * 24 * 60 * 60 * 1000;
    return {
      startPublishedDate: new Date(now - ms).toISOString(),
    };
  }
}
