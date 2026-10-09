/**
 * Tab state for the in-app browser workbench.
 *
 * Every live tab keeps its own mounted <webview>, so switching tabs never
 * reloads a page. This module is the pure state: which tabs exist, which is
 * active, what each one shows. The surface component renders it.
 */

export type BrowserTabBlock = {
  url: string;
  /** "policy" | "local_preview" | "scheme" from the main process. */
  reason: string;
  detail?: string;
};

export type BrowserTabLoadError = {
  url: string;
  code: number;
  description: string;
};

export type BrowserTab = {
  id: string;
  /** Current URL; "" shows the new-tab page. */
  url: string;
  /** URL the webview loads once its page is registered and guarded. */
  initialUrl: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  pinned: boolean;
  /** Audio is muted by the user. */
  muted: boolean;
  /** The page is playing audio. */
  audible: boolean;
  /** Chromium zoom level of the page (0 = 100%), remembered per site. */
  zoomLevel: number;
  lastActiveAt: number;
  openerTabId?: string;
  /** Opened by the agent or by a page; the main process already checked its URL. */
  openedByAgent?: boolean;
  /** Unloaded to save memory; reloads its URL when activated. */
  discarded: boolean;
  /** Bumped to remount the tab's webview (after a crash or a discard). */
  generation: number;
  blocked?: BrowserTabBlock;
  loadError?: BrowserTabLoadError;
  /** render-process-gone reason while the page is dead. */
  crashed?: string;
};

export type BrowserTabsState = {
  tabs: BrowserTab[];
  activeTabId: string;
  /** Recently closed tabs, newest last, for "Reopen closed tab". */
  closed: Array<{ url: string; title: string; index: number }>;
};

export type BrowserTabsAction =
  | {
      type: "open";
      id?: string;
      url?: string;
      background?: boolean;
      openerTabId?: string;
      openedByAgent?: boolean;
      /** Place the new tab right after this tab (tab menu "New tab to the right", "Duplicate"). */
      afterTabId?: string;
      now?: number;
    }
  | { type: "close"; id: string }
  | { type: "closeMany"; ids: string[] }
  | { type: "togglePin"; id: string }
  | { type: "activate"; id: string; now?: number }
  | { type: "update"; id: string; patch: Partial<BrowserTab> }
  | { type: "reopenClosed"; id?: string; now?: number }
  | { type: "move"; id: string; toIndex: number }
  | { type: "reloadCrashed"; id: string };

/** Live webviews beyond this are discarded, least recently used first. */
export const MAX_LIVE_BROWSER_TABS = 12;
const MAX_CLOSED_TABS = 20;

export function createBrowserTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createBrowserTab(
  input: {
    id?: string;
    url?: string;
    title?: string;
    openerTabId?: string;
    pinned?: boolean;
    openedByAgent?: boolean;
  },
  now = Date.now(),
): BrowserTab {
  const url = input.url || "";
  return {
    id: input.id || createBrowserTabId(),
    url,
    initialUrl: url,
    title: input.title || "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    pinned: input.pinned === true,
    muted: false,
    audible: false,
    zoomLevel: 0,
    lastActiveAt: now,
    openerTabId: input.openerTabId,
    ...(input.openedByAgent ? { openedByAgent: true } : {}),
    discarded: false,
    generation: 0,
  };
}

export function createInitialBrowserTabsState(url = ""): BrowserTabsState {
  const tab = createBrowserTab({ url });
  return { tabs: [tab], activeTabId: tab.id, closed: [] };
}

/** Keep at most MAX_LIVE_BROWSER_TABS webviews; discard the least recently used others. */
function enforceLiveTabLimit(tabs: BrowserTab[], activeTabId: string): BrowserTab[] {
  const live = tabs.filter((tab) => !tab.discarded);
  if (live.length <= MAX_LIVE_BROWSER_TABS) return tabs;
  const discard = new Set(
    live
      .filter((tab) => tab.id !== activeTabId)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
      .slice(0, live.length - MAX_LIVE_BROWSER_TABS)
      .map((tab) => tab.id),
  );
  return tabs.map((tab) =>
    discard.has(tab.id) ? { ...tab, discarded: true, initialUrl: tab.url, loading: false } : tab,
  );
}

function activate(tabs: BrowserTab[], id: string, now: number): BrowserTab[] {
  return tabs.map((tab) =>
    tab.id === id
      ? {
          ...tab,
          lastActiveAt: now,
          ...(tab.discarded
            ? { discarded: false, initialUrl: tab.url, generation: tab.generation + 1 }
            : {}),
        }
      : tab,
  );
}

export function browserTabsReducer(
  state: BrowserTabsState,
  action: BrowserTabsAction,
): BrowserTabsState {
  switch (action.type) {
    case "open": {
      const now = action.now ?? Date.now();
      if (action.id && state.tabs.some((tab) => tab.id === action.id)) {
        return action.background
          ? state
          : browserTabsReducer(state, { type: "activate", id: action.id, now });
      }
      const tab = createBrowserTab(
        {
          id: action.id,
          url: action.url,
          openerTabId: action.openerTabId,
          openedByAgent: action.openedByAgent,
        },
        action.background ? now - 1 : now,
      );
      // Tabs a page opens go right after their opener (and its other children), like Chrome.
      let index = state.tabs.length;
      const afterIndex = action.afterTabId
        ? state.tabs.findIndex((candidate) => candidate.id === action.afterTabId)
        : -1;
      if (afterIndex >= 0) {
        index = afterIndex + 1;
      } else if (action.openerTabId) {
        const openerIndex = state.tabs.findIndex(
          (candidate) => candidate.id === action.openerTabId,
        );
        if (openerIndex >= 0) {
          index = openerIndex + 1;
          while (
            index < state.tabs.length &&
            state.tabs[index].openerTabId === action.openerTabId
          ) {
            index += 1;
          }
        }
      }
      const tabs = [...state.tabs.slice(0, index), tab, ...state.tabs.slice(index)];
      const activeTabId = action.background ? state.activeTabId : tab.id;
      return { ...state, tabs: enforceLiveTabLimit(tabs, activeTabId), activeTabId };
    }
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const closedTab = state.tabs[index];
      const closed = closedTab.url
        ? [...state.closed, { url: closedTab.url, title: closedTab.title, index }].slice(
            -MAX_CLOSED_TABS,
          )
        : state.closed;
      const remaining = state.tabs.filter((tab) => tab.id !== action.id);
      if (remaining.length === 0) {
        // The workbench always has a tab; closing the last one leaves a new-tab page.
        const fresh = createBrowserTab({});
        return { tabs: [fresh], activeTabId: fresh.id, closed };
      }
      if (action.id !== state.activeTabId) return { ...state, tabs: remaining, closed };
      const opener = closedTab.openerTabId
        ? remaining.find((tab) => tab.id === closedTab.openerTabId)
        : undefined;
      const next = opener || remaining[Math.min(index, remaining.length - 1)];
      return {
        tabs: activate(remaining, next.id, Date.now()),
        activeTabId: next.id,
        closed,
      };
    }
    case "closeMany": {
      const ids = new Set(action.ids);
      if (ids.size === 0) return state;
      let next = state;
      // Close the others first so the active tab moves at most once.
      const ordered = [...state.tabs]
        .filter((tab) => ids.has(tab.id))
        .sort((a, b) => Number(a.id === state.activeTabId) - Number(b.id === state.activeTabId));
      for (const tab of ordered) next = browserTabsReducer(next, { type: "close", id: tab.id });
      return next;
    }
    case "togglePin": {
      const tab = state.tabs.find((candidate) => candidate.id === action.id);
      if (!tab) return state;
      const updated = { ...tab, pinned: !tab.pinned };
      const rest = state.tabs.filter((candidate) => candidate.id !== action.id);
      // Pinned tabs stay together at the start of the strip.
      const pinnedCount = rest.filter((candidate) => candidate.pinned).length;
      const tabs = [...rest.slice(0, pinnedCount), updated, ...rest.slice(pinnedCount)];
      return { ...state, tabs };
    }
    case "activate": {
      if (!state.tabs.some((tab) => tab.id === action.id)) return state;
      if (action.id === state.activeTabId) return state;
      const tabs = activate(state.tabs, action.id, action.now ?? Date.now());
      return { ...state, tabs: enforceLiveTabLimit(tabs, action.id), activeTabId: action.id };
    }
    case "update": {
      let changed = false;
      const tabs = state.tabs.map((tab) => {
        if (tab.id !== action.id) return tab;
        const next = { ...tab, ...action.patch };
        for (const key of Object.keys(action.patch) as Array<keyof BrowserTab>) {
          if (next[key] !== tab[key]) {
            changed = true;
            break;
          }
        }
        return changed ? next : tab;
      });
      return changed ? { ...state, tabs } : state;
    }
    case "reopenClosed": {
      const last = state.closed[state.closed.length - 1];
      if (!last) return state;
      const now = action.now ?? Date.now();
      const tab = createBrowserTab({ id: action.id, url: last.url, title: last.title }, now);
      const index = Math.min(last.index, state.tabs.length);
      const tabs = [...state.tabs.slice(0, index), tab, ...state.tabs.slice(index)];
      return {
        tabs: enforceLiveTabLimit(tabs, tab.id),
        activeTabId: tab.id,
        closed: state.closed.slice(0, -1),
      };
    }
    case "move": {
      const from = state.tabs.findIndex((tab) => tab.id === action.id);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(state.tabs.length - 1, Math.round(action.toIndex)));
      if (from === to) return state;
      const tabs = [...state.tabs];
      const [tab] = tabs.splice(from, 1);
      tabs.splice(to, 0, tab);
      return { ...state, tabs };
    }
    case "reloadCrashed": {
      return browserTabsReducer(state, {
        type: "update",
        id: action.id,
        patch: {
          crashed: undefined,
          loadError: undefined,
          blocked: undefined,
          initialUrl: state.tabs.find((tab) => tab.id === action.id)?.url || "",
          generation: (state.tabs.find((tab) => tab.id === action.id)?.generation || 0) + 1,
        },
      });
    }
    default:
      return state;
  }
}

/* ---------- persistence (session restore) ---------- */

type PersistedTabs = {
  version: 1;
  activeTabId: string;
  tabs: Array<{ id: string; url: string; title: string; pinned?: boolean }>;
};

const STORAGE_PREFIX = "cowork.browserWorkbench.tabs.v1";

export function browserTabsStorageKey(
  workspaceId: string | undefined,
  taskId: string,
  sessionId: string,
): string {
  return `${STORAGE_PREFIX}:${workspaceId || "default"}:${taskId}:${sessionId}`;
}

/** Only http(s) pages are restored; the URL is reloaded, not the page state. */
function isRestorableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function serializeBrowserTabs(state: BrowserTabsState): string {
  const tabs = state.tabs
    .filter((tab) => !tab.url || isRestorableUrl(tab.url))
    .map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      ...(tab.pinned ? { pinned: true } : {}),
    }));
  return JSON.stringify({
    version: 1,
    activeTabId: state.activeTabId,
    tabs,
  } satisfies PersistedTabs);
}

export function restoreBrowserTabs(raw: string | null | undefined): BrowserTabsState | null {
  if (!raw) return null;
  let parsed: PersistedTabs;
  try {
    parsed = JSON.parse(raw) as PersistedTabs;
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tabs)) return null;
  const now = Date.now();
  const seen = new Set<string>();
  const tabs = parsed.tabs
    .filter(
      (tab) =>
        tab &&
        typeof tab.id === "string" &&
        /^[A-Za-z0-9._:-]{1,120}$/.test(tab.id) &&
        typeof tab.url === "string" &&
        (!tab.url || isRestorableUrl(tab.url)) &&
        !seen.has(tab.id) &&
        seen.add(tab.id),
    )
    .map((tab) =>
      createBrowserTab(
        {
          id: tab.id,
          url: tab.url,
          title: typeof tab.title === "string" ? tab.title.slice(0, 300) : "",
          pinned: tab.pinned === true,
        },
        now,
      ),
    );
  if (tabs.length === 0) return null;
  const activeTabId = tabs.some((tab) => tab.id === parsed.activeTabId)
    ? parsed.activeTabId
    : tabs[0].id;
  return { tabs: enforceLiveTabLimit(tabs, activeTabId), activeTabId, closed: [] };
}
