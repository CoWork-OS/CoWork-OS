/**
 * Registry of fire-and-forget async work that must settle before shutdown releases what it
 * uses (the database, the memory service). `track` registers a promise and hands it back
 * unchanged; `drain` waits, bounded, until nothing tracked is still running (work started
 * by tracked work while draining is waited for as well).
 */
export class InFlightWork {
  private readonly pending = new Set<Promise<void>>();

  /** Register `work`; returns it unchanged so callers keep their own `.catch`. */
  track<T>(work: Promise<T>): Promise<T> {
    const settled: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(settled);
    void settled.then(() => {
      this.pending.delete(settled);
    });
    return work;
  }

  get size(): number {
    return this.pending.size;
  }

  /**
   * Wait until all tracked work has settled or `timeoutMs` has passed. Returns true when
   * nothing is left running. Never rejects.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });
    try {
      while (this.pending.size > 0 && !timedOut) {
        await Promise.race([Promise.all(this.pending), deadline]);
        // Let the bookkeeping `then` above remove what just settled.
        await Promise.resolve();
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.pending.size === 0;
  }
}
