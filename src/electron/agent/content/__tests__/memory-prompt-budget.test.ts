import { describe, expect, it } from "vitest";

import { estimateTokens } from "../../context-manager";
import { composePromptSections } from "../../executor-prompt-sections";
import { ContentBuilder } from "../ContentBuilder";
import { truncateAtFragmentBoundary } from "../fragment-truncation";
import { MEMORY_CONTEXT_SECTION_TOKENS, MEMORY_SYNTHESIS_SLICE_TOKENS } from "../prompt-budgets";
import { formatFlushBullets, parseFlushSectionBullets } from "../../executor-memory-flush-utils";

function bulletBlock(tag: string, count: number, width = 60): string {
  const lines = Array.from({ length: count }, (_, index) => `- fact ${index} ${"x".repeat(width)}`);
  return [`<${tag}>`, "## Heading", ...lines, `</${tag}>`].join("\n");
}

describe("truncateAtFragmentBoundary", () => {
  it("returns text unchanged when it fits", () => {
    const text = bulletBlock("cowork_hot_memory", 3);
    expect(truncateAtFragmentBoundary(text, 1000)).toBe(text);
  });

  it("cuts on line boundaries, stays within budget and closes open tags", () => {
    const text = [
      bulletBlock("cowork_hot_memory", 40),
      bulletBlock("cowork_structured_memory", 40),
    ].join("\n\n");
    const out = truncateAtFragmentBoundary(text, 300, "[cut]");

    expect(estimateTokens(out)).toBeLessThanOrEqual(300);
    const originalLines = new Set(text.split("\n"));
    for (const line of out.split("\n")) {
      if (line === "[cut]" || line.startsWith("</")) continue;
      expect(originalLines.has(line)).toBe(true);
    }
    const opens = (out.match(/<cowork_[a-z_]+>/g) || []).length;
    const closes = (out.match(/<\/cowork_[a-z_]+>/g) || []).length;
    expect(opens).toBe(closes);
    expect(out.endsWith("</cowork_hot_memory>")).toBe(true);
    expect(out).toContain("[cut]");
  });

  it("does not end on a dangling heading or an empty wrapper", () => {
    const text = [
      "- keep",
      "",
      "## Next",
      `<cowork_structured_memory>`,
      "- " + "y".repeat(400),
      "</cowork_structured_memory>",
    ].join("\n");
    const out = truncateAtFragmentBoundary(text, 20, "");
    expect(out).toBe("- keep");
  });
});

describe("memory prompt section budgets", () => {
  it("caps memory_context at the requested synthesizer budget", () => {
    expect(MEMORY_CONTEXT_SECTION_TOKENS).toBe(
      MEMORY_SYNTHESIS_SLICE_TOKENS.kitContext +
        MEMORY_SYNTHESIS_SLICE_TOKENS.memoryContext +
        MEMORY_SYNTHESIS_SLICE_TOKENS.playbookContext,
    );
    expect(MEMORY_CONTEXT_SECTION_TOKENS).toBe(1820);
  });

  it("keeps a full-budget memory block intact and gives design/profile their own sections", async () => {
    // ~1,700 tokens of synthesized memory: over the old 1,200 cap, under the new one.
    const memoryContext = bulletBlock("cowork_hot_memory", 95);
    expect(estimateTokens(memoryContext)).toBeGreaterThan(1200);
    expect(estimateTokens(memoryContext)).toBeLessThan(MEMORY_CONTEXT_SECTION_TOKENS);

    const result = await ContentBuilder.buildExecutionPrompt({
      workspaceId: "ws",
      workspacePath: "/tmp/none",
      taskPrompt: "Fix the layout",
      identityPrompt: "You are a helper.",
      baseInstructionPrompt: "Base rules.",
      memoryContext,
      designSystemContext: "### Workspace Design System (DESIGN.md)\n- Use 8px spacing",
      externalMemoryContext: "<cowork_user_profile>\nremote profile\n</cowork_user_profile>",
      projectGuidanceContext: "### Project Instructions (AGENTS.md)\n- Run tests",
      executionMode: "execute",
      taskDomain: "code",
      webSearchModeContract: "web",
      totalBudgetTokens: 0,
    });

    expect(result.truncatedSections).not.toContain("memory_context");
    expect(result.prompt).toContain(memoryContext);
    const keys = result.systemBlocks.map((block) => block.stableKey?.split(":")[0]);
    expect(keys).toEqual(
      expect.arrayContaining([
        "design_system",
        "external_memory",
        "project_guidance",
        "memory_context",
      ]),
    );
  });

  it("shrinks a fragment section on boundaries before dropping it when over the total budget", () => {
    const memory = bulletBlock("cowork_hot_memory", 60);
    const result = composePromptSections(
      [
        { key: "core", text: "c".repeat(2000), required: true },
        {
          key: "memory_context",
          text: memory,
          maxTokens: 1820,
          required: false,
          dropPriority: 5,
          truncation: "fragment",
          minTokens: 200,
        },
      ],
      900,
    );

    expect(result.droppedSections).not.toContain("memory_context");
    expect(result.truncatedSections).toContain("memory_context");
    expect(result.totalTokens).toBeLessThanOrEqual(905);
    expect(result.prompt).toContain("<cowork_hot_memory>");
    expect(result.prompt.trimEnd().endsWith("</cowork_hot_memory>")).toBe(true);
  });

  it("drops a fragment section when shrinking would go below its minimum", () => {
    const result = composePromptSections(
      [
        { key: "core", text: "c".repeat(3500), required: true },
        {
          key: "memory_context",
          text: bulletBlock("cowork_hot_memory", 60),
          maxTokens: 1820,
          required: false,
          dropPriority: 5,
          truncation: "fragment",
          minTokens: 400,
        },
      ],
      1000,
    );
    expect(result.droppedSections).toContain("memory_context");
  });
});

describe("pre-compaction flush parser", () => {
  const summary = [
    "Decisions:",
    "- ship the settings page",
    "- stay on sqlite",
    "Open Loops:",
    "- see whether search is slow",
    "",
    "Next Actions:",
    "-   send summary",
  ].join("\n");

  it("stops at the next section label instead of bleeding into it", () => {
    expect(parseFlushSectionBullets(summary, "Decisions")).toEqual([
      "- ship the settings page",
      "- stay on sqlite",
    ]);
    expect(parseFlushSectionBullets(summary, "Open Loops")).toEqual([
      "- see whether search is slow",
    ]);
  });

  it("keeps leading 's' characters and strips only dashes and spaces", () => {
    expect(formatFlushBullets(parseFlushSectionBullets(summary, "Decisions"), "09:30")).toEqual([
      "- [flush 09:30] ship the settings page",
      "- [flush 09:30] stay on sqlite",
    ]);
    expect(formatFlushBullets(parseFlushSectionBullets(summary, "Next Actions"), "09:30")).toEqual([
      "- [flush 09:30] send summary",
    ]);
    expect(formatFlushBullets(["-", "- "], "09:30")).toEqual([]);
  });

  it("returns nothing for a missing section", () => {
    expect(parseFlushSectionBullets(summary, "Goals")).toEqual([]);
  });
});
