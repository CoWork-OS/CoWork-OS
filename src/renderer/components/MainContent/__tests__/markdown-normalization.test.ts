import { describe, expect, it } from "vitest";
import { normalizeTimelineTitleMarkdownForDisplay } from "../markdown-normalization";

describe("normalizeTimelineTitleMarkdownForDisplay", () => {
  it("escapes a single # in prose but leaves fenced code untouched", () => {
    const bash = "```bash\n# route check\necho hi\n```";
    const tilde = "~~~sh\n# list files\nls\n~~~";
    const input = `## Summary\n# route check\n\n${bash}\n\n${tilde}`;
    expect(normalizeTimelineTitleMarkdownForDisplay(input)).toBe(
      `## Summary\n\\# route check\n\n${bash}\n\n${tilde}`,
    );
  });

  it("does not add a backslash to # comments in a bash fence", () => {
    const input = "Ran:\n\n```bash\n# route check\necho hi\n```";
    expect(normalizeTimelineTitleMarkdownForDisplay(input)).toBe(input);
  });

  it("treats an unclosed fence as code to the end of the text", () => {
    const input = "Ran:\n\n```bash\n# route check\necho hi";
    expect(normalizeTimelineTitleMarkdownForDisplay(input)).toBe(input);
  });
});
