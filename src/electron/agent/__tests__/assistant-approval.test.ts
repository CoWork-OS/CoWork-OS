import { describe, expect, it } from "vitest";
import {
  ASSISTANT_APPROVAL_QUESTION_ID,
  buildAssistantApprovalRequest,
  isAssistantApprovalInputRequest,
  parseAssistantApprovalAnswer,
  shouldUseAssistantApprovalInput,
} from "../assistant-approval";

describe("assistant mediated approvals", () => {
  it("routes every permission ask through the assistant while keeping allow decisions silent", () => {
    expect(
      shouldUseAssistantApprovalInput("network_access", {
        tool: "web_fetch",
        params: { method: "GET" },
      }),
    ).toBe(true);
    expect(
      shouldUseAssistantApprovalInput("external_service", {
        tool: "http_request",
        params: { method: "POST" },
      }),
    ).toBe(true);
    expect(
      shouldUseAssistantApprovalInput("network_access", { tool: "mcp_linear_create_issue" }),
    ).toBe(true);
  });

  it("requires an explicit decision for opt-out and workspace policy gates", () => {
    expect(shouldUseAssistantApprovalInput("network_access", {}, { allowAutoApprove: false })).toBe(
      true,
    );
    expect(
      shouldUseAssistantApprovalInput("network_access", {}, { requireExplicitApproval: true }),
    ).toBe(true);
  });

  it("fails closed on the default answer and parses only an explicit allow", () => {
    const request = buildAssistantApprovalRequest("data_export", "Export the report", {
      permissionPrompt: { scopePreview: "domain api.example.com" },
    });
    expect(request.questions[0]?.id).toBe(ASSISTANT_APPROVAL_QUESTION_ID);
    expect(request.questions[0]?.options[0]?.label).toBe("Deny");
    expect(parseAssistantApprovalAnswer({ approval_decision: { optionLabel: "Deny" } })).toBe(
      false,
    );
    expect(parseAssistantApprovalAnswer({ approval_decision: { optionLabel: "Allow once" } })).toBe(
      true,
    );
    expect(
      isAssistantApprovalInputRequest({
        id: "request-1",
        taskId: "task-1",
        ...request,
        status: "pending",
        requestedAt: Date.now(),
      }),
    ).toBe(true);
  });
});
