import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { isProductionFailureFix } = require("../../scripts/qa/enforce_eval_regression_policy.cjs") as {
  isProductionFailureFix: (title: string, body: string) => boolean;
};

describe("eval regression policy detection", () => {
  it("ignores unchecked production-failure checklist template text", () => {
    const body = [
      "## Reliability Regression Policy",
      "- [ ] This PR fixes a production failure/incident.",
      "- [ ] If checked above, I added or updated at least one eval case file.",
    ].join("\n");

    expect(isProductionFailureFix("perf: improve launch time", body)).toBe(false);
  });

  it("detects explicitly checked production-failure checklist text", () => {
    const body = "- [x] This PR fixes a production failure/incident.";

    expect(isProductionFailureFix("fix: recover failed workflow", body)).toBe(true);
  });

  it("detects production incident keywords outside unchecked checklist items", () => {
    expect(
      isProductionFailureFix(
        "fix: recover failed workflow",
        "Follow-up for the production incident on May 21.",
      ),
    ).toBe(true);
  });
});
