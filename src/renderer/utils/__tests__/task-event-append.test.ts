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
    ...(overrides.eventId ? { eventId: overrides.eventId } : {}),
    ...(overrides.stepId ? { stepId: overrides.stepId } : {}),
    ...(overrides.groupId ? { groupId: overrides.groupId } : {}),
  };
}

describe("isRendererNoiseEvent", () => {
  it("identifies noise event types", () => {
    expect(isRendererNoiseEvent(makeEvent({ taskId: "t1", type: "log", timestamp: 1 }))).toBe(true);
    expect(
      isRendererNoiseEvent(makeEvent({ taskId: "t1", type: "llm_streaming", timestamp: 1 })),
    ).toBe(true);
    expect(
      isRendererNoiseEvent(makeEvent({ taskId: "t1", type: "progress_update", timestamp: 1 })),
    ).toBe(true);
  });

  it("identifies structural event types", () => {
    expect(
      isRendererNoiseEvent(makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 })),
    ).toBe(false);
    expect(
      isRendererNoiseEvent(makeEvent({ taskId: "t1", type: "task_completed", timestamp: 1 })),
    ).toBe(false);
  });
});

describe("getTransientEventReplacementKey", () => {
  it("returns null for non-replaceable types", () => {
    expect(
      getTransientEventReplacementKey(
        makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 1 }),
      ),
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
    expect(getTransientEventReplacementKey(event)).toBe(
      "t1:progress_update:step-1:group-1:analyzing",
    );
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

  it("replaces existing events by ID when re-emitted with updated payload", () => {
    const original = makeEvent({
      id: "evt-123",
      taskId: "t1",
      type: "assistant_message",
      timestamp: 1,
      payload: { message: "Here is a draft." },
    });
    const updated = makeEvent({
      id: "evt-123",
      taskId: "t1",
      type: "assistant_message",
      timestamp: 1,
      payload: {
        message: "Here is a draft.",
        inlineFrames: [{ kind: "mail_compose", draftId: "d1" }],
      },
    });
    const result = appendRendererTaskEvents([original], [updated]);
    expect(result).toHaveLength(1);
    expect((result[0].payload as Record<string, unknown>).inlineFrames).toBeDefined();
  });

  it("replaces existing events by eventId when the timeline envelope omits the database ID", () => {
    const original = makeEvent({
      id: "evt-123",
      eventId: "timeline-123",
      taskId: "t1",
      type: "assistant_message",
      timestamp: 1,
      payload: { message: "Here is a draft." },
    });
    const updated = makeEvent({
      id: "evt-123",
      eventId: "timeline-123",
      taskId: "t1",
      type: "assistant_message",
      timestamp: 1,
      payload: {
        message: "Here is a draft.",
        inlineFrames: [{ kind: "mail_compose", draftId: "d1" }],
      },
    });
    const result = appendRendererTaskEvents([original], [updated]);
    expect(result).toHaveLength(1);
    expect((result[0].payload as Record<string, unknown>).inlineFrames).toBeDefined();
  });

  it("appends event with new ID that does not match any existing event", () => {
    const prev = [makeEvent({ id: "evt-1", taskId: "t1", type: "user_message", timestamp: 1 })];
    const incoming = [
      makeEvent({ id: "evt-2", taskId: "t1", type: "assistant_message", timestamp: 2 }),
    ];
    const result = appendRendererTaskEvents(prev, incoming);
    expect(result).toHaveLength(2);
  });

  it("handles mixed replaceable and non-replaceable incoming events", () => {
    const existing = makeEvent({
      taskId: "t1",
      type: "progress_update",
      timestamp: 1,
      stepId: "s1",
      payload: { stage: "old" },
    });
    const prev = [makeEvent({ taskId: "t1", type: "assistant_message", timestamp: 0 }), existing];

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

  it("truncates large command output payloads in renderer state", () => {
    const hugeOutput = "x".repeat(80 * 1024);
    const event = makeEvent({
      taskId: "t1",
      type: "command_output",
      timestamp: 1,
      payload: { type: "stderr", output: hugeOutput },
    });

    const [result] = capTaskEvents([event], 10);

    expect(result).not.toBe(event);
    expect(String(result.payload?.output || "").length).toBeLessThan(20 * 1024);
    expect(String(result.payload?.output || "")).toContain("renderer payload truncated");
  });

  it("preserves approval request payloads so approval dialogs keep full command details", () => {
    const command = "x".repeat(80 * 1024);
    const approval = makeEvent({
      taskId: "t1",
      type: "approval_requested",
      timestamp: 1,
      id: "approval",
      payload: {
        approval: {
          id: "approval-1",
          type: "run_command",
          description: "Run command",
          details: { command },
        },
      },
    });
    const noisyOutput = makeEvent({
      taskId: "t1",
      type: "command_output",
      timestamp: 2,
      id: "output",
      payload: { output: "y".repeat(80 * 1024) },
    });

    const result = capTaskEvents([approval, noisyOutput], 10, 32 * 1024);
    const retainedApproval = result.find((event) => event.id === "approval");

    expect(retainedApproval).toBeDefined();
    expect(
      String((retainedApproval?.payload?.approval as Any)?.details?.command || ""),
    ).toHaveLength(command.length);
  });

  it("caps retained payload bytes while preserving recent structural events", () => {
    const events = [
      makeEvent({
        taskId: "t1",
        type: "tool_result",
        timestamp: 1,
        id: "old-large",
        payload: { content: "a".repeat(40 * 1024) },
      }),
      makeEvent({
        taskId: "t1",
        type: "assistant_message",
        timestamp: 2,
        id: "structural",
        payload: { content: "keep me" },
      }),
      makeEvent({
        taskId: "t1",
        type: "tool_result",
        timestamp: 3,
        id: "new-large",
        payload: { content: "b".repeat(40 * 1024) },
      }),
    ];

    const result = capTaskEvents(events, 10, 45 * 1024);

    expect(result.map((event) => event.id)).toEqual(["old-large", "structural", "new-large"]);
    // The out-of-budget tool result stays so its tool call keeps a completion, as a preview.
    const oldLarge = result.find((event) => event.id === "old-large");
    expect(String(oldLarge?.payload?.content || "").length).toBeLessThan(2 * 1024);
    expect(String(oldLarge?.payload?.content || "")).toContain("renderer payload truncated");
    const newLarge = result.find((event) => event.id === "new-large");
    expect(String(newLarge?.payload?.content || "").length).toBeGreaterThan(30 * 1024);
  });

  it("keeps timeline v2 tool calls and assistant messages that fall outside the byte budget", () => {
    // Timeline v2 records tool calls, tool results and assistant messages all as
    // timeline_step_updated; only legacyType tells them apart. A long task's tool output used
    // to push every older one of them out, leaving empty step headers behind.
    const v2 = (id: string, legacyType: string, timestamp: number, payload: object) =>
      ({
        ...makeEvent({ id, taskId: "t1", type: "timeline_step_updated", timestamp, payload }),
        legacyType,
      }) as TaskEvent;
    const events = [
      v2("old-log", "log", 0, { message: "noise" }),
      v2("old-message", "assistant_message", 1, { message: "Checking the IPC surface." }),
      v2("old-call", "tool_call", 2, { tool: "run_command", callId: "c1" }),
      v2("old-result", "tool_result", 3, { callId: "c1", result: "r".repeat(60 * 1024) }),
      v2("new-call", "tool_call", 5, { tool: "run_command", callId: "c2" }),
      v2("new-result", "tool_result", 6, { callId: "c2", result: "s".repeat(30 * 1024) }),
    ];

    const result = capTaskEvents(events, 100, 40 * 1024);

    expect(result.map((event) => event.id)).toEqual([
      "old-message",
      "old-call",
      "old-result",
      "new-call",
      "new-result",
    ]);
  });

  it("returns the same compacted event objects on repeated caps", () => {
    const events = [
      makeEvent({
        taskId: "t1",
        type: "tool_result",
        timestamp: 1,
        id: "old",
        payload: { content: "a".repeat(40 * 1024) },
      }),
      makeEvent({
        taskId: "t1",
        type: "tool_result",
        timestamp: 2,
        id: "new",
        payload: { content: "b".repeat(40 * 1024) },
      }),
    ];

    const first = capTaskEvents(events, 10, 45 * 1024);
    const second = capTaskEvents(first, 10, 45 * 1024);

    expect(second[0]).toBe(first[0]);
  });

  it("keeps the newest llm_usage event of each task when structural events fill the cap", () => {
    const usage = (taskId: string, timestamp: number, inputTokens: number) =>
      makeEvent({
        taskId,
        type: "llm_usage",
        timestamp,
        payload: { totals: { inputTokens, outputTokens: 10, cost: 0.01 } },
      });
    const events: TaskEvent[] = [
      usage("child-a", 1, 100),
      usage("child-b", 2, 200),
      usage("child-a", 3, 300),
      ...Array.from({ length: 10 }, (_, i) =>
        makeEvent({ taskId: i % 2 ? "child-a" : "child-b", type: "tool_call", timestamp: 10 + i }),
      ),
    ];

    const result = capTaskEvents(events, 6);

    expect(result).toHaveLength(6);
    const usageEvents = result.filter((event) => event.type === "llm_usage");
    expect(usageEvents.map((event) => event.id)).toEqual([
      "child-b:llm_usage:2",
      "child-a:llm_usage:3",
    ]);
    expect(result.slice(-4).every((event) => event.type === "tool_call")).toBe(true);
    const timestamps = result.map((event) => event.timestamp);
    expect(timestamps).toEqual(timestamps.slice().sort((a, b) => a - b));
  });

  it("keeps canonical usage events pinned when noise is evicted", () => {
    const canonicalUsage = makeEvent({
      taskId: "child-a",
      type: "timeline_step_updated" as TaskEvent["type"],
      timestamp: 1,
      payload: { legacyType: "llm_usage", totals: { inputTokens: 500, outputTokens: 50 } },
    });
    const noise = Array.from({ length: 6 }, (_, i) =>
      makeEvent({ taskId: "child-a", type: "log", timestamp: 2 + i }),
    );
    const structural = makeEvent({ taskId: "child-a", type: "assistant_message", timestamp: 20 });

    const result = capTaskEvents([canonicalUsage, ...noise, structural], 3);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(canonicalUsage);
    expect(result[result.length - 1]).toBe(structural);
  });
});
