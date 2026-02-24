import { describe, expect, it } from "vitest";

import { validatePolicies } from "../policies";

describe("validatePolicies", () => {
  it("accepts non-conflicting pack policy lists", () => {
    expect(
      validatePolicies({
        packs: {
          allowed: ["alpha", "beta"],
          blocked: ["blocked-pack"],
          required: ["alpha"],
        },
      }),
    ).toBeNull();
  });

  it("rejects required IDs that are also blocked", () => {
    expect(
      validatePolicies({
        packs: {
          allowed: [],
          blocked: ["shared-pack"],
          required: ["shared-pack", "other-pack"],
        },
      }),
    ).toBe("A pack ID cannot be both required and blocked");
  });

  it("requires required IDs to be in allowlist when allowlist is set", () => {
    expect(
      validatePolicies({
        packs: {
          allowed: ["core-pack"],
          blocked: [],
          required: ["missing-pack"],
        },
      }),
    ).toBe("All required packs must also be in allowed list when allowlist is set");
  });
});
