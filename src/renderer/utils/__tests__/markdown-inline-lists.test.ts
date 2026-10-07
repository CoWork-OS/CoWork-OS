import { describe, expect, it } from "vitest";
import { cleanAssistantMessageForDisplay } from "../../components/MainContent/markdown-normalization";
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
    expect(normalizeInlineLists("Fast - and local: • A • B")).toBe("Fast - and local: • A\n• B");
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

  it("does not split a list item whose line ends in a number", () => {
    const input = "1. You pick a door, say Door 1.\n2. The host opens another door.";
    expect(normalizeInlineLists(input)).toBe(input);
    expect(cleanAssistantMessageForDisplay(input)).toBe(input);
  });

  it("does not split at a bullet marker at the end of a line", () => {
    const input = "- Item A ends with a dash -\n- Item B";
    expect(normalizeInlineLists(input)).toBe(input);
  });

  it("does not turn a trailing parenthetical number into an empty item", () => {
    const input = "See note (1)\nNext line";
    expect(normalizeInlineLists(input)).toBe(input);
  });

  it("still splits a real inline numbered list", () => {
    expect(normalizeInlineLists("1. A 2. B 3. C")).toBe("1. A\n2. B\n3. C");
    expect(normalizeInlineLists("Two options: 1. Keep it 2. Remove it")).toBe(
      "Two options: 1. Keep it\n2. Remove it",
    );
  });

  it("keeps the indentation of a nested inline list", () => {
    expect(normalizeInlineLists("- Parent\n   1. A 2. B 3. C")).toBe(
      "- Parent\n   1. A\n   2. B\n   3. C",
    );
  });

  it("leaves 'Version 2. Next' sentences alone", () => {
    const sentences = [
      "We shipped Version 2. Next we add sync.",
      "Requires Node 18. Then upgrade to Version 2. Next, restart.",
      "Step 1. Install Node 18. Then run it.",
      "1. Upgrade to Version 2. Next, run the migration.\n2. Restart the app.",
      "1. You pick Door 1. The host opens Door 3. You may switch to Door 2. Done.",
    ];
    for (const input of sentences) {
      expect(normalizeInlineLists(input)).toBe(input);
    }
  });

  it("leaves arithmetic and dashes in prose alone", () => {
    const lines = [
      "Estimate: people * 0.4 * 250 * 12 = budget",
      "* Cost: people * 0.4 * 250",
      "- **Speed** - it's faster than the old path",
      "Use X - it's faster - and Y",
      "- 2023 - 2024 - 2025",
      "* * *",
    ];
    for (const input of lines) {
      expect(normalizeInlineLists(input)).toBe(input);
    }
  });

  it("still splits an inline hyphen list on a bullet line", () => {
    expect(normalizeInlineLists("- Fast - Cheap - Local")).toBe("- Fast\n- Cheap\n- Local");
  });

  it("leaves fenced code blocks untouched", () => {
    const code = [
      "```python",
      "total = people * 0.4 * 250",
      "steps = '1. a 2. b 3. c'",
      "- x - y - z",
      "print((1) + 2)",
      "```",
    ].join("\n");
    const input = `Phases: 1. Plan 2. Build\n\n${code}\n\nAfter: 1. Test 2. Ship`;
    expect(normalizeInlineLists(input)).toBe(
      `Phases: 1. Plan\n2. Build\n\n${code}\n\nAfter: 1. Test\n2. Ship`,
    );
  });

  it("leaves tilde, indented and unclosed fences untouched", () => {
    const tilde = "~~~\n1. a 2. b 3. c\n~~~";
    expect(normalizeInlineLists(tilde)).toBe(tilde);
    const indented = "1. Run this:\n\n    ```bash\n    echo 1. a 2. b 3. c\n    ```";
    expect(normalizeInlineLists(indented)).toBe(indented);
    const unclosed = "```\n1. a 2. b 3. c";
    expect(normalizeInlineLists(unclosed)).toBe(unclosed);
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
