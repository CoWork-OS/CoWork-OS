/** A place the user can go back to: an app view, plus the open session in the main view. */
export interface NavigationEntry<View extends string = string> {
  view: View;
  taskId: string | null;
}

export interface NavigationHistory<View extends string = string> {
  entries: NavigationEntry<View>[];
  index: number;
}

export const NAVIGATION_HISTORY_LIMIT = 100;

export function createNavigationHistory<View extends string>(): NavigationHistory<View> {
  return { entries: [], index: -1 };
}

/** Sessions only distinguish entries in the main view; other views ignore the open task. */
export function toNavigationEntry<View extends string>(
  view: View,
  taskId: string | null,
  mainView: View,
): NavigationEntry<View> {
  return { view, taskId: view === mainView ? taskId : null };
}

export function isSameNavigationEntry<View extends string>(
  left: NavigationEntry<View>,
  right: NavigationEntry<View>,
): boolean {
  return left.view === right.view && left.taskId === right.taskId;
}

/** Push a location, dropping any forward entries, unless it is already the current one. */
export function recordNavigationEntry<View extends string>(
  history: NavigationHistory<View>,
  entry: NavigationEntry<View>,
  limit = NAVIGATION_HISTORY_LIMIT,
): NavigationHistory<View> {
  const current = history.entries[history.index];
  if (current && isSameNavigationEntry(current, entry)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), entry].slice(-limit);
  return { entries, index: entries.length - 1 };
}

export function stepNavigationHistory<View extends string>(
  history: NavigationHistory<View>,
  delta: -1 | 1,
): { history: NavigationHistory<View>; entry: NavigationEntry<View> } | null {
  const index = history.index + delta;
  const entry = history.entries[index];
  if (!entry) return null;
  return { history: { entries: history.entries, index }, entry };
}

export function getNavigationAvailability(history: NavigationHistory): {
  canGoBack: boolean;
  canGoForward: boolean;
} {
  return {
    canGoBack: history.index > 0,
    canGoForward: history.index >= 0 && history.index < history.entries.length - 1,
  };
}
