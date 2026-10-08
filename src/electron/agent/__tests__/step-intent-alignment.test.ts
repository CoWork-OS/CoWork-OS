import { describe, expect, it } from "vitest";
import {
  scorePlanStepIntentAlignment,
  scoreStepIntentContainment,
  scoreStepIntentOverlap,
} from "../step-intent-alignment";
import type { Plan } from "../../../shared/types";

describe("step-intent-alignment", () => {
  it("scoreStepIntentOverlap rewards shared tokens", () => {
    const a = scoreStepIntentOverlap(
      "Implement user login API with JWT",
      "Build user login with JWT tokens",
    );
    expect(a).toBeGreaterThan(0.15);
  });

  it("scorePlanStepIntentAlignment flags steps with no overlap", () => {
    const plan: Plan = {
      description: "test",
      steps: [
        {
          id: "1",
          description: "Refactor payment webhook handler",
          status: "pending",
          kind: "primary",
        },
        { id: "2", description: "Verify", status: "pending", kind: "verification" },
      ],
    };
    const taskText = "Add dark mode toggle to settings page";
    const { lowAlignmentStepIds, rows } = scorePlanStepIntentAlignment(plan, taskText);
    expect(rows.find((r) => r.stepId === "1")?.score ?? 1).toBeLessThan(0.08);
    expect(lowAlignmentStepIds).toContain("1");
  });

  it("does not flag an aligned step just because the task prompt is long", () => {
    const filler = Array.from({ length: 600 }, (_, index) => `context${index}`).join(" ");
    const taskText = `Synthesize one workshop plan with a timed agenda, volunteer responsibilities, a budget within the cash limit, outreach, risks, and open decisions. ${filler}`;
    const step = "Draft the timed agenda and volunteer responsibilities for the workshop plan";
    expect(scoreStepIntentOverlap(step, taskText)).toBeLessThan(0.08);
    expect(scoreStepIntentContainment(step, taskText)).toBeGreaterThan(0.5);

    const plan: Plan = {
      description: "test",
      steps: [{ id: "1", description: step, status: "pending", kind: "primary" }],
    };
    expect(scorePlanStepIntentAlignment(plan, taskText).lowAlignmentStepIds).toEqual([]);
  });
});
