import { describe, expect, it } from "vitest";
import { deferredInputForSelectedTask } from "../deferred-task-input";

describe("deferredInputForSelectedTask", () => {
  const pipeline = { task: { id: "pipeline" }, files: ["pipeline-review.xlsx"] };
  const onboarding = { task: { id: "onboarding" }, files: ["handout.docx"] };

  it("keeps the deferred input for the same task", () => {
    const newer = { task: { id: "pipeline" }, files: ["pipeline-review.xlsx", "summary.pdf"] };
    expect(deferredInputForSelectedTask(pipeline, newer)).toBe(pipeline);
  });

  it("never shows another task's deferred input after a switch", () => {
    expect(deferredInputForSelectedTask(pipeline, onboarding)).toBe(onboarding);
  });
});
