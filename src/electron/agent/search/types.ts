/**
 * Search Provider abstraction types
 * Allows switching between Tavily, Brave Search, SerpAPI, and Google Custom Search
 */

export type SearchProviderType = "tavily" | "brave" | "serpapi" | "google" | "duckduckgo";

export type SearchType = "web" | "news" | "images";

export interface SearchProviderConfig {
  type: SearchProviderType;
  // Tavily-specific
  tavilyApiKey?: string;
  // Brave-specific
  braveApiKey?: string;
  // SerpAPI-specific
  serpApiKey?: string;
  // Google Custom Search-specific
  googleApiKey?: string;
  googleSearchEngineId?: string;
}

export interface SearchQuery {
  query: string;
  searchType?: SearchType;
  maxResults?: number;
  // Optional filters
  dateRange?: "day" | "week" | "month" | "year";
  region?: string; // e.g., 'us', 'uk', 'de'
  language?: string; // e.g., 'en', 'de', 'fr'
  safeSearch?: boolean;
  // Override provider for this query
  provider?: SearchProviderType;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  // Optional metadata
  publishedDate?: string;
  source?: string;
  // For image search
  thumbnailUrl?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  searchType: SearchType;
  totalResults?: number;
  provider: SearchProviderType | "none";
  // Optional execution status fields for tool-level circuit-breaker integration.
  // Providers may omit these; SearchTools sets them for explicit failure signaling.
  success?: boolean;
  error?: string;
  providerErrorScope?: "provider" | "global";
  failedProvider?: SearchProviderType;
  failureClass?: "provider_quota" | "provider_rate_limit" | "external_unknown";
  failedProviders?: Array<{ provider: SearchProviderType; error: string }>;
  // Optional metadata for additional info (e.g., errors, configuration status)
  metadata?: {
    error?: string;
    notConfigured?: boolean;
    providerErrorScope?: "provider" | "global";
    failedProvider?: SearchProviderType;
    failureClass?: "provider_quota" | "provider_rate_limit" | "external_unknown";
    failedProviders?: Array<{ provider: SearchProviderType; error: string }>;
    [key: string]: unknown;
  };
}

/**
 * Abstract Search Provider interface
 */
export interface SearchProvider {
  readonly type: SearchProviderType;

  /**
   * Supported search types for this provider
   */
  readonly supportedSearchTypes: SearchType[];

  /**
   * Perform a search query
   */
  search(query: SearchQuery): Promise<SearchResponse>;

  /**
   * Test the provider connection/API key validity
   */
  testConnection(): Promise<{ success: boolean; error?: string }>;
}

/**
 * Provider capabilities for UI display
 */
export const SEARCH_PROVIDER_INFO = {
  tavily: {
    displayName: "Tavily",
    description: "AI-focused search API with structured results",
    supportedTypes: ["web", "news"] as SearchType[],
    envVar: "TAVILY_API_KEY",
    signupUrl: "https://tavily.com/",
  },
  brave: {
    displayName: "Brave Search",
    description: "Privacy-focused web, news, and image search",
    supportedTypes: ["web", "news", "images"] as SearchType[],
    envVar: "BRAVE_API_KEY",
    signupUrl: "https://brave.com/search/api/",
  },
  serpapi: {
    displayName: "SerpAPI",
    description: "Aggregates Google, Bing, DuckDuckGo results",
    supportedTypes: ["web", "news", "images"] as SearchType[],
    envVar: "SERPAPI_KEY",
    signupUrl: "https://serpapi.com/",
  },
  google: {
    displayName: "Google Custom Search",
    description: "Official Google Search API",
    supportedTypes: ["web", "images"] as SearchType[],
    envVars: ["GOOGLE_API_KEY", "GOOGLE_SEARCH_ENGINE_ID"],
    signupUrl: "https://developers.google.com/custom-search/v1/introduction",
  },
  duckduckgo: {
    displayName: "DuckDuckGo",
    description: "Free built-in web search — no API key required",
    supportedTypes: ["web"] as SearchType[],
    signupUrl: "https://duckduckgo.com/",
  },
} as const;
