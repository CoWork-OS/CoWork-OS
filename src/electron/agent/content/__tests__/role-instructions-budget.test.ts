import { describe, expect, it } from "vitest";
import { ContentBuilder } from "../ContentBuilder";
import { composePromptSections } from "../../executor-prompt-sections";

const instructions =
  "BEGIN SAVED INSTRUCTIONS\n" +
  "Respect identity and authorization.\n".repeat(330) +
  "END SAVED INSTRUCTIONS";

describe("persistent role instructions", () => {
  it.each([true, false])(
    "preserves the full role in legacy=%s execution prompts",
    async (legacy) => {
      const result = await ContentBuilder.buildExecutionPrompt({
        workspaceId: "fixture",
        workspacePath: "/tmp/fixture",
        taskPrompt: "Read available context",
        roleContext: instructions,
        identityPrompt: "Assistant",
        executionMode: "execute",
        taskDomain: "research",
        totalBudgetTokens: 1500,
        ...(legacy ? { coreInstructions: "Core rules" } : { baseInstructionPrompt: "Core rules" }),
      });
      expect(result.prompt).toContain(instructions);
      expect(result.truncatedSections).not.toContain("role_context");
      expect(result.droppedSections).not.toContain("role_context");
    },
  );

  it("does not silently truncate a protected section even when it alone exceeds the soft budget", () => {
    const result = composePromptSections(
      [
        {
          key: "role_context",
          text: instructions,
          preserveWhole: true,
          maxTokens: 1,
          required: true,
        },
      ],
      100,
    );
    expect(result.prompt).toBe(instructions);
    expect(result.truncatedSections).toEqual([]);
  });
});
