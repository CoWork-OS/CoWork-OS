import type { MemoryUsedForTask, MemoryUsedReply } from "../../../shared/memory-used";

/**
 * Per-task cache of "Memory used" attributions for the reply affordance. The
 * `memory_used` events are hidden from the timeline (they never reach the renderer's event
 * list); main attributes them to replies and this store fetches the result once per task,
 * again only when a reply it has not seen asks for its attribution.
 */
export type MemoryUsedFetcher = (request: {
  workspaceId: string;
  taskId: string;
}) => Promise<MemoryUsedForTask>;

interface TaskEntry {
  workspaceId: string;
  data: MemoryUsedForTask | null;
  /** Reply ids main has accounted for (with or without memory). */
  known: Set<string>;
  /** Reply ids already fetched for; a reply is fetched for at most once. */
  attempted: Set<string>;
  /** Reply ids waiting for the next fetch. */
  waiting: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
}

export interface MemoryUsedStore {
  getReply(taskId: string, eventId: string): MemoryUsedReply | null;
  /** Ask for a reply's attribution; fetches (coalesced) when the reply is new to the store. */
  request(taskId: string, workspaceId: string, eventId: string): void;
  subscribe(listener: () => void): () => void;
  /** Drop a task's cache (task deleted, workspace changed). */
  invalidate(taskId?: string): void;
}

const MAX_TASKS = 20;

export function createMemoryUsedStore(
  fetcher: MemoryUsedFetcher,
  options: { delayMs?: number } = {},
): MemoryUsedStore {
  const delayMs = options.delayMs ?? 50;
  const tasks = new Map<string, TaskEntry>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const run = (taskId: string, entry: TaskEntry) => {
    entry.timer = null;
    if (entry.inflight) {
      // A fetch is running: the waiting replies go out after it.
      void entry.inflight.finally(() => schedule(taskId, entry));
      return;
    }
    const batch = [...entry.waiting];
    entry.waiting.clear();
    if (batch.length === 0) return;
    for (const id of batch) entry.attempted.add(id);
    entry.inflight = fetcher({ workspaceId: entry.workspaceId, taskId })
      .then((data) => {
        if (tasks.get(taskId) !== entry) return;
        entry.data = data;
        entry.known = new Set(data?.replyEventIds ?? []);
        notify();
      })
      .catch(() => {
        // Attribution is optional UI; a failed read shows no affordance.
      })
      .finally(() => {
        entry.inflight = null;
      });
  };

  const schedule = (taskId: string, entry: TaskEntry) => {
    if (entry.timer || entry.waiting.size === 0) return;
    entry.timer = setTimeout(() => run(taskId, entry), delayMs);
  };

  return {
    getReply(taskId, eventId) {
      return tasks.get(taskId)?.data?.replies?.[eventId] ?? null;
    },
    request(taskId, workspaceId, eventId) {
      if (!taskId || !workspaceId || !eventId) return;
      let entry = tasks.get(taskId);
      if (!entry || entry.workspaceId !== workspaceId) {
        if (entry?.timer) clearTimeout(entry.timer);
        entry = {
          workspaceId,
          data: null,
          known: new Set(),
          attempted: new Set(),
          waiting: new Set(),
          timer: null,
          inflight: null,
        };
        tasks.set(taskId, entry);
        while (tasks.size > MAX_TASKS) {
          const oldest = tasks.keys().next().value as string;
          const dropped = tasks.get(oldest);
          if (dropped?.timer) clearTimeout(dropped.timer);
          tasks.delete(oldest);
        }
      }
      if (entry.known.has(eventId) || entry.attempted.has(eventId)) return;
      entry.waiting.add(eventId);
      schedule(taskId, entry);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate(taskId) {
      const ids = taskId ? [taskId] : [...tasks.keys()];
      for (const id of ids) {
        const entry = tasks.get(id);
        if (entry?.timer) clearTimeout(entry.timer);
        tasks.delete(id);
      }
      notify();
    },
  };
}

let defaultStore: MemoryUsedStore | null = null;

/** The app's store, over the preload API (null when the host has no such method). */
export function getMemoryUsedStore(): MemoryUsedStore | null {
  if (defaultStore) return defaultStore;
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api || typeof api.getMemoryUsedForTask !== "function") return null;
  defaultStore = createMemoryUsedStore((request) => api.getMemoryUsedForTask(request));
  return defaultStore;
}
