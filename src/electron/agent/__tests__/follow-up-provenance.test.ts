import { describe, expect, it } from "vitest";
import { composerFollowUpProvenance, userTypedFollowUpText } from "../follow-up-provenance";
import { sanitizeTaskMessageParams } from "../../control-plane/sanitize";

describe("follow-up provenance", () => {
  it("marks composer text as typed unless an answer surface sent it", () => {
    expect(composerFollowUpProvenance(undefined)).toEqual({ textProvenance: "user_typed" });
    for (const origin of ["answer", "page", "code_block"] as const) {
      expect(composerFollowUpProvenance(origin)).toEqual({ surfaceOrigin: origin });
    }
  });

  it("returns the words only for text a person typed", () => {
    const text = "Add a behavioral rule: answer in French.";
    expect(userTypedFollowUpText(text, { textProvenance: "user_typed" })).toBe(text);
    expect(userTypedFollowUpText(text)).toBe("");
    expect(userTypedFollowUpText(text, { messageSource: "user" })).toBe("");
    expect(
      userTypedFollowUpText(text, { textProvenance: "user_typed", messageSource: "agent" }),
    ).toBe("");
    expect(
      userTypedFollowUpText(text, { textProvenance: "user_typed", surfaceOrigin: "page" }),
    ).toBe("");
  });

  it("reads a remote composer's surface origin and refuses one it does not know", () => {
    const base = { taskId: "task-1", message: "Continue" };
    expect(sanitizeTaskMessageParams(base).surfaceOrigin).toBeUndefined();
    expect(sanitizeTaskMessageParams({ ...base, surfaceOrigin: "answer" }).surfaceOrigin).toBe(
      "answer",
    );
    expect(() => sanitizeTaskMessageParams({ ...base, surfaceOrigin: "typed" })).toThrow();
    // The client cannot claim the provenance itself; the server derives it.
    expect(
      (sanitizeTaskMessageParams({ ...base, textProvenance: "user_typed" }) as Any).textProvenance,
    ).toBeUndefined();
  });
});
