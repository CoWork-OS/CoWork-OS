/**
 * Tests for AgentDaemon transient task failure retry handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
  BrowserWindow: vi.fn(),
}));

// Mock task repository
const mockTaskRepo = {
  update: vi.fn(),
  findById: vi.fn(),
};

// Mock queue manager
const mockQueueManager = {
  onTaskFinished: vi.fn(),
};

// Mock log event
const mockLogEvent = vi.fn();

// Create a minimal mock daemon for testing retry logic
function createMockDaemon() {
  const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const retryCounts = new Map<string, number>();
  const activeTasks = new Map<string, Any>();
  const maxTaskRetries = 2;
  const retryDelayMs = 30 * 1000;

  return {
    pendingRetries,
    retryCounts,
    activeTasks,
    maxTaskRetries,
    retryDelayMs,
    taskRepo: mockTaskRepo,
    queueManager: mockQueueManager,
    logEvent: mockLogEvent,

    handleTransientTaskFailure(
      taskId: string,
      reason: string,
      delayMs: number = retryDelayMs,
    ): boolean {
      const currentCount = retryCounts.get(taskId) ?? 0;
      const nextCount = currentCount + 1;
      if (nextCount > maxTaskRetries) {
        return false;
      }

      retryCounts.set(taskId, nextCount);

      if (pendingRetries.has(taskId)) {
        return true;
      }

      // Mark as queued with a helpful message
      mockTaskRepo.update(taskId, {
        status: "queued",
        error: `Transient provider error. Retry ${nextCount}/${maxTaskRetries} in ${Math.ceil(delayMs / 1000)}s.`,
      });

      mockLogEvent(taskId, "log", {
        message: `Transient provider error detected. Scheduling retry ${nextCount}/${maxTaskRetries} in ${Math.ceil(delayMs / 1000)}s.`,
        reason,
      });

      // Clear executor and free queue slot
      activeTasks.delete(taskId);
      mockQueueManager.onTaskFinished(taskId);

      const handle = setTimeout(async () => {
        pendingRetries.delete(taskId);
        // Normally would call startTask here
      }, delayMs);

      pendingRetries.set(taskId, handle);
      return true;
    },
  };
}

describe("AgentDaemon transient retry handling", () => {
  let daemon: ReturnType<typeof createMockDaemon>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    daemon = createMockDaemon();
  });

  afterEach(() => {
    // Clean up any pending timers
    daemon.pendingRetries.forEach((handle) => clearTimeout(handle));
    daemon.pendingRetries.clear();
    vi.useRealTimers();
  });

  describe("handleTransientTaskFailure", () => {
    it("should schedule retry for first transient failure", () => {
      const taskId = "task-123";
      daemon.activeTasks.set(taskId, { executor: {} });

      const result = daemon.handleTransientTaskFailure(taskId, "ECONNRESET");

      expect(result).toBe(true);
      expect(daemon.retryCounts.get(taskId)).toBe(1);
      expect(daemon.pendingRetries.has(taskId)).toBe(true);
      expect(mockTaskRepo.update).toHaveBeenCalledWith(taskId, {
        status: "queued",
        error: "Transient provider error. Retry 1/2 in 30s.",
      });
      expect(mockQueueManager.onTaskFinished).toHaveBeenCalledWith(taskId);
    });

    it("should schedule retry for second transient failure", () => {
      const taskId = "task-456";
      daemon.retryCounts.set(taskId, 1);

      const result = daemon.handleTransientTaskFailure(taskId, "ETIMEDOUT");

      expect(result).toBe(true);
      expect(daemon.retryCounts.get(taskId)).toBe(2);
      expect(mockTaskRepo.update).toHaveBeenCalledWith(taskId, {
        status: "queued",
        error: "Transient provider error. Retry 2/2 in 30s.",
      });
    });

    it("should return false when max retries exceeded", () => {
      const taskId = "task-789";
      daemon.retryCounts.set(taskId, 2); // Already at max

      const result = daemon.handleTransientTaskFailure(taskId, "ENOTFOUND");

      expect(result).toBe(false);
      expect(daemon.retryCounts.get(taskId)).toBe(2); // Not incremented
      expect(mockTaskRepo.update).not.toHaveBeenCalled();
    });

    it("should not create duplicate retry timers", () => {
      const taskId = "task-dup";

      // First call
      const result1 = daemon.handleTransientTaskFailure(taskId, "ECONNRESET");
      expect(result1).toBe(true);

      const firstTimer = daemon.pendingRetries.get(taskId);

      // Second call while retry is still pending
      const result2 = daemon.handleTransientTaskFailure(taskId, "ETIMEDOUT");
      expect(result2).toBe(true);

      // Should be same timer (not replaced)
      expect(daemon.pendingRetries.get(taskId)).toBe(firstTimer);
      // Retry count should be incremented though
      expect(daemon.retryCounts.get(taskId)).toBe(2);
    });

    it("should use custom delay when provided", () => {
      const taskId = "task-custom-delay";
      const customDelay = 60000; // 60 seconds

      daemon.handleTransientTaskFailure(taskId, "timeout", customDelay);

      expect(mockTaskRepo.update).toHaveBeenCalledWith(taskId, {
        status: "queued",
        error: "Transient provider error. Retry 1/2 in 60s.",
      });
    });

    it("should remove task from activeTasks", () => {
      const taskId = "task-active";
      daemon.activeTasks.set(taskId, { executor: {} });

      daemon.handleTransientTaskFailure(taskId, "network error");

      expect(daemon.activeTasks.has(taskId)).toBe(false);
    });

    it("should log the transient failure reason", () => {
      const taskId = "task-log";
      const reason = "fetch failed: socket hang up";

      daemon.handleTransientTaskFailure(taskId, reason);

      expect(mockLogEvent).toHaveBeenCalledWith(taskId, "log", {
        message: "Transient provider error detected. Scheduling retry 1/2 in 30s.",
        reason,
      });
    });

    it("should clear pending retry after delay expires", () => {
      const taskId = "task-clear";

      daemon.handleTransientTaskFailure(taskId, "timeout");
      expect(daemon.pendingRetries.has(taskId)).toBe(true);

      // Advance timers
      vi.advanceTimersByTime(30000);

      expect(daemon.pendingRetries.has(taskId)).toBe(false);
    });
  });
});
