import { describe, expect, it, vi } from "vitest";
import { parseCliApprovalResponse, respondToCliApprovalResponse } from "../approval-cli";

const argv = (hash: string) => [
  "--cowork-cli-approval-response",
  "--approval-id",
  "approval-1",
  "--revision-hash",
  hash,
  "--approved",
];
describe("CLI desktop approval handoff", () => {
  it.each(["", "latest", "A".repeat(64)])(
    "refuses malformed or missing displayed hashes %s",
    (hash) => {
      expect(parseCliApprovalResponse(argv(hash))).toBeNull();
    },
  );
  it("requires exactly one explicit decision", () => {
    expect(parseCliApprovalResponse([...argv("a".repeat(64)), "--rejected"])).toBeNull();
    expect(parseCliApprovalResponse(argv("a".repeat(64)).slice(0, -1))).toBeNull();
  });
  it.each([true, false])(
    "forwards the operator's displayed hash for approved=%s",
    async (approved) => {
      const input = argv("a".repeat(64));
      if (!approved) input[input.length - 1] = "--rejected";
      const response = parseCliApprovalResponse(input);
      expect(response).toEqual({
        approvalId: "approval-1",
        approved,
        expectedRevisionHash: "a".repeat(64),
      });
      if (!response) throw new Error("Missing fixture decision");
      const respondToApproval = vi.fn().mockResolvedValue("not_found");
      await expect(
        respondToCliApprovalResponse({ respondToApproval } as never, response),
      ).resolves.toBe("not_found");
      expect(respondToApproval).toHaveBeenCalledWith(
        "approval-1",
        approved,
        undefined,
        undefined,
        "a".repeat(64),
      );
    },
  );
});
