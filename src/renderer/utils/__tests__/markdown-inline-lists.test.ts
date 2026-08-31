import { describe, expect, it } from "vitest";
import {
  normalizeInlineLists,
  normalizeInlineHeadings,
  normalizeMarkdownForCollab,
  unwrapMarkdownCodeBlocks,
} from "../markdown-inline-lists";

describe("normalizeInlineLists", () => {
  it("splits inline numbered list with period", () => {
    const input =
      "Execution phases: 1. Detect (run `which claude`) 2. Install (if missing) 3. Authenticate (if required) 4. Execute (run commands)";
    const output = normalizeInlineLists(input);
    expect(output).toContain("1. Detect (run `which claude`)\n2. Install (if missing)");
    expect(output).toContain("2. Install (if missing)\n3. Authenticate (if required)");
    expect(output).toContain("3. Authenticate (if required)\n4. Execute (run commands)");
  });

  it("splits inline numbered list with parenthesis", () => {
    const input = "1) First 2) Second 3) Third";
    const output = normalizeInlineLists(input);
    expect(output).toBe("1) First\n2) Second\n3) Third");
  });

  it("splits inline bullet list", () => {
    const input = "• Item A • Item B • Item C";
    const output = normalizeInlineLists(input);
    expect(output).toContain("• Item A\n• Item B");
    expect(output).toContain("• Item B\n• Item C");
  });

  it("leaves already-formatted lists unchanged", () => {
    const input = "1. First\n2. Second\n3. Third";
    const output = normalizeInlineLists(input);
    expect(output).toBe(input);
  });

  it("converts parenthetical numbers (1) (2) to markdown list format", () => {
    const input =
      "You'll find (1) where everyone agrees, (2) any gaps or conflicts, (3) the key insights, and (4) a clear plan.";
    const output = normalizeInlineLists(input);
    expect(output).toContain("\n1. where everyone agrees");
    expect(output).toContain("\n2. any gaps or conflicts");
    expect(output).toContain("\n3. the key insights");
    expect(output).toContain("\n4. a clear plan");
  });
});

describe("normalizeInlineHeadings", () => {
  it("converts mid-line ### to line-start heading", () => {
    const input = "From Subagent A: ### Architecture Overview";
    const output = normalizeInlineHeadings(input);
    expect(output).toBe("From Subagent A:\n### Architecture Overview");
  });

  it("converts mid-line ## and # as well", () => {
    const input = "Section ## Feature Inventory";
    const output = normalizeInlineHeadings(input);
    expect(output).toBe("Section\n## Feature Inventory");
  });

  it("leaves line-start headings unchanged", () => {
    const input = "### Architecture Overview\nContent here";
    const output = normalizeInlineHeadings(input);
    expect(output).toBe(input);
  });

  it("handles multiple mid-line headings", () => {
    const input = "Section ### Architecture and ## Feature Inventory";
    const output = normalizeInlineHeadings(input);
    expect(output).toContain("\n### Architecture");
    expect(output).toContain("\n## Feature Inventory");
  });
});

describe("unwrapMarkdownCodeBlocks", () => {
  it("unwraps ```markdown blocks so inner content is parsed", () => {
    const input = `Here is the deliverable:

\`\`\`markdown
# Final Marketing Strategy Synthesis
## Executive summary
**the local-first AI agent OS for real work**
\`\`\``;
    const output = unwrapMarkdownCodeBlocks(input);
    expect(output).toContain("# Final Marketing Strategy Synthesis");
    expect(output).not.toContain("```markdown");
    expect(output).toContain("**the local-first AI agent OS for real work**");
  });

  it("unwraps ```md blocks", () => {
    const input = "```md\n# Header\n**bold**\n```";
    const output = unwrapMarkdownCodeBlocks(input);
    expect(output).toBe("# Header\n**bold**");
  });

  it("leaves other code blocks unchanged", () => {
    const input = "```js\nconsole.log(1)\n```";
    const output = unwrapMarkdownCodeBlocks(input);
    expect(output).toBe(input);
  });

  it("unwraps plain ``` blocks when content starts with #", () => {
    const input = `Here is the deliverable:

\`\`\`
# Collab-1773823736382 - Final Marketing Strategy Synthesis
## Executive summary
CoWork OS should go to market as **the local-first AI agent OS for real work**.
\`\`\``;
    const output = unwrapMarkdownCodeBlocks(input);
    expect(output).toContain("# Collab-1773823736382");
    expect(output).not.toMatch(/^```\s*$/m);
    expect(output).toContain("**the local-first AI agent OS for real work**");
  });

  it("unwraps plain ``` blocks when content has intro before #", () => {
    const input = `Intro text

\`\`\`
Preamble line

# Header
## Sub
\`\`\``;
    const output = unwrapMarkdownCodeBlocks(input);
    expect(output).toContain("# Header");
    expect(output).toContain("Preamble line");
  });

  it("unwraps ```Markdown (case-insensitive)", () => {
    const input = "```Markdown\n# Title\n**bold**\n```";
    const output = unwrapMarkdownCodeBlocks(input);
    expect(output).toBe("# Title\n**bold**");
  });
});

describe("normalizeMarkdownForCollab", () => {
  it("applies both heading and list normalization", () => {
    const input = "From X: ### Architecture Overview You'll find (1) first (2) second";
    const output = normalizeMarkdownForCollab(input);
    expect(output).toContain("From X:\n### Architecture Overview");
    expect(output).toContain("\n1. first");
    expect(output).toContain("\n2. second");
  });

  it("strips trailing ** from glob code blocks (LLM bold attempt)", () => {
    const input = "- `**/*team* **`\n- `**/*task* **`";
    const output = normalizeMarkdownForCollab(input);
    expect(output).toContain("`**/*team*`");
    expect(output).toContain("`**/*task*`");
    expect(output).not.toContain("`**/*team* **`");
  });

  it("wraps glob patterns in backticks so ** renders correctly", () => {
    const input = "Checked - **/*team* - **/*task* - **/*agent*";
    const output = normalizeMarkdownForCollab(input);
    expect(output).toContain("`**/*team*`");
    expect(output).toContain("`**/*task*`");
    expect(output).toContain("`**/*agent*`");
  });

  it("wraps bare double-star path globs in backticks", () => {
    const input = "Search: **/SKILL.md and **/scripts/setup.sh";
    const output = normalizeMarkdownForCollab(input);
    expect(output).toContain("`**/SKILL.md`");
    expect(output).toContain("`**/scripts/setup.sh`");
  });

  it("fixes unclosed bold at end of line", () => {
    const input = "**Electron desktop app";
    const output = normalizeMarkdownForCollab(input);
    expect(output).toBe("**Electron desktop app**");
  });

  it("does not add closing ** when bold is already closed", () => {
    const input = "**CoWork OS** most likely fits";
    const output = normalizeMarkdownForCollab(input);
    expect(output).toBe(input);
  });
});
