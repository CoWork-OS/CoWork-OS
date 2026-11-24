import {
  SearchProvider,
  SearchProviderConfig,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SearchType,
} from "./types";
import { assertNetworkPolicyAllowed } from "../../security/network-policy";

interface KeenableResult {
  title?: string;
  url?: string;
  description?: string;
  snippet?: string;
  published_at?: string | null;
}

interface KeenableSearchResponse {
  results?: KeenableResult[];
}

/** Names the calling app, which Keenable requires on its keyless endpoint. */
const KEENABLE_APP_TITLE = "CoWork OS";
/** Keenable snippets can run to thousands of characters; this is enough to rank and cite. */
const KEENABLE_SNIPPET_MAX_LENGTH = 400;

const DATE_RANGE_DELTAS: Record<NonNullable<SearchQuery["dateRange"]>, string> = {
  day: "1d",
  week: "7d",
  month: "30d",
  year: "365d",
};

/**
 * Keenable Search API provider.
 * Works without a key through POST /v1/search/public (rate-limited per IP); an API key
 * switches to POST /v1/search. https://docs.keenable.ai/api-reference/search
 */
export class KeenableProvider implements SearchProvider {
  readonly type = "keenable" as const;
  readonly supportedSearchTypes: SearchType[] = ["web"];

  private readonly apiKey?: string;
  private readonly baseUrl = "https://api.keenable.ai/v1";

  constructor(config: SearchProviderConfig) {
    const apiKey = config.keenableApiKey?.trim();
    this.apiKey = apiKey || undefined;
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const searchType = query.searchType || "web";
    if (!this.supportedSearchTypes.includes(searchType)) {
      throw new Error(
        `Keenable does not support ${searchType} search. Supported: ${this.supportedSearchTypes.join(", ")}`,
      );
    }

    const endpointUrl = this.apiKey ? `${this.baseUrl}/search` : `${this.baseUrl}/search/public`;
    assertNetworkPolicyAllowed({
      url: endpointUrl,
      toolName: "web_search",
      networkEnabled: query.networkEnabled,
      accessNetworkMode: query.accessNetworkMode,
      profileDomainRules: query.profileDomainRules,
    });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
    } else {
      headers["X-Keenable-Title"] = KEENABLE_APP_TITLE;
    }

    const response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: query.query,
        max_results: Math.min(Math.max(query.maxResults || 10, 1), 50),
        snippet_max_length: KEENABLE_SNIPPET_MAX_LENGTH,
        ...(query.dateRange ? { published_after: DATE_RANGE_DELTAS[query.dateRange] } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Keenable API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as KeenableSearchResponse;
    const results = Array.isArray(data.results) ? data.results : [];
    return {
      results: this.mapResults(results),
      query: query.query,
      searchType,
      totalResults: results.length,
      provider: "keenable",
    };
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.search({ query: "test", maxResults: 1 });
      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to connect to Keenable",
      };
    }
  }

  private mapResults(results: KeenableResult[]): SearchResult[] {
    return results
      .filter((result) => typeof result.url === "string" && result.url.length > 0)
      .map((result) => ({
        title: result.title || "",
        url: result.url || "",
        snippet: result.snippet?.trim() || result.description?.trim() || "",
        publishedDate: result.published_at || undefined,
      }));
  }
}
