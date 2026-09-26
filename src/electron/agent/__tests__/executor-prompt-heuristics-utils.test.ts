import { describe, expect, it } from "vitest";
import { detectTestRequirement } from "../executor-prompt-heuristics-utils";

describe("detectTestRequirement", () => {
  it("detects explicit test-run requests", () => {
    expect(detectTestRequirement("Run the unit tests after the change.")).toBe(true);
    expect(detectTestRequirement("Please execute the test suite.")).toBe(true);
  });

  it("does not treat explicit test-run prohibitions as requirements", () => {
    expect(detectTestRequirement("Do not execute tests.")).toBe(false);
    expect(
      detectTestRequirement(
        "Read files only; do not run commands, modify files, or execute tests.",
      ),
    ).toBe(false);
    expect(detectTestRequirement("No need to run the test suite.")).toBe(false);
  });

  it("preserves a later positive request after a negated one", () => {
    expect(detectTestRequirement("Do not run tests now. Run the test suite after the fix.")).toBe(
      true,
    );
  });

  it("does not treat a request to avoid asking as a test prohibition", () => {
    expect(detectTestRequirement("Do not ask me before running the tests.")).toBe(true);
  });
});
