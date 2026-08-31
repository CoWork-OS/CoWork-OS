import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import { getAssistantBubbleStatusLabel, getCompletionSummaryText } from "./task-event-presentation";

function completionEvent(payload: Record<string, unknown>): TaskEvent {
  return {
    id: "completion-1",
    taskId: "task-1",
    timestamp: 1,
    type: "timeline_step_finished",
    payload: {
      legacyType: "task_completed",
      ...payload,
    },
    schemaVersion: 2,
  } as TaskEvent;
}

describe("getCompletionSummaryText", () => {
  it("does not append internal semantic summaries to the answer", () => {
    expect(
      getCompletionSummaryText(
        completionEvent({
          resultSummary: "The user-facing answer.",
          semanticSummary: "Browser Navigate https://web.whatsapp.com/ · List Directory",
        }),
      ),
    ).toBe("The user-facing answer.");
  });

  it("does not create an answer from a semantic-only completion", () => {
    expect(
      getCompletionSummaryText(
        completionEvent({ semanticSummary: "Searched Message History References" }),
      ),
    ).toBe("");
  });
});

describe("getAssistantBubbleStatusLabel", () => {
  it("keeps successful exact-output answers free of completion decoration", () => {
    expect(
      getAssistantBubbleStatusLabel({
        status: "completed",
        terminalStatus: "ok",
      }),
    ).toBe("");
  });

  it("keeps partial-success state visible", () => {
    expect(
      getAssistantBubbleStatusLabel({
        status: "completed",
        terminalStatus: "partial_success",
      }),
    ).toBe("Completed - partial success");
  });

  it("uses the skill-specific pause label", () => {
    expect(
      getAssistantBubbleStatusLabel({
        status: "paused",
        awaitingUserInputReasonCode: "skill_parameters",
      }),
    ).toBe("Waiting for your skill answer");
  });
});
