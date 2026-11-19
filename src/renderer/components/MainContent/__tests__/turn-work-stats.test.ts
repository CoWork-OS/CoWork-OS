import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventType, TaskEvent } from "../../../../shared/types";
import {
  INITIAL_TURN_ID,
  applyTurnDisclosures,
  collectTurnWorkStats,
  formatTurnWorkStats,
  type TaskFeedRow,
} from "../task-feed-logic";
import { TurnHeader } from "../../timeline/TurnHeader";

function event(
  id: string,
  type: EventType | string,
  payload: Record<string, unknown> = {},
  timestamp = 1,
): TaskEvent {
  return { id, taskId: "task-1", timestamp, type, payload } as TaskEvent;
}

describe("collectTurnWorkStats", () => {
  const events = [
    event("t1", "tool_call"),
    event("t2", "tool_call"),
    event("e1", "tool_error"),
    event("g1", "approval_granted", { reason: "assistant_input", assistantInput: true }),
    event("u1", "user_message"),
    event("t3", "tool_call"),
    event("g2", "approval_granted", { reason: "auto_review" }),
    event("g3", "approval_granted", { autoResolved: true, reason: "durable_restart_allow_once" }),
    event("d1", "approval_denied", { reason: "assistant_input_denied" }),
    event("d2", "approval_denied", { reason: "timeout" }),
  ];

  it("counts each turn by the ids the turn headers use", () => {
    const stats = collectTurnWorkStats(events, { historyComplete: true });
    expect(stats.get(INITIAL_TURN_ID)).toEqual({ actions: 2, failed: 1, approved: 1, declined: 0 });
    // Automatic grants and an unanswered card are not the person's decisions.
    expect(stats.get("turn:u1")).toEqual({ actions: 1, failed: 0, approved: 0, declined: 1 });
  });

  it("gives the first turn no counts when its start is not loaded", () => {
    const stats = collectTurnWorkStats(events, { historyComplete: false });
    expect(stats.has(INITIAL_TURN_ID)).toBe(false);
    expect(stats.get("turn:u1")?.actions).toBe(1);
  });

  it("keeps the hidden task prompt inside the initial turn", () => {
    const stats = collectTurnWorkStats(
      [
        event("prompt", "user_message"),
        event("t1", "tool_call"),
        event("u2", "user_message"),
        event("t2", "tool_call"),
      ],
      { historyComplete: true, turnStartIds: new Set(["u2"]) },
    );
    expect(stats.get(INITIAL_TURN_ID)?.actions).toBe(1);
    expect(stats.has("turn:prompt")).toBe(false);
    expect(stats.get("turn:u2")?.actions).toBe(1);
  });

  it("counts a projected tool error as failed", () => {
    const projected = { ...event("x1", "timeline_error"), legacyType: "tool_error" } as TaskEvent;
    expect(
      collectTurnWorkStats([projected], { historyComplete: true }).get(INITIAL_TURN_ID)?.failed,
    ).toBe(1);
  });

  it("reads legacy types through timeline projections", () => {
    const projected = {
      ...event("p1", "timeline_step_updated"),
      legacyType: "tool_call",
    } as TaskEvent;
    expect(
      collectTurnWorkStats([projected], { historyComplete: true }).get(INITIAL_TURN_ID),
    ).toMatchObject({ actions: 1 });
  });
});

describe("formatTurnWorkStats", () => {
  it("lists only non-zero counts with singular forms", () => {
    expect(formatTurnWorkStats({ actions: 1, failed: 0, approved: 2, declined: 0 })).toEqual([
      "1 action",
      "2 approved",
    ]);
    expect(formatTurnWorkStats({ actions: 0, failed: 0, approved: 0, declined: 0 })).toEqual([]);
    expect(formatTurnWorkStats(undefined)).toEqual([]);
  });
});

describe("turn receipt in the header", () => {
  function row(id: string, type: EventType, timestamp: number, payload = {}): TaskFeedRow {
    return {
      kind: "timeline",
      key: `event:${id}`,
      estimatedHeight: 40,
      timelineIndex: timestamp,
      item: {
        kind: "event",
        event: event(id, type, payload, timestamp),
        eventIndex: timestamp,
        timestamp,
      },
      revision: id,
      visiblePerfEventId: id,
    };
  }

  it("attaches the counts to the turn and changes the row revision with them", () => {
    const rows = [
      row("u1", "user_message", 1),
      row("c1", "progress_update", 2),
      row("a1", "assistant_message", 3, { message: "Done." }),
    ];
    const project = (actions: number) =>
      applyTurnDisclosures(rows, {
        isTaskWorking: false,
        taskStartedAt: 0,
        isTurnExpanded: () => false,
        statsByTurnId: new Map([["turn:u1", { actions, failed: 0, approved: 1, declined: 0 }]]),
      });
    const first = project(3);
    expect(first.turns[0].stats).toEqual({ actions: 3, failed: 0, approved: 1, declined: 0 });
    const header = (result: ReturnType<typeof project>) =>
      result.rows.find((candidate) => candidate.kind === "turn-header");
    expect(header(first)?.revision).not.toBe(header(project(4))?.revision);
  });

  it("renders the receipt after the duration", () => {
    const html = renderToStaticMarkup(
      createElement(TurnHeader, {
        turn: {
          id: "turn:u1",
          status: "worked",
          startedAt: 0,
          endedAt: 4000,
          expanded: false,
          collapsible: true,
          stats: { actions: 8, failed: 1, approved: 1, declined: 0 },
        },
        onToggle: () => undefined,
      }),
    );
    expect(html).toContain("8 actions");
    expect(html).toContain('data-tone="attention">1 failed');
    expect(html).toContain("1 approved");
  });
});
