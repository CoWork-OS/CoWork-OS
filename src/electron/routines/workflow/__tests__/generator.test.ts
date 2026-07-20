import { describe, expect, it } from "vitest";
import { generateRoutineWorkflowDraft } from "../generator";

describe("generateRoutineWorkflowDraft", () => {
  it("matches a relevant template", () => {
    const result = generateRoutineWorkflowDraft("Save invoice email attachments to Drive");

    expect(result.matchedTemplateId).toBe("save-email-attachments");
    expect(result.workflow.nodes.some((node) => node.operation === "drive.save_attachments")).toBe(
      true,
    );
  });

  it("creates a safe manual agent draft for an unmatched request", () => {
    const result = generateRoutineWorkflowDraft(
      "Reconcile the basalt ledger with the lighthouse manifest",
    );

    expect(result.workflow.nodes[0].operation).toBe("starter.manual");
    expect(result.workflow.nodes[1].operation).toBe("agent.run");
    expect(result.workflow.generatedFromPrompt).toContain("basalt ledger");
  });
});
