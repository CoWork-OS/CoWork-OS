import { describe, expect, it } from "vitest";
import {
  inlineResponsibilityActionReviewPresentation,
  responsibilityActionReviewPresentation,
  resolveInlineApprovalDraftReviewResponse,
} from "../approval-draft-presentation";

const content = "Reviewed π content\n";
const validReview = {
  version: 1,
  operation: { connectorId: "workspace_files", method: "write_file" },
  canonicalPath: "notes/proposal.md",
  content,
  contentSha256: "9f01ed997345b7e1f7fcf1e5c780764cd7bbbbd70f01df17a7b5a3f78e5d2adf",
  contentBytes: new TextEncoder().encode(content).byteLength,
  responsibilityRun: {
    id: "run-1",
    revision: 3,
    controlVersion: 4,
    workspaceId: "workspace-1",
    agentRoleId: "writer",
  },
};

function present(review: unknown) {
  return responsibilityActionReviewPresentation({ responsibilityActionReview: review });
}

describe("responsibility action review presentation", () => {
  it("preserves the complete reviewed write and checks UTF-8 byte size", () => {
    expect(present(validReview)).toEqual({
      state: "valid",
      review: {
        canonicalPath: validReview.canonicalPath,
        content: validReview.content,
        contentSha256: validReview.contentSha256,
        contentBytes: validReview.contentBytes,
        responsibilityRun: validReview.responsibilityRun,
      },
    });
  });

  it("preserves a leading UTF-8 BOM in the reviewed content and hash binding", () => {
    const bomContent = `\uFEFF${content}`;
    const contentSha256 = "d1c9ada3408be79436ac8f6ac7c41605dd67504d0a2f73502721396b2b563527";
    const parsed = present({
      ...validReview,
      content: bomContent,
      contentSha256,
      contentBytes: new TextEncoder().encode(bomContent).byteLength,
    });

    expect(parsed).toMatchObject({
      state: "valid",
      review: {
        content: bomContent,
        contentSha256,
        contentBytes: new TextEncoder().encode(bomContent).byteLength,
      },
    });
  });

  it("distinguishes an absent review from an invalid mandatory review", () => {
    expect(responsibilityActionReviewPresentation({ permissionPrompt: {} })).toEqual({
      state: "absent",
    });
    expect(present(undefined)).toEqual({ state: "invalid" });
  });

  it.each([
    { ...validReview, version: 2 },
    { ...validReview, operation: { connectorId: "workspace_files", method: "delete_file" } },
    { ...validReview, canonicalPath: "/absolute/file.md" },
    { ...validReview, canonicalPath: "notes/../private.md" },
    { ...validReview, canonicalPath: "notes\\private.md" },
    { ...validReview, contentSha256: "A".repeat(64) },
    { ...validReview, contentBytes: validReview.contentBytes + 1 },
    { ...validReview, responsibilityRun: { ...validReview.responsibilityRun, revision: 0 } },
    { ...validReview, responsibilityRun: { ...validReview.responsibilityRun, revision: -1 } },
  ])("fails closed for malformed review payloads", (review) => {
    expect(present(review)).toEqual({ state: "invalid" });
  });

  it("rejects proposed content over the 256,000-byte canonical bound", () => {
    const oversized = "x".repeat(256_001);
    expect(
      present({
        ...validReview,
        content: oversized,
        contentBytes: new TextEncoder().encode(oversized).byteLength,
      }),
    ).toEqual({ state: "invalid" });
  });

  it("rejects content strings that cannot be represented exactly as UTF-8", () => {
    const malformed = "unpaired \ud800 surrogate";
    expect(
      present({
        ...validReview,
        content: malformed,
        contentBytes: new TextEncoder().encode(malformed).byteLength,
      }),
    ).toEqual({ state: "invalid" });
  });

  it("accepts a trusted inline result only when its base revision is bound to the same target", () => {
    const { version: _version, operation: _operation, ...review } = validReview;
    const response = {
      required: true,
      state: "valid",
      review,
    };
    const draft = {
      state: "bound",
      files: [{ reference: review.canonicalPath, status: "missing" }],
    };

    expect(inlineResponsibilityActionReviewPresentation(response, true, draft)).toEqual({
      state: "valid",
      review: {
        canonicalPath: review.canonicalPath,
        content: review.content,
        contentSha256: review.contentSha256,
        contentBytes: review.contentBytes,
        responsibilityRun: review.responsibilityRun,
      },
    });
    expect(
      inlineResponsibilityActionReviewPresentation(response, true, {
        state: "bound",
        files: [{ reference: "other.md", status: "missing" }],
      }),
    ).toEqual({ state: "invalid" });
    expect(inlineResponsibilityActionReviewPresentation(undefined, true, draft)).toEqual({
      state: "invalid",
    });
    expect(inlineResponsibilityActionReviewPresentation(undefined, false)).toBeUndefined();
  });

  it("normalizes the inline review result and makes a missing marked result invalid", () => {
    const { version: _version, operation: _operation, ...review } = validReview;
    const response = resolveInlineApprovalDraftReviewResponse(
      {
        draft: { state: "bound", files: [{ reference: review.canonicalPath, status: "missing" }] },
        previews: [],
        responsibilityActionReview: { required: true, state: "valid", review },
      },
      true,
    );
    expect(response?.responsibilityActionReview).toMatchObject({
      state: "valid",
      review: { canonicalPath: review.canonicalPath, content },
    });
    expect(
      resolveInlineApprovalDraftReviewResponse(undefined, true)?.responsibilityActionReview,
    ).toEqual({ state: "invalid" });
    expect(resolveInlineApprovalDraftReviewResponse(undefined, false)).toBeUndefined();
  });
});
