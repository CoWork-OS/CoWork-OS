import { expect, it } from "vitest";
import { ContentBuilder } from "../ContentBuilder";

it.each([true, false])(
  "keeps background worker guidance independent of the base instruction budget (legacy=%s)",
  async (legacy) => {
    const guidance =
      "BACKGROUND APPLICATIONS\nUse application_operation with worker.vm.photoshop.v1. Never replay unknown jobs.";
    const result = await ContentBuilder.buildExecutionPrompt({
      workspaceId: "fixture",
      workspacePath: "/tmp/fixture",
      taskPrompt: "Create an editable Photoshop banner",
      identityPrompt: "Assistant",
      executionMode: "execute",
      taskDomain: "design",
      totalBudgetTokens: 1200,
      applicationWorkerPrompt: guidance,
      ...(legacy
        ? { coreInstructions: "Core rules".repeat(2000) }
        : { baseInstructionPrompt: "Core rules".repeat(2000) }),
    });
    expect(result.prompt).toContain(guidance);
    expect(result.droppedSections).not.toContain("application_workers");
    expect(result.truncatedSections).not.toContain("application_workers");
  },
);
