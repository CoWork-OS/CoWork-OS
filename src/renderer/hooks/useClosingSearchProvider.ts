import { useEffect, useState } from "react";
import type {
  RetiredSearchProviderSwitch,
  SearchConfigStatus,
  SearchProviderInfo,
} from "../../shared/types";
import {
  resolvePrimarySearchProvider,
  supportsSearchFallback,
} from "../utils/search-provider-selection";

/** Fired by Search settings after a save, so notices re-read the provider choice. */
export const SEARCH_SETTINGS_CHANGED = "search-settings-changed";

/**
 * The closing provider that web search currently relies on (primary or fallback),
 * or null when search does not depend on one. See #914.
 */
export function findClosingSearchProvider(
  status: Pick<SearchConfigStatus, "primaryProvider" | "fallbackProvider" | "providers"> | null,
): SearchProviderInfo | null {
  if (!status) return null;
  const primary = resolvePrimarySearchProvider(status.providers, status.primaryProvider);
  if (primary?.retirement) return primary;
  if (!primary || !supportsSearchFallback(primary.type)) return null;
  return (
    status.providers.find(
      (provider) =>
        provider.retirement && provider.configured && provider.type === status.fallbackProvider,
    ) ?? null
  );
}

function useSearchConfigStatus(): SearchConfigStatus | null {
  const [status, setStatus] = useState<SearchConfigStatus | null>(null);
  useEffect(() => {
    const getStatus = window.electronAPI?.getSearchConfigStatus;
    if (typeof getStatus !== "function") return;
    let cancelled = false;
    const refresh = () => {
      getStatus()
        .then((next) => {
          if (!cancelled) setStatus(next as SearchConfigStatus);
        })
        .catch(() => {
          // Search settings unavailable: show no notice.
        });
    };
    refresh();
    window.addEventListener(SEARCH_SETTINGS_CHANGED, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(SEARCH_SETTINGS_CHANGED, refresh);
    };
  }, []);
  return status;
}

export interface SearchProviderNotices {
  /** A closing provider web search still relies on. */
  closingProvider: SearchProviderInfo | null;
  /** Set once web search was moved off a provider that shut down. */
  retiredSwitch: RetiredSearchProviderSwitch | null;
}

export function useSearchProviderNotices(): SearchProviderNotices {
  const status = useSearchConfigStatus();
  return {
    closingProvider: findClosingSearchProvider(status),
    retiredSwitch: status?.retiredProviderSwitch ?? null,
  };
}

export function useClosingSearchProvider(): SearchProviderInfo | null {
  return useSearchProviderNotices().closingProvider;
}
