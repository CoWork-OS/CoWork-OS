import { describe, expect, it } from "vitest";
import {
  ASSISTANT_APPROVAL_QUESTION_ID,
  buildAssistantApprovalRequest,
  isAssistantApprovalInputRequest,
  isHighImpactApprovalDecision,
  parseAssistantApprovalAnswer,
  shouldUseAssistantApprovalInput,
} from "../assistant-approval";
import { RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID } from "../../../shared/approval-draft-presentation";

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

  it("treats forgetting a memory as a high-impact decision with a readable option", () => {
    expect(isHighImpactApprovalDecision("memory_delete", { tool: "memory_forget" })).toBe(true);
    const request = buildAssistantApprovalRequest(
      "memory_delete",
      'Forget a saved memory: "The user prefers dark mode"',
      { tool: "memory_forget" },
    );
    expect(request.questions[0].question).toContain("dark mode");
    expect(request.questions[0].options?.[1].description).toBe("Forget this memory.");
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

  it("marks exact workspace write review with its persisted one-time decision question", () => {
    const request = buildAssistantApprovalRequest("workspace_write", "Review write", {
      tool: "write_file",
      responsibilityActionReview: { version: 1 },
    });
    expect(request.questions[0]?.id).toBe(RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID);
    expect(request.questions[0]?.options.map((option) => option.label)).toEqual([
      "Deny once",
      "Allow once",
    ]);
    expect(
      parseAssistantApprovalAnswer(
        { approval_decision: { optionLabel: "Allow once" } },
        true,
      ),
    ).toBe(false);
    expect(
      parseAssistantApprovalAnswer(
        {
          [RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID]: { optionLabel: "Allow once" },
        },
        true,
      ),
    ).toBe(true);
    expect(
      isAssistantApprovalInputRequest({
        id: "review-request",
        taskId: "task-1",
        ...request,
        status: "pending",
        requestedAt: Date.now(),
      }),
    ).toBe(true);
  });
});

it("makes the duration and app scope explicit while keeping Deny first", () => {
  const request = buildAssistantApprovalRequest("external_service", 'Use "Calculator"?', {
    taskConsentScope: "reading, clicking, typing, and dragging in Calculator",
  });
  expect(request.questions[0].question).toContain("until this task ends");
  expect(request.questions[0].options.map((option) => option.label)).toEqual([
    "Deny",
    "Allow for this task",
  ]);
  expect(
    parseAssistantApprovalAnswer({ approval_decision: { optionLabel: "Allow for this task" } }),
  ).toBe(true);
});

it("offers a chat-scoped consent for read-only web access in a bot chat", () => {
  const request = buildAssistantApprovalRequest(
    "network_access",
    "Let this bot search and read web pages for this chat?",
    {
      taskConsentScope: "searching and opening web pages in this chat",
      taskConsentLabel: "Allow for this chat",
    },
  );
  expect(request.questions[0].question).toContain(
    "Consent covers searching and opening web pages in this chat.",
  );
  expect(request.questions[0].question).not.toContain("until this task ends");
  expect(request.questions[0].options.map((option) => option.label)).toEqual([
    "Deny",
    "Allow for this chat",
  ]);
  expect(
    parseAssistantApprovalAnswer({ approval_decision: { optionLabel: "Allow for this chat" } }),
  ).toBe(true);
  // Only the two supported labels are accepted; anything else falls back.
  expect(
    buildAssistantApprovalRequest("network_access", "x", {
      taskConsentScope: "y",
      taskConsentLabel: "Allow forever",
    }).questions[0].options[1].label,
  ).toBe("Allow for this task");
  // Without a consent scope, network access stays a one-time decision.
  expect(
    buildAssistantApprovalRequest("network_access", "x", {}).questions[0].options[1].label,
  ).toBe("Allow once");
});
