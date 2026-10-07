import { SearchProviderFactory } from "../agent/search/provider-factory";
import type { SearchProviderType } from "../agent/search/types";
import type { AnswerImageNetworkContext } from "./AnswerImageService";

export type WebImageHit = {
  url: string;
  title?: string;
  sourceUrl?: string;
  width?: number;
  height?: number;
};

export type ConfiguredImageSearch = {
  provider: SearchProviderType;
  /** Free to query (self-hosted); paid providers are only a last resort for photos. */
  free: boolean;
  search(query: string, context: AnswerImageNetworkContext): Promise<WebImageHit[]>;
};

const FREE_PROVIDERS = new Set<SearchProviderType>(["searxng"]);

/**
 * The user's configured web search provider, when it can search images: the primary one
 * if it can, otherwise the first configured image-capable one. Read on every lookup, so
 * a settings change applies without a restart.
 */
export function configuredImageSearch(): ConfiguredImageSearch | null {
  let chosen: SearchProviderType | undefined;
  try {
    const primary = SearchProviderFactory.loadSettings().primaryProvider;
    const capable = SearchProviderFactory.getAvailableProviders().filter(
      (provider) => provider.configured && provider.supportedTypes.includes("images"),
    );
    chosen = (capable.find((provider) => provider.type === primary) ?? capable[0])?.type;
  } catch {
    return null;
  }
  if (!chosen) return null;
  const provider = chosen;
  return {
    provider,
    free: FREE_PROVIDERS.has(provider),
    async search(query, context) {
      const response = await SearchProviderFactory.searchWithFallback({
        query,
        searchType: "images",
        maxResults: 8,
        safeSearch: true,
        provider,
        networkEnabled: context.networkEnabled,
        accessNetworkMode: context.accessNetworkMode,
        profileDomainRules: context.profileDomainRules,
      });
      return response.results.flatMap((result) => {
        const url = result.thumbnailUrl || result.imageUrl;
        return url && url.startsWith("https://")
          ? [
              {
                url,
                title: result.title,
                sourceUrl: result.url,
                width: result.width,
                height: result.height,
              },
            ]
          : [];
      });
    },
  };
}
