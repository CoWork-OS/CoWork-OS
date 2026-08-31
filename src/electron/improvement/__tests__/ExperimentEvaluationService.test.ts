import { describe, expect, it } from "vitest";
import { collectSafetySignals, extractArtifactSummary } from "../ExperimentEvaluationService";

describe("ExperimentEvaluationService helpers", () => {
  it("extracts multiple fallback verification commands when no explicit label is present", () => {
    const summary = extractArtifactSummary(
      {
        resultSummary:
          "Reproduction method: reproduced from logs. Ran npm test, pnpm run lint, and bun run verify before marking PR readiness: ready.",
      } as any,
      8,
    );

    expect(summary.reproductionMethod).toBe(
      "reproduced from logs. Ran npm test, pnpm run lint, and bun run verify before marking PR readiness: ready.",
    );
    expect(summary.verificationCommands).toEqual(["npm test", "pnpm run lint", "bun run verify"]);
    expect(summary.prReadiness).toBe("ready");
  });

  it("parses structured artifact fields including singular verification command labels", () => {
    const summary = extractArtifactSummary(
      {
        resultSummary: [
          "Reproduction method: reproduced from verifier output",
          "Root cause: missing artifact wiring",
          "Changed files summary: src/app.ts; src/lib/check.ts",
          "Verification command: npm test | pnpm run lint",
          "PR readiness: ready",
        ].join("\n"),
      } as any,
      8,
    );

    expect(summary.rootCauseSummary).toBe("missing artifact wiring");
    expect(summary.changedFiles).toEqual(["src/app.ts", "src/lib/check.ts"]);
    expect(summary.verificationCommands).toEqual(["npm test", "pnpm run lint"]);
    expect(summary.prReadiness).toBe("ready");
    expect(summary.missingEvidence).toEqual([]);
  });

  it("flags safety issues for empty changed-files evidence, oversized patches, and large diffs", () => {
    expect(
      collectSafetySignals(
        {
          reproductionMethod: "reproduced",
          changedFiles: [],
          verificationCommands: ["npm test"],
          prReadiness: "ready",
          missingEvidence: [],
        },
        0.12,
        2,
      ),
    ).toEqual([
      "PR readiness was declared without a changed-files summary.",
      "Patch appears larger than expected for a bounded self-improvement run.",
    ]);

    expect(
      collectSafetySignals(
        {
          reproductionMethod: "reproduced",
          changedFiles: ["a.ts", "b.ts", "c.ts"],
          verificationCommands: ["npm test"],
          prReadiness: "ready",
          missingEvidence: [],
        },
        0.02,
        2,
      ),
    ).toContain("Patch scope exceeded the expected file cap (3/2).");
  });
});
