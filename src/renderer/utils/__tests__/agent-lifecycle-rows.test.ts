import { describe, expect, it } from "vitest";

import type { Task, TaskEvent } from "../../../shared/types";
import {
  buildAgentLifecycleRows,
  describeAgentStatus,
  resolveAgentDisplayName,
  withoutCoveredAgentLifecycleEvents,
} from "../agent-lifecycle-rows";
import type { BaseTimelineItem } from "../task-event-derived";

const T0 = 1_760_000_000_000;

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    prompt: "Do the thing",
    status: "executing",
    workspaceId: "workspace-1",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as Task;
}

function makeEvent(
  id: string,
  type: TaskEvent["type"],
  payload: Record<string, unknown>,
): TaskEvent {
  return { id, taskId: "parent", timestamp: T0, type, payload, schemaVersion: 2 } as TaskEvent;
}

describe("buildAgentLifecycleRows", () => {
  it("groups agents spawned together into one start row", () => {
    const rows = buildAgentLifecycleRows([
      makeTask("a", { createdAt: T0 }),
      makeTask("b", { createdAt: T0 + 2_000 }),
      makeTask("c", { createdAt: T0 + 4_000 }),
    ]);
    expect(rows).toEqual([
      { id: "start:working:a", state: "working", timestamp: T0, taskIds: ["a", "b", "c"] },
    ]);
  });

  it("starts a new row for a later burst", () => {
    const rows = buildAgentLifecycleRows([
      makeTask("a", { createdAt: T0 }),
      makeTask("b", { createdAt: T0 + 60_000 }),
    ]);
    expect(rows.map((row) => row.taskIds)).toEqual([["a"], ["b"]]);
  });

  it("adds end rows split by outcome, after the start row", () => {
    const rows = buildAgentLifecycleRows([
      makeTask("a", { status: "completed", completedAt: T0 + 30_000 }),
      makeTask("b", { status: "completed", completedAt: T0 + 31_000 }),
      makeTask("c", { status: "failed", completedAt: T0 + 32_000 }),
      makeTask("d", { status: "executing" }),
    ]);
    expect(rows.map((row) => [row.state, row.taskIds])).toEqual([
      ["working", ["a", "b", "c", "d"]],
      ["finished", ["a", "b"]],
      ["failed", ["c"]],
    ]);
  });

  it("never places an end row before its start row", () => {
    const rows = buildAgentLifecycleRows([
      makeTask("a", { createdAt: T0, status: "cancelled", completedAt: T0 - 5_000 }),
    ]);
    expect(rows.map((row) => row.state)).toEqual(["working", "stopped"]);
    expect(rows[1].timestamp).toBe(T0);
  });

  it("keeps a burst's row id stable as more agents join it", () => {
    const first = buildAgentLifecycleRows([makeTask("a")]);
    const later = buildAgentLifecycleRows([makeTask("a"), makeTask("b", { createdAt: T0 + 1 })]);
    expect(later[0].id).toBe(first[0].id);
  });
});

describe("resolveAgentDisplayName", () => {
  it("drops the mention prefix, leading emoji and call-sign", () => {
    expect(resolveAgentDisplayName("@builder: 🔧 Fix the parser (builder)")).toBe("Fix the parser");
  });

  it("clips long titles", () => {
    expect(resolveAgentDisplayName("A".repeat(40))).toBe(`${"A".repeat(28)}…`);
  });

  it("falls back when nothing is left", () => {
    expect(resolveAgentDisplayName("")).toBe("Agent");
  });
});

describe("describeAgentStatus", () => {
  it("maps task statuses to chip tones", () => {
    expect(describeAgentStatus("executing")).toEqual({ tone: "running", label: "Working" });
    expect(describeAgentStatus("completed")).toEqual({ tone: "done", label: "Done" });
    expect(describeAgentStatus("cancelled")).toEqual({ tone: "failed", label: "Stopped" });
    expect(describeAgentStatus("queued")).toEqual({ tone: "queued", label: "Queued" });
  });
});

describe("withoutCoveredAgentLifecycleEvents", () => {
  const spawned = makeEvent("e1", "agent_spawned", { childTaskId: "a" });
  const completed = makeEvent("e2", "agent_completed", { childTaskId: "a" });
  const otherChild = makeEvent("e3", "agent_spawned", { childTaskId: "zzz" });
  const message = makeEvent("e4", "agent_message", { childTaskId: "a" });
  const assistant = makeEvent("e5", "assistant_message", { message: "hi" });

  it("drops spawn and finish events for covered agents only", () => {
    const items: BaseTimelineItem[] = [
      { kind: "event", event: spawned, eventIndex: 0, timestamp: T0 },
      {
        kind: "action_block",
        blockId: "b1",
        events: [completed, otherChild, message],
        eventIndices: [1, 2, 3],
        timestamp: T0,
      },
      { kind: "event", event: assistant, eventIndex: 4, timestamp: T0 },
    ];
    const result = withoutCoveredAgentLifecycleEvents(items, new Set(["a"]));
    expect(result).toEqual([
      {
        kind: "action_block",
        blockId: "b1",
        events: [otherChild, message],
        eventIndices: [2, 3],
        timestamp: T0,
      },
      items[2],
    ]);
  });

  it("drops a block left empty", () => {
    const items: BaseTimelineItem[] = [
      { kind: "action_block", blockId: "b1", events: [spawned], eventIndices: [0], timestamp: T0 },
    ];
    expect(withoutCoveredAgentLifecycleEvents(items, new Set(["a"]))).toEqual([]);
  });

  it("returns the same array when nothing is covered", () => {
    const items: BaseTimelineItem[] = [
      { kind: "event", event: assistant, eventIndex: 0, timestamp: T0 },
    ];
    expect(withoutCoveredAgentLifecycleEvents(items, new Set(["a"]))).toBe(items);
  });
});
