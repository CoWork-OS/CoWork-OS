import { describe, expect, it } from "vitest";

import {
  isSameAcceptedComposerDraftFence,
  isSameComposerDraftSubmission,
  isTaskCreationAccepted,
} from "../composer-draft-fencing";

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

  it("keeps an optimistic clear scoped to the same task and draft revision", () => {
    const base = {
      fenceDraftKey: "local:workspace:task:main",
      currentDraftKey: "local:workspace:task:main",
      fenceTaskId: "task",
      currentTaskId: "task",
      fenceRevision: 9,
      currentRevision: 9,
    };
    expect(isSameAcceptedComposerDraftFence(base)).toBe(true);
    expect(isSameAcceptedComposerDraftFence({ ...base, currentTaskId: "other-task" })).toBe(false);
    expect(isSameAcceptedComposerDraftFence({ ...base, currentRevision: 10 })).toBe(false);
  });
});
