import { describe, expect, it, vi } from "vitest";
import type { ApprovalResponse } from "../../../shared/types";
import { respondToApprovalWithDisplayedRevision } from "../handlers";
import { ApprovalResponseSchema } from "../../utils/validation";

describe("approval response revision IPC contract", () => {
  it("validates and forwards the exact displayed revision and session action", async () => {
    const expectedRevisionHash = "a".repeat(64);
    const response = ApprovalResponseSchema.parse({
      approvalId: "550e8400-e29b-41d4-a716-446655440000",
      action: "allow_session",
      expectedRevisionHash,
    }) as ApprovalResponse;
    const respondToApproval = vi.fn().mockResolvedValue("handled");
    const daemon = { respondToApproval } as never;
    const attribution = { principalId: "operator-1", role: "reviewer" as const };

    await expect(
      respondToApprovalWithDisplayedRevision(daemon, response, attribution),
    ).resolves.toBe("handled");
    expect(respondToApproval).toHaveBeenCalledWith(
      response.approvalId,
      true,
      "allow_session",
      attribution,
      expectedRevisionHash,
    );
  });

  it("rejects a malformed expected revision", () => {
    expect(
      ApprovalResponseSchema.safeParse({
        approvalId: "550e8400-e29b-41d4-a716-446655440000",
        approved: true,
        expectedRevisionHash: "latest",
      }).success,
    ).toBe(false);
  });
});
