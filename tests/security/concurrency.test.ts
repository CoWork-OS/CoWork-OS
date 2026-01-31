/**
 * Tests for Concurrency Safety Module
 *
 * Tests the mutex and idempotency mechanisms that prevent
 * race conditions in critical operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AsyncMutex,
  NamedMutexManager,
  IdempotencyManager,
} from '../../src/electron/security/concurrency';

describe('AsyncMutex', () => {
  describe('Basic locking', () => {
    it('should acquire and release lock', async () => {
      const mutex = new AsyncMutex();

      expect(mutex.isLocked()).toBe(false);

      const release = await mutex.acquire();
      expect(mutex.isLocked()).toBe(true);

      release();
      expect(mutex.isLocked()).toBe(false);
    });

    it('should execute function with lock held', async () => {
      const mutex = new AsyncMutex();
      let executed = false;

      await mutex.withLock(async () => {
        executed = true;
        expect(mutex.isLocked()).toBe(true);
      });

      expect(executed).toBe(true);
      expect(mutex.isLocked()).toBe(false);
    });

    it('should release lock even if function throws', async () => {
      const mutex = new AsyncMutex();

      await expect(mutex.withLock(async () => {
        throw new Error('Test error');
      })).rejects.toThrow('Test error');

      expect(mutex.isLocked()).toBe(false);
    });
  });

  describe('Concurrent access', () => {
    it('should queue concurrent lock requests', async () => {
      const mutex = new AsyncMutex();
      const order: number[] = [];

      const p1 = mutex.withLock(async () => {
        await new Promise(r => setTimeout(r, 50));
        order.push(1);
      });

      const p2 = mutex.withLock(async () => {
        order.push(2);
      });

      const p3 = mutex.withLock(async () => {
        order.push(3);
      });

      await Promise.all([p1, p2, p3]);

      // Should execute in order despite concurrent calls
      expect(order).toEqual([1, 2, 3]);
    });

    it('should prevent concurrent execution', async () => {
      const mutex = new AsyncMutex();
      let concurrentCount = 0;
      let maxConcurrent = 0;

      const tasks = Array.from({ length: 5 }, (_, i) =>
        mutex.withLock(async () => {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          await new Promise(r => setTimeout(r, 10));
          concurrentCount--;
        })
      );

      await Promise.all(tasks);

      // Should never have more than 1 concurrent execution
      expect(maxConcurrent).toBe(1);
    });
  });
});

describe('NamedMutexManager', () => {
  describe('Named locks', () => {
    it('should create separate mutexes for different keys', async () => {
      const manager = new NamedMutexManager();

      const mutex1 = manager.getMutex('key1');
      const mutex2 = manager.getMutex('key2');

      expect(mutex1).not.toBe(mutex2);
    });

    it('should return same mutex for same key', () => {
      const manager = new NamedMutexManager();

      const mutex1 = manager.getMutex('key1');
      const mutex2 = manager.getMutex('key1');

      expect(mutex1).toBe(mutex2);
    });

    it('should allow concurrent access to different keys', async () => {
      const manager = new NamedMutexManager();
      const results: string[] = [];

      const p1 = manager.withLock('key1', async () => {
        await new Promise(r => setTimeout(r, 50));
        results.push('key1-done');
      });

      const p2 = manager.withLock('key2', async () => {
        results.push('key2-done');
      });

      await Promise.all([p1, p2]);

      // key2 should finish before key1 because they're independent
      expect(results[0]).toBe('key2-done');
    });

    it('should serialize access to same key', async () => {
      const manager = new NamedMutexManager();
      const results: string[] = [];

      const p1 = manager.withLock('key1', async () => {
        await new Promise(r => setTimeout(r, 50));
        results.push('first');
      });

      const p2 = manager.withLock('key1', async () => {
        results.push('second');
      });

      await Promise.all([p1, p2]);

      expect(results).toEqual(['first', 'second']);
    });
  });

  describe('Cleanup', () => {
    it('should clean up unused mutexes', async () => {
      const manager = new NamedMutexManager();

      manager.getMutex('key1');
      manager.getMutex('key2');

      manager.cleanup();

      // After cleanup, getting the same key should return a new mutex
      // (since the old one was cleaned up)
      const newMutex = manager.getMutex('key1');
      expect(newMutex.isLocked()).toBe(false);
    });

    it('should not clean up locked mutexes', async () => {
      const manager = new NamedMutexManager();

      const mutex = manager.getMutex('key1');
      const release = await mutex.acquire();

      manager.cleanup();

      // The locked mutex should still be there
      expect(mutex.isLocked()).toBe(true);

      release();
    });
  });
});

describe('IdempotencyManager', () => {
  let manager: IdempotencyManager;

  beforeEach(() => {
    manager = new IdempotencyManager(1000); // 1 second TTL for tests
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('Key generation', () => {
    it('should generate consistent keys', () => {
      const key1 = IdempotencyManager.generateKey('op', 'arg1', 'arg2');
      const key2 = IdempotencyManager.generateKey('op', 'arg1', 'arg2');
      expect(key1).toBe(key2);
    });

    it('should generate different keys for different args', () => {
      const key1 = IdempotencyManager.generateKey('op', 'arg1');
      const key2 = IdempotencyManager.generateKey('op', 'arg2');
      expect(key1).not.toBe(key2);
    });

    it('should handle undefined args', () => {
      const key1 = IdempotencyManager.generateKey('op', 'arg1', undefined);
      const key2 = IdempotencyManager.generateKey('op', 'arg1');
      // undefined args should be filtered out
      expect(key1).toBe(key2);
    });
  });

  describe('Basic operations', () => {
    it('should track new operations', () => {
      const key = 'test-op-1';

      const before = manager.check(key);
      expect(before.exists).toBe(false);

      manager.start(key);

      const after = manager.check(key);
      expect(after.exists).toBe(true);
      expect(after.status).toBe('pending');
    });

    it('should complete operations', () => {
      const key = 'test-op-2';

      manager.start(key);
      manager.complete(key, { result: 'success' });

      const check = manager.check(key);
      expect(check.exists).toBe(true);
      expect(check.status).toBe('completed');
      expect(check.result).toEqual({ result: 'success' });
    });

    it('should mark operations as failed', () => {
      const key = 'test-op-3';

      manager.start(key);
      manager.fail(key, new Error('Test error'));

      const check = manager.check(key);
      expect(check.exists).toBe(true);
      expect(check.status).toBe('failed');
    });

    it('should remove operations', () => {
      const key = 'test-op-4';

      manager.start(key);
      manager.remove(key);

      const check = manager.check(key);
      expect(check.exists).toBe(false);
    });
  });

  describe('Idempotent execution', () => {
    it('should execute operation only once', async () => {
      const key = 'exec-op-1';
      let callCount = 0;

      const operation = async () => {
        callCount++;
        return 'result';
      };

      const result1 = await manager.execute(key, operation);
      const result2 = await manager.execute(key, operation);

      expect(callCount).toBe(1);
      expect(result1.result).toBe('result');
      expect(result1.cached).toBe(false);
      expect(result2.result).toBe('result');
      expect(result2.cached).toBe(true);
    });

    it('should return cached result for completed operations', async () => {
      const key = 'exec-op-2';

      const result1 = await manager.execute(key, async () => 'first');
      const result2 = await manager.execute(key, async () => 'second');

      expect(result1.result).toBe('first');
      expect(result2.result).toBe('first'); // Should return cached
    });

    it('should propagate errors', async () => {
      const key = 'exec-op-3';

      await expect(manager.execute(key, async () => {
        throw new Error('Test error');
      })).rejects.toThrow('Test error');
    });

    it('should allow retry after failure is removed', async () => {
      const key = 'exec-op-4';
      let attempt = 0;

      // First attempt fails
      await expect(manager.execute(key, async () => {
        attempt++;
        if (attempt === 1) throw new Error('First attempt fails');
        return 'success';
      })).rejects.toThrow();

      // Remove the failed entry
      manager.remove(key);

      // Retry should succeed
      const result = await manager.execute(key, async () => {
        attempt++;
        return 'success';
      });

      expect(result.result).toBe('success');
      expect(attempt).toBe(2);
    });
  });

  describe('Duplicate prevention', () => {
    it('should prevent starting duplicate operations', () => {
      const key = 'dup-op-1';

      const first = manager.start(key);
      const second = manager.start(key);

      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it('should not prevent duplicate after completion', async () => {
      // After TTL expires, same key should be allowed
      const manager2 = new IdempotencyManager(10); // Very short TTL
      const key = 'dup-op-2';

      manager2.start(key);
      manager2.complete(key, 'result');

      // Wait for expiry
      await new Promise(r => setTimeout(r, 50));

      const canStart = manager2.start(key);
      expect(canStart).toBe(true);

      manager2.destroy();
    });
  });

  describe('Expiration', () => {
    it('should expire entries after TTL', async () => {
      const shortTTLManager = new IdempotencyManager(50); // 50ms TTL
      const key = 'expire-op-1';

      shortTTLManager.start(key);

      // Should exist immediately
      expect(shortTTLManager.check(key).exists).toBe(true);

      // Wait for expiry
      await new Promise(r => setTimeout(r, 100));

      // Should be expired
      expect(shortTTLManager.check(key).exists).toBe(false);

      shortTTLManager.destroy();
    });
  });

  describe('Statistics', () => {
    it('should report correct stats', () => {
      manager.start('pending-1');
      manager.start('pending-2');

      manager.start('completed-1');
      manager.complete('completed-1', 'result');

      manager.start('failed-1');
      manager.fail('failed-1', 'error');

      const stats = manager.getStats();
      expect(stats.total).toBe(4);
      expect(stats.pending).toBe(2);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
    });
  });

  describe('Concurrent execution handling', () => {
    it('should handle concurrent calls to execute', async () => {
      const key = 'concurrent-exec';
      let callCount = 0;

      const operation = async () => {
        callCount++;
        await new Promise(r => setTimeout(r, 50));
        return `result-${callCount}`;
      };

      // Start multiple concurrent executions
      const promises = [
        manager.execute(key, operation),
        manager.execute(key, operation),
        manager.execute(key, operation),
      ];

      const results = await Promise.all(promises);

      // Should only execute once
      expect(callCount).toBe(1);

      // All should have the same result
      const firstResult = results[0].result;
      results.forEach(r => {
        expect(r.result).toBe(firstResult);
      });
    });
  });
});

describe('Integration: Pairing Code Verification', () => {
  it('should prevent duplicate pairing verification', async () => {
    const manager = new IdempotencyManager(5000);

    const verifyPairing = async (channelId: string, userId: string, code: string) => {
      const key = IdempotencyManager.generateKey('pairing:verify', channelId, userId, code);

      const { result, cached } = await manager.execute(key, async () => {
        // Simulate verification
        await new Promise(r => setTimeout(r, 50));
        return { success: true };
      });

      return { ...result, fromCache: cached };
    };

    // Simulate user clicking "verify" button multiple times
    const results = await Promise.all([
      verifyPairing('channel-1', 'user-1', 'ABC123'),
      verifyPairing('channel-1', 'user-1', 'ABC123'),
      verifyPairing('channel-1', 'user-1', 'ABC123'),
    ]);

    // Only one should be from actual execution
    const fromExecution = results.filter(r => !r.fromCache);
    expect(fromExecution.length).toBe(1);

    manager.destroy();
  });
});

describe('Integration: Approval Response', () => {
  it('should prevent double approval', async () => {
    const manager = new IdempotencyManager(5000);
    let approvalCount = 0;

    const respondToApproval = async (approvalId: string, approved: boolean) => {
      const key = IdempotencyManager.generateKey(
        'approval:respond',
        approvalId,
        approved ? 'approve' : 'deny'
      );

      const existing = manager.check(key);
      if (existing.exists) {
        return { success: false, reason: 'Already processed' };
      }

      if (!manager.start(key)) {
        return { success: false, reason: 'Processing in progress' };
      }

      try {
        approvalCount++;
        await new Promise(r => setTimeout(r, 50));
        manager.complete(key, { success: true });
        return { success: true };
      } catch (error) {
        manager.fail(key, error);
        throw error;
      }
    };

    // Simulate rapid clicking on approve button
    const results = await Promise.all([
      respondToApproval('approval-1', true),
      respondToApproval('approval-1', true),
      respondToApproval('approval-1', true),
    ]);

    // Only one should succeed
    const successful = results.filter(r => r.success);
    expect(successful.length).toBe(1);
    expect(approvalCount).toBe(1);

    manager.destroy();
  });
});
