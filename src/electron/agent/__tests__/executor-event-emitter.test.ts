import { describe, expect, it, vi } from "vitest";
import { ExecutorEventEmitter } from "../executor-event-emitter";

describe("ExecutorEventEmitter", () => {
  it("forwards event type and payload through the adapter", () => {
    const logEvent = vi.fn();
    const emitter = new ExecutorEventEmitter(logEvent);
    const payload = { ok: true };

    emitter.emit("task_completed", payload);

    expect(logEvent).toHaveBeenCalledWith("task_completed", payload);
  });
});
