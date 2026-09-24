import { afterEach, describe, expect, it, vi } from "vitest";
import { MailboxService, setMailboxServiceInstance } from "../MailboxService";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cowork-mailbox-lifecycle" } }));

function createBackgroundService() {
  // Exercise the timer lifecycle without a real mailbox, database, or network.
  const service = Object.create(MailboxService.prototype) as Any;
  Object.assign(service, {
    stopped: false,
    backgroundRuns: new Set(),
    autoSyncTimer: null,
    autoSyncInitialTimer: null,
    outboxTimer: null,
    runAutoSyncIfDue: vi.fn().mockResolvedValue(undefined),
    processMailboxQueue: vi.fn().mockResolvedValue(undefined),
  });
  return service;
}

afterEach(async () => {
  await MailboxService.stopBackgroundServices();
  setMailboxServiceInstance(null);
  vi.useRealTimers();
});

describe("MailboxService shutdown", () => {
  it("stops loop owners even when a task-local service replaced the active accessor", async () => {
    vi.useFakeTimers();
    const owner = createBackgroundService();
    owner.startAutoSyncLoop();
    owner.startOutboxLoop();
    setMailboxServiceInstance(createBackgroundService());
    await MailboxService.stopBackgroundServices();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(owner.processMailboxQueue).not.toHaveBeenCalled();
    expect(owner.runAutoSyncIfDue).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels both loops and queued initial work before database release", async () => {
    vi.useFakeTimers();
    const service = createBackgroundService();
    service.startAutoSyncLoop();
    service.startOutboxLoop();
    await service.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(service.runAutoSyncIfDue).not.toHaveBeenCalled();
    expect(service.processMailboxQueue).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for an active queue drain and does not restart it", async () => {
    vi.useFakeTimers();
    const service = createBackgroundService();
    let finish!: () => void;
    service.processMailboxQueue.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    service.startOutboxLoop();
    await Promise.resolve();
    let stopped = false;
    const stop = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stop;
    service.startOutboxLoop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(service.processMailboxQueue).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(true);
  });

  it("handles a background rejection and still drains on shutdown", async () => {
    const service = createBackgroundService();
    service.processMailboxQueue.mockRejectedValue(new Error("Queue unavailable"));
    service.startOutboxLoop();
    await Promise.resolve();
    await expect(service.stop()).resolves.toBeUndefined();
    expect(service.backgroundRuns.size).toBe(0);
  });
});
