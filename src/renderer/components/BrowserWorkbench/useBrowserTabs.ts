import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  type BrowserTab,
  type BrowserTabsState,
  browserTabsReducer,
  createInitialBrowserTabsState,
  restoreBrowserTabs,
  serializeBrowserTabs,
} from "./browser-tabs-model";

function readStoredTabs(storageKey: string): BrowserTabsState | null {
  try {
    return restoreBrowserTabs(window.sessionStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

/** Tabs to show for a storage key: the stored ones when restoring, else one fresh tab. */
export function loadBrowserTabsState(
  storageKey: string,
  initialUrl: string,
  restore: boolean,
): { state: BrowserTabsState; restored: boolean } {
  const stored = restore ? readStoredTabs(storageKey) : null;
  return stored
    ? { state: stored, restored: true }
    : { state: createInitialBrowserTabsState(initialUrl), restored: false };
}

/**
 * Workbench tab state, restored from sessionStorage for this
 * (workspace, task, session) so closing and reopening the workbench brings the
 * tabs back (pages reload, like a browser's session restore).
 *
 * `restore` is undefined until the setting has loaded; tabs are restored
 * meanwhile (the default), and a setting that turns out to be off replaces them
 * with a fresh tab.
 */
export function useBrowserTabs(storageKey: string, initialUrl: string, restore?: boolean) {
  const [initial] = useState(() => loadBrowserTabsState(storageKey, initialUrl, restore !== false));
  const [state, dispatch] = useReducer(browserTabsReducer, initial.state);
  const [loadedFor, setLoadedFor] = useState({ storageKey, restored: initial.restored });
  const [restoreDecided, setRestoreDecided] = useState(restore !== undefined);

  if (loadedFor.storageKey !== storageKey) {
    // Another task or session: show its own tabs. Replacing during render means
    // these tabs are never rendered or saved under the new key.
    const next = loadBrowserTabsState(storageKey, initialUrl, restore !== false);
    setLoadedFor({ storageKey, restored: next.restored });
    dispatch({ type: "replace", state: next.state });
  }

  useEffect(() => {
    if (restoreDecided || restore === undefined) return;
    setRestoreDecided(true);
    if (restore === false && loadedFor.restored) {
      dispatch({ type: "replace", state: createInitialBrowserTabsState(initialUrl) });
    }
  }, [initialUrl, loadedFor.restored, restore, restoreDecided]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, serializeBrowserTabs(state));
    } catch {
      // Storage can be unavailable; tabs still work for this mount.
    }
  }, [state, storageKey]);

  const activeTab = useMemo<BrowserTab>(
    () => state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0],
    [state.activeTabId, state.tabs],
  );

  const openTab = useCallback(
    (
      input: {
        id?: string;
        url?: string;
        background?: boolean;
        openerTabId?: string;
        openedByAgent?: boolean;
        afterTabId?: string;
      } = {},
    ) => dispatch({ type: "open", ...input }),
    [],
  );
  const closeTab = useCallback((id: string) => dispatch({ type: "close", id }), []);
  const activateTab = useCallback((id: string) => dispatch({ type: "activate", id }), []);
  const updateTab = useCallback(
    (id: string, patch: Partial<BrowserTab>) => dispatch({ type: "update", id, patch }),
    [],
  );
  const reopenClosedTab = useCallback(() => dispatch({ type: "reopenClosed" }), []);
  const moveTab = useCallback(
    (id: string, toIndex: number) => dispatch({ type: "move", id, toIndex }),
    [],
  );
  const reloadCrashedTab = useCallback((id: string) => dispatch({ type: "reloadCrashed", id }), []);
  const closeTabs = useCallback((ids: string[]) => dispatch({ type: "closeMany", ids }), []);
  const togglePinTab = useCallback((id: string) => dispatch({ type: "togglePin", id }), []);

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab,
    canReopenClosed: state.closed.length > 0,
    openTab,
    closeTab,
    activateTab,
    updateTab,
    reopenClosedTab,
    moveTab,
    reloadCrashedTab,
    closeTabs,
    togglePinTab,
    closedTabs: state.closed,
  };
}
