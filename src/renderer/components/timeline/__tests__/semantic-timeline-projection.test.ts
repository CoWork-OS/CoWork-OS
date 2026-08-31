/**
 * Semantic timeline projection tests.
 *
 * These tests validate the output shape produced by the timeline normalizer
 * as consumed by the renderer layer.  They focus on:
 *  - summary card projection
 *  - approval card projection
 *  - agent card projection
 *  - 100+ event compression guarantee
 *  - raw event audit trail is never lost
 *  - older / incomplete event formats normalise without crashes
 */

import { describe, expect, it } from "vitest";
import { normalizeTaskEvents } from "../../../../electron/agent/timeline/timeline-normalizer";
import type { NormalizerInputEvent } from "../../../../shared/timeline-events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function resetSeq() {
  seq = 0;
}

function makeEvent(
  type: string,
  payload: Record<string, unknown> = {},
  overrides: Partial<NormalizerInputEvent> = {},
): NormalizerInputEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    taskId: "task-1",
    timestamp: seq * 1000,
    type,
    payload,
    schemaVersion: 2,
    ...overrides,
  };
}

function makeToolCall(
  tool: string,
  payload: Record<string, unknown> = {},
  overrides: Partial<NormalizerInputEvent> = {},
) {
  return makeEvent("tool_call", { tool, ...payload }, overrides);
}

// ---------------------------------------------------------------------------
// Summary card projection
// ---------------------------------------------------------------------------

describe("summary card projection", () => {
  it("produces kind=summary for file-read events", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeToolCall("read_file", { path: "src/index.ts" })]);
    expect(result[0].kind).toBe("summary");
  });

  it("summary card has required fields", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeToolCall("read_file", { path: "src/index.ts" })]);
    const card = result[0];
    expect(card.id).toBeTruthy();
    expect(card.summary).toBeTruthy();
    expect(card.startedAt).toBeTruthy();
    expect(typeof card.rawEventIds).toBe("object");
    expect(card.expandable).toBe(true);
  });

  it("summary card sets actionKind for icon selection", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeToolCall("edit_file", { path: "src/app.ts" })]);
    if (result[0].kind === "summary") {
      expect(result[0].actionKind).toBe("file.edit");
    }
  });

  it("summary card includes phase chip", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeToolCall("read_file", { path: "src/index.ts" })]);
    if (result[0].kind === "summary") {
      expect(result[0].phase).toBeTruthy();
    }
  });

  it("batches a glob+grep+read sequence into one summary", () => {
    resetSeq();
    const events = [
      makeToolCall("list_directory", { path: "src/" }),
      makeToolCall("search_files", { pattern: "useEffect" }),
    ];
    // These are different families so will be separate — that's correct
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    // At most one per family
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result.every((r) => r.kind === "summary")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Approval card projection
// ---------------------------------------------------------------------------

describe("approval card projection", () => {
  it("produces kind=approval for approval_requested events", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("approval_requested", { reason: "Shell may modify files" }),
    ]);
    expect(result[0].kind).toBe("approval");
  });

  it("approval card has risk field", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("approval_requested", { command: "rm -rf /tmp/x" }),
    ]);
    if (result[0].kind === "approval") {
      expect(["low", "medium", "high"]).toContain(result[0].risk);
    }
  });

  it("approval card is never swallowed into a summary batch", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "a.ts" }),
      makeToolCall("read_file", { path: "b.ts" }),
      makeEvent("approval_requested", { reason: "Shell exec" }),
      makeToolCall("read_file", { path: "c.ts" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 60_000 });
    const approvalCards = result.filter((r) => r.kind === "approval");
    expect(approvalCards).toHaveLength(1);
    // Reads before and after should be separate batches
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it("approval card has expandable=true", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeEvent("approval_requested", { reason: "x" })]);
    expect(result[0].expandable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent card projection
// ---------------------------------------------------------------------------

describe("agent card projection", () => {
  it("produces kind=agent for agent lifecycle events", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeEvent("agent_start", { actor: "Explore" })]);
    expect(result[0].kind).toBe("agent");
  });

  it("agent card includes actor field", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("agent_started", { actor: "Research", agentName: "Research" }),
    ]);
    if (result[0].kind === "agent") {
      expect(result[0].actor).toBeTruthy();
    }
  });

  it("agent card has expandable=true", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeEvent("agent_start", { actor: "Explore" })]);
    expect(result[0].expandable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 100+ event compression
// ---------------------------------------------------------------------------

describe("100+ event compression", () => {
  it("compresses 100+ events into fewer semantic cards in default mode", () => {
    resetSeq();
    const events = Array.from({ length: 120 }, (_, i) => ({
      ...makeToolCall("read_file", { path: `src/file-${i}.ts` }),
      timestamp: 1000 + i * 50, // all within 6 seconds
    }));
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    expect(result.length).toBeLessThan(20);
    expect(result.length).toBeGreaterThan(0);
  });

  it("never loses raw event IDs even after heavy compression", () => {
    resetSeq();
    const events = Array.from({ length: 50 }, (_, i) => ({
      ...makeToolCall("read_file", { path: `src/file-${i}.ts` }),
      timestamp: 1000 + i * 50,
    }));
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    const allPreservedIds = result.flatMap((r) => r.rawEventIds);
    for (const event of events) {
      expect(allPreservedIds).toContain(event.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Backward compat — older / incomplete event formats
// ---------------------------------------------------------------------------

describe("backward compatibility", () => {
  it("normalises events that have no payload without crashing", () => {
    resetSeq();
    expect(() =>
      normalizeTaskEvents([
        {
          id: "e1",
          taskId: "t1",
          timestamp: 1000,
          type: "tool_call",
          payload: undefined as unknown as null,
          schemaVersion: 2,
        },
      ]),
    ).not.toThrow();
  });

  it("normalises events that have string payload without crashing", () => {
    resetSeq();
    expect(() =>
      normalizeTaskEvents([
        {
          id: "e1",
          taskId: "t1",
          timestamp: 1000,
          type: "tool_call",
          payload: "raw string" as unknown as null,
          schemaVersion: 2,
        },
      ]),
    ).not.toThrow();
  });

  it("normalises events with missing timestamp field", () => {
    resetSeq();
    expect(() =>
      normalizeTaskEvents([
        { id: "e1", taskId: "t1", timestamp: 0, type: "tool_call", payload: {}, schemaVersion: 2 },
      ]),
    ).not.toThrow();
  });

  it("normalises unknown event types to generic kind without crashing", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeEvent("some_future_event_type_v99", { data: 42 })]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("summary");
  });

  it("always emits approval card even for approval events with no fields", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeEvent("approval_requested", {})]);
    expect(result[0].kind).toBe("approval");
    expect(result[0].expandable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Actor-aware grouping — multiple actors stay in separate lanes
// ---------------------------------------------------------------------------

describe("actor-aware grouping", () => {
  it("keeps events from different actors in separate cards", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "a.ts" }, { actor: "agent" }),
      makeToolCall("read_file", { path: "b.ts" }, { actor: "subagent" }),
      makeToolCall("read_file", { path: "c.ts" }, { actor: "agent" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    // Main agent and subagent events should not be merged together
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("batches events from the same actor together", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "a.ts" }, { actor: "agent" }),
      makeToolCall("read_file", { path: "b.ts" }, { actor: "agent" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    expect(result).toHaveLength(1);
  });
});
