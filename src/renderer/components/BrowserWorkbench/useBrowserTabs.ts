import { useCallback, useEffect, useMemo, useReducer } from "react";
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

/**
 * Workbench tab state, restored from sessionStorage for this
 * (workspace, task, session) so closing and reopening the workbench brings the
 * tabs back (pages reload, like a browser's session restore).
 */
export function useBrowserTabs(storageKey: string, initialUrl: string, restore = true) {
  const [state, dispatch] = useReducer(
    browserTabsReducer,
    undefined,
    () => (restore && readStoredTabs(storageKey)) || createInitialBrowserTabsState(initialUrl),
  );

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
