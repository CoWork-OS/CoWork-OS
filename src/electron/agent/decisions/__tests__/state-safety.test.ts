import { describe, expect, it } from "vitest";
import {
  DECISION_REDACTED,
  DECISION_TRUNCATED,
  redactDecisionText,
  redactDecisionValue,
} from "../state-safety";

describe("decision state safety", () => {
  it("redacts credential-shaped text before transport", () => {
    expect(redactDecisionText("Authorization: Bearer super-secret")).toContain(DECISION_REDACTED);
    expect(redactDecisionText("api_key=hidden-value")).toBe("api_key=[REDACTED]");
    expect(redactDecisionText("token: hidden-token")).toBe("token: [REDACTED]");
  });

  it("redacts secret keys and marks truncated projections", () => {
    const projection = redactDecisionValue(
      {
        password: "do-not-send",
        nested: { token: "also-private" },
        items: ["one", "two", "three"],
      },
      { maxArrayItems: 2 },
    ) as Record<string, unknown>;

    expect(projection.password).toBe(DECISION_REDACTED);
    expect((projection.nested as Record<string, unknown>).token).toBe(DECISION_REDACTED);
    expect(projection.items).toEqual(["one", "two", DECISION_TRUNCATED]);
  });
});
