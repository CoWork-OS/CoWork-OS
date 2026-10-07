import { describe, expect, it, vi } from "vitest";
import {
  readAuthorizedApprovalDraftPreview,
  readAuthorizedInlineApprovalDraftReview,
} from "../approval-draft-preview";
import { approvalRequestRevisionHash } from "../../agent/approval-revision";
const request = {
  id: "request",
  taskId: "task",
  type: "data_export" as const,
  description: "Review",
  details: { reviewFiles: ["draft.md"] },
  requestedAt: 1,
};
function fixture() {
  return {
    findById: vi.fn().mockResolvedValue({ taskId: "task" }),
    authorize: vi.fn().mockResolvedValue({}),
    draftPreviews: vi.fn().mockResolvedValue([
      {
        reference: "draft.md",
        sha256: "a".repeat(64),
        text: "private fixture",
        truncated: false,
      },
    ]),
  };
}
describe("local authorized approval draft previews", () => {
  it("checks caller authority before reading and again before returning private content", async () => {
    const deps = fixture();
    expect(await readAuthorizedApprovalDraftPreview(request, deps)).toEqual(
      await deps.draftPreviews.mock.results[0].value,
    );
    expect(deps.draftPreviews).toHaveBeenCalledWith(
      request.id,
      approvalRequestRevisionHash(request),
    );
    expect(deps.authorize).toHaveBeenCalledTimes(2);
    expect(deps.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      deps.draftPreviews.mock.invocationCallOrder[0],
    );
    expect(deps.authorize.mock.invocationCallOrder[1]).toBeGreaterThan(
      deps.draftPreviews.mock.invocationCallOrder[0],
    );
  });
  it("does not read content for an unauthorized caller or a different task", async () => {
    const deps = fixture();
    deps.authorize.mockRejectedValue(new Error("Not authorized"));
    await expect(readAuthorizedApprovalDraftPreview(request, deps)).rejects.toThrow(
      "Not authorized",
    );
    expect(deps.draftPreviews).not.toHaveBeenCalled();
    const other = fixture();
    await expect(
      readAuthorizedApprovalDraftPreview({ ...request, taskId: "other" }, other),
    ).rejects.toThrow("not found");
    expect(other.authorize).not.toHaveBeenCalled();
    expect(other.draftPreviews).not.toHaveBeenCalled();
  });
  it("withholds content when caller authority is revoked while the worker reads", async () => {
    const deps = fixture();
    deps.authorize.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Revoked"));
    await expect(readAuthorizedApprovalDraftPreview(request, deps)).rejects.toThrow("Revoked");
    expect(deps.draftPreviews).toHaveBeenCalledOnce();
  });
});

function inlineFixture() {
  const approval = {
    ...request,
    status: "pending" as const,
    requestedAt: Date.now(),
    details: {
      draftRevision: {
        version: 1,
        state: "bound",
        entries: [{ reference: "draft.md", status: "present", sha256: "a".repeat(64), size: 15 }],
      },
    },
  };
  const binding = {
    approvalId: approval.id,
    taskId: approval.taskId,
    revisionHash: approvalRequestRevisionHash(approval),
  };
  return {
    ...fixture(),
    findInput: vi.fn().mockResolvedValue({ taskId: "task", status: "pending" }),
    getApprovalBinding: vi.fn().mockResolvedValue(binding),
    findApproval: vi.fn().mockResolvedValue(approval),
    approval,
    binding,
  };
}
const inlineRequest = { inputRequestId: "input", taskId: "task" };
describe("durable inline draft review authority", () => {
  it("reads the stored revision with pre and post audience checks", async () => {
    const deps = inlineFixture();
    const review = await readAuthorizedInlineApprovalDraftReview(inlineRequest, deps);
    expect(review?.draft.state).toBe("bound");
    expect(review?.previews[0].text).toBe("private fixture");
    expect(deps.draftPreviews).toHaveBeenCalledWith(
      deps.binding.approvalId,
      deps.binding.revisionHash,
    );
    expect(deps.authorize).toHaveBeenCalledTimes(2);
    expect(deps.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      deps.draftPreviews.mock.invocationCallOrder[0],
    );
    expect(deps.authorize.mock.invocationCallOrder[1]).toBeGreaterThan(
      deps.draftPreviews.mock.invocationCallOrder[0],
    );
  });
  it("leaves ordinary unlinked questions without a file read", async () => {
    const deps = inlineFixture();
    deps.getApprovalBinding.mockResolvedValue(undefined);
    expect(await readAuthorizedInlineApprovalDraftReview(inlineRequest, deps)).toBeUndefined();
    expect(deps.findApproval).not.toHaveBeenCalled();
    expect(deps.draftPreviews).not.toHaveBeenCalled();
  });
  it.each([
    "input-task",
    "input-status",
    "link-task",
    "approval-task",
    "approval-id",
    "approval-status",
    "revision",
    "expired",
    "future",
  ])("rejects %s before private file read", async (failure) => {
    const deps = inlineFixture();
    if (failure === "input-task")
      deps.findInput.mockResolvedValue({ taskId: "other", status: "pending" });
    if (failure === "input-status")
      deps.findInput.mockResolvedValue({ taskId: "task", status: "submitted" });
    if (failure === "link-task")
      deps.getApprovalBinding.mockResolvedValue({ ...deps.binding, taskId: "other" });
    if (failure === "approval-id")
      deps.findApproval.mockResolvedValue({ ...deps.approval, id: "other" });
    if (failure === "approval-task")
      deps.findApproval.mockResolvedValue({ ...deps.approval, taskId: "other" });
    if (failure === "approval-status")
      deps.findApproval.mockResolvedValue({ ...deps.approval, status: "approved" });
    if (failure === "revision")
      deps.findApproval.mockResolvedValue({ ...deps.approval, description: "changed" });
    if (failure === "expired")
      deps.findApproval.mockResolvedValue({ ...deps.approval, requestedAt: Date.now() - 300_000 });
    if (failure === "future")
      deps.findApproval.mockResolvedValue({ ...deps.approval, requestedAt: Date.now() + 300_000 });
    expect(await readAuthorizedInlineApprovalDraftReview(inlineRequest, deps)).toBeUndefined();
    expect(deps.draftPreviews).not.toHaveBeenCalled();
  });
  it.each(["input-decision", "rebind", "approval-decision", "approval-change"])(
    "withholds a read after concurrent %s",
    async (failure) => {
      const deps = inlineFixture();
      if (failure === "input-decision")
        deps.findInput
          .mockResolvedValueOnce({ taskId: "task", status: "pending" })
          .mockResolvedValue({ taskId: "task", status: "dismissed" });
      if (failure === "rebind")
        deps.getApprovalBinding
          .mockResolvedValueOnce(deps.binding)
          .mockResolvedValue({ ...deps.binding, approvalId: "other" });
      if (failure === "approval-decision")
        deps.findApproval
          .mockResolvedValueOnce(deps.approval)
          .mockResolvedValue({ ...deps.approval, status: "approved" });
      if (failure === "approval-change")
        deps.findApproval
          .mockResolvedValueOnce(deps.approval)
          .mockResolvedValue({ ...deps.approval, description: "changed" });
      expect(await readAuthorizedInlineApprovalDraftReview(inlineRequest, deps)).toBeUndefined();
      expect(deps.draftPreviews).toHaveBeenCalledOnce();
    },
  );
  it("denies before private read and withholds on post-read revocation", async () => {
    const deps = inlineFixture();
    deps.authorize.mockRejectedValue(new Error("Denied"));
    await expect(readAuthorizedInlineApprovalDraftReview(inlineRequest, deps)).rejects.toThrow(
      "Denied",
    );
    expect(deps.draftPreviews).not.toHaveBeenCalled();
    const after = inlineFixture();
    after.authorize.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Revoked"));
    await expect(readAuthorizedInlineApprovalDraftReview(inlineRequest, after)).rejects.toThrow(
      "Revoked",
    );
    expect(after.draftPreviews).toHaveBeenCalledOnce();
  });
  it("uses only the durable link even when the caller supplies a different approval", async () => {
    const deps = inlineFixture();
    await readAuthorizedInlineApprovalDraftReview(
      { ...inlineRequest, approvalId: "forged", revisionHash: "b".repeat(64) },
      deps,
    );
    expect(deps.findApproval).toHaveBeenCalledWith("request");
  });
});
