import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../../shared/types";
import { indexLegacyInitialAnswerCitations, readTaskAnswerCitations } from "../task-citations";

function event(id: string, type: string, payload = {}, legacyType?: string): TaskEvent {
  return { id, taskId: "t", timestamp: 1, type, payload, legacyType } as TaskEvent;
}

const message = "The initial answer cites [1].";
const firstAnswer = event("answer-1", "assistant_message", { message });
const legacyEvents = [
  event("created", "task_created"),
  firstAnswer,
  event(
    "evidence",
    "timeline_evidence_attached",
    {
      evidenceRefs: [
        {
          sourceUrlOrPath: "https://calendar.google.com/e/1",
          citationIndex: 1,
          title: "Proposal review",
          sourceTool: "calendar_action",
          sourceLabel: "Google Calendar",
          capturedAt: 5,
        },
      ],
    },
    "citations_collected",
  ),
  event("gate", "timeline_evidence_attached", {
    legacyType: "citations_collected",
    gate: "key_claim_evidence_gate",
    evidenceRefs: [{ sourceUrlOrPath: "https://example.net/wrong" }],
  }),
  event("complete", "task_completed", { resultSummary: message }),
];

describe("saved answer citations", () => {
  it("uses each answer's own snapshot even when a restarted executor reuses [1]", () => {
    for (const [id, url] of [
      ["initial", "https://example.com/a"],
      ["follow-up", "https://example.org/b"],
    ]) {
      const answer = event(
        id,
        "timeline_step_updated",
        {
          message: "A sourced claim [1].",
          answerCitations: [{ index: 1, url }],
        },
        "assistant_message",
      );
      expect(readTaskAnswerCitations(answer)).toMatchObject([{ index: 1, url }]);
    }
  });

  it("preserves the original completion's connector evidence without giving it to a follow-up", () => {
    const followUp = event("answer-2", "assistant_message", { message: "An unsupported [1]." });
    const evidence = indexLegacyInitialAnswerCitations([...legacyEvents, followUp]);
    expect(readTaskAnswerCitations(firstAnswer, evidence.get(firstAnswer.id))).toEqual([
      {
        index: 1,
        url: "https://calendar.google.com/e/1",
        title: "Proposal review",
        snippet: "",
        domain: "calendar.google.com",
        accessedAt: 5,
        sourceTool: "calendar_action",
        sourceLabel: "Google Calendar",
      },
    ]);
    expect(readTaskAnswerCitations(followUp, evidence.get(followUp.id))).toEqual([]);
  });

  it("does not borrow evidence across an unlogged follow-up boundary or an incomplete page", () => {
    const followUpComplete = event("follow-up-result", "task_completed", {
      resultSummary: "Follow-up result [1].",
    });
    expect(
      indexLegacyInitialAnswerCitations([
        ...legacyEvents.slice(0, -1),
        event("internal-follow-up", "follow_up_completed"),
        followUpComplete,
      ]).size,
    ).toBe(0);
    expect(indexLegacyInitialAnswerCitations(legacyEvents.slice(1)).size).toBe(0);
  });

  it("recovers a legacy follow-up's explicit bibliography and respects an empty saved snapshot", () => {
    const text =
      "The follow-up cites [1].\n\n## Sources\n- [1] [Second source](https://example.org/b)";
    const answer = event("follow-up", "task_completed", { resultSummary: text });
    expect(readTaskAnswerCitations(answer)).toMatchObject([
      { index: 1, url: "https://example.org/b", title: "Second source" },
    ]);
    const empty = event("empty", "assistant_message", { message: text, answerCitations: [] });
    expect(readTaskAnswerCitations(empty)).toEqual([]);
  });
});
