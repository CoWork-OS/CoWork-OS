import { describe, expect, it } from "vitest";
import { deriveEntropySweepDecision, resolveEntropySweepPolicy } from "../risk";

describe("entropy sweep policy", () => {
  it("resolveEntropySweepPolicy honors explicit value", () => {
    expect(resolveEntropySweepPolicy("strict", "balanced")).toBe("strict");
  });

  it("resolveEntropySweepPolicy falls back to review policy", () => {
    expect(resolveEntropySweepPolicy(undefined, "balanced")).toBe("balanced");
  });

  it("deriveEntropySweepDecision strict runs on mutation or non-low risk", () => {
    expect(
      deriveEntropySweepDecision({
        policy: "strict",
        riskLevel: "low",
        isMutatingTask: true,
        deepWorkMode: false,
      }).runEntropySweep,
    ).toBe(true);
    expect(
      deriveEntropySweepDecision({
        policy: "strict",
        riskLevel: "medium",
        isMutatingTask: false,
        deepWorkMode: false,
      }).runEntropySweep,
    ).toBe(true);
  });

  it("deriveEntropySweepDecision off never runs", () => {
    expect(
      deriveEntropySweepDecision({
        policy: "off",
        riskLevel: "high",
        isMutatingTask: true,
        deepWorkMode: true,
      }).runEntropySweep,
    ).toBe(false);
  });

  it("deriveEntropySweepDecision balanced runs for high risk", () => {
    expect(
      deriveEntropySweepDecision({
        policy: "balanced",
        riskLevel: "high",
        isMutatingTask: false,
        deepWorkMode: false,
      }).runEntropySweep,
    ).toBe(true);
  });
});
