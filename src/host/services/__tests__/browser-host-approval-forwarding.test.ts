import { describe, expect, it, vi } from "vitest";
import type { ApprovalResponseAction, SessionActionAttribution } from "../../../shared/types";
import { createBrowserApprovalCommandAdapter } from "../browser-host-application";

describe("browser host approval command forwarding", () => {
  it("forwards the displayed revision and existing decision metadata to the daemon unchanged", async () => {
    const respondToApproval = vi.fn(async () => "handled" as const);
    const adapter = createBrowserApprovalCommandAdapter({ respondToApproval });
    const action: ApprovalResponseAction = "allow_once";
    const attribution: SessionActionAttribution = {
      principalId: "principal-1",
      role: "owner",
    };
    const revisionHash = "a".repeat(64);

    await expect(adapter("approval-1", true, action, attribution, revisionHash)).resolves.toBe(
      "handled",
    );
    expect(respondToApproval).toHaveBeenCalledWith(
      "approval-1",
      true,
      action,
      attribution,
      revisionHash,
    );
  });
});
