import { describe, expect, it } from "vitest";
import type { Task, TaskEvent } from "../../../shared/types";
import {
  isActivityBlockInLatestTurn,
  isTaskTurnTerminalEvent,
  resolveInitialTaskTurnTiming,
} from "../task-turn-timing";

const task = {
  id: "task-1",
  createdAt: 1000,
  updatedAt: 901_500,
  completedAt: 901_500,
  status: "completed",
} as Task;
function event(type: string, timestamp: number, payload: Record<string, unknown> = {}): TaskEvent {
  return {
    id: `${type}-${timestamp}`,
    taskId: task.id,
    type,
    timestamp,
    payload,
  } as TaskEvent;
}

describe("resolveInitialTaskTurnTiming", () => {
  const initial = [
    event("task_created", 1000),
    event("user_message", 1010),
    event("task_completed", 57_607, { lastRunDurationMs: 56_597 }),
  ];
  const followUp = [
    event("task_resumed", 889_000, { newRunStarted: true }),
    event("user_message", 889_000),
  ];

  it("ends a quota-failed original turn at its explicit terminal error before a later follow-up", () => {
    const terminal = event("timeline_error", 16_000, {
      legacyType: "error",
      terminal_failure_fingerprint: "ChatGPT usage limit|unknown|",
    });
    expect(
      resolveInitialTaskTurnTiming({
        task: { ...task, status: "executing", completedAt: undefined },
        events: [initial[0], initial[1], terminal, ...followUp],
        isTaskWorking: true,
      }),
    ).toMatchObject({ startedAt: 1010, completedAt: 16_000, isWorking: false, isFinished: true });
    expect(
      isTaskTurnTerminalEvent(event("timeline_error", 5_000, { message: "Recoverable error" })),
    ).toBe(false);
  });

  it("keeps the original duration after a short follow-up overwrites the task row", () => {
    const timing = resolveInitialTaskTurnTiming({
      task,
      events: [
        ...initial,
        ...followUp,
        event("follow_up_completed", 901_500),
        event("task_completed", 901_505),
      ],
      isTaskWorking: false,
    });
    expect(timing).toEqual({
      startedAt: 1010,
      completedAt: 57_607,
      durationMs: 56_597,
      isWorking: false,
      isFinished: true,
    });
  });

  it("does not restart the original header clock while a follow-up is working", () => {
    const timing = resolveInitialTaskTurnTiming({
      task: { ...task, status: "executing", completedAt: undefined },
      events: [...initial, ...followUp],
      isTaskWorking: true,
    });
    expect(timing).toMatchObject({
      completedAt: 57_607,
      durationMs: 56_597,
      isWorking: false,
      isFinished: true,
    });
  });

  it("uses the original task start when only follow-up user messages were persisted", () => {
    const timing = resolveInitialTaskTurnTiming({
      task,
      events: [event("task_completed", 57_607), ...followUp],
      isTaskWorking: false,
    });
    expect(timing).toMatchObject({ startedAt: 1000, completedAt: 57_607 });
  });

  it("reads timeline-v2 completion and cancellation/failure status wrappers", () => {
    for (const [type, payload] of [
      ["task_completed", {}],
      ["task_status", { status: "failed" }],
      ["task_status", { status: "cancelled" }],
    ] as const) {
      const terminal = event("timeline_step_finished", 57_607, {
        legacyType: type,
        ...payload,
        lastRunDurationMs: 56_597,
      });
      const timing = resolveInitialTaskTurnTiming({
        task,
        events: [initial[0], initial[1], terminal, ...followUp],
        isTaskWorking: false,
      });
      expect(timing).toMatchObject({
        completedAt: 57_607,
        durationMs: 56_597,
        isFinished: true,
      });
    }
  });

  it("does not mistake recoverable errors or child completions for the initial run's end", () => {
    const child = { ...event("task_completed", 1050), taskId: "child" };
    const timing = resolveInitialTaskTurnTiming({
      task: { ...task, status: "executing", completedAt: undefined },
      events: [...initial.slice(0, 2), event("tool_error", 1040), child],
      isTaskWorking: true,
    });
    expect(timing).toMatchObject({
      startedAt: 1010,
      completedAt: undefined,
      isWorking: true,
      isFinished: false,
    });
  });

  it("omits original timing when only a paginated tail is available", () => {
    const timing = resolveInitialTaskTurnTiming({
      task,
      events: [...followUp, event("task_completed", 901_500)],
      isTaskWorking: false,
      hasMoreHistory: true,
    });
    expect(timing).toEqual({
      startedAt: 1000,
      isWorking: false,
      isFinished: false,
    });
    expect(
      resolveInitialTaskTurnTiming({
        task,
        events: [...initial, ...followUp],
        isTaskWorking: true,
        hasMoreHistory: true,
      }),
    ).toMatchObject({ durationMs: 56_597, isFinished: true });
  });

  it("omits timing if a resumed run is present but its earlier completion is missing", () => {
    for (const events of [followUp, [...followUp, event("follow_up_completed", 901_500)]]) {
      expect(resolveInitialTaskTurnTiming({ task, events, isTaskWorking: false })).toEqual({
        startedAt: 1000,
        isWorking: false,
        isFinished: false,
      });
    }
  });

  it("keeps legacy single-run fallback and ignores invalid persisted durations", () => {
    expect(
      resolveInitialTaskTurnTiming({
        task: { ...task, lastRunDurationMs: 1234 },
        events: [],
        isTaskWorking: false,
      }),
    ).toMatchObject({
      completedAt: task.completedAt,
      durationMs: 1234,
      isFinished: true,
    });
    for (const value of [-1, NaN, Infinity]) {
      expect(
        resolveInitialTaskTurnTiming({
          task,
          events: [event("task_completed", 57_607, { lastRunDurationMs: value })],
          isTaskWorking: false,
        }).durationMs,
      ).toBeUndefined();
    }
  });
});

describe("activity block turn ownership", () => {
  it("does not reactivate earlier work while a follow-up waits for its first activity", () => {
    const oldBlock = [event("step_started", 2000), event("step_failed", 3000)];
    const nextUser = event("user_message", 900_000);
    expect(isActivityBlockInLatestTurn(oldBlock, [...oldBlock, nextUser])).toBe(false);
    const nextBlock = [event("tool_call", 900_100)];
    expect(isActivityBlockInLatestTurn(nextBlock, [...oldBlock, nextUser, ...nextBlock])).toBe(
      true,
    );
    expect(isActivityBlockInLatestTurn([...nextBlock, event("task_completed", 900_200)], [])).toBe(
      false,
    );
  });
});

describe("isTaskTurnTerminalEvent", () => {
  it("includes follow-up endings and excludes nonterminal status updates", () => {
    for (const type of ["task_cancelled", "follow_up_completed", "follow_up_failed"]) {
      expect(isTaskTurnTerminalEvent(event(type, 1))).toBe(true);
    }
    expect(isTaskTurnTerminalEvent(event("task_status", 1, { status: "executing" }))).toBe(false);
    expect(isTaskTurnTerminalEvent(event("error", 1))).toBe(false);
  });
});
