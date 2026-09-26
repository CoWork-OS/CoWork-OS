import { describe, expect, it } from "vitest";
import { applyRevisionContract } from "../revision-contract";
import type { ReleaseBriefCheck } from "../verify-release-brief";

const checked: ReleaseBriefCheck = {
  missionId: "release-brief-v1",
  passed: true,
  checks: ["facts"],
  errors: [],
  artifactHashes: { "release-brief.html": "first", "summary.json": "summary" },
};

describe("sample revision contract", () => {
  it("requires the brief itself to change after a revision request", () => {
    expect(applyRevisionContract(checked, checked.artifactHashes).passed).toBe(false);
    expect(applyRevisionContract(checked, { "release-brief.html": "older" }).passed).toBe(true);
    expect(checked.passed).toBe(true);
  });
});
