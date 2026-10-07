import { describe, expect, it } from "vitest";
import {
  approvalResponseDisposition,
  isResolvedApprovalResponse,
} from "../approval-response-result";

describe("approval response outcomes", () => {
  it.each(["handled", "duplicate"])("dismisses a confirmed %s result", (status) => {
    expect(approvalResponseDisposition(status)).toBe("resolved");
    expect(isResolvedApprovalResponse(status)).toBe(true);
  });

  it.each([
    ["not_found", "stale"],
    ["in_progress", "in_progress"],
    [undefined, "unknown"],
    ["unexpected", "unknown"],
  ] as const)("keeps an unconfirmed %s result visible", (status, disposition) => {
    expect(approvalResponseDisposition(status)).toBe(disposition);
    expect(isResolvedApprovalResponse(status)).toBe(false);
  });
});
