import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUEUE_SETTINGS, type Task } from "../../../shared/types";

const secureSettingsMock = vi.hoisted(() => ({
  initialized: true,
  writeResult: true,
  persisted: null as Record<string, unknown> | null,
  save: vi.fn((_category: string, _settings: Record<string, unknown>) => true),
  load: vi.fn(() => null),
  exists: vi.fn(() => true),
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => secureSettingsMock.initialized,
    getInstance: () => secureSettingsMock,
  },
}));

vi.mock("../../utils/user-data-dir", () => ({
  getUserDataDir: () => "/tmp/cowork-queue-manager-settings-test",
}));

import { TaskQueueManager } from "../queue-manager";

function task(id: string, status: string, createdAt: number): Task {
  return { id, status, createdAt } as unknown as Task;
}

describe("TaskQueueManager settings persistence", () => {
  let manager: TaskQueueManager;
  const queuedTask = task("queued-task", "queued", 20);
  const callbacks = {
    startTaskImmediate: vi.fn(async () => {}),
    emitQueueUpdate: vi.fn(),
    getTaskById: vi.fn((id: string) => (id === queuedTask.id ? queuedTask : undefined)),
    updateTaskStatus: vi.fn(),
    onTaskTimeout: vi.fn(async () => {}),
  };

  beforeEach(() => {
    secureSettingsMock.initialized = true;
    secureSettingsMock.writeResult = true;
    secureSettingsMock.persisted = null;
    secureSettingsMock.save.mockReset().mockImplementation((_category, settings) => {
      if (!secureSettingsMock.writeResult) return false;
      secureSettingsMock.persisted = { ...settings };
      return true;
    });
    secureSettingsMock.load.mockReset().mockReturnValue(null);
    secureSettingsMock.exists.mockReset().mockReturnValue(true);
    callbacks.startTaskImmediate.mockReset().mockResolvedValue(undefined);
    callbacks.emitQueueUpdate.mockReset();
    callbacks.getTaskById.mockClear();
    callbacks.updateTaskStatus.mockReset();
    callbacks.onTaskTimeout.mockReset().mockResolvedValue(undefined);
    manager = new TaskQueueManager(callbacks);
  });

  afterEach(() => {
    manager.destroy();
  });

  async function initializeAtCapacity() {
    await manager.initialize(
      [queuedTask],
      Array.from({ length: DEFAULT_QUEUE_SETTINGS.maxConcurrentTasks }, (_, index) =>
        task(`running-${index}`, "running", index),
      ),
    );
    callbacks.emitQueueUpdate.mockClear();
  }

  it("persists first, then applies and processes the newly available runtime slot", async () => {
    await initializeAtCapacity();

    manager.saveSettings({ maxConcurrentTasks: DEFAULT_QUEUE_SETTINGS.maxConcurrentTasks + 1 });
    await vi.waitFor(() => expect(callbacks.startTaskImmediate).toHaveBeenCalledWith(queuedTask));

    expect(secureSettingsMock.save).toHaveBeenCalledWith("queue", {
      maxConcurrentTasks: DEFAULT_QUEUE_SETTINGS.maxConcurrentTasks + 1,
      taskTimeoutMinutes: DEFAULT_QUEUE_SETTINGS.taskTimeoutMinutes,
    });
    expect(manager.getSettings().maxConcurrentTasks).toBe(
      DEFAULT_QUEUE_SETTINGS.maxConcurrentTasks + 1,
    );
    expect(secureSettingsMock.persisted).toEqual(manager.getSettings());
  });

  it("does not publish settings or start queued work when secure storage refuses the write", async () => {
    await initializeAtCapacity();
    secureSettingsMock.writeResult = false;

    expect(() => manager.saveSettings({ maxConcurrentTasks: 9 })).toThrow(
      "secure storage refused the write",
    );
    expect(manager.getSettings()).toEqual(DEFAULT_QUEUE_SETTINGS);
    expect(callbacks.startTaskImmediate).not.toHaveBeenCalled();
    expect(callbacks.emitQueueUpdate).not.toHaveBeenCalled();
    expect(secureSettingsMock.persisted).toBeNull();
  });

  it("does not publish settings or process work when secure storage throws", async () => {
    await initializeAtCapacity();
    secureSettingsMock.save.mockImplementation(() => {
      throw new Error("write failed");
    });

    expect(() => manager.saveSettings({ maxConcurrentTasks: 9 })).toThrow("write failed");
    expect(manager.getSettings()).toEqual(DEFAULT_QUEUE_SETTINGS);
    expect(callbacks.startTaskImmediate).not.toHaveBeenCalled();
    expect(callbacks.emitQueueUpdate).not.toHaveBeenCalled();
  });

  it("fails closed before persistence or runtime mutation when secure settings are unavailable", async () => {
    await initializeAtCapacity();
    secureSettingsMock.initialized = false;

    expect(() => manager.saveSettings({ maxConcurrentTasks: 9 })).toThrow(
      "cannot be saved before secure settings are initialized",
    );
    expect(secureSettingsMock.save).not.toHaveBeenCalled();
    expect(manager.getSettings()).toEqual(DEFAULT_QUEUE_SETTINGS);
    expect(callbacks.startTaskImmediate).not.toHaveBeenCalled();
    expect(callbacks.emitQueueUpdate).not.toHaveBeenCalled();
  });

  it("keeps the native clamp while leaving the caller's partial settings untouched", () => {
    const requested = { maxConcurrentTasks: 21 };

    manager.saveSettings(requested);

    expect(requested).toEqual({ maxConcurrentTasks: 21 });
    expect(manager.getSettings().maxConcurrentTasks).toBe(20);
    expect(secureSettingsMock.persisted?.maxConcurrentTasks).toBe(20);
  });
});
