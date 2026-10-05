import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { MemoryService } from "../MemoryService";

// LOOP-14: quiet mode starts no memory background jobs, and shutdown waits (bounded) for a
// running compression batch or markdown sync before the database closes.

interface MemoryServiceInternals {
  cleanupIntervalHandle?: ReturnType<typeof setInterval>;
  archiveCleanupTimer?: ReturnType<typeof setTimeout>;
  markdownIndex: { syncWorkspace: (...args: unknown[]) => Promise<void> } | null;
  processCompressionQueue(): Promise<void>;
  runCompressionQueue(): Promise<void>;
  isCompressionPaused(): boolean;
}

const internals = MemoryService as unknown as MemoryServiceInternals;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

describe("MemoryService background jobs and drain", () => {
  const cleanups: Array<() => void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(() => {
    MemoryService.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  const profile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-memory-drain-"));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    cleanups.push(() => {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return manager;
  };

  it("starts the cleanup interval and the archive migration only outside quiet mode", () => {
    const manager = profile();
    MemoryService.initialize(manager, { backgroundJobs: false });
    expect(internals.cleanupIntervalHandle).toBeUndefined();
    expect(internals.archiveCleanupTimer).toBeUndefined();
    MemoryService.shutdown();

    MemoryService.initialize(manager);
    expect(internals.cleanupIntervalHandle).toBeDefined();
    expect(internals.archiveCleanupTimer).toBeDefined();
  });

  it("waits for a running markdown sync and starts no new one while draining", async () => {
    MemoryService.initialize(profile(), { backgroundJobs: false });
    const running = deferred();
    const syncWorkspace = vi.fn(() => running.promise);
    internals.markdownIndex = { syncWorkspace };

    const sync = MemoryService.syncWorkspaceMarkdown("ws", "/tmp/ws");
    let drained: boolean | undefined;
    const draining = MemoryService.drain(5_000).then((value) => (drained = value));
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBeUndefined();

    await MemoryService.syncWorkspaceMarkdown("ws", "/tmp/ws");
    expect(syncWorkspace).toHaveBeenCalledTimes(1);

    running.resolve();
    await Promise.all([sync, draining]);
    expect(drained).toBe(true);
  });

  it("waits for a running compression batch and pauses the queue while draining", async () => {
    MemoryService.initialize(profile(), { backgroundJobs: false });
    const batch = deferred();
    vi.spyOn(internals, "runCompressionQueue").mockImplementation(() => batch.promise);

    void internals.processCompressionQueue();
    expect(internals.isCompressionPaused()).toBe(false);
    let drained: boolean | undefined;
    const draining = MemoryService.drain(5_000).then((value) => (drained = value));
    // A batch in progress stops at its next group while draining.
    expect(internals.isCompressionPaused()).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBeUndefined();

    batch.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it("gives up after its bound so shutdown is never held by stuck work", async () => {
    MemoryService.initialize(profile(), { backgroundJobs: false });
    internals.markdownIndex = { syncWorkspace: () => new Promise<void>(() => undefined) };
    void MemoryService.syncWorkspaceMarkdown("ws", "/tmp/ws");

    vi.useFakeTimers();
    const draining = MemoryService.drain(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(draining).resolves.toBe(false);
  });

  it("cancels the cleanup interval and the deferred archive migration", async () => {
    MemoryService.initialize(profile());
    await MemoryService.drain(1_000);
    expect(internals.cleanupIntervalHandle).toBeUndefined();
    expect(internals.archiveCleanupTimer).toBeUndefined();
  });
});
