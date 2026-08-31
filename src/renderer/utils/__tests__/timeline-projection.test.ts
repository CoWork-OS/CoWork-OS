import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import { normalizeEventsForTimelineUi } from "../timeline-projection";

function makeEvent(
  id: string,
  taskId: string,
  type: TaskEvent["type"],
  payload: Record<string, unknown>,
  timestamp: number,
  seq?: number,
): TaskEvent {
  return {
    id,
    taskId,
    timestamp,
    type,
    payload,
    schemaVersion: 2,
    ...(typeof seq === "number" ? { seq } : {}),
  };
}

describe("normalizeEventsForTimelineUi", () => {
  it("enforces monotonic sequence numbers per task even when persisted rows regress", () => {
    const events: TaskEvent[] = [
      makeEvent("e1", "task-1", "timeline_step_started", { stepId: "step-1" }, 100, 5),
      makeEvent("e2", "task-1", "timeline_step_updated", { stepId: "step-1" }, 110, 3),
      makeEvent("e3", "task-1", "timeline_step_finished", { stepId: "step-1" }, 120, 6),
    ];

    const normalized = normalizeEventsForTimelineUi(events);
    expect(normalized.map((event) => event.seq)).toEqual([5, 6, 7]);
  });

  it("tracks sequence independently per task lane", () => {
    const events: TaskEvent[] = [
      makeEvent("a1", "task-a", "timeline_step_started", { stepId: "a-step-1" }, 100, 2),
      makeEvent("b1", "task-b", "timeline_step_started", { stepId: "b-step-1" }, 101, 1),
      makeEvent("a2", "task-a", "timeline_step_finished", { stepId: "a-step-1" }, 102, 1),
      makeEvent("b2", "task-b", "timeline_step_finished", { stepId: "b-step-1" }, 103, 2),
    ];

    const normalized = normalizeEventsForTimelineUi(events);
    expect(normalized[0].seq).toBe(2);
    expect(normalized[1].seq).toBe(1);
    expect(normalized[2].seq).toBe(3);
    expect(normalized[3].seq).toBe(2);
  });

  it("replays deterministically for mixed legacy and v2 records", () => {
    const events: TaskEvent[] = [
      makeEvent("l1", "task-1", "task_created", { message: "start" }, 100),
      makeEvent("l2", "task-1", "tool_call", { tool: "run_command" }, 110),
      makeEvent("l3", "task-1", "tool_result", { tool: "run_command", result: "ok" }, 120),
      makeEvent("l4", "task-1", "task_completed", { resultSummary: "done" }, 130),
    ];

    const first = normalizeEventsForTimelineUi(events);
    const second = normalizeEventsForTimelineUi(events);

    expect(second).toEqual(first);
  });
});
