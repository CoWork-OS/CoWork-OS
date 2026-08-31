import { describe, it, expect } from "vitest";
import {
  HeartbeatPulseEngine,
  getSignalStrength,
  type HeartbeatPulseInput,
} from "../HeartbeatPulseEngine";
import type { AgentRole, HeartbeatSignal } from "../../../shared/types";

function makeAgent(overrides: Partial<AgentRole> = {}): AgentRole {
  return {
    id: "agent-1",
    name: "test",
    displayName: "Test Agent",
    description: "",
    icon: "A",
    color: "#000",
    capabilities: [],
    isSystem: false,
    isActive: true,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    heartbeatProfile: "dispatcher",
    dispatchCooldownMinutes: 120,
    maxDispatchesPerDay: 6,
    ...overrides,
  } as AgentRole;
}

function makeSignal(overrides: Partial<HeartbeatSignal> = {}): HeartbeatSignal {
  return {
    id: "sig-1",
    agentRoleId: "agent-1",
    agentScope: "agent",
    workspaceScope: "single",
    signalFamily: "awareness_signal",
    source: "manual",
    fingerprint: "fp-1",
    urgency: "medium",
    confidence: 0.6,
    expiresAt: Date.now() + 60_000,
    evidenceRefs: [],
    mergedCount: 1,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    ...overrides,
  };
}

function baseInput(overrides: Partial<HeartbeatPulseInput> = {}): HeartbeatPulseInput {
  return {
    agent: makeAgent(),
    signals: [],
    pendingMentions: 0,
    assignedTasks: 0,
    hasActiveForegroundTask: false,
    manualOverride: false,
    dueChecklistItems: [],
    dueProactiveTasks: [],
    dispatchesToday: 0,
    maxDispatchesPerDay: 6,
    hasInFlightDispatch: false,
    ...overrides,
  };
}

const engine = new HeartbeatPulseEngine();

describe("getSignalStrength", () => {
  it("returns 0 for empty signal list", () => {
    expect(getSignalStrength([])).toBe(0);
  });

  it("floors critical signals at 0.9 even when confidence is low", () => {
    const sig = makeSignal({ urgency: "critical", confidence: 0.1 });
    expect(getSignalStrength([sig])).toBe(0.9);
  });

  it("uses confidence when it exceeds the urgency floor", () => {
    const sig = makeSignal({ urgency: "high", confidence: 0.95 });
    expect(getSignalStrength([sig])).toBe(0.95);
  });

  it("takes the max across multiple signals", () => {
    const low = makeSignal({ id: "a", urgency: "low", confidence: 0.1 });
    const high = makeSignal({ id: "b", urgency: "critical", confidence: 0.5 });
    expect(getSignalStrength([low, high])).toBe(0.9); // critical floor
  });
});

describe("HeartbeatPulseEngine.evaluate", () => {
  it("returns idle when there is nothing to do", () => {
    const decision = engine.evaluate(baseInput());
    expect(decision.kind).toBe("idle");
  });

  it("defers when a foreground task is active and there is pending work", () => {
    const decision = engine.evaluate(
      baseInput({
        hasActiveForegroundTask: true,
        pendingMentions: 1,
      }),
    );
    expect(decision.kind).toBe("deferred");
    expect(decision.deferred?.reason).toBe("foreground_active");
  });

  it("does NOT defer when manualOverride is set, even with active foreground task", () => {
    const decision = engine.evaluate(
      baseInput({
        hasActiveForegroundTask: true,
        pendingMentions: 1,
        manualOverride: true,
      }),
    );
    expect(decision.kind).not.toBe("deferred");
  });

  it("returns idle when a dispatch is already in flight", () => {
    const decision = engine.evaluate(baseInput({ hasInFlightDispatch: true }));
    expect(decision.kind).toBe("idle");
    expect(decision.reason).toMatch(/in flight/i);
  });

  it("returns idle when cooldown is active", () => {
    const decision = engine.evaluate(baseInput({ cooldownUntil: Date.now() + 60_000 }));
    expect(decision.kind).toBe("idle");
    expect(decision.reason).toMatch(/cooldown/i);
  });

  it("bypasses cooldown when manualOverride is set", () => {
    const decision = engine.evaluate(
      baseInput({
        cooldownUntil: Date.now() + 60_000,
        manualOverride: true,
        pendingMentions: 1,
      }),
    );
    expect(decision.kind).not.toBe("idle");
  });

  it("returns idle when daily budget is exhausted", () => {
    const decision = engine.evaluate(baseInput({ dispatchesToday: 6, maxDispatchesPerDay: 6 }));
    expect(decision.kind).toBe("idle");
    expect(decision.reason).toMatch(/budget/i);
  });

  it("observer with no work and weak signals → idle", () => {
    const agent = makeAgent({ heartbeatProfile: "observer" });
    const decision = engine.evaluate(
      baseInput({
        agent,
        signals: [makeSignal({ urgency: "low", confidence: 0.2 })],
      }),
    );
    expect(decision.kind).toBe("idle");
  });

  it("observer with strong signals (strength ≥ 0.8) → suggestion", () => {
    const agent = makeAgent({ heartbeatProfile: "observer" });
    const decision = engine.evaluate(
      baseInput({
        agent,
        signals: [makeSignal({ urgency: "critical", confidence: 1.0 })],
      }),
    );
    expect(decision.kind).toBe("suggestion");
  });

  it("dispatcher with pending mentions → dispatch_task", () => {
    const decision = engine.evaluate(baseInput({ pendingMentions: 2 }));
    expect(decision.kind).toBe("dispatch_task");
    expect(decision.dispatchKind).toBe("task");
  });

  it("non-dispatcher with pending mentions → suggestion", () => {
    const agent = makeAgent({ heartbeatProfile: "operator" });
    const decision = engine.evaluate(baseInput({ agent, pendingMentions: 1 }));
    expect(decision.kind).toBe("suggestion");
    expect(decision.dispatchKind).toBe("suggestion");
  });

  it("returns handoff_to_cron when cron-mode proactive tasks are due", () => {
    const decision = engine.evaluate(
      baseInput({
        dueProactiveTasks: [
          { id: "p1", name: "Nightly sweep", enabled: true, executionMode: "cron_handoff" } as Any,
        ],
      }),
    );
    expect(decision.kind).toBe("handoff_to_cron");
    expect(decision.dispatchKind).toBe("cron_handoff");
  });

  it("dispatcher with due checklist items → dispatch_runbook", () => {
    const decision = engine.evaluate(
      baseInput({
        dueChecklistItems: [{ id: "c1", title: "Check metrics" } as Any],
      }),
    );
    expect(decision.kind).toBe("dispatch_runbook");
  });

  it("operator with due checklist → suggestion (not runbook)", () => {
    const agent = makeAgent({ heartbeatProfile: "operator" });
    const decision = engine.evaluate(
      baseInput({
        agent,
        dueChecklistItems: [{ id: "c1", title: "Check metrics" } as Any],
      }),
    );
    expect(decision.kind).toBe("suggestion");
  });

  it("crosses signal strength dispatch threshold (≥ 0.72) → dispatches", () => {
    const decision = engine.evaluate(
      baseInput({
        signals: [makeSignal({ urgency: "high", confidence: 0.9 })],
      }),
    );
    expect(["dispatch_task", "suggestion"]).toContain(decision.kind);
  });

  it("propagates evidence refs and signal IDs to decision", () => {
    const sig = makeSignal({ id: "s-x", evidenceRefs: ["ref-1", "ref-2"] });
    const decision = engine.evaluate(baseInput({ signals: [sig] }));
    expect(decision.signalIds).toContain("s-x");
    expect(decision.evidenceRefs).toContain("ref-1");
    expect(decision.evidenceRefs).toContain("ref-2");
  });

  it("computes compressedSignalCount as sum of mergedCount across signals", () => {
    const signals = [
      makeSignal({ id: "a", mergedCount: 3 }),
      makeSignal({ id: "b", mergedCount: 5 }),
    ];
    const decision = engine.evaluate(baseInput({ signals }));
    expect(decision.compressedSignalCount).toBe(8);
  });
});
