import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

class MockWorker extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn();
}

let mockWorkerInstance: MockWorker;

vi.mock("worker_threads", () => ({
  Worker: class {
    constructor() {
      mockWorkerInstance = new MockWorker();
      return mockWorkerInstance;
    }
  },
}));

import { FtsWorkerClient } from "../FtsWorkerClient";

describe("FtsWorkerClient", () => {
  let client: FtsWorkerClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new FtsWorkerClient("/tmp/test.db");
  });

  afterEach(async () => {
    // Catch rejections from pending requests being cleaned up
    try {
      client.destroy();
    } catch {
      /* expected */
    }
    await vi.runAllTimersAsync().catch(() => {});
    vi.useRealTimers();
  });

  it("sends a search request and resolves with the result", async () => {
    const promise = client.search("ws-1", "hello", 10, false);

    const msg = mockWorkerInstance.postMessage.mock.calls[0][0];
    expect(msg.method).toBe("search");
    expect(msg.args).toEqual(["ws-1", "hello", 10, false]);

    mockWorkerInstance.emit("message", { id: msg.id, result: [{ id: "m1" }] });
    const result = await promise;
    expect(result).toEqual([{ id: "m1" }]);
  });

  it("rejects when worker responds with an error", async () => {
    const promise = client.searchByContentMarker("ws-1", "[TEST]", 5);

    const msg = mockWorkerInstance.postMessage.mock.calls[0][0];
    mockWorkerInstance.emit("message", { id: msg.id, error: "FTS table missing" });

    await expect(promise).rejects.toThrow("FTS table missing");
  });

  it("rejects pending requests on timeout", async () => {
    const promise = client.search("ws-1", "test", 10, false);

    vi.advanceTimersByTime(30_001);

    await expect(promise).rejects.toThrow("timed out");

    // Resolve worker to avoid unhandled rejection in afterEach destroy
    mockWorkerInstance.emit("message", { id: "stale", result: null });
  });

  it("rejects pending requests on worker crash", async () => {
    const promise = client.search("ws-1", "test", 10, false);

    mockWorkerInstance.emit("error", new Error("boom"));

    await expect(promise).rejects.toThrow("crashed");
  });

  it("handles paired worker error and exit as one crash", async () => {
    const promise = client.search("ws-1", "test", 10, false);

    mockWorkerInstance.emit("error", new Error("boom"));
    mockWorkerInstance.emit("exit", 1);

    await expect(promise).rejects.toThrow("crashed");
    vi.advanceTimersByTime(999);
    const workerBeforeRestart = mockWorkerInstance;
    vi.advanceTimersByTime(1);
    expect(mockWorkerInstance).not.toBe(workerBeforeRestart);
  });

  it("respawns with exponential backoff after crash", () => {
    mockWorkerInstance.emit("error", new Error("crash 1"));
    expect(mockWorkerInstance.terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(mockWorkerInstance).toBeDefined();

    mockWorkerInstance.emit("error", new Error("crash 2"));
    vi.advanceTimersByTime(1999);
    const workerAfterFirstDelay = mockWorkerInstance;

    vi.advanceTimersByTime(1);
    expect(mockWorkerInstance).not.toBe(workerAfterFirstDelay);
  });

  it("stops respawning after max crash restarts", () => {
    for (let i = 0; i < 5; i++) {
      mockWorkerInstance.emit("error", new Error(`crash ${i + 1}`));
      vi.advanceTimersByTime(60_000);
    }

    const lastWorker = mockWorkerInstance;
    mockWorkerInstance.emit("error", new Error("crash 6"));
    vi.advanceTimersByTime(60_000);
    expect(mockWorkerInstance).toBe(lastWorker);
  });

  it("resets crash count on successful response", async () => {
    // Crash twice with backoff
    mockWorkerInstance.emit("error", new Error("crash 1"));
    vi.advanceTimersByTime(1000);

    mockWorkerInstance.emit("error", new Error("crash 2"));
    vi.advanceTimersByTime(2000);

    // Send a successful request — should reset crash count
    const promise = client.search("ws-1", "test", 5, false);
    const msg = mockWorkerInstance.postMessage.mock.calls[0][0];
    mockWorkerInstance.emit("message", { id: msg.id, result: [] });
    await promise;

    // Crash again — should use base delay (1s) since count was reset
    mockWorkerInstance.emit("error", new Error("crash after reset"));
    vi.advanceTimersByTime(1000);

    // Verify worker is alive again with a request
    const freshPromise = client.search("ws-1", "x", 1, false);
    const freshMsg = mockWorkerInstance.postMessage.mock.calls[0][0];
    mockWorkerInstance.emit("message", { id: freshMsg.id, result: [] });
    await freshPromise;
  });

  it("rejects requests after destroy", async () => {
    client.destroy();
    await expect(client.search("ws-1", "test", 10, false)).rejects.toThrow("not available");
  });

  it("clears restart timer on destroy so no respawn occurs", () => {
    const workerBeforeCrash = mockWorkerInstance;
    mockWorkerInstance.emit("error", new Error("crash"));
    // Worker is now null, restart timer is pending
    client.destroy();
    // Advance past the restart delay — no new worker should spawn
    vi.advanceTimersByTime(60_000);
    // The instance should still be the one created after destroy was called —
    // no new spawnWorker should have fired
    expect(mockWorkerInstance).toBe(workerBeforeCrash);
  });
});
