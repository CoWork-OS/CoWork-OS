import { describe, expect, it } from "vitest";

import { getDefaultGuardrailSettings } from "../../../shared/guardrail-defaults";
import { resolveWebSearchUseCaps } from "../web-search-budget";

const defaults = getDefaultGuardrailSettings();

function capsFor(
  profile: "strict" | "balanced" | "aggressive",
  overrides: Partial<Parameters<typeof resolveWebSearchUseCaps>[0]> = {},
) {
  return resolveWebSearchUseCaps({
    profile,
    guardrailMaxUsesPerTask: defaults.webSearchMaxUsesPerTask,
    guardrailMaxUsesPerStep: defaults.webSearchMaxUsesPerStep,
    ...overrides,
  });
}

describe("web search use caps", () => {
  it("defaults to 25 searches per task and 8 per step", () => {
    expect(defaults.webSearchMaxUsesPerTask).toBe(25);
    expect(defaults.webSearchMaxUsesPerStep).toBe(8);
    expect(capsFor("balanced")).toEqual({ perTask: 25, perStep: 8 });
  });

  it("scales the per-task cap with the budget profile while the setting is uncustomized", () => {
    // The setting is always present in loaded settings, so before this the
    // stored default overrode every profile and "aggressive" never applied.
    expect(capsFor("strict").perTask).toBe(12);
    expect(capsFor("aggressive").perTask).toBe(50);
  });

  it("uses a customized setting for every profile", () => {
    expect(capsFor("aggressive", { guardrailMaxUsesPerTask: 10 }).perTask).toBe(10);
    expect(capsFor("strict", { guardrailMaxUsesPerTask: 40 }).perTask).toBe(40);
    expect(capsFor("aggressive", { guardrailMaxUsesPerStep: 2 }).perStep).toBe(2);
  });

  it("lets the task's own agentConfig caps take precedence", () => {
    expect(capsFor("aggressive", { taskMaxUsesPerTask: 5, taskMaxUsesPerStep: 1 })).toEqual({
      perTask: 5,
      perStep: 1,
    });
  });

  it("falls back to the profile and default caps for invalid settings", () => {
    expect(
      capsFor("aggressive", { guardrailMaxUsesPerTask: "lots", guardrailMaxUsesPerStep: 0 }),
    ).toEqual({ perTask: 50, perStep: 8 });
    expect(capsFor("balanced", { guardrailMaxUsesPerTask: 9999 }).perTask).toBe(500);
  });
});
