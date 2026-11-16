/**
 * A tab reloads itself when the host restarted and kept its sign-in. This caps how often,
 * so a host that keeps restarting (or two hosts answering one address in turn) cannot keep
 * the page reloading forever.
 */
const STORAGE_KEY = "cowork:host-restart-reloads";
const WINDOW_MS = 60_000;
const MAX_RELOADS_PER_WINDOW = 3;

type ReloadStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Whether the page may reload itself now, recording the reload when it may. Without working
 * session storage the reloads cannot be counted, so the answer is no and the user reloads.
 */
export function allowHostRestartReload(
  storage: ReloadStorage | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    const recent = (Array.isArray(parsed) ? parsed : []).filter(
      (time): time is number => typeof time === "number" && time <= now && now - time < WINDOW_MS,
    );
    if (recent.length >= MAX_RELOADS_PER_WINDOW) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify([...recent, now]));
    return true;
  } catch {
    return false;
  }
}

/** This tab's session storage, or null where the browser blocks it. */
export function tabSessionStorage(): ReloadStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
