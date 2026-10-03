import { describe, expect, it } from "vitest";
import { BUILTIN_ACCESS_PROFILES } from "../../../../shared/access-profiles";
import { getAccessProfilePresentation } from "../access-profile-presentation";

describe("getAccessProfilePresentation", () => {
  it("explains that on-request profiles ask inline in the default runtime", () => {
    const profile = BUILTIN_ACCESS_PROFILES[0];
    const presentation = getAccessProfilePresentation(profile, false);
    expect(presentation.label).toBe(profile.label);
    expect(presentation.label).not.toContain("prompts off");
    expect(presentation.description).toContain(profile.description);
    expect(presentation.description).toContain("Deny / Allow once");
    expect(presentation.description).not.toContain("blocked");
    expect(presentation.notice).toBeNull();
  });

  it("keeps the configured profile copy when prompts are available", () => {
    const profile = BUILTIN_ACCESS_PROFILES[0];
    expect(getAccessProfilePresentation(profile, true)).toEqual({
      label: profile.label,
      description: profile.description,
      notice: null,
    });
  });

  it("does not report the prompt limitation while runtime support is still unknown", () => {
    expect(getAccessProfilePresentation(BUILTIN_ACCESS_PROFILES[0], null).notice).toBeNull();
  });

  it("does not imply approval is needed for full access", () => {
    const profile = BUILTIN_ACCESS_PROFILES[2];
    expect(getAccessProfilePresentation(profile, false).label).toBe("Full access");
  });
});
