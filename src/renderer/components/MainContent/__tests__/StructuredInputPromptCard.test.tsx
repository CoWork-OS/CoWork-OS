import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  keyEventFromModalDialog,
  responsibilityActionReviewDecisionAllowed,
  responsibilityActionReviewOptionDisabled,
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
