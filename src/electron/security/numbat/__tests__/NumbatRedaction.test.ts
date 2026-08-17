import { describe, expect, it } from "vitest";
import { redactAgentSecurityRecord, redactAgentSecurityString } from "../NumbatRedaction";

describe("redactAgentSecurityRecord", () => {
  it("preserves repeated shared references that are not cycles", () => {
    const shared = { rule: "safe-rule", token: "secret-value" };

    const result = redactAgentSecurityRecord({ match: shared, evidence: { rule: shared } });

    expect(result).toEqual({
      match: { rule: "safe-rule", token: "[REDACTED]" },
      evidence: { rule: { rule: "safe-rule", token: "[REDACTED]" } },
    });
  });

  it("still marks an actual recursive path as circular", () => {
    const recursive: Record<string, unknown> = {};
    recursive.self = recursive;

    expect(redactAgentSecurityRecord(recursive)).toEqual({ self: "[CIRCULAR]" });
  });

  it("redacts shell assignments, structured credentials, and authorization headers", () => {
    const input = [
      "AWS_SECRET_ACCESS_KEY=cloud-secret node script.js",
      "PASSWORD='database-password'",
      '"api_key": "provider-key"',
      "Authorization: Basic dXNlcjpwYXNz",
    ].join("\n");

    const result = redactAgentSecurityString(input);

    expect(result).not.toContain("cloud-secret");
    expect(result).not.toContain("database-password");
    expect(result).not.toContain("provider-key");
    expect(result).not.toContain("dXNlcjpwYXNz");
    expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
