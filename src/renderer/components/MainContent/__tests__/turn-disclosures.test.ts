import { describe, expect, it } from "vitest";
import type { EventType, TaskEvent } from "../../../../shared/types";
import {
  INITIAL_TURN_ID,
  applyTurnDisclosures,
  isPlanStepLifecycleEvent,
  isQuietActivityBlock,
  mergeAdjacentActivityBlockRows,
  shouldUseTurnDisclosures,
  type TaskFeedRow,
} from "../task-feed-logic";

function makeEvent(
  id: string,
  timestamp: number,
  type: EventType,
  payload: Record<string, unknown> = {},
): TaskEvent {
  return { id, taskId: "task-1", timestamp, type, payload } as TaskEvent;
}

function eventRow(
  id: string,
  timestamp: number,
  type: EventType,
  payload: Record<string, unknown> = {},
): TaskFeedRow {
  return {
    kind: "timeline",
    key: `event:${id}`,
    estimatedHeight: 40,
    timelineIndex: timestamp,
    item: { kind: "event", event: makeEvent(id, timestamp, type, payload), eventIndex: timestamp },
    revision: id,
    visiblePerfEventId: id,
  };
}

function blockRow(id: string, events: TaskEvent[]): TaskFeedRow {
  return {
    kind: "timeline",
    key: `action-block:${id}`,
    estimatedHeight: 34,
    timelineIndex: events[0]?.timestamp ?? 0,
    item: {
      kind: "action_block",
      blockId: id,
      events,
      eventIndices: events.map((event) => event.timestamp),
    },
    revision: id,
    visiblePerfEventId: null,
  };
}

const keysOf = (rows: TaskFeedRow[]) => rows.map((row) => row.key);

describe("applyTurnDisclosures", () => {
  const firstTurn = [
    eventRow("commentary-1", 110, "assistant_message", { message: "Listing handlers." }),
    blockRow("block-1", [makeEvent("call-1", 120, "tool_call", { tool: "run_command" })]),
    eventRow("answer-1", 200, "assistant_message", { message: "Found two issues." }),
  ];
  const secondTurn = [
    eventRow("user-2", 300, "user_message", { message: "Fix them" }),
    blockRow("block-2", [makeEvent("call-2", 320, "tool_call", { tool: "edit_file" })]),
    eventRow("answer-2", 400, "assistant_message", { message: "Fixed." }),
  ];

  it("folds each finished turn's work behind its own header", () => {
    const { rows, turns } = applyTurnDisclosures([...firstTurn, ...secondTurn], {
      isTaskWorking: false,
      taskStartedAt: 100,
      isTurnExpanded: () => false,
    });

    expect(keysOf(rows)).toEqual([
      `turn-header:${INITIAL_TURN_ID}`,
      "event:answer-1",
      "event:user-2",
      "turn-header:turn:user-2",
      "event:answer-2",
    ]);
    expect(turns).toEqual([
      {
        id: INITIAL_TURN_ID,
        status: "worked",
        startedAt: 100,
        endedAt: 200,
        expanded: false,
        collapsible: true,
      },
      {
        id: "turn:user-2",
        status: "worked",
        startedAt: 300,
        endedAt: 400,
        expanded: false,
        collapsible: true,
      },
    ]);
  });

  it("shows an expanded turn's work between its header and answer", () => {
    const { rows } = applyTurnDisclosures([...firstTurn, ...secondTurn], {
      isTaskWorking: false,
      taskStartedAt: 100,
      isTurnExpanded: (turnId) => turnId === "turn:user-2",
    });

    expect(keysOf(rows)).toEqual([
      `turn-header:${INITIAL_TURN_ID}`,
      "event:answer-1",
      "event:user-2",
      "turn-header:turn:user-2",
      "action-block:block-2",
      "event:answer-2",
    ]);
  });

  it("keeps the running turn open with a working header and no final answer", () => {
    const { rows, turns } = applyTurnDisclosures([...firstTurn, ...secondTurn], {
      isTaskWorking: true,
      taskStartedAt: 100,
      isTurnExpanded: () => false,
    });

    // While the turn runs no message is its answer yet, so everything stays in view.
    expect(keysOf(rows).slice(2)).toEqual([
      "event:user-2",
      "turn-header:turn:user-2",
      "action-block:block-2",
      "event:answer-2",
    ]);
    expect(turns[1]).toMatchObject({
      status: "working",
      endedAt: null,
      expanded: true,
      collapsible: false,
    });
  });

  it("surfaces critical events from folded work", () => {
    const rows = [
      blockRow("block-1", [
        makeEvent("call-1", 120, "tool_call", { tool: "run_command" }),
        makeEvent("error-1", 130, "error", { message: "Command failed" }),
      ]),
      eventRow("answer-1", 200, "assistant_message", { message: "Partially done." }),
    ];

    const result = applyTurnDisclosures(rows, {
      isTaskWorking: false,
      taskStartedAt: 100,
      isTurnExpanded: () => false,
    });

    expect(keysOf(result.rows)).toEqual([
      `turn-header:${INITIAL_TURN_ID}`,
      "delivery-event:error-1:130",
      "event:answer-1",
    ]);
  });

  it("does not fold a finished turn that has no final answer", () => {
    const rows = [
      blockRow("block-1", [makeEvent("call-1", 120, "tool_call", { tool: "run_command" })]),
    ];

    const result = applyTurnDisclosures(rows, {
      isTaskWorking: false,
      taskStartedAt: 100,
      isTurnExpanded: () => false,
    });

    expect(keysOf(result.rows)).toEqual([`turn-header:${INITIAL_TURN_ID}`, "action-block:block-1"]);
    expect(result.turns[0]).toMatchObject({ collapsible: false, expanded: true, endedAt: 120 });
  });

  it("skips the header for a turn that is only an answer", () => {
    const rows = [eventRow("answer-1", 200, "assistant_message", { message: "Hi." })];

    const result = applyTurnDisclosures(rows, {
      isTaskWorking: false,
      taskStartedAt: 100,
      isTurnExpanded: () => false,
    });

    expect(keysOf(result.rows)).toEqual(["event:answer-1"]);
    expect(result.turns).toEqual([]);
  });

  it("prefers a non-commentary message as the turn's answer", () => {
    const rows = [
      eventRow("commentary-1", 110, "assistant_message", {
        message: "Checking the handlers.",
        phase: "commentary",
      }),
      blockRow("block-1", [makeEvent("call-1", 120, "tool_call", { tool: "run_command" })]),
      eventRow("answer-1", 200, "assistant_message", { message: "Two handlers are unguarded." }),
      eventRow("commentary-2", 210, "assistant_message", {
        message: "Recording the findings.",
        phase: "commentary",
      }),
      blockRow("block-2", [makeEvent("call-2", 220, "tool_call", { tool: "write_file" })]),
    ];

    const result = applyTurnDisclosures(rows, {
      isTaskWorking: false,
      taskStartedAt: 100,
      isTurnExpanded: () => false,
    });

    expect(keysOf(result.rows)).toEqual([
      `turn-header:${INITIAL_TURN_ID}`,
      "event:answer-1",
      "event:commentary-2",
      "action-block:block-2",
    ]);
  });

  it("treats a completion event carrying the final summary as the turn's answer", () => {
    const rows = [
      eventRow("kickoff", 110, "assistant_message", { message: "I'll map the folder first." }),
      blockRow("block-1", [makeEvent("call-1", 120, "tool_call", { tool: "list_directory" })]),
      eventRow("commentary-1", 130, "assistant_message", {
        message: "Reading the four components next.",
        phase: "commentary",
      }),
      blockRow("block-2", [makeEvent("call-2", 140, "tool_call", { tool: "read_file" })]),
      eventRow("done", 400, "task_completed", {
        resultSummary: "Each component's responsibility is summarized below.",
      }),
    ];

    const result = applyTurnDisclosures(rows, {
      isTaskWorking: false,
      taskStartedAt: 100,
      isTurnExpanded: () => false,
    });

    expect(keysOf(result.rows)).toEqual([`turn-header:${INITIAL_TURN_ID}`, "event:done"]);
    expect(result.turns[0]).toMatchObject({ endedAt: 400, collapsible: true });
  });

  it("does not treat internal assistant messages as the turn's answer", () => {
    const rows = [
      blockRow("block-1", [makeEvent("call-1", 120, "tool_call", { tool: "run_command" })]),
      eventRow("answer-1", 200, "assistant_message", { message: "Done." }),
      eventRow("internal-1", 210, "assistant_message", { message: "note", internal: true }),
    ];

    const result = applyTurnDisclosures(rows, {
      isTaskWorking: false,
      taskStartedAt: 100,
      isTurnExpanded: () => false,
    });

    expect(keysOf(result.rows)).toEqual([
      `turn-header:${INITIAL_TURN_ID}`,
      "event:answer-1",
      "event:internal-1",
    ]);
  });
});

describe("turn disclosure helpers", () => {
  it("enables turn headers only for the compact transcript", () => {
    const base = { verboseSteps: false, isReplayMode: false, isConversationOnlySurface: false };
    expect(shouldUseTurnDisclosures(base)).toBe(true);
    expect(shouldUseTurnDisclosures({ ...base, verboseSteps: true })).toBe(false);
    expect(shouldUseTurnDisclosures({ ...base, isReplayMode: true })).toBe(false);
    expect(shouldUseTurnDisclosures({ ...base, isConversationOnlySurface: true })).toBe(false);
  });

  it("recognizes plan-step start and finish markers but not failures", () => {
    expect(isPlanStepLifecycleEvent(makeEvent("s", 1, "step_started"))).toBe(true);
    expect(isPlanStepLifecycleEvent(makeEvent("c", 1, "step_completed"))).toBe(true);
    expect(isPlanStepLifecycleEvent(makeEvent("f", 1, "step_failed"))).toBe(false);
  });
});

describe("mergeAdjacentActivityBlockRows", () => {
  it("joins neighbouring activity blocks and keeps the first block's identity", () => {
    const rows = [
      blockRow("block-1", [makeEvent("call-1", 10, "tool_call", { tool: "write_file" })]),
      blockRow("block-2", [makeEvent("call-2", 20, "tool_call", { tool: "run_command" })]),
      eventRow("answer", 30, "assistant_message", { message: "Done." }),
      blockRow("block-3", [makeEvent("call-3", 40, "tool_call", { tool: "grep" })]),
    ];

    const merged = mergeAdjacentActivityBlockRows(rows);

    expect(keysOf(merged)).toEqual([
      "action-block:block-1",
      "event:answer",
      "action-block:block-3",
    ]);
    const first = merged[0] as Extract<TaskFeedRow, { kind: "timeline" }>;
    expect(first.item.blockId).toBe("block-1");
    expect(first.item.events.map((entry: TaskEvent) => entry.id)).toEqual(["call-1", "call-2"]);
    expect(first.item.eventIndices).toEqual([10, 20]);
    expect(first.timelineIndex).toBe(20);
  });
});

describe("isQuietActivityBlock", () => {
  it("flags blocks made only of lifecycle markers with no tool activity", () => {
    const markers = [
      makeEvent("created", 1, "task_created"),
      makeEvent("started", 2, "step_started"),
      makeEvent("done", 3, "step_completed"),
    ];
    expect(isQuietActivityBlock(markers, 0)).toBe(true);
    expect(isQuietActivityBlock(markers, 2)).toBe(false);
    expect(isQuietActivityBlock([...markers, makeEvent("fail", 4, "step_failed")], 0)).toBe(
      false,
    );
  });
});
