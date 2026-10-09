import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../../../shared/types";
import {
  approvalMatchesBrowserSession,
  describeBrowserApproval,
  isBrowserTabApproval,
} from "../BrowserApprovalCard";

function approval(details: Record<string, unknown>, status = "pending"): ApprovalRequest {
  return {
    id: "a1",
    taskId: "t1",
    type: "network_access",
    description: "CoWork wants to search your browsing history",
    details,
    status,
    requestedAt: 1,
  } as ApprovalRequest;
}

describe("browser approval card", () => {
  it("docks browser approvals other than opening the browser itself", () => {
    expect(isBrowserTabApproval(approval({ kind: "browser_use_domain_access" }))).toBe(true);
    expect(isBrowserTabApproval(approval({ kind: "browser_upload" }))).toBe(true);
    expect(isBrowserTabApproval(approval({ kind: "browser_visible_workbench" }))).toBe(false);
    expect(isBrowserTabApproval(approval({ kind: "shell_command" }))).toBe(false);
    expect(isBrowserTabApproval(approval({ kind: "browser_upload" }, "approved"))).toBe(false);
    expect(isBrowserTabApproval(null)).toBe(false);
  });

  it("matches the workbench session when the approval names one", () => {
    expect(approvalMatchesBrowserSession(approval({ browserSessionId: "s1" }), "s1")).toBe(true);
    expect(approvalMatchesBrowserSession(approval({ browserSessionId: "s2" }), "s1")).toBe(false);
    expect(approvalMatchesBrowserSession(approval({}), "s1")).toBe(true);
  });

  it("offers the dialog's choices", () => {
    const site = describeBrowserApproval(
      approval({ kind: "browser_use_domain_access", origin: "https://shop.example" }),
    );
    expect(site.subject).toBe("https://shop.example");
    expect(site.choices.map((choice) => choice.action)).toEqual([
      "deny_once",
      "allow_workspace",
      "allow_session",
    ]);

    const upload = describeBrowserApproval(
      approval({ kind: "browser_upload", filePath: "/ws/report.pdf", host: "forms.example" }),
    );
    expect(upload.subject).toBe("report.pdf → forms.example");
    expect(upload.choices.map((choice) => choice.action)).toEqual(["deny_once", "allow_once"]);
  });
});
