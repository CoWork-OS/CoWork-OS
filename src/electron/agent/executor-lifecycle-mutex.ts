type ReleaseFn = () => void;

/**
 * Simple async mutex used to serialize TaskExecutor lifecycle entrypoints
 * (`execute`, `sendMessage`, `resume`) and avoid re-entrant state corruption.
 */
export class LifecycleMutex {
  private tail: Promise<void> = Promise.resolve();
  private _locked = false;

  /** Whether an exclusive operation is currently running. */
  get isLocked(): boolean {
    return this._locked;
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: ReleaseFn;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = this.tail.then(() => next);

    await previous;
    this._locked = true;
    try {
      return await operation();
    } finally {
      this._locked = false;
      release();
    }
  }
}
