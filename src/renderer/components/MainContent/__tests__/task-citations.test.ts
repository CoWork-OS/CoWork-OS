import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../../shared/types";
import { extractTaskCitations } from "../task-citations";

function event(type: string, payload: Record<string, unknown>, legacyType?: string): TaskEvent {
  return { id: type, taskId: "t", timestamp: 1, type, payload, legacyType } as TaskEvent;
}

describe("extractTaskCitations", () => {
  it("reads the projected evidence event with its [N], title and connector", () => {
    const citations = extractTaskCitations([
      event(
        "timeline_evidence_attached",
        {
          evidenceRefs: [
            {
              sourceUrlOrPath: "https://calendar.google.com/e/1",
              citationIndex: 3,
              title: "Proposal review",
              sourceTool: "calendar_action",
              sourceLabel: "Google Calendar",
              capturedAt: 5,
            },
          ],
        },
        "citations_collected",
      ),
    ]);
    expect(citations).toEqual([
      {
        index: 3,
        url: "https://calendar.google.com/e/1",
        title: "Proposal review",
        snippet: "",
        domain: "calendar.google.com",
        accessedAt: 5,
        sourceTool: "calendar_action",
        sourceLabel: "Google Calendar",
      },
    ]);
  });

  it("falls back to position and domain for older evidence refs", () => {
    const [citation] = extractTaskCitations([
      event("timeline_evidence_attached", {
        evidenceRefs: [{ sourceUrlOrPath: "https://example.com/a", snippet: "x" }],
      }),
    ]);
    expect(citation).toMatchObject({
      index: 1,
      title: "example.com",
      sourceTool: "timeline_evidence",
    });
  });

  it("reads a legacy citations event and uses the latest one", () => {
    const citations = extractTaskCitations([
      event("citations_collected", { citations: [{ url: "https://old.example/a", index: 1 }] }),
      event("citations_collected", {
        citations: [
          { url: "https://new.example/a", index: 1, title: "New", sourceTool: "web_fetch" },
        ],
      }),
    ]);
    expect(citations.map((citation) => citation.url)).toEqual(["https://new.example/a"]);
  });

  it("returns nothing without a citation event", () => {
    expect(extractTaskCitations([event("assistant_message", { message: "hi" })])).toEqual([]);
  });
});
