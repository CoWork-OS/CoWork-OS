import { describe, expect, it } from "vitest";
import type { LLMTool, LLMToolPromptRenderContext } from "../../llm/types";
import { BrowserTools } from "../browser-tools";
import { renderToolDescription, withToolPromptMetadata } from "../tool-prompting";

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
  it("places the canonical description before prompt-specific guidance", () => {
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
      "Base description comes from the canonical tool schema. Use this only after collecting concrete evidence.",
    );
  });

  it("keeps both the canonical description and the guidance when together they are long", () => {
    const base = `${"Canonical behaviour detail. ".repeat(13)}Returns immediately with a task id.`;
    const guidance = `${"Contextual guidance detail. ".repeat(10)}Set worker_role explicitly.`;
    const description = renderToolDescription(
      tool({
        description: base,
        prompting: { render: () => ({ appendDescription: guidance }) },
      }),
      context,
    );

    expect(base.length + guidance.length).toBeGreaterThan(420);
    expect(description).toContain("Returns immediately with a task id.");
    expect(description).toContain("Set worker_role explicitly.");
    expect(description.indexOf("Canonical behaviour")).toBeLessThan(
      description.indexOf("Contextual guidance"),
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

  it("describes browser_navigate routing without claiming the visible workbench is the default", () => {
    const navigate = BrowserTools.getToolDefinitions().find(
      (definition) => definition.name === "browser_navigate",
    );
    expect(navigate).toBeTruthy();

    const description = renderToolDescription(withToolPromptMetadata(navigate as LLMTool), context);

    expect(description).not.toContain("By default this opens and controls the visible");
    expect(description).toMatch(/background.*headless|headless.*background/i);
    expect(description).toContain("visible");
    expect(description).toContain("web_fetch");
    expect(description).toContain("browser_snapshot");
    expect(description).not.toMatch(/\.\.\.$/);
  });
});
