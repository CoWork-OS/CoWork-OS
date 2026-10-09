import { describe, expect, it, vi } from "vitest";
import {
  BackgroundDispatchBudget,
  getBackgroundDispatchBudget,
  setBackgroundDispatchBudget,
} from "../BackgroundDispatchBudget";

function clock(start = new Date("2026-10-03T09:00:00").getTime()) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("BackgroundDispatchBudget", () => {
  it("does not silently fall back to an ephemeral production budget", () => {
    setBackgroundDispatchBudget(null);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => getBackgroundDispatchBudget()).toThrow("not initialized");
    } finally {
      vi.unstubAllEnvs();
      setBackgroundDispatchBudget(null);
    }
  });
  it("shares one daily budget per workspace across all producers", () => {
    const time = clock();
    const budget = new BackgroundDispatchBudget({ maxPerWorkspacePerDay: 3, now: time.now });

    expect(budget.tryConsume({ workspaceId: "ws-1", source: "heartbeat" }).allowed).toBe(true);
    expect(
      budget.tryConsume({ workspaceId: "ws-1", source: "workflow_intelligence" }).allowed,
    ).toBe(true);
    expect(budget.tryConsume({ workspaceId: "ws-1", source: "strategic_planner" }).allowed).toBe(
      true,
    );
    const denied = budget.tryConsume({ workspaceId: "ws-1", source: "strategic_planner" });
    expect(denied).toMatchObject({
      allowed: false,
      reason: "workspace_budget_exhausted",
      dispatchesToday: 3,
    });
    // Other workspaces have their own budget.
    expect(budget.tryConsume({ workspaceId: "ws-2", source: "heartbeat" }).allowed).toBe(true);
    expect(budget.snapshot("ws-1").bySource).toEqual({
      heartbeat: 1,
      workflow_intelligence: 1,
      strategic_planner: 1,
    });
  });

  it("resets at the start of the next local day", () => {
    const time = clock();
    const budget = new BackgroundDispatchBudget({
      maxPerWorkspacePerDay: 1,
      entityCooldownMs: 60_000,
      now: time.now,
    });
    expect(budget.tryConsume({ workspaceId: "ws-1", source: "heartbeat" }).allowed).toBe(true);
    expect(budget.tryConsume({ workspaceId: "ws-1", source: "heartbeat" }).allowed).toBe(false);
    time.advance(24 * 60 * 60 * 1000);
    expect(budget.tryConsume({ workspaceId: "ws-1", source: "heartbeat" }).allowed).toBe(true);
  });

  it("applies a per-entity cooldown across producers", () => {
    const time = clock();
    const budget = new BackgroundDispatchBudget({ entityCooldownMs: 60 * 60_000, now: time.now });
    expect(
      budget.tryConsume({
        workspaceId: "ws-1",
        source: "workflow_intelligence",
        entityKey: "Commitment:1",
      }).allowed,
    ).toBe(true);
    const blocked = budget.tryConsume({
      workspaceId: "ws-1",
      source: "workflow_intelligence",
      entityKey: "commitment:1",
    });
    expect(blocked).toMatchObject({ allowed: false, reason: "entity_cooldown" });
    time.advance(60 * 60_000);
    expect(
      budget.tryConsume({
        workspaceId: "ws-1",
        source: "workflow_intelligence",
        entityKey: "commitment:1",
      }).allowed,
    ).toBe(true);
  });

  it("records manual dispatches without refusing them", () => {
    const budget = new BackgroundDispatchBudget({ maxPerWorkspacePerDay: 1 });
    budget.tryConsume({ workspaceId: "ws-1", source: "heartbeat" });
    const manual = budget.tryConsume({ workspaceId: "ws-1", source: "heartbeat", manual: true });
    expect(manual.allowed).toBe(true);
    expect(budget.snapshot("ws-1").dispatchesToday).toBe(2);
  });

  it("refunds a slot when task creation failed", () => {
    const budget = new BackgroundDispatchBudget({ maxPerWorkspacePerDay: 1 });
    const grant = budget.tryConsume({ workspaceId: "ws-1", source: "strategic_planner" });
    budget.refund(grant.ticket);
    expect(
      budget.tryConsume({ workspaceId: "ws-1", source: "workflow_intelligence" }).allowed,
    ).toBe(true);
  });
});
