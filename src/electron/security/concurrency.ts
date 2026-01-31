/**
 * Concurrency Safety Module
 *
 * Provides mutex locks and idempotency guarantees for critical operations.
 */

/**
 * Simple async mutex for protecting critical sections
 * Prevents race conditions in pairing, approval, and state changes
 */
export class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  /**
   * Acquire the lock. Returns a release function.
   */
  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  /**
   * Release the lock
   */
  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  /**
   * Execute a function with the lock held
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Check if the lock is currently held
   */
  isLocked(): boolean {
    return this.locked;
  }
}

/**
 * Named mutex manager for managing multiple locks by key
 */
export class NamedMutexManager {
  private mutexes: Map<string, AsyncMutex> = new Map();

  /**
   * Get or create a mutex for a given key
   */
  getMutex(key: string): AsyncMutex {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.mutexes.set(key, mutex);
    }
    return mutex;
  }

  /**
   * Execute a function with the named lock held
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.getMutex(key).withLock(fn);
  }

  /**
   * Clean up unused mutexes
   */
  cleanup(): void {
    for (const [key, mutex] of this.mutexes.entries()) {
      if (!mutex.isLocked()) {
        this.mutexes.delete(key);
      }
    }
  }
}

/**
 * Idempotency key entry
 */
interface IdempotencyEntry {
  key: string;
  result: any;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'completed' | 'failed';
}

/**
 * Idempotency Manager
 *
 * Ensures operations are idempotent by tracking operation keys and their results.
 * Implements C6-style approval safety: prevents duplicate approvals/denials.
 */
export class IdempotencyManager {
  private entries: Map<string, IdempotencyEntry> = new Map();
  private defaultTTLMs: number;
  private cleanupIntervalId?: ReturnType<typeof setInterval>;

  constructor(defaultTTLMs = 5 * 60 * 1000) { // 5 minutes default
    this.defaultTTLMs = defaultTTLMs;

    // Periodic cleanup of expired entries
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupExpired();
    }, 60 * 1000); // Every minute
  }

  /**
   * Generate an idempotency key for an operation
   */
  static generateKey(operation: string, ...args: (string | number | undefined)[]): string {
    const parts = [operation, ...args.filter(a => a !== undefined)];
    return parts.join(':');
  }

  /**
   * Check if an operation with this key is already in progress or completed
   */
  check(key: string): { exists: boolean; status?: 'pending' | 'completed' | 'failed'; result?: any } {
    const entry = this.entries.get(key);

    if (!entry) {
      return { exists: false };
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return { exists: false };
    }

    return {
      exists: true,
      status: entry.status,
      result: entry.result,
    };
  }

  /**
   * Start tracking an operation (mark as pending)
   * Returns false if operation is already in progress
   */
  start(key: string, ttlMs?: number): boolean {
    const existing = this.check(key);

    if (existing.exists) {
      // Already in progress or completed
      return false;
    }

    const now = Date.now();
    this.entries.set(key, {
      key,
      result: undefined,
      createdAt: now,
      expiresAt: now + (ttlMs || this.defaultTTLMs),
      status: 'pending',
    });

    return true;
  }

  /**
   * Mark an operation as completed with its result
   */
  complete(key: string, result: any): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.status = 'completed';
      entry.result = result;
    }
  }

  /**
   * Mark an operation as failed
   */
  fail(key: string, error?: any): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.status = 'failed';
      entry.result = error;
    }
  }

  /**
   * Remove an entry (for retry scenarios)
   */
  remove(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Execute an operation with idempotency guarantee
   * If operation was already completed, returns cached result
   * If operation is in progress, waits and returns result
   */
  async execute<T>(
    key: string,
    operation: () => Promise<T>,
    ttlMs?: number
  ): Promise<{ result: T; cached: boolean }> {
    const existing = this.check(key);

    if (existing.exists && existing.status === 'completed') {
      return { result: existing.result as T, cached: true };
    }

    if (existing.exists && existing.status === 'pending') {
      // Wait for completion
      const result = await this.waitForCompletion<T>(key);
      return { result, cached: true };
    }

    // Start new operation
    if (!this.start(key, ttlMs)) {
      // Race condition: another call started between check and start
      const result = await this.waitForCompletion<T>(key);
      return { result, cached: true };
    }

    try {
      const result = await operation();
      this.complete(key, result);
      return { result, cached: false };
    } catch (error) {
      this.fail(key, error);
      throw error;
    }
  }

  /**
   * Wait for a pending operation to complete
   */
  private async waitForCompletion<T>(key: string, timeoutMs = 30000): Promise<T> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const entry = this.entries.get(key);

      if (!entry || Date.now() > entry.expiresAt) {
        throw new Error(`Operation ${key} expired or not found`);
      }

      if (entry.status === 'completed') {
        return entry.result as T;
      }

      if (entry.status === 'failed') {
        throw entry.result || new Error(`Operation ${key} failed`);
      }

      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for operation ${key}`);
  }

  /**
   * Clean up expired entries
   */
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (now > entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Get statistics about the idempotency cache
   */
  getStats(): { total: number; pending: number; completed: number; failed: number } {
    let pending = 0;
    let completed = 0;
    let failed = 0;

    for (const entry of this.entries.values()) {
      switch (entry.status) {
        case 'pending': pending++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
      }
    }

    return {
      total: this.entries.size,
      pending,
      completed,
      failed,
    };
  }

  /**
   * Clean up and stop background tasks
   */
  destroy(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
    this.entries.clear();
  }
}

// Global instances for common use cases
export const pairingMutex = new NamedMutexManager();
export const approvalIdempotency = new IdempotencyManager(5 * 60 * 1000); // 5 min TTL
export const taskIdempotency = new IdempotencyManager(60 * 1000); // 1 min TTL for task creation
