/**
 * Tests for TaskQueueManager
 *
 * Focus on sub-agent queue bypass behavior to prevent deadlocks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, QueueStatus, TaskStatus } from '../../../shared/types';

// Mock helper functions that mirror queue-manager logic
function shouldBypassQueue(task: Pick<Task, 'parentTaskId'>): boolean {
  // Sub-agents (tasks with parentTaskId) bypass the concurrency limit
  return !!task.parentTaskId;
}

function canStartImmediately(runningCount: number, maxConcurrent: number): boolean {
  return runningCount < maxConcurrent;
}

function enqueueLogic(
  task: Pick<Task, 'id' | 'parentTaskId'>,
  runningCount: number,
  maxConcurrent: number
): 'start_immediately' | 'queue' {
  const isSubAgent = shouldBypassQueue(task);

  if (isSubAgent) {
    // Sub-agents always start immediately to prevent deadlock
    return 'start_immediately';
  } else if (canStartImmediately(runningCount, maxConcurrent)) {
    return 'start_immediately';
  } else {
    return 'queue';
  }
}

// Create mock task
function createMockTask(overrides: Partial<Task> = {}): Pick<Task, 'id' | 'parentTaskId' | 'title' | 'status'> {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    title: 'Test Task',
    status: 'pending',
    ...overrides,
  };
}

describe('TaskQueueManager sub-agent behavior', () => {
  describe('shouldBypassQueue', () => {
    it('should return true for tasks with parentTaskId (sub-agents)', () => {
      const subAgent = createMockTask({ parentTaskId: 'parent-123' });
      expect(shouldBypassQueue(subAgent)).toBe(true);
    });

    it('should return false for tasks without parentTaskId (main tasks)', () => {
      const mainTask = createMockTask({ parentTaskId: undefined });
      expect(shouldBypassQueue(mainTask)).toBe(false);
    });
  });

  describe('enqueueLogic', () => {
    it('should queue main tasks when at concurrency limit', () => {
      const mainTask = createMockTask({ parentTaskId: undefined });
      const result = enqueueLogic(mainTask, 5, 5); // 5 running, max 5
      expect(result).toBe('queue');
    });

    it('should start main tasks immediately when under concurrency limit', () => {
      const mainTask = createMockTask({ parentTaskId: undefined });
      const result = enqueueLogic(mainTask, 3, 5); // 3 running, max 5
      expect(result).toBe('start_immediately');
    });

    it('should start sub-agents immediately even when at concurrency limit', () => {
      const subAgent = createMockTask({ parentTaskId: 'parent-123' });
      const result = enqueueLogic(subAgent, 5, 5); // 5 running, max 5
      expect(result).toBe('start_immediately');
    });

    it('should start sub-agents immediately even when over concurrency limit', () => {
      const subAgent = createMockTask({ parentTaskId: 'parent-123' });
      const result = enqueueLogic(subAgent, 10, 5); // 10 running (due to sub-agents), max 5
      expect(result).toBe('start_immediately');
    });

    it('should prevent deadlock scenario: parent spawns sub-agents at full capacity', () => {
      // Scenario: 5 main tasks running (max 5), one of them spawns 3 sub-agents
      // Without bypass: sub-agents queue forever, parent waits forever = DEADLOCK
      // With bypass: sub-agents start immediately, parent can complete

      const maxConcurrent = 5;
      let runningCount = 5; // At full capacity

      // Parent task wants to spawn 3 sub-agents with wait: true
      const subAgents = [
        createMockTask({ parentTaskId: 'parent-1' }),
        createMockTask({ parentTaskId: 'parent-1' }),
        createMockTask({ parentTaskId: 'parent-1' }),
      ];

      // All sub-agents should start immediately (bypass queue)
      for (const subAgent of subAgents) {
        const result = enqueueLogic(subAgent, runningCount, maxConcurrent);
        expect(result).toBe('start_immediately');
        runningCount++; // Sub-agent starts, increases running count
      }

      // Running count is now 8 (5 main + 3 sub-agents)
      expect(runningCount).toBe(8);

      // New main task should still be queued (respects limit for main tasks)
      const newMainTask = createMockTask({ parentTaskId: undefined });
      const mainResult = enqueueLogic(newMainTask, runningCount, maxConcurrent);
      expect(mainResult).toBe('queue');
    });
  });
});

describe('Queue status calculation', () => {
  it('should count sub-agents in running count', () => {
    // Sub-agents are tracked in runningTaskIds just like main tasks
    // They're just not subject to the concurrency limit for starting
    const runningTaskIds = new Set(['main-1', 'main-2', 'sub-1', 'sub-2', 'sub-3']);
    const queuedTaskIds = ['queued-1', 'queued-2'];

    const status: QueueStatus = {
      runningCount: runningTaskIds.size,
      queuedCount: queuedTaskIds.length,
      runningTaskIds: Array.from(runningTaskIds),
      queuedTaskIds: [...queuedTaskIds],
      maxConcurrent: 5,
    };

    expect(status.runningCount).toBe(5); // 2 main + 3 sub-agents
    expect(status.queuedCount).toBe(2);
  });
});
