import { beforeEach, describe, expect, it } from "vitest";
import {
  bookCharge,
  chargeExceedsLimit,
  chargeLines,
  chargeSpent,
  pendingCharge,
  refundCharge,
  resetToolCostTallyForTests,
  type ToolCostPolicy,
} from "../tool-costs";

const POLICY: ToolCostPolicy = {
  vendor: "Meshy",
  unit: "credits",
  limit: 30,
  costs: {
    make: { low: 5, high: 25 },
    rig: { low: 5, high: 5 },
    animate: { low: 3, high: 3, note: "3 per action", perItemField: "action_ids" },
    free: { low: 0, high: 0 },
  },
  freeTools: new Set(["status"]),
};

describe("tool costs", () => {
  beforeEach(() => resetToolCostTallyForTests());

  it("has no charge for undeclared or free tools", () => {
    expect(pendingCharge(POLICY, "task-1", "server-1", "status")).toBeNull();
    expect(pendingCharge({ ...POLICY, freeTools: undefined }, "t", "s", "status")?.unknown).toBe(
      true,
    );
    expect(pendingCharge(POLICY, "task-1", "server-1", "free")).toBeNull();
    expect(pendingCharge(null, "task-1", "server-1", "make")).toBeNull();
  });

  it("names the estimate and the limit before anything is spent", () => {
    const charge = pendingCharge(POLICY, "task-1", "server-1", "make")!;
    expect(chargeLines(charge)).toEqual([
      "Costs 5–25 credits.",
      "Spend limit for this task on Meshy: 30 credits.",
    ]);
    expect(chargeLines(pendingCharge(POLICY, "task-1", "server-1", "rig")!)[0]).toBe(
      "Costs about 5 credits.",
    );
    expect(chargeLines(pendingCharge(POLICY, "task-1", "server-1", "animate")!)[0]).toBe(
      "Costs about 3 credits (3 per action).",
    );
  });

  it("counts the top of the range per task and asks once a call would pass the limit", () => {
    const make = pendingCharge(POLICY, "task-1", "server-1", "make")!;
    expect(chargeExceedsLimit(make)).toBe(false);
    bookCharge(make);
    expect(chargeSpent(make)).toBe(25);

    const rig = pendingCharge(POLICY, "task-1", "server-1", "rig")!;
    expect(chargeExceedsLimit(rig)).toBe(false); // 25 + 5 = 30, at the limit
    expect(chargeLines(rig)[1]).toBe("This task has used about 25 credits on Meshy (limit 30).");

    const again = pendingCharge(POLICY, "task-1", "server-1", "make")!;
    expect(chargeExceedsLimit(again)).toBe(true);
    expect(chargeLines(again)[2]).toMatch(/past its 30 credits limit, so it needs your approval/);
  });

  it("keeps each task's tally apart", () => {
    bookCharge(pendingCharge(POLICY, "task-1", "server-1", "make")!);
    expect(chargeSpent(pendingCharge(POLICY, "task-2", "server-1", "make")!)).toBe(0);
    expect(chargeSpent(pendingCharge(POLICY, "task-1", "server-2", "make")!)).toBe(0);
  });

  it("never asks again when the limit is off", () => {
    const unlimited = { ...POLICY, limit: 0 };
    const charge = pendingCharge(unlimited, "task-1", "server-1", "make")!;
    for (let index = 0; index < 10; index += 1) bookCharge(charge);
    expect(chargeExceedsLimit(charge)).toBe(false);
    expect(chargeLines(charge)).toEqual([
      "Costs 5–25 credits.",
      "This task has used about 250 credits on Meshy.",
    ]);
  });
});

describe("costs that are not fixed", () => {
  beforeEach(() => resetToolCostTallyForTests());

  it("prices a per-action tool by the actions asked for", () => {
    const charge = pendingCharge(POLICY, "task-1", "server-1", "animate", {
      action_ids: [1, 2, 3, 4],
    })!;
    expect(charge.cost.high).toBe(12);
  });

  it("always asks for a tool whose price is not declared", () => {
    const charge = pendingCharge(POLICY, "task-1", "server-1", "new_paid_tool")!;
    expect(charge.unknown).toBe(true);
    expect(chargeExceedsLimit(charge)).toBe(true);
    expect(chargeLines(charge)[0]).toBe(
      "Meshy does not list a price for new_paid_tool; it may spend credits.",
    );
  });

  it("gives a refused call's booking back", () => {
    const charge = pendingCharge(POLICY, "task-1", "server-1", "make")!;
    bookCharge(charge);
    refundCharge(charge);
    expect(chargeSpent(charge)).toBe(0);
  });
});
