/**
 * Tracks writes that IPC handlers have started, so shutdown can wait for them before
 * storage closes.
 */
export interface PendingWriteTracker {
  /** Track `write` until it settles and return it unchanged. */
  track<T>(write: Promise<T>): Promise<T>;
  /**
   * Wait `settleMs` for writes sent just before a window closed to arrive, then for
   * every tracked write to settle.
   */
  waitForAll(settleMs?: number): Promise<void>;
}

export function createPendingWriteTracker(): PendingWriteTracker {
  const pending = new Set<Promise<unknown>>();
  return {
    track(write) {
      pending.add(write);
      void write
        .finally(() => pending.delete(write))
        .catch(() => {
          // The caller receives the error through its own promise.
        });
      return write;
    },
    async waitForAll(settleMs = 100) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      await Promise.allSettled(pending);
    },
  };
}
