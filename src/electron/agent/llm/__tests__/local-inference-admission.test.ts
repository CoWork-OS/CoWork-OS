import { afterEach, describe, expect, it } from "vitest";
import {
  LocalInferenceAdmission,
  clearLocalInferenceAdmissionsForTests,
  getLocalInferenceAdmission,
} from "../local-inference-admission";

afterEach(() => {
  clearLocalInferenceAdmissionsForTests();
});

describe("LocalInferenceAdmission", () => {
  it("allows one active generation and queues the next", async () => {
    const admission = new LocalInferenceAdmission("test", 1);
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const first = admission.run(undefined, async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstStarted.promise;

    let secondStarted = false;
    const second = admission.run(undefined, async () => {
      secondStarted = true;
      return "second";
    });
    expect(admission.activeCount).toBe(1);
    expect(admission.queuedCount).toBe(1);
    expect(secondStarted).toBe(false);

    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(admission.activeCount).toBe(0);
  });

  it("removes cancelled waiters without blocking the next request", async () => {
    const admission = new LocalInferenceAdmission("test", 1);
    const release = await admission.acquire();
    const controller = new AbortController();
    const waiting = admission.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(admission.queuedCount).toBe(0);
    release();

    await expect(admission.acquire()).resolves.toBeTypeOf("function");
  });

  it("shares admission by serving-resource key", () => {
    expect(getLocalInferenceAdmission("atomic:http://127.0.0.1:1337/v1")).toBe(
      getLocalInferenceAdmission("atomic:http://127.0.0.1:1337/v1"),
    );
  });
});
