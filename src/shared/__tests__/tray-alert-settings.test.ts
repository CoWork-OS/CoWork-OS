import { describe, expect, it } from "vitest";
import { isNotificationSound, wantsAttentionAlert } from "../types";

const on = {
  showNotifications: true,
  showApprovalNotifications: true,
  showQuestionNotifications: true,
};

describe("wantsAttentionAlert", () => {
  it("follows the toggle for the kind of request", () => {
    expect(wantsAttentionAlert(on, "approval")).toBe(true);
    expect(wantsAttentionAlert(on, "question")).toBe(true);
    expect(wantsAttentionAlert({ ...on, showApprovalNotifications: false }, "approval")).toBe(
      false,
    );
    expect(wantsAttentionAlert({ ...on, showApprovalNotifications: false }, "question")).toBe(true);
    expect(wantsAttentionAlert({ ...on, showQuestionNotifications: false }, "question")).toBe(
      false,
    );
  });

  it("is off for both kinds when desktop alerts are off", () => {
    const off = { ...on, showNotifications: false };
    expect(wantsAttentionAlert(off, "approval")).toBe(false);
    expect(wantsAttentionAlert(off, "question")).toBe(false);
  });
});

describe("isNotificationSound", () => {
  it("accepts only the offered sounds", () => {
    expect(isNotificationSound("default")).toBe(true);
    expect(isNotificationSound("none")).toBe(true);
    expect(isNotificationSound("Glass")).toBe(true);
    expect(isNotificationSound("glass")).toBe(false);
    expect(isNotificationSound("/System/Library/Sounds/Glass.aiff")).toBe(false);
    expect(isNotificationSound(undefined)).toBe(false);
  });
});
