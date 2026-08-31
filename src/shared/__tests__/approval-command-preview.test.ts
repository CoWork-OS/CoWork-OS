import { describe, expect, it } from "vitest";
import { buildApprovalCommandPreview } from "../approval-command-preview";

describe("buildApprovalCommandPreview", () => {
  it("keeps short commands unchanged", () => {
    const preview = buildApprovalCommandPreview("git status --short");

    expect(preview).toEqual({
      text: "git status --short",
      truncated: false,
    });
  });

  it("collapses oversized heredoc bodies", () => {
    const preview = buildApprovalCommandPreview(
      [
        "cat <<'EOF' > /tmp/outline.md",
        "# Chapter 1",
        "Line 2",
        "Line 3",
        "Line 4",
        "Line 5",
        "Line 6",
        "Line 7",
        "EOF",
      ].join("\n"),
    );

    expect(preview.truncated).toBe(true);
    expect(preview.text).toContain("cat <<'EOF' > /tmp/outline.md");
    expect(preview.text).toContain("[inline content truncated: 2 more lines hidden]");
    expect(preview.text).toContain("EOF");
  });

  it("caps extremely long previews", () => {
    const preview = buildApprovalCommandPreview(
      Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
    );

    expect(preview.truncated).toBe(true);
    expect(preview.text).toContain("[preview truncated:");
  });
});
