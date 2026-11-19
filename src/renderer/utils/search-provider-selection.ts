import type { SearchProviderInfo, SearchProviderType } from "../../shared/types";

export function supportsSearchFallback(primary: SearchProviderType | null): boolean {
  return primary !== "duckduckgo" && primary !== "searxng";
}

/** Choose the configured primary, mirroring the order returned by the search settings API. */
export function resolvePrimarySearchProvider(
  providers: readonly SearchProviderInfo[],
  primary: SearchProviderType | null,
): SearchProviderInfo | null {
  const configured = providers.filter((provider) => provider.configured);
  return (
    configured.find((provider) => provider.type === primary) ??
    configured.find((provider) => provider.type !== "duckduckgo") ??
    configured[0] ??
    null
  );
}
