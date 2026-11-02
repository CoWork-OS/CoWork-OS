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
  getUserDataDir: () => "/tmp/cowork-queue-manager-suspend-credit-test",
}));

import { TaskQueueManager } from "../queue-manager";

describe("TaskQueueManager suspended-time credit", () => {
  let manager: TaskQueueManager;
  const onTaskTimeout = vi.fn(async () => {});

  beforeEach(() => {
    vi.useFakeTimers();
    onTaskTimeout.mockClear();
    manager = new TaskQueueManager({
      startTaskImmediate: vi.fn(async () => {}),
      emitQueueUpdate: vi.fn(),
      getTaskById: vi.fn(() => undefined),
      updateTaskStatus: vi.fn(),
      onTaskTimeout,
    });
    manager.saveSettings({ taskTimeoutMinutes: 10 });
    manager.registerResumedTask("task-1");
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  it("does not count time the computer slept toward the session timeout", async () => {
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    // The laptop slept for an hour: the wall clock moved, no task ran.
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    manager.creditSuspendedTime(60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(onTaskTimeout).not.toHaveBeenCalled();

    // About two minutes of working time remain.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(onTaskTimeout).toHaveBeenCalledWith("task-1");
  });

  it("ignores nonsense credits", async () => {
    manager.creditSuspendedTime(-5);
    manager.creditSuspendedTime(Number.NaN);
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect(onTaskTimeout).toHaveBeenCalledWith("task-1");
  });
});
