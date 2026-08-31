import { describe, expect, it } from "vitest";

import { formatUserFacingCompletionSummary } from "../task-completion";

describe("formatUserFacingCompletionSummary", () => {
  it("formats the result and verification fields only", () => {
    const result = formatUserFacingCompletionSummary({
      resultSummary: "The user-facing answer.",
      verificationVerdict: "PASS",
      verificationReport: "The verifier confirmed the result.",
      ...({
        semanticSummary: "Browser Navigate https://web.whatsapp.com/ · List Directory",
      } as Record<string, unknown>),
    });

    expect(result).toBe(
      "The user-facing answer.\n\nVerification: PASS\nThe verifier confirmed the result.",
    );
    expect(result).not.toContain("Browser Navigate");
  });
});
