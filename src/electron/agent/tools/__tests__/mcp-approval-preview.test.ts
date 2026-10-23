import { describe, expect, it } from "vitest";
import { buildAssistantApprovalRequest } from "../../assistant-approval";
import { buildMcpApprovalPresentation, withMcpCostLines } from "../mcp-approval-preview";

const NAME_CHANGE = {
  workersId: "693618e08cc11000cb2ec622bc370001",
  proposedName: {
    firstName: "Logan Test",
    lastName: "McNeil",
    country: { id: "bc33aa3152ec42d4995f4791a106ed09" },
  },
};

describe("buildMcpApprovalPresentation", () => {
  it("names the server and shows the exact arguments", () => {
    const presentation = buildMcpApprovalPresentation(
      "mcp_create_worker_preferred_name_change",
      "Workday",
      NAME_CHANGE,
    );
    expect(presentation.description).toBe(
      "Allow mcp_create_worker_preferred_name_change to call Workday with the arguments shown below?",
    );
    expect(presentation.approvalPreview).toEqual({
      label: "Arguments",
      text: JSON.stringify(NAME_CHANGE, null, 2),
    });
  });

  it("says so when the call has no arguments", () => {
    for (const input of [undefined, null, {}]) {
      const presentation = buildMcpApprovalPresentation("mcp_ping", "Workday", input);
      expect(presentation.description).toBe("Allow mcp_ping to call Workday with no arguments?");
      expect(presentation.approvalPreview).toBeUndefined();
    }
  });

  it("reaches the approval card as its preview", () => {
    const presentation = buildMcpApprovalPresentation(
      "mcp_create_worker_preferred_name_change",
      "Workday",
      NAME_CHANGE,
    );
    const request = buildAssistantApprovalRequest("external_service", presentation.description, {
      tool: "mcp_create_worker_preferred_name_change",
      approvalPreview: presentation.approvalPreview,
    });
    const question = request.questions[0];
    expect(question.question).toContain("to call Workday with the arguments shown below?");
    expect(question.preview?.label).toBe("Arguments");
    expect(question.preview?.text).toContain('"firstName": "Logan Test"');
  });
});

describe("costed MCP calls", () => {
  it("puts the cost above the arguments", () => {
    const presentation = buildMcpApprovalPresentation(
      "mcp_meshy_text_to_3d",
      "Meshy",
      { prompt: "a treasure chest" },
      ["Costs 5–25 credits.", "Spend limit for this task on Meshy: 200 credits."],
    );
    expect(presentation.approvalPreview).toEqual({
      label: "Cost and arguments",
      text:
        "Costs 5–25 credits.\nSpend limit for this task on Meshy: 200 credits.\n\n" +
        JSON.stringify({ prompt: "a treasure chest" }, null, 2),
    });
  });

  it("shows the cost alone for a call with no arguments", () => {
    const presentation = buildMcpApprovalPresentation("mcp_meshy_rig", "Meshy", {}, [
      "Costs about 5 credits.",
    ]);
    expect(presentation.approvalPreview).toEqual({ label: "Cost", text: "Costs about 5 credits." });
  });

  it("leaves a connector's own preview alone when the call has no cost", () => {
    const preview = { label: "Described by Jira", text: "Create PROJ-1" };
    expect(withMcpCostLines(preview, [])).toBe(preview);
  });
});
