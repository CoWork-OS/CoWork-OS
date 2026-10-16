import { describe, expect, it } from "vitest";

import {
  AGENT_DISPATCH_STEP_DESCRIPTION,
  GENERATED_HANDOFF_STEP_DESCRIPTION,
  MATCHING_OUTPUTS_VERIFICATION_STEP_DESCRIPTION,
  SOURCED_ANSWER_VERIFICATION_STEP_DESCRIPTION,
  VERIFICATION_RECHECK_STEP_DESCRIPTION,
  VERIFICATION_REPAIR_STEP_DESCRIPTION,
  generatedPlanStepLabel,
} from "../generated-plan-steps";

describe("generatedPlanStepLabel", () => {
  it("labels every step the executor writes", () => {
    expect(
      [
        GENERATED_HANDOFF_STEP_DESCRIPTION,
        VERIFICATION_REPAIR_STEP_DESCRIPTION,
        VERIFICATION_RECHECK_STEP_DESCRIPTION,
        MATCHING_OUTPUTS_VERIFICATION_STEP_DESCRIPTION,
        SOURCED_ANSWER_VERIFICATION_STEP_DESCRIPTION,
        AGENT_DISPATCH_STEP_DESCRIPTION,
      ].map(generatedPlanStepLabel),
    ).toEqual([
      "Summarize the results",
      "Fix the issues the final check found",
      "Re-check the fixes",
      "Check the files are complete and consistent",
      "Check every fact links to its source",
      "Hand the separate parts to sub-agents",
    ]);
  });

  it("leaves planner steps alone", () => {
    expect(generatedPlanStepLabel("Summarize the findings in plain language")).toBeUndefined();
    expect(generatedPlanStepLabel("Verify the build passes")).toBeUndefined();
  });
});
