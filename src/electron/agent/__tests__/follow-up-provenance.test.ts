import { describe, expect, it } from "vitest";
import { composerFollowUpProvenance, userTypedFollowUpText } from "../follow-up-provenance";
import { sanitizeTaskMessageParams } from "../../control-plane/sanitize";
import { TaskMessageSchema } from "../../utils/validation";
import { surfaceOriginNote } from "../../../shared/answer-surfaces/actions";

describe("follow-up provenance", () => {
  it("marks composer text as typed unless an answer surface sent it", () => {
    expect(composerFollowUpProvenance(undefined)).toEqual({ textProvenance: "user_typed" });
    for (const origin of ["answer", "page", "code_block", "browser_page"] as const) {
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
    expect(
      sanitizeTaskMessageParams({ ...base, surfaceOrigin: "browser_page" }).surfaceOrigin,
    ).toBe("browser_page");
    expect(() => sanitizeTaskMessageParams({ ...base, surfaceOrigin: "typed" })).toThrow();
    // The client cannot claim the provenance itself; the server derives it.
    expect(
      (sanitizeTaskMessageParams({ ...base, textProvenance: "user_typed" }) as Any).textProvenance,
    ).toBeUndefined();
  });

  it("accepts in-app browser page text over IPC and tells the model it is page content", () => {
    const send = { taskId: "8f4e2f62-3c1b-4c55-9f0e-6f1f3f5d2a10", message: "About this text" };
    expect(TaskMessageSchema.parse({ ...send, surfaceOrigin: "browser_page" }).surfaceOrigin).toBe(
      "browser_page",
    );
    expect(() => TaskMessageSchema.parse({ ...send, surfaceOrigin: "typed" })).toThrow();
    const note = surfaceOriginNote("browser_page");
    expect(note).toContain("in-app browser");
    expect(note).toContain("not their instructions");
  });
});
