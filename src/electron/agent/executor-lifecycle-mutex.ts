type ReleaseFn = () => void;

/**
 * Simple async mutex used to serialize TaskExecutor lifecycle entrypoints
 * (`execute`, `sendMessage`, `resume`) and avoid re-entrant state corruption.
 */
export class LifecycleMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: ReleaseFn;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = this.tail.then(() => next);

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
