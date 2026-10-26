import { useCallback, useEffect, useRef, useState } from "react";
import type { HostFolderListing } from "../../shared/host-api/host-folders";
import { getBrowserHostFolderApi } from "../host/browser-host-folders";

type Location = { rootId: string; path: string[] };

export interface HostFolderBrowser {
  listing: HostFolderListing | null;
  loading: boolean;
  error: string | null;
  includeHidden: boolean;
  setIncludeHidden: (value: boolean) => void;
  open: (location: Location) => void;
  retry: () => void;
}

/**
 * Browses host folders through the browser host. Only the latest request's
 * reply is applied, so quick clicks never show an older folder.
 */
export function useHostFolderBrowser(startWorkspaceId?: string): HostFolderBrowser {
  const [listing, setListing] = useState<HostFolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeHidden, setIncludeHiddenState] = useState(false);
  const requestSeqRef = useRef(0);
  const locationRef = useRef<Location | null>(null);

  const load = useCallback(
    async (location: Location | null, hidden: boolean) => {
      const requestId = ++requestSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const next = await getBrowserHostFolderApi().listHostFolders({
          ...(location
            ? { rootId: location.rootId, path: location.path }
            : startWorkspaceId
              ? { startWorkspaceId }
              : {}),
          includeHidden: hidden,
        });
        if (requestId !== requestSeqRef.current) return;
        locationRef.current = { rootId: next.rootId, path: next.path };
        setListing(next);
      } catch (loadError) {
        if (requestId !== requestSeqRef.current) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load this folder.");
      } finally {
        if (requestId === requestSeqRef.current) setLoading(false);
      }
    },
    [startWorkspaceId],
  );

  useEffect(() => {
    void load(null, false);
    return () => {
      requestSeqRef.current += 1;
    };
  }, [load]);

  const open = useCallback(
    (location: Location) => {
      void load(location, includeHidden);
    },
    [includeHidden, load],
  );

  const setIncludeHidden = useCallback(
    (value: boolean) => {
      setIncludeHiddenState(value);
      void load(locationRef.current, value);
    },
    [load],
  );

  const retry = useCallback(() => {
    void load(locationRef.current, includeHidden);
  }, [includeHidden, load]);

  return { listing, loading, error, includeHidden, setIncludeHidden, open, retry };
}
