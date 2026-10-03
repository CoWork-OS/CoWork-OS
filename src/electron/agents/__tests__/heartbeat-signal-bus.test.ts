import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitCorrectionLearningSignal,
  emitHeartbeatSignal,
  setHeartbeatSignalEmitter,
} from "../heartbeat-signal-bus";

describe("heartbeat-signal-bus", () => {
  afterEach(() => {
    setHeartbeatSignalEmitter(null);
  });

  it("drops signals while no emitter is registered", () => {
    expect(() =>
      emitHeartbeatSignal({ signalFamily: "maintenance", source: "system" }),
    ).not.toThrow();
  });

  it("emits a merged, low-strength correction signal without the user's text", () => {
    const emitter = vi.fn(async () => []);
    setHeartbeatSignalEmitter(emitter);

    emitCorrectionLearningSignal({ workspaceId: "ws-1", taskId: "task-1" });
    emitCorrectionLearningSignal({ workspaceId: "ws-1", taskId: "task-2" });

    expect(emitter).toHaveBeenCalledTimes(2);
    const [first] = emitter.mock.calls[0] as unknown as [Record<string, unknown>];
    const [second] = emitter.mock.calls[1] as unknown as [Record<string, unknown>];
    expect(first).toMatchObject({
      workspaceId: "ws-1",
      signalFamily: "correction_learning",
      urgency: "low",
      evidenceRefs: ["task:task-1"],
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.confidence as number).toBeLessThan(0.72);
  });

  it("swallows emitter failures", async () => {
    setHeartbeatSignalEmitter(async () => {
      throw new Error("boom");
    });
    expect(() =>
      emitCorrectionLearningSignal({ workspaceId: "ws-1", taskId: "task-1" }),
    ).not.toThrow();
    await Promise.resolve();
  });
});
