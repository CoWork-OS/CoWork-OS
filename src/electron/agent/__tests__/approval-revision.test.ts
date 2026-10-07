import { describe, expect, it } from "vitest";
import { approvalRequestRevisionHash, approvalRevisionMatches } from "../approval-revision";
const request = {
  taskId: "task",
  type: "run_command" as const,
  description: "Review command",
  details: { command: "fixture", authorization: { version: 1, key: "authority" } },
  requestedAt: 100,
};
describe("approval transport revision", () => {
  it("is canonical across object key order but keeps array order", () => {
    const expected = approvalRequestRevisionHash(request);
    expect(
      approvalRequestRevisionHash({
        ...request,
        details: { authorization: { key: "authority", version: 1 }, command: "fixture" },
      }),
    ).toBe(expected);
    expect(approvalRequestRevisionHash({ ...request, details: { paths: ["a", "b"] } })).not.toBe(
      approvalRequestRevisionHash({ ...request, details: { paths: ["b", "a"] } }),
    );
  });
  it.each(["taskId", "type", "description", "details", "requestedAt"])(
    "invalidates changed %s",
    (field) => {
      expect(
        approvalRevisionMatches(
          { ...request, [field]: field === "requestedAt" ? 101 : "changed" } as Any,
          approvalRequestRevisionHash(request),
        ),
      ).toBe(false);
    },
  );
  it("fails closed on malformed hashes and oversized or circular request details", () => {
    expect(approvalRevisionMatches(request, "malformed")).toBe(false);
    expect(
      approvalRevisionMatches(
        { ...request, details: { text: "x".repeat(256001) } },
        approvalRequestRevisionHash(request),
      ),
    ).toBe(false);
    const circular: Any = {};
    circular.self = circular;
    expect(
      approvalRevisionMatches(
        { ...request, details: circular },
        approvalRequestRevisionHash(request),
      ),
    ).toBe(false);
  });
});
