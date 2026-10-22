import { describe, expect, it } from "vitest";
import {
  ASSISTANT_APPROVAL_QUESTION_ID,
  buildAssistantApprovalMessage,
  buildAssistantApprovalRequest,
  canOfferAssistantAlwaysAllow,
  findAssistantApprovalOptionLabel,
  isAssistantApprovalInputRequest,
  isHighImpactApprovalDecision,
  parseAssistantApprovalAction,
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

  it("shows the full review text even past the description limit", () => {
    const message = `Please cancel order A-1. ${"Keep the refund on my card. ".repeat(30)}End.`;
    const request = buildAssistantApprovalRequest(
      "external_service",
      "Send a change to Example Co. Support.",
      {
        tool: "pact_send_message",
        approvalReviewText: `Message: “${message.trim()}” Permissions: orders:cancel.`,
        permissionPrompt: { scopePreview: "pact_send_message on domain example.com" },
      },
    );
    const question = request.questions[0]!.question;
    expect(message.length).toBeGreaterThan(480);
    expect(question).toContain(`Message: “${message.trim()}” Permissions: orders:cancel.`);
    expect(question.indexOf("Message:")).toBeLessThan(question.indexOf("Scope:"));
  });

  it("lists every permission in full even when the review text fills its bound", () => {
    const message = "x".repeat(4000);
    const permissions = Array.from(
      { length: 20 },
      (_, index) => `${"Change your account settings ".repeat(17).trim()} (account:scope-${index})`,
    );
    const request = buildAssistantApprovalRequest(
      "external_service",
      "Send a change to Example Co. Support.",
      {
        tool: "pact_send_message",
        approvalReviewText: `Message: “${message}”`,
        approvalReviewPermissions: permissions,
      },
    );
    const question = request.questions[0]!.question;
    expect(question).toContain(`Message: “${message}”`);
    expect(question).toContain(` Permissions: ${permissions.join("; ")}.`);
    expect(question).toContain("(account:scope-19).");
    expect(question.endsWith("Do you want CoWork to continue?")).toBe(true);
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
      parseAssistantApprovalAnswer({ approval_decision: { optionLabel: "Allow once" } }, true),
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

it("points the transcript at the card instead of repeating its explanation", () => {
  const description =
    "Approve this shell command and its potential network access for this invocation.";
  const details = {
    command: "python3 check_totals.py vendor-totals.xlsx",
    permissionPrompt: { scopePreview: 'commands starting with "python3 check_totals.py"' },
  };
  const message = buildAssistantApprovalMessage("run_command", description, details);
  const card = buildAssistantApprovalRequest("run_command", description, details).questions[0];
  expect(card.question).toContain(description);
  expect(message).not.toContain(description);
  expect(message).not.toContain("Scope:");
  expect(message).toBe(
    "I need your decision before I can continue. Choose **Deny** or **Allow once** below.",
  );
  expect(
    buildAssistantApprovalMessage("external_service", 'Use "Calculator"?', {
      taskConsentScope: "reading and clicking in Calculator",
    }),
  ).toContain("Choose **Deny** or **Allow for this task** below.");
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

it("labels native background app permission with the actual task duration", () => {
  const request = buildAssistantApprovalRequest("computer_use", "Control Calculator", {
    taskConsentScope: "background observation, clicking and typing in com.apple.calculator",
  });
  expect(request.questions[0].question).toContain("com.apple.calculator");
  expect(request.questions[0].question).toContain("until this task ends");
  expect(request.questions[0].options.map((option) => option.label)).toEqual([
    "Deny",
    "Allow for this task",
  ]);
});

it("offers a task-scoped consent for reading one terminal tab", () => {
  const request = buildAssistantApprovalRequest(
    "data_export",
    'Let the agent read the recent output of your terminal tab "cowork" (/Users/almarion/cowork)?',
    {
      taskConsentScope:
        'reading the recent output of your terminal tab "cowork" (/Users/almarion/cowork)',
      taskConsentLabel: "Allow for this task",
    },
  );
  expect(request.questions[0].question).toContain('terminal tab "cowork"');
  expect(request.questions[0].question).toContain("until this task ends");
  expect(request.questions[0].options.map((option) => option.label)).toEqual([
    "Deny",
    "Allow for this task",
  ]);
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

describe("approval content preview", () => {
  const script = 'tell application "Pages"\r\n  count of pages of front document\r\nend tell';

  it("shows the exact script, line for line, on the approval question", () => {
    const question = buildAssistantApprovalRequest("run_applescript", "Run AppleScript", {
      script,
      approvalPreview: { label: "AppleScript", text: script },
    }).questions[0];
    expect(question.preview).toEqual({
      label: "AppleScript",
      text: 'tell application "Pages"\n  count of pages of front document\nend tell',
    });
  });

  it("reports the length it leaves out of a very long script", () => {
    const long = "x".repeat(20_050);
    const question = buildAssistantApprovalRequest("run_applescript", "Run AppleScript", {
      approvalPreview: { label: "AppleScript", text: long },
    }).questions[0];
    expect(question.preview?.text).toHaveLength(20_000);
    expect(question.preview?.omittedChars).toBe(50);
  });

  it("adds no preview when the tool supplies none", () => {
    const question = buildAssistantApprovalRequest("run_command", "Run", { command: "ls" })
      .questions[0];
    expect(question.preview).toBeUndefined();
  });
});

describe("Always allow on the inline approval card", () => {
  const persistablePrompt = {
    scope: { kind: "command_prefix", prefix: "npm test" },
    scopePreview: 'commands starting with "npm test"',
    suggestedActions: [
      { action: "deny_once", label: "Deny once", effect: "deny" },
      { action: "allow_once", label: "Allow once", effect: "allow" },
      { action: "allow_session", label: "Allow for session", effect: "allow" },
      { action: "allow_workspace", label: "Allow for workspace", effect: "allow" },
    ],
  };

  it("offers Always allow between Deny and Allow once when the engine allows a workspace rule", () => {
    const details = { command: "npm test", permissionPrompt: persistablePrompt };
    const options = buildAssistantApprovalRequest("run_command", "Run the tests", details)
      .questions[0].options;
    expect(options.map((option) => option.label)).toEqual(["Deny", "Always allow", "Allow once"]);
    expect(options[1].description).toBe(
      'Continue and stop asking in this workspace for commands starting with "npm test".',
    );
    expect(buildAssistantApprovalMessage("run_command", "Run the tests", details)).toBe(
      "I need your decision before I can continue. Choose **Deny**, **Always allow**, or **Allow once** below.",
    );
  });

  it("withholds Always allow when the engine offers no workspace rule or no scope", () => {
    const oneTimeOnly = {
      ...persistablePrompt,
      suggestedActions: persistablePrompt.suggestedActions.slice(0, 2),
    };
    expect(canOfferAssistantAlwaysAllow({ permissionPrompt: oneTimeOnly })).toBe(false);
    expect(
      canOfferAssistantAlwaysAllow({
        permissionPrompt: { ...persistablePrompt, scope: undefined },
      }),
    ).toBe(false);
    expect(canOfferAssistantAlwaysAllow({})).toBe(false);
    expect(canOfferAssistantAlwaysAllow(undefined)).toBe(false);
    expect(
      buildAssistantApprovalRequest("run_command", "Run", {
        permissionPrompt: oneTimeOnly,
      }).questions[0].options.map((option) => option.label),
    ).toEqual(["Deny", "Allow once"]);
  });

  it("never offers Always allow on task consent or an exact-write review", () => {
    const consent = buildAssistantApprovalRequest("computer_use", 'Use "Calculator"?', {
      taskConsentScope: "reading and clicking in Calculator",
      permissionPrompt: persistablePrompt,
    });
    expect(consent.questions[0].options.map((option) => option.label)).toEqual([
      "Deny",
      "Allow for this task",
    ]);
    const review = buildAssistantApprovalRequest("workspace_write", "Review write", {
      tool: "write_file",
      responsibilityActionReview: { version: 1 },
      permissionPrompt: persistablePrompt,
    });
    expect(review.questions[0].options.map((option) => option.label)).toEqual([
      "Deny once",
      "Allow once",
    ]);
  });

  it("maps each answer to its approval action and fails closed on anything else", () => {
    const answer = (optionLabel?: string, otherText?: string) => ({
      [ASSISTANT_APPROVAL_QUESTION_ID]: { optionLabel, otherText },
    });
    expect(parseAssistantApprovalAction(answer("Always allow"))).toBe("allow_workspace");
    expect(parseAssistantApprovalAction(answer(" always ALLOW "))).toBe("allow_workspace");
    expect(parseAssistantApprovalAction(answer("Allow once"))).toBe("allow_once");
    expect(parseAssistantApprovalAction(answer("Allow for this task"))).toBe("allow_once");
    expect(parseAssistantApprovalAction(answer("Deny"))).toBe("deny_once");
    expect(parseAssistantApprovalAction(answer(undefined, "always allow this"))).toBe("deny_once");
    expect(parseAssistantApprovalAction(undefined)).toBe("deny_once");
    expect(parseAssistantApprovalAnswer(answer("Always allow"))).toBe(true);
    // A reviewed write approves one write only, whatever label arrives.
    expect(
      parseAssistantApprovalAction(
        { [RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID]: { optionLabel: "Always allow" } },
        true,
      ),
    ).toBe("deny_once");
  });

  it("answers a workspace-scope decision with Always allow only when the card offers it", () => {
    const withAlways = [{ label: "Deny" }, { label: "Always allow" }, { label: "Allow once" }];
    const withoutAlways = [{ label: "Deny" }, { label: "Allow once" }];
    expect(findAssistantApprovalOptionLabel(withAlways, "allow_workspace")).toBe("Always allow");
    expect(findAssistantApprovalOptionLabel(withAlways, "allow_once")).toBe("Allow once");
    expect(findAssistantApprovalOptionLabel(withAlways, "allow_session")).toBe("Allow once");
    expect(findAssistantApprovalOptionLabel(withAlways, "deny_workspace")).toBe("Deny");
    expect(findAssistantApprovalOptionLabel(withoutAlways, "allow_workspace")).toBe("Allow once");
    expect(findAssistantApprovalOptionLabel(undefined, "allow_once")).toBeUndefined();
  });
});
