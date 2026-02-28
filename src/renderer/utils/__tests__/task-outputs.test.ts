import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  deriveTaskOutputSummaryFromEvents,
  formatOutputLocationLabel,
  getFileName,
  getPrimaryOutputFileName,
  resolveTaskOutputSummaryFromCompletionEvent,
  sanitizeTaskOutputSummary,
} from "../task-outputs";

function makeEvent(
  type: TaskEvent["type"],
  payload: Record<string, unknown>,
  timestamp: number,
): TaskEvent {
  return {
    id: `event-${timestamp}-${type}`,
    taskId: "task-1",
    timestamp,
    type,
    payload,
  };
}

describe("task output summary utilities", () => {
  it("derives summary from created files only", () => {
    const events: TaskEvent[] = [
      makeEvent("file_created", { path: "docs/old.md" }, 10),
      makeEvent("file_created", { path: "artifacts/new.md" }, 20),
    ];

    const summary = deriveTaskOutputSummaryFromEvents(events);
    expect(summary).not.toBeNull();
    expect(summary?.created).toEqual(["artifacts/new.md", "docs/old.md"]);
    expect(summary?.outputCount).toBe(2);
    expect(summary?.primaryOutputPath).toBe("artifacts/new.md");
    expect(summary?.folders).toEqual(["artifacts", "docs"]);
  });

  it("falls back to modified files when no created output exists", () => {
    const events: TaskEvent[] = [
      makeEvent("file_modified", { path: "README.md" }, 15),
      makeEvent("file_modified", { path: "docs/guide.md" }, 25),
    ];

    const summary = deriveTaskOutputSummaryFromEvents(events);
    expect(summary).not.toBeNull();
    expect(summary?.created).toEqual([]);
    expect(summary?.modifiedFallback).toEqual(["docs/guide.md", "README.md"]);
    expect(summary?.outputCount).toBe(2);
    expect(summary?.primaryOutputPath).toBe("docs/guide.md");
  });

  it("prefers created output over modified fallback when both are present", () => {
    const events: TaskEvent[] = [
      makeEvent("file_modified", { path: "README.md" }, 30),
      makeEvent("file_created", { path: "artifacts/report.md" }, 40),
    ];

    const summary = deriveTaskOutputSummaryFromEvents(events);
    expect(summary).not.toBeNull();
    expect(summary?.created).toEqual(["artifacts/report.md"]);
    expect(summary?.outputCount).toBe(1);
    expect(summary?.primaryOutputPath).toBe("artifacts/report.md");
  });

  it("includes artifact_created as output evidence", () => {
    const events: TaskEvent[] = [
      makeEvent("artifact_created", { path: "artifacts/screenshot.png" }, 50),
    ];

    const summary = deriveTaskOutputSummaryFromEvents(events);
    expect(summary).not.toBeNull();
    expect(summary?.created).toEqual(["artifacts/screenshot.png"]);
    expect(summary?.outputCount).toBe(1);
    expect(getPrimaryOutputFileName(summary)).toBe("screenshot.png");
  });

  it("formats filename-only labels and output folder context", () => {
    expect(getFileName("artifacts/legal/negotiation-analysis")).toBe("negotiation-analysis");
    const nestedSummary = sanitizeTaskOutputSummary({
      created: ["artifacts/legal/negotiation-analysis.md"],
    });
    expect(formatOutputLocationLabel(nestedSummary)).toBe("artifacts/legal/");

    const rootSummary = sanitizeTaskOutputSummary({
      created: ["negotiation-analysis.md"],
    });
    expect(formatOutputLocationLabel(rootSummary)).toBe("Workspace root");
  });

  it("returns null when no output file evidence exists", () => {
    const events: TaskEvent[] = [makeEvent("step_completed", { message: "done" }, 60)];
    expect(deriveTaskOutputSummaryFromEvents(events)).toBeNull();
  });

  it("sanitizes payload summaries and enforces fallback defaults", () => {
    const summary = sanitizeTaskOutputSummary({
      created: [],
      modifiedFallback: ["notes.md", "notes.md", "docs/review.md"],
    });
    expect(summary).not.toBeNull();
    expect(summary?.created).toEqual([]);
    expect(summary?.modifiedFallback).toEqual(["notes.md", "docs/review.md"]);
    expect(summary?.primaryOutputPath).toBe("notes.md");
    expect(summary?.folders).toEqual([".", "docs"]);
  });

  it("resolves completion summary from payload first, then event fallback", () => {
    const completionWithPayload = makeEvent(
      "task_completed",
      {
        outputSummary: {
          created: ["artifacts/final.md"],
          outputCount: 1,
          folders: ["artifacts"],
        },
      },
      70,
    );
    const fromPayload = resolveTaskOutputSummaryFromCompletionEvent(completionWithPayload, []);
    expect(fromPayload?.primaryOutputPath).toBe("artifacts/final.md");

    const completionWithoutPayload = makeEvent("task_completed", {}, 80);
    const fallbackEvents: TaskEvent[] = [
      makeEvent("file_created", { path: "artifacts/fallback.md" }, 75),
      completionWithoutPayload,
    ];
    const fromFallback = resolveTaskOutputSummaryFromCompletionEvent(
      completionWithoutPayload,
      fallbackEvents,
    );
    expect(fromFallback?.primaryOutputPath).toBe("artifacts/fallback.md");
  });
});
