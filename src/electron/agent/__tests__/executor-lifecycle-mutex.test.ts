import { describe, expect, it } from "vitest";
import { LifecycleMutex } from "../executor-lifecycle-mutex";

describe("LifecycleMutex", () => {
  it("serializes overlapping operations", async () => {
    const mutex = new LifecycleMutex();
    const events: string[] = [];

    const first = mutex.runExclusive(async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("first:end");
    });

    const second = mutex.runExclusive(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});
