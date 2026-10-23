import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  keyEventFromModalDialog,
  responsibilityActionReviewDecisionAllowed,
  responsibilityActionReviewOptionDisabled,
  splitApprovalQuestion,
  StructuredInputPromptCard,
} from "../StructuredInputPromptCard";
import { RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID } from "../../../../shared/approval-draft-presentation";
import type { InputRequest } from "../../../../shared/types";

function request(
  questionId = RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
  labels = ["Deny once", "Allow once", "Allow for this task"],
): InputRequest {
  return {
    id: "input-1",
    taskId: "task-1",
    status: "pending",
    requestedAt: 10,
    questions: [
      {
        id: questionId,
        header: "Permission",
        question: "Continue?",
        options: labels.map((label) => ({ label, description: label })),
      },
    ],
  };
}

describe("StructuredInputPromptCard exact-write review gate", () => {
  it("keeps Allow disabled while the marked review is unresolved and leaves Deny available", () => {
    const html = renderToStaticMarkup(
      createElement(StructuredInputPromptCard, {
        request: request(),
        onSubmit: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );

    expect(html).toContain("Loading the exact proposed content");
    expect(html).toContain('<span class="input-request-option-label">Deny once</span>');
    expect(html).toContain('<span class="input-request-option-label">Allow once</span>');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Allow for this task");
    expect(html).not.toContain("Type a custom response");
  });

  it("allows Allow once only after a valid review and never permits broader marked answers", () => {
    const question = request().questions[0];
    expect(responsibilityActionReviewDecisionAllowed(question, 0, "pending")).toBe(true);
    expect(responsibilityActionReviewDecisionAllowed(question, 1, "pending")).toBe(false);
    expect(responsibilityActionReviewDecisionAllowed(question, 1, "invalid")).toBe(false);
    expect(responsibilityActionReviewDecisionAllowed(question, 1, "valid")).toBe(true);
    expect(responsibilityActionReviewDecisionAllowed(question, 2, "valid")).toBe(false);
    expect(responsibilityActionReviewOptionDisabled(question, 1, "pending")).toBe(true);
    expect(responsibilityActionReviewOptionDisabled(question, 1, "invalid")).toBe(true);
    expect(responsibilityActionReviewOptionDisabled(question, 1, "valid")).toBe(false);
  });

  it("preserves ordinary structured-input options without applying the approval gate", () => {
    const ordinary = request("choose_format", ["Markdown", "Plain text"]);
    const html = renderToStaticMarkup(
      createElement(StructuredInputPromptCard, {
        request: ordinary,
        onSubmit: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );

    expect(html).toContain("Markdown");
    expect(html).toContain("Plain text");
    expect(html).toContain("Type a custom response");
    expect(responsibilityActionReviewDecisionAllowed(ordinary.questions[0], 0, "invalid")).toBe(
      true,
    );
  });
});

describe("StructuredInputPromptCard keyboard shortcuts", () => {
  it("leaves keys pressed inside an open modal, like the image lightbox, to that modal", () => {
    const element = (modal: object | null) => ({
      closest: (selector: string) => (selector === '[aria-modal="true"]' ? modal : null),
    });

    expect(keyEventFromModalDialog(element({}) as unknown as EventTarget)).toBe(true);
    expect(keyEventFromModalDialog(element(null) as unknown as EventTarget)).toBe(false);
    expect(keyEventFromModalDialog({} as EventTarget)).toBe(false);
    expect(keyEventFromModalDialog(null)).toBe(false);
  });
});

describe("StructuredInputPromptCard approval preview", () => {
  it("shows the exact content an approval covers and what it leaves out", () => {
    const withPreview = request("approval_decision", ["Deny", "Allow once"]);
    withPreview.questions[0].preview = {
      label: "AppleScript",
      text: 'tell application "Pages"\n  count of pages of front document\nend tell',
      omittedChars: 1200,
    };
    const html = renderToStaticMarkup(
      createElement(StructuredInputPromptCard, {
        request: withPreview,
        onSubmit: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(html).toContain("AppleScript");
    expect(html).toContain("count of pages of front document\nend tell");
    expect(html).toContain("1,200 more characters are not");
  });
});

describe("StructuredInputPromptCard compact approval", () => {
  const shellQuestion =
    'Approve this shell command and its potential network access for this invocation. Shell scripts can access the network even when the command text does not show it. Scope: commands starting with "wc -l notes.txt" (ordinary). Do you want CoWork to continue?';

  it("splits an approval into title, detail and scope without losing any of it", () => {
    expect(splitApprovalQuestion(shellQuestion)).toEqual({
      title: "Approve this shell command and its potential network access for this invocation.",
      detail: "Shell scripts can access the network even when the command text does not show it.",
      scope: 'commands starting with "wc -l notes.txt" (ordinary)',
    });
    expect(
      splitApprovalQuestion(
        "Export the report. Scope: domain api.example.com. Consent covers exports until this task ends. Do you want CoWork to continue?",
      ),
    ).toEqual({
      title: "Export the report.",
      detail: "Consent covers exports until this task ends.",
      scope: "domain api.example.com",
    });
    expect(splitApprovalQuestion("Continue?")).toEqual({
      title: "Continue?",
      detail: "",
      scope: "",
    });
  });

  it("leads with the exact command and keeps Deny first", () => {
    const approval = request("approval_decision", ["Deny", "Allow once"]);
    approval.questions[0].question = shellQuestion;
    approval.questions[0].preview = { label: "Command", text: "wc -l notes.txt && echo done" };
    const html = renderToStaticMarkup(
      createElement(StructuredInputPromptCard, {
        request: approval,
        onSubmit: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(html).toContain("input-request-card-approval");
    expect(html).toContain("<code>wc -l notes.txt &amp;&amp; echo done</code>");
    expect(html).toContain("Shell command · may use the network");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Do you want CoWork to continue?");
    expect(html).not.toContain('role="radio"');
    expect(html.indexOf(">Deny<")).toBeLessThan(html.indexOf(">Allow once<"));
  });

  it("falls back to the approval sentence when there is no command", () => {
    const approval = request("approval_decision", ["Deny", "Allow once"]);
    approval.questions[0].question =
      "Export the report. It goes to api.example.com. Do you want CoWork to continue?";
    const html = renderToStaticMarkup(
      createElement(StructuredInputPromptCard, {
        request: approval,
        onSubmit: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(html).toContain('<div class="input-request-approval-title">Export the report.</div>');
    expect(html).toContain("It goes to api.example.com.");
  });
});
