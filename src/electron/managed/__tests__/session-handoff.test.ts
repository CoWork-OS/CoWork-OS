import { describe, expect, it } from "vitest";
import { parseHandoffManifest, safeRelativeArtifactPath } from "../session-handoff";

describe("session handoff helpers", () => {
  it("accepts only workspace-relative paths without traversal", () => {
    expect(safeRelativeArtifactPath("reports/q3.md")).toBe("reports/q3.md");
    expect(safeRelativeArtifactPath("reports\\q3.md")).toBe("reports/q3.md");
    for (const unsafe of ["", "/etc/passwd", "C:/x", "../x", "a/../../x", "a//b", "./a", "a/b?"]) {
      expect(safeRelativeArtifactPath(unsafe)).toBeUndefined();
    }
  });

  it("rejects manifests that are not JSON or not a handoff package", () => {
    expect(() => parseHandoffManifest("{")).toThrow(/not valid JSON/);
    expect(() => parseHandoffManifest(JSON.stringify({ kind: "something-else" }))).toThrow(
      /not a cowork\.session-handoff v1 package/,
    );
  });
});
