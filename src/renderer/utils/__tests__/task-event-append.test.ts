import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import {
  appendRendererTaskEvents,
  capTaskEvents,
  getTransientEventReplacementKey,
  isRendererNoiseEvent,
} from "../task-event-append";

function makeEvent(
  overrides: Partial<TaskEvent> & Pick<TaskEvent, "taskId" | "type" | "timestamp">,
): TaskEvent {
  return {
    id: overrides.id ?? `${overrides.taskId}:${overrides.type}:${overrides.timestamp}`,
    taskId: overrides.taskId,
    type: overrides.type,
    timestamp: overrides.timestamp,
    payload: overrides.payload ?? {},
    schemaVersion: overrides.schemaVersion ?? 2,
    ...(overrides.stepId ? { stepId: overrides.stepId } : {}),
    ...(overrides.groupId ? { groupId: overrides.groupId } : {}),
  };
}

describe("isRendererNoiseEvent", () => {
  it("identifies noise event types", () => {
    expect(isRendererNoiseEvent(makeEvent({ taskId: "t1", type: "log", timestamp: 1 }))).toBe(true);
    expect(isRendererNoiseEvent(makeEvent({ taskId: "t1", type: "llm_streaming", timestamp: 1 }))).toBe(true);
    expect(isRendererNoiseEvent(makeEvent({ taskId: "t1", type: "progress_update", timestamp: 1 }))).toBe(true);
  });

  it("identifies structural event types", () => {
    expect(isRendererNoiseEvent(makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 }))).toBe(false);
    expect(isRendererNoiseEvent(makeEvent({ taskId: "t1", type: "task_completed", timestamp: 1 }))).toBe(false);
  });
});

describe("getTransientEventReplacementKey", () => {
  it("returns null for non-replaceable types", () => {
    expect(
      getTransientEventReplacementKey(makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 })),
    ).toBeNull();
  });

  it("builds a key from taskId, type, stepId, groupId, and stage", () => {
    const event = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 1,
      stepId: "step-1",
      groupId: "group-1",
      payload: { stage: "analyzing" },
    });
    expect(getTransientEventReplacementKey(event)).toBe("t1:progress_update:step-1:group-1:analyzing");
  });

  it("extracts stepId from payload.step.id", () => {
    const event = makeEvent({
      taskId: "t1",
      type: "executing",
      timestamp: 1,
      payload: { step: { id: "nested-step" } },
    });
    expect(getTransientEventReplacementKey(event)).toBe("t1:executing:nested-step::");
  });

  it("uses label as fallback for stage", () => {
    const event = makeEvent({
      taskId: "t1",
      type: "llm_streaming",
      timestamp: 1,
      payload: { label: "generating" },
    });
    expect(getTransientEventReplacementKey(event)).toBe("t1:llm_streaming:::generating");
  });
});

describe("appendRendererTaskEvents", () => {
  it("returns previous events unchanged when incoming is empty", () => {
    const prev = [makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 })];
    expect(appendRendererTaskEvents(prev, [])).toBe(prev);
  });

  it("appends non-replaceable events", () => {
    const prev = [makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 })];
    const incoming = [makeEvent({ taskId: "t1", type: "task_completed", timestamp: 2 })];
    const result = appendRendererTaskEvents(prev, incoming);
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe("task_completed");
  });

  it("replaces existing events by transient key", () => {
    const existing = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 1,
      stepId: "s1",
      payload: { stage: "planning", message: "old" },
    });
    const replacement = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 2,
      stepId: "s1",
      payload: { stage: "planning", message: "new" },
    });
    const result = appendRendererTaskEvents([existing], [replacement]);
    expect(result).toHaveLength(1);
    expect((result[0].payload as Record<string, unknown>).message).toBe("new");
  });

  it("appends replaceable events when no match exists in previous", () => {
    const prev = [makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 })];
    const incoming = [
      makeEvent({
        taskId: "t1",
        type: "progress_update",
        timestamp: 2,
        stepId: "s1",
        payload: { stage: "running" },
      }),
    ];
    const result = appendRendererTaskEvents(prev, incoming);
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe("progress_update");
  });

  it("handles mixed replaceable and non-replaceable incoming events", () => {
    const existing = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 1,
      stepId: "s1",
      payload: { stage: "old" },
    });
    const prev = [
      makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 0 }),
      existing,
    ];

    const replacement = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 2,
      stepId: "s1",
      payload: { stage: "old" },
    });
    const append = makeEvent({ taskId: "t1", type: "task_completed", timestamp: 3 });

    const result = appendRendererTaskEvents(prev, [replacement, append]);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("assistant_message");
    expect(result[1].type).toBe("progress_update");
    expect(result[1].timestamp).toBe(2);
    expect(result[2].type).toBe("task_completed");
  });
});

describe("capTaskEvents", () => {
  it("returns events unchanged when under the cap", () => {
    const events = [makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 })];
    expect(capTaskEvents(events, 10)).toBe(events);
  });

  it("prioritizes structural events over noise events", () => {
    const structural = makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 100 });
    const noise = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ taskId: "t1", type: "log", timestamp: i }),
    );
    const events = [...noise, structural];
    const result = capTaskEvents(events, 3);
    expect(result.some((e) => e.type === "assistant_message")).toBe(true);
    expect(result).toHaveLength(3);
  });

  it("keeps most recent noise when budget allows", () => {
    const structural = makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 50 });
    const noise = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ taskId: "t1", type: "progress_update", timestamp: i, id: `n-${i}` }),
    );
    const events = [...noise, structural];
    const result = capTaskEvents(events, 4);
    expect(result).toHaveLength(4);
    expect(result[result.length - 1].type).toBe("assistant_message");
  });
});
