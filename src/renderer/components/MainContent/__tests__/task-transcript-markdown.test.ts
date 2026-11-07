import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../../shared/types";
import { buildTaskTranscriptMarkdown } from "../task-transcript-markdown";

let seq = 0;
const timeline = (legacyType: string, payload: Record<string, unknown>): TaskEvent =>
  ({
    id: `e${++seq}`,
    taskId: "t1",
    timestamp: seq,
    type: "timeline_step_updated",
    payload: { legacyType, ...payload },
  }) as unknown as TaskEvent;

describe("buildTaskTranscriptMarkdown", () => {
  it("keeps every turn of a session, with each reply once", () => {
    const answer = "Here is the answer.";
    const events = [
      timeline("user_message", { message: "Draft a haiku" }),
      timeline("assistant_message", { message: "Tea steam rises", internal: false }),
      timeline("user_message", { message: "List three primes" }),
      timeline("assistant_message", { message: answer }),
      timeline("assistant_message", { message: answer }),
      timeline("follow_up_completed", { message: "Follow-up message processed" }),
    ];
    expect(buildTaskTranscriptMarkdown(events, "Draft a haiku", "Nova")).toBe(
      [
        "### You\n\nDraft a haiku",
        "### Nova\n\nTea steam rises",
        "### You\n\nList three primes",
        `### Nova\n\n${answer}`,
      ].join("\n\n---\n\n"),
    );
  });

  it("leaves out internal assistant messages and repeated completion summaries", () => {
    const events = [
      timeline("user_message", { message: "Check the build" }),
      timeline("assistant_message", { message: "Planning the check", internal: true }),
      timeline("assistant_message", { message: "The build passes." }),
      {
        id: "c1",
        taskId: "t1",
        timestamp: 99,
        type: "task_completed",
        payload: { resultSummary: "The build passes." },
      } as unknown as TaskEvent,
    ];
    expect(buildTaskTranscriptMarkdown(events, "Check the build", "CoWork")).toBe(
      "### You\n\nCheck the build\n\n---\n\n### CoWork\n\nThe build passes.",
    );
  });

  it("opens with the prompt when its message event is not in the list", () => {
    const events = [
      timeline("assistant_message", { message: "Tea steam rises" }),
      timeline("user_message", { message: "Now one about coffee" }),
      timeline("assistant_message", { message: "Dark cup at dawn" }),
    ];
    expect(buildTaskTranscriptMarkdown(events, "Draft a haiku", "CoWork")).toBe(
      [
        "### You\n\nDraft a haiku",
        "### CoWork\n\nTea steam rises",
        "### You\n\nNow one about coffee",
        "### CoWork\n\nDark cup at dawn",
      ].join("\n\n---\n\n"),
    );
  });

  it("falls back to the prompt when no message was recorded", () => {
    expect(buildTaskTranscriptMarkdown([], "  Summarize the report  ", "CoWork")).toBe(
      "### You\n\nSummarize the report",
    );
    expect(buildTaskTranscriptMarkdown([], "", "CoWork")).toBe("");
  });
});
