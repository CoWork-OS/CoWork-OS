import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { HeartbeatSignalStore, type SubmitHeartbeatSignalInput } from "../HeartbeatSignalStore";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-signal-store-test-"));
  process.env.COWORK_USER_DATA_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.COWORK_USER_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeInput(
  overrides: Partial<SubmitHeartbeatSignalInput> = {},
): SubmitHeartbeatSignalInput {
  return {
    agentRoleId: "agent-1",
    signalFamily: "awareness_signal",
    source: "manual",
    urgency: "medium",
    confidence: 0.6,
    ...overrides,
  };
}

function store(): HeartbeatSignalStore {
  return new HeartbeatSignalStore();
}

describe("HeartbeatSignalStore.submit", () => {
  it("stores and retrieves a new signal", () => {
    const s = store();
    s.submit(makeInput());
    const signals = s.listAgentSignals("agent-1");
    expect(signals).toHaveLength(1);
    expect(signals[0].signalFamily).toBe("awareness_signal");
  });

  it("merges a duplicate signal (same fingerprint) instead of creating a new entry", () => {
    const s = store();
    s.submit(makeInput({ fingerprint: "fp-x", confidence: 0.4 }));
    const { merged } = s.submit(makeInput({ fingerprint: "fp-x", confidence: 0.7 }));
    expect(merged).toBe(true);
    const signals = s.listAgentSignals("agent-1");
    expect(signals).toHaveLength(1);
    expect(signals[0].mergedCount).toBe(2);
    expect(signals[0].confidence).toBe(0.7);
  });

  it("upgrades urgency on merge when the new signal is more urgent", () => {
    const s = store();
    s.submit(makeInput({ fingerprint: "fp-u", urgency: "low" }));
    s.submit(makeInput({ fingerprint: "fp-u", urgency: "critical" }));
    expect(s.listAgentSignals("agent-1")[0].urgency).toBe("critical");
  });

  it("does NOT downgrade urgency on merge", () => {
    const s = store();
    s.submit(makeInput({ fingerprint: "fp-d", urgency: "high" }));
    s.submit(makeInput({ fingerprint: "fp-d", urgency: "low" }));
    expect(s.listAgentSignals("agent-1")[0].urgency).toBe("high");
  });

  it("clamps confidence to [0, 1]", () => {
    const s = store();
    s.submit(makeInput({ confidence: 2.5 }));
    expect(s.listAgentSignals("agent-1")[0].confidence).toBe(1);
  });

  it("persists signals to disk and reloads them in a fresh instance", () => {
    const s1 = store();
    s1.submit(makeInput({ reason: "persisted" }));
    const s2 = store();
    const signals = s2.listAgentSignals("agent-1");
    expect(signals).toHaveLength(1);
    expect(signals[0].reason).toBe("persisted");
  });

  it("does not return signals for a different agent", () => {
    const s = store();
    s.submit(makeInput({ agentRoleId: "agent-a" }));
    expect(s.listAgentSignals("agent-b")).toHaveLength(0);
  });
});

describe("HeartbeatSignalStore.removeSignals", () => {
  it("removes signals matching the snapshot", () => {
    const s = store();
    const { signal } = s.submit(makeInput());
    s.removeSignals("agent-1", [
      { id: signal.id, lastSeenAt: signal.lastSeenAt, mergedCount: signal.mergedCount },
    ]);
    expect(s.listAgentSignals("agent-1")).toHaveLength(0);
  });

  it("keeps a signal that was updated since the snapshot was taken", () => {
    const s = store();
    const { signal } = s.submit(makeInput({ fingerprint: "fp-keep" }));
    // Merge a second submit so mergedCount becomes 2.
    s.submit(makeInput({ fingerprint: "fp-keep" }));
    // Try to remove using the stale snapshot (mergedCount = 1).
    s.removeSignals("agent-1", [{ id: signal.id, lastSeenAt: signal.lastSeenAt, mergedCount: 1 }]);
    const remaining = s.listAgentSignals("agent-1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].mergedCount).toBe(2);
  });
});

describe("HeartbeatSignalStore deferred state", () => {
  it("stores and retrieves deferred state per agent + workspace", () => {
    const s = store();
    const state = {
      active: true,
      reason: "foreground_active" as const,
      summary: "test",
      deferredAt: 1,
      compressedSignalCount: 3,
    };
    s.setDeferredState("agent-1", state, "ws-1");
    expect(s.getDeferredState("agent-1", "ws-1")).toEqual(state);
    expect(s.getDeferredState("agent-1", "ws-2")).toBeUndefined();
  });

  it("clears deferred state", () => {
    const s = store();
    const state = {
      active: true,
      reason: "foreground_active" as const,
      summary: "x",
      deferredAt: 1,
      compressedSignalCount: 0,
    };
    s.setDeferredState("agent-1", state);
    s.clearDeferredState("agent-1");
    expect(s.getDeferredState("agent-1")).toBeUndefined();
  });

  it("clearAgent removes both signals and deferred state", () => {
    const s = store();
    s.submit(makeInput());
    s.setDeferredState("agent-1", {
      active: true,
      reason: "foreground_active" as const,
      summary: "x",
      deferredAt: 1,
      compressedSignalCount: 0,
    });
    s.clearAgent("agent-1");
    expect(s.listAgentSignals("agent-1")).toHaveLength(0);
    expect(s.getDeferredState("agent-1")).toBeUndefined();
  });
});

describe("HeartbeatSignalStore signal expiry", () => {
  it("prunes expired signals", () => {
    const s = store();
    // Use a timestamp well in the past as the signal's expiry, and a far-future
    // "now" so the prune filter definitely considers it expired.
    const farFuture = Date.now() + 999_999_999;
    s.submit(makeInput({ expiresAt: farFuture - 1_000_000_000 }));
    const signals = s.listAgentSignals("agent-1", farFuture);
    expect(signals).toHaveLength(0);
  });
});
