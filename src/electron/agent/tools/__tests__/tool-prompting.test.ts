import { describe, expect, it } from "vitest";
import type { LLMTool, LLMToolPromptRenderContext } from "../../llm/types";
import { renderToolDescription } from "../tool-prompting";

const context: LLMToolPromptRenderContext = {
  executionMode: "execute",
  taskDomain: "coding",
  webSearchMode: "allowed",
  shellEnabled: true,
};

function tool(overrides: Partial<LLMTool> = {}): LLMTool {
  return {
    name: "example_tool",
    description: "Base description comes from the canonical tool schema.",
    input_schema: { type: "object", properties: {} },
    ...overrides,
  };
}

describe("renderToolDescription", () => {
  it("places prompt-specific appended guidance before the base description", () => {
    const description = renderToolDescription(
      tool({
        prompting: {
          render: () => ({
            appendDescription: "Use this only after collecting concrete evidence.",
          }),
        },
      }),
      context,
    );

    expect(description).toBe(
      "Use this only after collecting concrete evidence. Base description comes from the canonical tool schema.",
    );
  });

  it("still lets prompt metadata replace the description entirely", () => {
    const description = renderToolDescription(
      tool({
        prompting: {
          render: () => ({
            description: "Replacement description.",
            appendDescription: "Appendix should not be used.",
          }),
        },
      }),
      context,
    );

    expect(description).toBe("Replacement description.");
  });
});
