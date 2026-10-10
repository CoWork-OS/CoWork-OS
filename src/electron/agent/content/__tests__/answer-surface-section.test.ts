import { describe, expect, it } from "vitest";

import { ANSWER_SURFACE_PROMPT } from "../../../../shared/answer-surfaces/prompt";
import { HTML_SURFACE_RUNTIME_PROMPT } from "../../../../shared/answer-surfaces/html-bridge";
import { RICH_FRAME_DESIGN_LANGUAGE_PROMPT } from "../../../../shared/rich-frame-design-language";
import { ANSWER_SURFACE_SECTION_TOKENS, ContentBuilder } from "../ContentBuilder";

// What the executor sends for answer-style tasks (buildExecutionRichSurfacesPrompt).
const richSurfaces = [
  "RICH INLINE SURFACES:",
  RICH_FRAME_DESIGN_LANGUAGE_PROMPT,
  HTML_SURFACE_RUNTIME_PROMPT,
  "",
  ANSWER_SURFACE_PROMPT,
].join("\n");

const base = {
  workspaceId: "ws",
  workspacePath: "/tmp/none",
  taskPrompt: "How much should I save each month?",
  identityPrompt: "You are a helper.",
  // A realistic base instruction already near its 1800-token cap.
  baseInstructionPrompt: `OPERATING RULES:\n${"- Use tools when needed.\n".repeat(280)}`,
  executionMode: "execute" as const,
  taskDomain: "general" as const,
  webSearchModeContract: "web",
};

describe("answer surface prompt section", () => {
  it("fits the whole component reference, examples included", () => {
    expect(Math.ceil(richSurfaces.length / 4)).toBeLessThanOrEqual(ANSWER_SURFACE_SECTION_TOKENS);
  });

  it("reaches the model whole in task mode, alongside a full base instruction", async () => {
    const result = await ContentBuilder.buildExecutionPrompt({
      ...base,
      answerSurfacePrompt: richSurfaces,
      totalBudgetTokens: 7600 + ANSWER_SURFACE_SECTION_TOKENS,
    });
    expect(result.truncatedSections).not.toContain("answer_surfaces");
    expect(result.prompt).toContain("Components (`type`)");
    // The last example is the end of the reference: nothing was cut.
    expect(result.prompt).toContain(ANSWER_SURFACE_PROMPT.slice(-200));
  });
});
