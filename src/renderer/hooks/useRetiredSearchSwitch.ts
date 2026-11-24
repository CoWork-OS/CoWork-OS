import { useEffect, useState } from "react";
import type { RetiredSearchProviderSwitch, SearchConfigStatus } from "../../shared/types";

/** Fired by Search settings after a save, so notices re-read the provider choice. */
export const SEARCH_SETTINGS_CHANGED = "search-settings-changed";

/**
 * Set once web search was moved off a provider that shut down and was removed (#914),
 * or null when that never happened.
 */
export function useRetiredSearchSwitch(): RetiredSearchProviderSwitch | null {
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
  return status?.retiredProviderSwitch ?? null;
}
