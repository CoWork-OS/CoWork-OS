import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { GuardrailManager } from "../../guardrails/guardrail-manager";
import { domainMatches } from "../../security/network-policy";
import {
  SearchProviderFactory,
  SearchQuery,
  SearchResult,
  SearchResponse,
  SearchType,
  SearchProviderType,
} from "../search";

/**
 * SearchTools implements web search operations for the agent
 */
export class SearchTools {
  private domainPolicyOverride: {
    allowedDomains: string[];
    blockedDomains: string[];
  } | null = null;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  setDomainPolicy(policy: { allowedDomains?: string[]; blockedDomains?: string[] } | null): void {
    if (!policy) {
      this.domainPolicyOverride = null;
      return;
    }
    this.domainPolicyOverride = {
      allowedDomains: this.normalizeDomainPatterns(policy.allowedDomains || []),
      blockedDomains: this.normalizeDomainPatterns(policy.blockedDomains || []),
    };
  }

  private normalizeDomainPatterns(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    const normalized = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string") continue;
      const pattern = value.trim().toLowerCase();
      if (!pattern) continue;
      normalized.add(pattern);
    }
    return Array.from(normalized.values());
  }

  private matchesDomainPattern(hostname: string, pattern: string): boolean {
    const normalizedHost = hostname.trim().toLowerCase();
    const normalizedPattern = pattern.trim().toLowerCase();
    if (!normalizedHost || !normalizedPattern) return false;
    if (normalizedPattern.startsWith("*.")) {
      const suffix = normalizedPattern.slice(2);
      return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
    }
    return normalizedHost === normalizedPattern;
  }

  private extractHostname(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private getEffectiveDomainPolicy(): { allowedDomains: string[]; blockedDomains: string[] } {
    if (this.domainPolicyOverride) return this.domainPolicyOverride;
    const settings = GuardrailManager.loadSettings();
    return {
      blockedDomains: this.normalizeDomainPatterns((settings as Any).webSearchBlockedDomains || []),
      allowedDomains: this.normalizeDomainPatterns((settings as Any).webSearchAllowedDomains || []),
    };
  }

  private getAccessProfileDomainRules() {
    return Array.isArray(this.workspace.permissions?.accessDomainRules)
      ? this.workspace.permissions.accessDomainRules
      : [];
  }

  private applyDomainPolicy(response: SearchResponse): {
    response: SearchResponse;
    originalCount: number;
    filteredCount: number;
    filteredOutCount: number;
  } {
    const effectivePolicy = this.getEffectiveDomainPolicy();
    const blockedDomains = effectivePolicy.blockedDomains;
    const allowedDomains = effectivePolicy.allowedDomains;
    const profileDomainRules = this.getAccessProfileDomainRules();

    const originalResults = Array.isArray(response.results) ? response.results : [];
    const originalCount = originalResults.length;
    if (
      originalCount === 0 ||
      (blockedDomains.length === 0 &&
        allowedDomains.length === 0 &&
        profileDomainRules.length === 0)
    ) {
      return {
        response,
        originalCount,
        filteredCount: originalCount,
        filteredOutCount: 0,
      };
    }

    const filteredResults: SearchResult[] = [];
    for (const result of originalResults) {
      const hostname = this.extractHostname(String(result.url || ""));
      if (!hostname) {
        continue;
      }
      const profileDenied = profileDomainRules.some(
        (rule) => rule.access === "deny" && domainMatches(hostname, rule.pattern),
      );
      if (profileDenied) continue;
      const profileAllows = profileDomainRules.filter((rule) => rule.access === "allow");
      if (
        profileAllows.length > 0 &&
        !profileAllows.some((rule) => domainMatches(hostname, rule.pattern))
      ) {
        continue;
      }
      const blocked = blockedDomains.some((pattern) =>
        this.matchesDomainPattern(hostname, pattern),
      );
      if (blocked) {
        continue;
      }
      if (allowedDomains.length > 0) {
        const allowed = allowedDomains.some((pattern) =>
          this.matchesDomainPattern(hostname, pattern),
        );
        if (!allowed) {
          continue;
        }
      }
      filteredResults.push(result);
    }

    const filteredCount = filteredResults.length;
    const filteredOutCount = Math.max(0, originalCount - filteredCount);
    const filteredResponse: SearchResponse = {
      ...response,
      results: filteredResults,
    };

    if (originalCount > 0 && filteredCount === 0 && filteredOutCount > 0) {
      const policyError =
        "All web_search results were filtered by domain policy (blocked domains or allowlist restrictions).";
      return {
        response: {
          ...filteredResponse,
          success: false,
          error: policyError,
          metadata: {
            ...filteredResponse.metadata,
            error: policyError,
            policyReason: "domain_policy_filtered",
            blockedDomains,
            allowedDomains,
            originalResultCount: originalCount,
            filteredOutCount,
          },
        },
        originalCount,
        filteredCount,
        filteredOutCount,
      };
    }

    return {
      response: filteredResponse,
      originalCount,
      filteredCount,
      filteredOutCount,
    };
  }

  /**
   * Perform a web search with automatic fallback support
   */
  async webSearch(input: {
    query: string;
    searchType?: SearchType;
    maxResults?: number;
    provider?: SearchProviderType;
    dateRange?: "day" | "week" | "month" | "year";
    region?: string;
    language?: string;
    safeSearch?: boolean;
    maxUses?: number;
  }): Promise<SearchResponse> {
    if (
      this.workspace.permissions?.network === false ||
      this.workspace.permissions?.accessNetworkMode === "disabled"
    ) {
      const error = "Network access disabled by the active access profile.";
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "web_search",
        error,
        reason: "workspace_network_disabled",
      });
      return {
        success: false,
        error,
        query: input.query,
        searchType: input.searchType || "web",
        results: [],
        provider: "none",
        metadata: { error, policyReason: "workspace_network_disabled" },
      };
    }

    const endpointDomainPolicy = this.getEffectiveDomainPolicy();
    const searchQuery: SearchQuery = {
      query: input.query,
      searchType: input.searchType || "web",
      maxResults: Math.min(input.maxResults || 10, 20), // Cap at 20 results
      dateRange: input.dateRange,
      region: input.region,
      language: input.language,
      safeSearch: input.safeSearch,
      provider: input.provider,
      endpointDomainPolicy,
      profileDomainRules: this.getAccessProfileDomainRules(),
      networkEnabled: this.workspace.permissions?.network,
      accessNetworkMode: this.workspace.permissions?.accessNetworkMode,
    };

    const settings = SearchProviderFactory.loadSettings();
    const providerName = input.provider || settings.primaryProvider || "duckduckgo";
    this.daemon.logEvent(this.taskId, "log", {
      message: `Searching ${searchQuery.searchType}: "${input.query}" via ${providerName}`,
    });

    try {
      const response = await SearchProviderFactory.searchWithFallback(searchQuery);
      const domainPolicy = this.applyDomainPolicy(response);
      const filteredResponse = domainPolicy.response;

      this.daemon.logEvent(this.taskId, "log", {
        metric: "web_search_domain_filtered_result_count",
        query: input.query,
        originalCount: domainPolicy.originalCount,
        filteredCount: domainPolicy.filteredCount,
        filteredOutCount: domainPolicy.filteredOutCount,
      });

      if (filteredResponse.success === false) {
        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: "web_search",
          error: filteredResponse.error || "All web_search results were filtered by domain policy.",
          resultCount: domainPolicy.filteredCount,
          filteredOutCount: domainPolicy.filteredOutCount,
        });
        return filteredResponse;
      }

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "web_search",
        result: {
          query: input.query,
          searchType: searchQuery.searchType,
          resultCount: filteredResponse.results.length,
          provider: filteredResponse.provider,
        },
      });

      return {
        ...filteredResponse,
        success: true,
      };
    } catch (error: Any) {
      const message = error?.message || "Web search failed";
      const failedProvider =
        typeof error?.failedProvider === "string"
          ? (error.failedProvider as SearchProviderType)
          : undefined;
      const providerErrorScope =
        error?.providerErrorScope === "provider" || error?.providerErrorScope === "global"
          ? error.providerErrorScope
          : undefined;
      const failureClass =
        error?.failureClass === "provider_quota" ||
        error?.failureClass === "provider_rate_limit" ||
        error?.failureClass === "external_unknown"
          ? error.failureClass
          : undefined;
      const failedProviders = Array.isArray(error?.failedProviders)
        ? (error.failedProviders as Array<{ provider: SearchProviderType; error: string }>)
        : undefined;
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "web_search",
        error: message,
      });

      return {
        success: false,
        error: message,
        query: input.query,
        searchType: input.searchType || "web",
        results: [],
        provider: (input.provider || settings.primaryProvider || "none") as
          | SearchProviderType
          | "none",
        providerErrorScope,
        failedProvider,
        failureClass,
        failedProviders,
        metadata: {
          error: message,
          providerErrorScope,
          failedProvider,
          failureClass,
          failedProviders,
        },
      };
    }
  }
}
