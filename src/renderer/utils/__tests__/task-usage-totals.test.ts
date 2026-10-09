import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import { capTaskEvents } from "../task-event-append";
import { accumulateTaskUsage, retainTaskUsage } from "../task-usage-totals";

function usageEvent(
  taskId: string,
  seq: number,
  totals: { inputTokens: number; outputTokens: number; cost: number; costKnown?: boolean },
  overrides: Partial<TaskEvent> = {},
): TaskEvent {
  return {
    id: `${taskId}:usage:${seq}`,
    taskId,
    timestamp: seq,
    schemaVersion: 2,
    type: "llm_usage",
    payload: { delta: { inputTokens: 1 }, totals },
    ...overrides,
  } as TaskEvent;
}

function toolEvent(taskId: string, seq: number): TaskEvent {
  return {
    id: `${taskId}:tool:${seq}`,
    taskId,
    timestamp: seq,
    schemaVersion: 2,
    type: "tool_call",
    payload: { tool: "read_file" },
  } as TaskEvent;
}

describe("accumulateTaskUsage", () => {
  it("keeps totals and call counts stable when the event cap evicts usage events", () => {
    const events: TaskEvent[] = [];
    let accumulated = accumulateTaskUsage({}, []);
    for (let call = 1; call <= 12; call += 1) {
      const usage = usageEvent("child-a", call * 100, {
        inputTokens: call * 1000,
        outputTokens: call * 100,
        cost: call * 0.001,
      });
      events.push(usage);
      for (let tool = 1; tool <= 20; tool += 1) {
        events.push(toolEvent("child-a", call * 100 + tool));
      }
      // The renderer only keeps a capped window, but usage is folded in before capping.
      accumulated = accumulateTaskUsage(accumulated, events);
      const capped = capTaskEvents(events, 30);
      expect(capped.length).toBeLessThanOrEqual(30);
    }

    const capped = capTaskEvents(events, 30);
    expect(capped.filter((event) => event.type === "llm_usage")).toHaveLength(1);
    expect(accumulated["child-a"]).toMatchObject({
      inputTokens: 12_000,
      outputTokens: 1_200,
      llmCallCount: 12,
      costKnown: true,
    });
    expect(accumulated["child-a"]?.cost).toBeCloseTo(0.012);
  });

  it("does not decrease or double count when history is refetched or replayed", () => {
    const first = usageEvent("child-a", 1, { inputTokens: 100, outputTokens: 10, cost: 0.01 });
    const second = usageEvent("child-a", 2, { inputTokens: 300, outputTokens: 30, cost: 0.03 });
    const live = accumulateTaskUsage({}, [first, second]);

    // A refetch returns the same events (one under a different identity) plus only a
    // capped window that no longer includes the newest usage event.
    const refetched = accumulateTaskUsage(live, [
      { ...first, id: "db-row-1" } as TaskEvent,
      usageEvent("child-a", 0, { inputTokens: 50, outputTokens: 5, cost: 0.005 }, { id: "x" }),
    ]);

    expect(refetched["child-a"]).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      cost: 0.03,
    });
    expect(refetched["child-a"]?.llmCallCount).toBe(3);
    expect(accumulateTaskUsage(refetched, [first, second])).toBe(refetched);
  });

  it("keeps an unknown-cost state once any usage was unpriced", () => {
    const unpriced = usageEvent("child-a", 1, {
      inputTokens: 100,
      outputTokens: 10,
      cost: 0,
      costKnown: false,
    });
    const later = usageEvent("child-a", 2, { inputTokens: 200, outputTokens: 20, cost: 0.02 });
    const accumulated = accumulateTaskUsage({}, [unpriced, later]);
    expect(accumulated["child-a"]?.costKnown).toBe(false);
  });

  it("reads canonical usage events and ignores other event types", () => {
    const canonical = {
      id: "c-1",
      taskId: "child-b",
      timestamp: 5,
      schemaVersion: 2,
      type: "timeline_step_updated",
      payload: {
        legacyType: "llm_usage",
        totals: { inputTokens: 42, outputTokens: 8, cost: 0.002 },
      },
    } as unknown as TaskEvent;
    const accumulated = accumulateTaskUsage({}, [toolEvent("child-b", 1), canonical]);
    expect(accumulated["child-b"]).toMatchObject({ inputTokens: 42, llmCallCount: 1 });
  });
});

describe("retainTaskUsage", () => {
  it("drops tasks that are no longer children and keeps identity when unchanged", () => {
    const accumulated = accumulateTaskUsage({}, [
      usageEvent("child-a", 1, { inputTokens: 1, outputTokens: 1, cost: 0 }),
      usageEvent("child-b", 2, { inputTokens: 1, outputTokens: 1, cost: 0 }),
    ]);
    expect(retainTaskUsage(accumulated, ["child-a", "child-b"])).toBe(accumulated);
    expect(Object.keys(retainTaskUsage(accumulated, ["child-b"]))).toEqual(["child-b"]);
  });
});
