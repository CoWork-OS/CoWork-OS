import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerPredictionCoordinator } from "../ComposerPredictionCoordinator";
import type { ComposerPrediction } from "../../../shared/composer-predictions";
const result = { revision: "r", text: "Compare tradeoffs" };
const deferred = () => {
  let resolve!: (value: ComposerPrediction | null) => void;
  const promise = new Promise<ComposerPrediction | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe("prediction coordinator", () => {
  it("does not start work registered after its window was destroyed during context reads", async () => {
    const service = new ComposerPredictionCoordinator();
    const generate = vi.fn().mockResolvedValue(result);
    service.cancelOwner(1);
    expect(await service.request(1, "late", "key", generate)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(await service.request(2, "live", "key", generate)).toEqual(result);
  });

  it("retries after provider errors and empty results instead of caching null", async () => {
    const service = new ComposerPredictionCoordinator();
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(result);
    expect(await service.request(1, "one", "key", generate)).toBeNull();
    expect(await service.request(1, "two", "key", generate)).toBeNull();
    expect(await service.request(1, "three", "key", generate)).toEqual(result);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("deduplicates subscribers and caches success only until expiry", async () => {
    vi.useFakeTimers();
    const service = new ComposerPredictionCoordinator({
      maxQueued: 8,
      maxCache: 100,
      cacheTtlMs: 1000,
    });
    const pending = deferred();
    const generate = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(result);
    const first = service.request(1, "one", "key", generate);
    const second = service.request(1, "two", "key", generate);
    pending.resolve(result);
    expect(await first).toEqual(result);
    expect(await second).toEqual(result);
    expect(await service.request(1, "three", "key", generate)).toEqual(result);
    expect(generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    await service.request(1, "four", "key", generate);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("runs one provider call at a time and rejects queue overflow", async () => {
    const service = new ComposerPredictionCoordinator({
      maxQueued: 1,
      maxCache: 100,
      cacheTtlMs: 1000,
    });
    const pending = deferred();
    const firstRun = vi.fn(() => pending.promise);
    const nextRun = vi.fn().mockResolvedValue(result);
    const first = service.request(1, "one", "key1", firstRun);
    const second = service.request(1, "two", "key2", nextRun);
    expect(await service.request(1, "three", "key3", nextRun)).toBeNull();
    expect(nextRun).not.toHaveBeenCalled();
    pending.resolve(result);
    await first;
    await second;
    expect(nextRun).toHaveBeenCalledOnce();
  });

  it("aborts cancelled work but keeps its slot until a non-cooperative provider settles", async () => {
    const service = new ComposerPredictionCoordinator();
    const pending = deferred();
    let signal!: AbortSignal;
    const first = service.request(1, "one", "key1", (incoming) => {
      signal = incoming;
      return pending.promise;
    });
    const nextRun = vi.fn().mockResolvedValue(result);
    const second = service.request(1, "two", "key2", nextRun);
    service.cancel(1, "one");
    expect(await first).toBeNull();
    expect(signal.aborted).toBe(true);
    expect(nextRun).not.toHaveBeenCalled();
    pending.resolve(result);
    expect(await second).toEqual(result);
    // Cancelled success must not poison a retry's cache.
    const retry = vi.fn().mockResolvedValue(result);
    await service.request(1, "three", "key1", retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("removes cancelled queued work without invoking its provider", async () => {
    const service = new ComposerPredictionCoordinator();
    const pending = deferred();
    const first = service.request(1, "one", "key1", () => pending.promise);
    const queued = vi.fn().mockResolvedValue(result);
    const second = service.request(1, "two", "key2", queued);
    service.cancel(1, "two");
    expect(await second).toBeNull();
    pending.resolve(result);
    await first;
    expect(queued).not.toHaveBeenCalled();
  });

  it("does not abort shared generation until every subscriber cancels", async () => {
    const service = new ComposerPredictionCoordinator();
    const pending = deferred();
    let signal!: AbortSignal;
    const first = service.request(1, "one", "key", (incoming) => {
      signal = incoming;
      return pending.promise;
    });
    const second = service.request(1, "two", "key", vi.fn());
    service.cancel(1, "one");
    expect(await first).toBeNull();
    expect(signal.aborted).toBe(false);
    pending.resolve(result);
    expect(await second).toEqual(result);
  });

  it("cancels a destroyed renderer's queued and running work", async () => {
    const service = new ComposerPredictionCoordinator();
    const pending = deferred();
    let signal!: AbortSignal;
    const running = service.request(1, "one", "key1", (incoming) => {
      signal = incoming;
      return pending.promise;
    });
    const generate = vi.fn().mockResolvedValue(result);
    const queued = service.request(1, "two", "key2", generate);
    service.cancelOwner(1);
    expect(await running).toBeNull();
    expect(await queued).toBeNull();
    expect(signal.aborted).toBe(true);
    pending.resolve(result);
    await Promise.resolve();
    expect(generate).not.toHaveBeenCalled();
  });

  it("handles cancel-before-registration and isolates request owners", async () => {
    const service = new ComposerPredictionCoordinator();
    const generate = vi.fn().mockResolvedValue(result);
    service.cancel(1, "one");
    expect(await service.request(1, "one", "key", generate)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(await service.request(2, "one", "key", generate)).toEqual(result);
  });
});
