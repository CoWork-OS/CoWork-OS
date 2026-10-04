/**
 * Synchronous read model of the `memory_items` rows that synchronous consumers need on
 * their hot path (docs/memory-engine.md §5): the active global facts about the user and
 * every active commitment. It is a cache of `memory_items`, never a store: nothing writes
 * to it except a refresh from the repository.
 *
 * - The memory engine refreshes it at startup (awaited, after the lane migration) and
 *   after every MemoryWriter change.
 * - Services that write through MemoryWriter await `refresh()` before they return, so
 *   their caller reads its own write.
 * - A read of a snapshot older than `STALE_AFTER_MS` schedules a refresh, so a change made
 *   by another process on the same profile (desktop app and node daemon) shows up.
 *
 * Without a MemoryWriter (CLI, tests that install none) the snapshot is empty.
 */
import { createLogger } from "../utils/logger";
import { MemoryWriter, type MemoryItemsChange } from "./MemoryWriter";
import type { MemoryItem } from "./memory-items-types";

const logger = createLogger("MemoryFactsSnapshot");

/** Upper bound of rows per query; profiles hold hundreds of facts, not thousands. */
const SNAPSHOT_LIMIT = 2000;
/** A snapshot older than this is refreshed in the background on the next read. */
export const STALE_AFTER_MS = 30_000;

let items: MemoryItem[] = [];
let loadedAt = 0;
let running: Promise<void> | null = null;
let dirty = false;
let now: () => number = () => Date.now();

async function load(): Promise<MemoryItem[]> {
  const repository = MemoryWriter.get()?.repository;
  if (!repository) return [];
  const [globalItems, commitments] = await Promise.all([
    repository.list({
      workspaceId: null,
      scope: "global",
      statuses: ["active"],
      includePrivate: true,
      limit: SNAPSHOT_LIMIT,
    }),
    repository.list({
      kinds: ["commitment"],
      statuses: ["active"],
      includePrivate: true,
      limit: SNAPSHOT_LIMIT,
    }),
  ]);
  const byId = new Map<string, MemoryItem>();
  for (const item of [...globalItems, ...commitments]) byId.set(item.id, item);
  return [...byId.values()];
}

export const MemoryFactsSnapshot = {
  /**
   * Reload from `memory_items`. Concurrent calls share one pass; a call during a pass
   * schedules exactly one more, so the result reflects every write that finished first.
   */
  refresh(): Promise<void> {
    if (running) {
      dirty = true;
      return running;
    }
    running = (async () => {
      do {
        dirty = false;
        try {
          items = await load();
          loadedAt = now();
        } catch (error) {
          logger.warn("Refreshing the memory facts snapshot failed:", error);
        }
      } while (dirty);
    })().finally(() => {
      running = null;
    });
    return running;
  },

  /** Active global items and active commitments (any scope), as last loaded. */
  items(): MemoryItem[] {
    if (MemoryWriter.get() && now() - loadedAt > STALE_AFTER_MS && !running) {
      void this.refresh();
    }
    return items;
  },

  /** Subscribe to MemoryWriter changes; returns the unsubscribe function. */
  install(): () => void {
    return MemoryWriter.onChange((_change: MemoryItemsChange) => {
      void this.refresh();
    });
  },

  /** Resolves when no refresh is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (running) await running;
  },

  /** Tests: drop the cached rows and optionally install a clock. */
  reset(clock?: () => number): void {
    items = [];
    loadedAt = 0;
    dirty = false;
    now = clock ?? (() => Date.now());
  },
};
