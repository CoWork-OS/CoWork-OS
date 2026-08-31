import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import type { SummaryUiEvent } from "../../../shared/timeline-events";
import {
  buildTaskTraceDebugRows,
  buildTaskTraceTranscriptRows,
  filterTaskTraceRows,
  normalizeTaskTraceMarkdownDisplay,
  serializeTaskTraceRows,
} from "../task-trace-debugger";

function makeEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: overrides.id ?? "evt-1",
    taskId: overrides.taskId ?? "task-1",
    timestamp: overrides.timestamp ?? 1_000,
    type: overrides.type ?? "tool_call",
    payload: overrides.payload ?? {},
    schemaVersion: 2,
    ...overrides,
  } as TaskEvent;
}

function makeUiEvent(overrides: Partial<SummaryUiEvent> = {}): SummaryUiEvent {
  return {
    id: overrides.id ?? "ui-1",
    kind: "summary",
    phase: overrides.phase ?? "explore",
    actionKind: overrides.actionKind ?? "step.update",
    status: overrides.status ?? "success",
    summary: overrides.summary ?? "Read repository context",
    startedAt: overrides.startedAt ?? new Date(1_000).toISOString(),
    durationMs: overrides.durationMs ?? 500,
    evidence: overrides.evidence ?? [],
    rawEventIds: overrides.rawEventIds ?? ["evt-1"],
    expandable: overrides.expandable ?? true,
    ...overrides,
  };
}

describe("task-trace-debugger utils", () => {
  it("builds transcript rows from semantic timeline events", () => {
    const rows = buildTaskTraceTranscriptRows(
      [
        makeUiEvent({
          summary: "Searched the codebase",
          rawEventIds: ["evt-1"],
        }),
      ],
      [
        makeEvent({
          id: "evt-1",
          type: "assistant_message",
          payload: { message: "Let me search more broadly for reference files." },
        }),
      ],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tab: "transcript",
      label: "Agent",
      title: "Searched the codebase",
    });
    expect(rows[0].body).toContain("search more broadly");
  });

  it("labels transcript rows by the underlying event family instead of defaulting to agent", () => {
    const rows = buildTaskTraceTranscriptRows(
      [
        makeUiEvent({
          id: "ui-model",
          summary: "Used the model",
          rawEventIds: ["evt-model"],
          actionKind: "step.update",
        }),
      ],
      [
        makeEvent({
          id: "evt-model",
          type: "llm_usage",
          payload: {
            providerType: "openai",
            modelId: "gpt-5.4",
            totals: {
              inputTokens: 120,
              outputTokens: 34,
            },
          },
        }),
      ],
    );

    expect(rows[0].label).toBe("Model");
    expect(rows[0].actor).toBe("model");
  });

  it("falls back to transcript rows derived from raw events when semantic rows are unavailable", () => {
    const rows = buildTaskTraceTranscriptRows(
      [],
      [
        makeEvent({
          id: "evt-user",
          type: "user_message",
          payload: { message: "Rules: Do not create a PR." },
        }),
      ],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tab: "transcript",
      label: "User",
      rawEventIds: ["evt-user"],
    });
    expect(rows[0].inspector.title).toContain("Rules: Do not create a PR.");
  });

  it("builds debug rows with badges and payload-backed inspector metadata", () => {
    const rows = buildTaskTraceDebugRows([
      makeEvent({
        id: "evt-usage",
        type: "llm_usage",
        status: "completed",
        seq: 12,
        payload: {
          providerType: "openai",
          modelId: "gpt-5.4",
          delta: { inputTokens: 220, outputTokens: 45 },
        },
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].badges.map((badge) => badge.label)).toEqual(
      expect.arrayContaining(["Llm Usage", "Completed", "seq 12", "in 220", "out 45"]),
    );
    expect(rows[0].inspector.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Sequence", value: "12" })]),
    );
  });

  it("filters rows by actor and search query", () => {
    const rows = buildTaskTraceDebugRows([
      makeEvent({
        id: "evt-user",
        type: "user_message",
        payload: { message: "First request" },
      }),
      makeEvent({
        id: "evt-tool",
        type: "tool_call",
        payload: { tool: "bash", message: "Run tests" },
      }),
    ]);

    const filtered = filterTaskTraceRows(rows, "tool", "tests");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rawEventIds).toEqual(["evt-tool"]);
  });

  it("serializes transcript rows as readable text and debug rows as JSON", () => {
    const transcriptRows = buildTaskTraceTranscriptRows(
      [makeUiEvent({ summary: "Uploaded the file" })],
      [
        makeEvent({
          id: "evt-1",
          type: "assistant_message",
          payload: { message: "Upload complete" },
        }),
      ],
    );
    const debugRows = buildTaskTraceDebugRows([
      makeEvent({
        id: "evt-tool",
        type: "tool_call",
        payload: { tool: "bash", command: "npm test" },
      }),
    ]);

    expect(serializeTaskTraceRows(transcriptRows, "transcript")).toContain("Uploaded the file");
    expect(serializeTaskTraceRows(debugRows, "debug")).toContain('"rawEventIds": [');
  });

  it("removes leading glob stars from trace markdown display", () => {
    const output = normalizeTaskTraceMarkdownDisplay(
      "Glob search: **/references/full-guidance.md in **",
    );

    expect(output).toContain("`/references/full-guidance.md`");
    expect(output).toContain("all files");
    expect(output).not.toContain("**/references/full-guidance.md");
    expect(output).not.toContain(" in **");
  });
});
