import { describe, expect, it } from "vitest";
import {
  FINAL_TRY_HEADLINE,
  FINAL_TRY_NEXT_STEP,
  selectFinalTrySuggestion,
  submitFinalTryPrompt,
} from "../final-try-utils";

describe("onboarding first-task prompt", () => {
  it("explains that the prompt starts a normal task after setup", () => {
    expect(`${FINAL_TRY_HEADLINE} ${FINAL_TRY_NEXT_STEP}`).not.toMatch(/instant/i);
    expect(FINAL_TRY_NEXT_STEP).toContain("saves your setup");
    expect(FINAL_TRY_NEXT_STEP).toContain("normal task");
  });

  it("fills a suggested prompt and clears voice errors without starting the task", () => {
    const calls: string[] = [];
    selectFinalTrySuggestion(
      "Create a weekly plan",
      (value) => calls.push(`input:${value}`),
      () => calls.push("clear-error"),
    );

    expect(calls).toEqual(["input:Create a weekly plan", "clear-error"]);
  });

  it("queues a non-empty prompt before completing onboarding", () => {
    const calls: string[] = [];
    const submitted = submitFinalTryPrompt(
      "  Create a weekly plan  ",
      (prompt) => calls.push(`queue:${prompt}`),
      () => calls.push("complete"),
    );

    expect(submitted).toBe(true);
    expect(calls).toEqual(["queue:Create a weekly plan", "complete"]);
  });

  it("does not complete onboarding for a blank prompt", () => {
    const calls: string[] = [];
    const submitted = submitFinalTryPrompt(
      "  ",
      (prompt) => calls.push(prompt),
      () => calls.push("complete"),
    );

    expect(submitted).toBe(false);
    expect(calls).toEqual([]);
  });
});
