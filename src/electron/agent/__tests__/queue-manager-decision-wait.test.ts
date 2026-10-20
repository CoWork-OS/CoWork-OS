import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secureSettingsMock = vi.hoisted(() => ({
  save: vi.fn(() => true),
  load: vi.fn(() => null),
  exists: vi.fn(() => true),
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => secureSettingsMock,
  },
}));

vi.mock("../../utils/user-data-dir", () => ({
  getUserDataDir: () => "/tmp/cowork-queue-manager-decision-wait-test",
}));

import { TaskQueueManager } from "../queue-manager";

describe("TaskQueueManager watchdog and pending decisions", () => {
  let manager: TaskQueueManager;
  let waiting: boolean;
  const onTaskTimeout = vi.fn(async () => {});

  beforeEach(() => {
    vi.useFakeTimers();
    waiting = false;
    onTaskTimeout.mockClear();
    manager = new TaskQueueManager({
      startTaskImmediate: vi.fn(async () => {}),
      emitQueueUpdate: vi.fn(),
      getTaskById: vi.fn(() => undefined),
      updateTaskStatus: vi.fn(),
      onTaskTimeout,
      isWaitingForUser: () => waiting,
    });
    manager.saveSettings({ taskTimeoutMinutes: 5 });
    manager.registerResumedTask("task-1");
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  it("still times out a task that is not waiting for anyone", async () => {
    await vi.advanceTimersByTimeAsync(7 * 60 * 1000);
    expect(onTaskTimeout).toHaveBeenCalledWith("task-1");
  });

  it("does not count time spent waiting for a person's decision", async () => {
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    waiting = true;
    // The person answers 3 hours later: far past the 5-minute watchdog.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(onTaskTimeout).not.toHaveBeenCalled();

    waiting = false;
    // Only the remaining working time counts again (about 3 minutes, checked once a minute).
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(onTaskTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(onTaskTimeout).toHaveBeenCalledWith("task-1");
  });
});
