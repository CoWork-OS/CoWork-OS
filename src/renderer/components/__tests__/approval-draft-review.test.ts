import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalDraftReview, InlineApprovalDraftReview } from "../ApprovalDraftReview";
import type {
  ApprovalDraftPresentation,
  ResponsibilityActionReviewPresentation,
} from "../../../shared/approval-draft-presentation";
import { resolveInlineApprovalDraftReviewResponse } from "../../../shared/approval-draft-presentation";
import type { InputRequest } from "../../../shared/types";
const sha = "a".repeat(64);
const draft: ApprovalDraftPresentation = {
  state: "bound",
  files: [{ reference: "draft.md", status: "present", sha256: sha, size: 50 }],
};
it("escapes text and displays the version and truncation in the shared review", () => {
  const html = renderToStaticMarkup(
    createElement(ApprovalDraftReview, {
      draft,
      previews: [
        { reference: "draft.md", sha256: sha, text: "<script>private</script>", truncated: true },
      ],
    }),
  );
  expect(html).toContain("File version aaaaaaaaaaaa");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Preview truncated");
});
describe("file revision matching", () => {
  it.each([
    { reference: "other.md", sha256: sha },
    { reference: "draft.md", sha256: "b".repeat(64) },
  ])("does not display unmatched preview %j", (identity) => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDraftReview, {
        draft,
        previews: [{ ...identity, text: "WRONG REVISION", truncated: false }],
      }),
    );
    expect(html).not.toContain("WRONG REVISION");
    expect(html).toContain("Text preview unavailable");
  });
  it("shows no draft before a local linked review resolves", () => {
    const request = {
      id: "input",
      taskId: "task",
      status: "pending",
      questions: [],
      requestedAt: 1,
    } as InputRequest;
    expect(renderToStaticMarkup(createElement(InlineApprovalDraftReview, { request }))).toBe("");
    expect(renderToStaticMarkup(createElement(ApprovalDraftReview, { previews: [] }))).toBe("");
  });
});

describe("proposed write review", () => {
  const text = "First line\n<img src=x onerror=alert(1)> π\n";
  const responsibilityActionReview: ResponsibilityActionReviewPresentation = {
    state: "valid",
    review: {
      canonicalPath: "notes/proposal.md",
      content: text,
      contentSha256: "b".repeat(64),
      contentBytes: new TextEncoder().encode(text).byteLength,
      responsibilityRun: {
        id: "run-1",
        revision: 3,
        controlVersion: 4,
        workspaceId: "workspace-1",
        agentRoleId: "writer",
      },
    },
  };

  it("shows the full escaped proposed content separately from the current-file revision", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDraftReview, {
        draft,
        previews: [],
        responsibilityActionReview,
      }),
    );
    expect(html).toContain('aria-label="Draft revision for review"');
    expect(html).toContain('aria-label="Proposed write for responsibility review"');
    expect(html).toContain("notes/proposal.md");
    expect(html).toContain("b".repeat(64));
    expect(html).toContain(
      `${responsibilityActionReview.state === "valid" ? responsibilityActionReview.review.contentBytes : 0} bytes`,
    );
    expect(html).toContain("First line\n&lt;img src=x onerror=alert(1)&gt; π\n");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("Preview truncated");
  });

  it("shows invalid mandatory review as unavailable without proposed content", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDraftReview, {
        previews: [],
        responsibilityActionReview: { state: "invalid" },
      }),
    );
    expect(html).toContain("proposed write review is invalid");
    expect(html).not.toContain("Full proposed file content");
  });

  it("renders a leading BOM with its original byte count and hash", () => {
    const content = "\uFEFFReviewed π content\n";
    const contentSha256 = "d1c9ada3408be79436ac8f6ac7c41605dd67504d0a2f73502721396b2b563527";
    const html = renderToStaticMarkup(
      createElement(ApprovalDraftReview, {
        previews: [],
        responsibilityActionReview: {
          state: "valid",
          review: {
            canonicalPath: "notes/bom.md",
            content,
            contentSha256,
            contentBytes: new TextEncoder().encode(content).byteLength,
            responsibilityRun: {
              id: "run-1",
              revision: 1,
              controlVersion: 0,
              workspaceId: "workspace-1",
              agentRoleId: "writer",
            },
          },
        },
      }),
    );

    expect(html).toContain(contentSha256);
    expect(html).toContain(`${new TextEncoder().encode(content).byteLength} bytes`);
    expect(html).toContain(`<pre aria-label="Full proposed file content">${content}</pre>`);
  });

  it("renders the trusted inline result with proposed bytes separate from its base revision", () => {
    const proposedContent = "Exact inline content\nπ\n";
    const inlineReview = resolveInlineApprovalDraftReviewResponse(
      {
        draft: {
          state: "bound",
          files: [{ reference: "notes/inline.md", status: "missing" }],
        },
        previews: [],
        responsibilityActionReview: {
          required: true,
          state: "valid",
          review: {
            canonicalPath: "notes/inline.md",
            content: proposedContent,
            contentSha256: "c".repeat(64),
            contentBytes: new TextEncoder().encode(proposedContent).byteLength,
            responsibilityRun: {
              id: "run-inline",
              revision: 2,
              controlVersion: 1,
              workspaceId: "workspace-1",
              agentRoleId: "writer",
            },
          },
        },
      },
      true,
    );
    expect(inlineReview?.responsibilityActionReview?.state).toBe("valid");
    const html = renderToStaticMarkup(
      createElement(ApprovalDraftReview, {
        draft: inlineReview?.draft,
        previews: inlineReview?.previews ?? [],
        responsibilityActionReview: inlineReview?.responsibilityActionReview,
      }),
    );

    expect(html).toContain('aria-label="Draft revision for review"');
    expect(html).toContain('aria-label="Proposed write for responsibility review"');
    expect(html).toContain("Exact inline content\nπ\n");
    expect(html).toContain("notes/inline.md");
    expect(html).toContain("c".repeat(64));
    expect(html).toContain("Exact proposed content");
  });
});
