import { describe, expect, it } from "vitest";
import { MESSAGE_FEEDBACK_REASONS } from "../memory-ipc-validation";
import {
  MESSAGE_FEEDBACK_REASON_OPTIONS,
  messageFeedbackReasonLabel,
} from "../../../shared/message-feedback-reasons";

describe("message feedback reasons", () => {
  it("offers exactly the reasons the main process accepts", () => {
    expect(MESSAGE_FEEDBACK_REASON_OPTIONS.map(([code]) => code)).toEqual([
      ...MESSAGE_FEEDBACK_REASONS,
    ]);
  });

  // Live 2026-11-09: Usage Insights listed "too_verbose" under Top rejection reasons.
  it("shows stored reasons as words", () => {
    expect(messageFeedbackReasonLabel("too_verbose")).toBe("Too verbose");
    expect(messageFeedbackReasonLabel("unsafe")).toBe("Unsafe / unwanted");
    expect(messageFeedbackReasonLabel("missed_the_point")).toBe("Missed the point");
  });
});
