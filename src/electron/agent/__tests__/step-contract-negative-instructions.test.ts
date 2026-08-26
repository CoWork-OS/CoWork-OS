import { describe, expect, it } from "vitest";

import { analyzeInstructionIntent, descriptionHasWriteIntent } from "../step-contract";

describe("negative instruction intent", () => {
  it.each([
    "Do not use tools or modify files.",
    "Review without editing files.",
    "Never call write_file; summarize the findings.",
  ])("does not treat a constraint-only clause as executable: %s", (input) => {
    const analysis = analyzeInstructionIntent(input);
    expect(descriptionHasWriteIntent(analysis.positiveText)).toBe(false);
  });

  it("keeps positive clauses while excluding prohibited mutations", () => {
    expect(analyzeInstructionIntent("Do not edit files; run npm test.").positiveText).toBe(
      "run npm test.",
    );
    expect(
      descriptionHasWriteIntent(
        analyzeInstructionIntent("Do not overwrite README; create report.md.").positiveText,
      ),
    ).toBe(true);
  });

  it("ignores quoted and code examples", () => {
    expect(analyzeInstructionIntent('Explain the phrase "do not edit files".').positiveText).toBe(
      "Explain the phrase  .",
    );
    expect(analyzeInstructionIntent("Summarize `write_file` usage.").positiveText).toBe(
      "Summarize   usage.",
    );
  });
});
