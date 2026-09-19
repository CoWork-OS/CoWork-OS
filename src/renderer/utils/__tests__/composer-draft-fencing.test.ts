import { describe, expect, it } from "vitest";

import { isSameComposerDraftSubmission, isTaskCreationAccepted } from "../composer-draft-fencing";

describe("composer draft submission fencing", () => {
  it("treats only explicit task-creation false as rejection", () => {
    expect(isTaskCreationAccepted(undefined)).toBe(true);
    expect(isTaskCreationAccepted(true)).toBe(true);
    expect(isTaskCreationAccepted(false)).toBe(false);
  });

  it("rejects a clear when the key, revision, or text changed", () => {
    const base = {
      submittedDraftKey: "local:workspace:task:main",
      currentDraftKey: "local:workspace:task:main",
      submittedRevision: 4,
      currentRevision: 4,
      submittedText: "keep this",
      currentText: "keep this",
    };
    expect(isSameComposerDraftSubmission(base)).toBe(true);
    expect(isSameComposerDraftSubmission({ ...base, currentRevision: 5 })).toBe(false);
    expect(isSameComposerDraftSubmission({ ...base, currentText: "keep this plus more" })).toBe(
      false,
    );
    expect(
      isSameComposerDraftSubmission({ ...base, currentDraftKey: "local:workspace:other:main" }),
    ).toBe(false);
  });
});
