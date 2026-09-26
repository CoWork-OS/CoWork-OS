import { describe, expect, it, vi } from "vitest";
import { StartupActionGate } from "../startup-action-gate";

describe("StartupActionGate", () => {
  it("defers actions until startup is ready", () => {
    const gate = new StartupActionGate();
    const action = vi.fn();

    gate.runWhenReady(action);

    expect(action).not.toHaveBeenCalled();
    gate.open();
    expect(action).toHaveBeenCalledOnce();
  });

  it("runs later actions immediately and opens only once", () => {
    const gate = new StartupActionGate();
    const queuedAction = vi.fn();
    const laterAction = vi.fn();

    gate.runWhenReady(queuedAction);
    gate.open();
    gate.open();
    gate.runWhenReady(laterAction);

    expect(queuedAction).toHaveBeenCalledOnce();
    expect(laterAction).toHaveBeenCalledOnce();
  });
});
