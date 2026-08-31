import { describe, expect, it } from "vitest";
import { resolveTaskResultText } from "../result-text";
import type { TaskEvent } from "../../../shared/types";

function makeEvent(
  type: TaskEvent["type"],
  payload: Record<string, unknown>,
  timestamp: number,
): TaskEvent {
  return {
    id: `evt-${timestamp}`,
    taskId: "task-1",
    timestamp,
    type,
    payload,
    schemaVersion: 2,
  } as TaskEvent;
}

describe("resolveTaskResultText", () => {
  it("prefers rich artifact preview over failure-like summary text", () => {
    const summary = "Almarion — this is not ready yet. Problems to fix before completion.";
    const events: TaskEvent[] = [
      makeEvent(
        "timeline_step_updated",
        { actor: "agent", message: "Almarion — this is not ready yet. Problems to fix." },
        100,
      ),
      makeEvent(
        "timeline_artifact_emitted",
        {
          path: "research/report.md",
          previewTruncated: false,
          contentPreview:
            "# Report\n\nExecutive summary with evidence-backed trends and detailed source-backed findings for the last 24 hours.\n\n- Trend 1\n- Trend 2\n- Trend 3\n",
        },
        101,
      ),
    ];

    const result = resolveTaskResultText({ summary, events });
    expect(result).toContain("# Report");
    expect(result).not.toContain("not ready yet");
  });

  it("falls back to summary when timeline messages are only progress noise", () => {
    const summary = "Final concise summary.";
    const events: TaskEvent[] = [
      makeEvent(
        "timeline_step_updated",
        { actor: "agent", message: "Executing step 1/7: Collect data" },
        100,
      ),
      makeEvent(
        "timeline_group_finished",
        { actor: "tool", message: "Tool batch: 1 succeeded" },
        101,
      ),
    ];

    const result = resolveTaskResultText({ summary, events });
    expect(result).toBe(summary);
  });

  it("never returns semantic timeline metadata as scheduled-task output", () => {
    const semanticSummary = "Browser Navigate https://web.whatsapp.com/ · List Directory";
    const events: TaskEvent[] = [makeEvent("task_completed", { semanticSummary }, 100)];

    expect(resolveTaskResultText({ semanticSummary, events })).toBeUndefined();
    expect(
      resolveTaskResultText({
        summary: "The user-facing answer.",
        semanticSummary,
      }),
    ).toBe("The user-facing answer.");
  });

  it("uses legacy assistant_message content when available", () => {
    const summary = "Short summary";
    const events: TaskEvent[] = [
      makeEvent(
        "assistant_message",
        { message: "Detailed user-facing completion text with context." },
        100,
      ),
    ];

    const result = resolveTaskResultText({ summary, events });
    expect(result).toBe("Detailed user-facing completion text with context.");
  });

  it("ignores internal assistant messages unless no better candidate exists", () => {
    const events: TaskEvent[] = [
      makeEvent(
        "assistant_message",
        {
          internal: true,
          message:
            "Internal note with details about final output selection and delivery context for downstream channels.",
        },
        100,
      ),
      makeEvent("assistant_message", { message: "Done." }, 101),
    ];

    const result = resolveTaskResultText({ summary: "", events });
    expect(result).toBe(
      "Internal note with details about final output selection and delivery context for downstream channels.",
    );
  });
});
