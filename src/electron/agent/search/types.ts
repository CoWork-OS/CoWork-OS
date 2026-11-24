/**
 * Search Provider abstraction types
 * Allows switching between Tavily, Exa, Brave Search, SerpAPI, SearXNG, Keenable and DuckDuckGo
 */
import type { AccessDomainRule, AccessNetworkMode } from "../../../shared/access-profiles";

export type SearchProviderType =
  | "tavily"
  | "exa"
  | "brave"
  | "serpapi"
  | "searxng"
  | "keenable"
  | "duckduckgo";

export type SearchType = "web" | "news" | "images";

export interface SearchProviderConfig {
  type: SearchProviderType;
  // Tavily-specific
  tavilyApiKey?: string;
  // Exa-specific
  exaApiKey?: string;
  // Brave-specific
  braveApiKey?: string;
  // SerpAPI-specific
  serpApiKey?: string;
  // SearXNG-specific
  searxngBaseUrl?: string;
  searxngAllowPrivate?: boolean;
  // Keenable-specific (optional: without a key the keyless endpoint is used)
  keenableApiKey?: string;
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
  // Task/workspace policy applied to a configurable provider endpoint.
  endpointDomainPolicy?: {
    allowedDomains: string[];
    blockedDomains: string[];
  };
  /** Access-profile domain rules applied to the provider endpoint as well as returned sources. */
  profileDomainRules?: AccessDomainRule[];
  /** Effective access-profile network mode for direct provider calls. */
  accessNetworkMode?: AccessNetworkMode;
  /** Effective workspace network capability for direct provider calls. */
  networkEnabled?: boolean;
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
  exa: {
    displayName: "Exa",
    description: "Semantic web and news search with content-aware results",
    supportedTypes: ["web", "news"] as SearchType[],
    envVar: "EXA_API_KEY",
    signupUrl: "https://exa.ai/",
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
  searxng: {
    displayName: "SearXNG",
    description: "Self-hosted metasearch with no commercial API key required",
    supportedTypes: ["web", "news", "images"] as SearchType[],
    signupUrl: "https://docs.searxng.org/admin/installation.html",
  },
  keenable: {
    displayName: "Keenable",
    description: "Web search on Keenable's own index; works without an API key",
    supportedTypes: ["web"] as SearchType[],
    envVar: "KEENABLE_API_KEY",
    signupUrl: "https://docs.keenable.ai/api-keys",
  },
  duckduckgo: {
    displayName: "DuckDuckGo",
    description: "Free built-in web search — no API key required",
    supportedTypes: ["web"] as SearchType[],
    signupUrl: "https://duckduckgo.com/",
  },
} as const;
