import { describe, expect, it } from "vitest";
import { BUILTIN_ACCESS_PROFILES } from "../../../../shared/access-profiles";
import { getAccessProfilePresentation } from "../access-profile-presentation";

describe("getAccessProfilePresentation", () => {
  it("explains that on-request profiles cannot prompt in the default runtime", () => {
    const presentation = getAccessProfilePresentation(BUILTIN_ACCESS_PROFILES[0], false);
    expect(presentation.label).toContain("prompts off");
    expect(presentation.description).toContain("blocked");
    expect(presentation.notice).toContain("Approval prompts are off");
  });

  it("keeps the configured profile copy when prompts are available", () => {
    const profile = BUILTIN_ACCESS_PROFILES[0];
    expect(getAccessProfilePresentation(profile, true)).toEqual({
      label: profile.label,
      description: profile.description,
      notice: null,
    });
  });

  it("does not imply approval is needed for full access", () => {
    const profile = BUILTIN_ACCESS_PROFILES[2];
    expect(getAccessProfilePresentation(profile, false).label).toBe("Full access");
  });
});
