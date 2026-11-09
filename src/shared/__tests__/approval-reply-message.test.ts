import { describe, expect, it } from "vitest";
import { approvalReplyDisplayText, buildApprovalReplyMessage } from "../approval-reply-message";

describe("approval reply message", () => {
  it("tells the agent what the reply answers and shows the person only their words", () => {
    const message = buildApprovalReplyMessage("Keep the build folder\nand list it");
    expect(message).toBe(
      "Reply to your permission request (the operation was not run): Keep the build folder\nand list it",
    );
    expect(approvalReplyDisplayText(message)).toBe("Keep the build folder\nand list it");
    expect(approvalReplyDisplayText("Reply to the email")).toBe("Reply to the email");
  });
});
