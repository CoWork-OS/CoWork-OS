import { describe, expect, it } from "vitest";
import {
  MAX_FOLLOW_UP_COMPLETION_NUDGES,
  shouldNudgeForFullerFollowUpAnswer,
} from "../executor-loop-utils";

describe("shouldNudgeForFullerFollowUpAnswer", () => {
  it("asks for a fuller answer a bounded number of times, then lets the answer stand", () => {
    const decisions = Array.from({ length: 6 }, (_, nudgesSoFar) =>
      shouldNudgeForFullerFollowUpAnswer({ completionFailed: true, nudgesSoFar }),
    );
    expect(decisions.filter(Boolean)).toHaveLength(MAX_FOLLOW_UP_COMPLETION_NUDGES);
    expect(MAX_FOLLOW_UP_COMPLETION_NUDGES).toBeLessThanOrEqual(2);
    expect(decisions.slice(MAX_FOLLOW_UP_COMPLETION_NUDGES).every((d) => !d)).toBe(true);
  });

  it("never nudges when the completion check passed", () => {
    expect(shouldNudgeForFullerFollowUpAnswer({ completionFailed: false, nudgesSoFar: 0 })).toBe(
      false,
    );
  });
});
