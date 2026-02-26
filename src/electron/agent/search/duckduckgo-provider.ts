import {
  SearchProvider,
  SearchProviderConfig,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SearchType,
} from "./types";

/**
 * DuckDuckGo HTML search provider (free, no API key required).
 * Scrapes https://html.duckduckgo.com/html/ for results.
 * Used as an automatic last-resort fallback when no paid provider is configured.
 */
export class DuckDuckGoProvider implements SearchProvider {
  readonly type = "duckduckgo" as const;
  readonly supportedSearchTypes: SearchType[] = ["web"];

  private baseUrl = "https://html.duckduckgo.com/html/";

  constructor(_config?: SearchProviderConfig) {
    // No API key needed — this is a free provider.
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    const searchType = query.searchType || "web";

    if (searchType !== "web") {
      throw new Error(`DuckDuckGo only supports web search, not ${searchType}`);
    }

    const maxResults = Math.min(query.maxResults || 10, 20);

    const params = new URLSearchParams({
      q: query.query,
    });

    // DuckDuckGo HTML endpoint supports region via 'kl' param
    if (query.region) {
      params.set("kl", this.mapRegion(query.region));
    }

    // Date range via 'df' param
    if (query.dateRange) {
      params.set("df", this.mapDateRange(query.dateRange));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "CoWorkOS/1.0",
        },
        body: params.toString(),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`DuckDuckGo request failed: ${response.status}`);
      }

      const html = await response.text();
      const results = this.parseResults(html, maxResults);

      return {
        results,
        query: query.query,
        searchType: "web",
        provider: "duckduckgo",
      };
    } catch (error: Any) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        throw new Error("DuckDuckGo request timed out");
      }
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await this.search({ query: "test", maxResults: 1 });
      if (result.results.length === 0) {
        return { success: false, error: "No results returned from DuckDuckGo" };
      }
      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to connect to DuckDuckGo",
      };
    }
  }

  /**
   * Parse search results from DuckDuckGo HTML response.
   *
   * The HTML structure uses:
   * - .result__a for the title link (href = redirect URL, text = title)
   * - .result__snippet for the description text
   */
  private parseResults(html: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = [];

    // Match each result block: class="result__a" for title+url, class="result__snippet" for snippet
    const resultBlockRegex =
      /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match: RegExpExecArray | null;
    while ((match = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
      const rawUrl = match[1];
      const rawTitle = match[2];
      const rawSnippet = match[3];

      // DDG wraps URLs in a redirect; extract actual URL from uddg= param
      const url = this.extractUrl(rawUrl);
      const title = this.stripHtml(rawTitle).trim();
      const snippet = this.stripHtml(rawSnippet).trim();

      if (url && title) {
        results.push({
          title,
          url,
          snippet,
          source: this.extractHostname(url),
        });
      }
    }

    return results;
  }

  /**
   * Extract the real URL from DuckDuckGo's redirect wrapper.
   * DDG links look like: /l/?uddg=https%3A%2F%2Fexample.com&rut=...
   */
  private extractUrl(rawUrl: string): string {
    try {
      if (rawUrl.includes("uddg=")) {
        const urlObj = new URL(rawUrl, "https://duckduckgo.com");
        const uddg = urlObj.searchParams.get("uddg");
        if (uddg) return uddg;
      }
      if (rawUrl.startsWith("http")) return rawUrl;
    } catch {
      // Fall through
    }
    return rawUrl;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<b>/g, "")
      .replace(/<\/b>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ");
  }

  private extractHostname(url: string): string | undefined {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }

  private mapRegion(region: string): string {
    const regionMap: Record<string, string> = {
      us: "us-en",
      uk: "uk-en",
      gb: "uk-en",
      de: "de-de",
      fr: "fr-fr",
      es: "es-es",
      it: "it-it",
      jp: "jp-jp",
      br: "br-pt",
    };
    return regionMap[region.toLowerCase()] || `${region.toLowerCase()}-en`;
  }

  private mapDateRange(range: string): string {
    switch (range) {
      case "day":
        return "d";
      case "week":
        return "w";
      case "month":
        return "m";
      case "year":
        return "y";
      default:
        return "w";
    }
  }
}
