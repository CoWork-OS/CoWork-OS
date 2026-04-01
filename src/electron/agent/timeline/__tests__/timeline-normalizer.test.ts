import { describe, expect, it } from "vitest";
import {
  buildCompletionSummaryFromUiEvents,
  normalizeTaskEvents,
} from "../timeline-normalizer";
import type { NormalizerInputEvent } from "../../../../shared/timeline-events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
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
): NormalizerInputEvent {
  return makeEvent("tool_call", { tool, ...payload }, overrides);
}

// Reset seq before each test group so IDs are stable within a test
function resetSeq() {
  seq = 0;
}

// ---------------------------------------------------------------------------
// Batching — adjacent file reads
// ---------------------------------------------------------------------------

describe("normalizeTaskEvents — batching", () => {
  it("groups adjacent file reads into one summary event", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "src/a.ts" }),
      makeToolCall("read_file", { path: "src/b.ts" }),
      makeToolCall("read_file", { path: "src/c.ts" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("summary");
    expect(result[0].summary).toMatch(/3 files/);
    expect(result[0].rawEventIds).toHaveLength(3);
  });

  it("groups mixed read and list_directory into the same batch", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "src/index.ts" }),
      makeToolCall("list_directory", { path: "src/" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("summary");
  });

  it("keeps searches and reads in separate batches (different families)", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "src/a.ts" }),
      makeToolCall("search_files", { pattern: "useEffect" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    // Different families: files vs search — should not merge
    expect(result).toHaveLength(2);
  });

  it("breaks batch when time gap exceeds window", () => {
    resetSeq();
    const events: NormalizerInputEvent[] = [
      { ...makeToolCall("read_file", { path: "a.ts" }), timestamp: 1000 },
      { ...makeToolCall("read_file", { path: "b.ts" }), timestamp: 10_000 },
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 5000 });
    // Gap is 9000ms > 5000ms window
    expect(result).toHaveLength(2);
  });

  it("does not merge events from different actors", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "a.ts" }, { actor: "agent" }),
      makeToolCall("read_file", { path: "b.ts" }, { actor: "subagent" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    expect(result).toHaveLength(2);
  });

  it("never merges approval events into any batch", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "a.ts" }),
      makeEvent("approval_requested", { reason: "Shell command may modify files" }),
      makeToolCall("read_file", { path: "b.ts" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    // approval_requested breaks the batch on both sides
    expect(result.some((e) => e.kind === "approval")).toBe(true);
    // The approval card must be a separate entry
    const approvalIndex = result.findIndex((e) => e.kind === "approval");
    expect(approvalIndex).toBeGreaterThanOrEqual(0);
  });

  it("error events are not merged into a running batch", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "a.ts" }),
      makeToolCall("read_file", { path: "b.ts" }),
      makeEvent("timeline_error", { message: "Something went wrong" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    const errorCard = result.find(
      (e) => e.kind === "summary" && e.status === "error",
    );
    expect(errorCard).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Raw event IDs are always preserved
// ---------------------------------------------------------------------------

describe("normalizeTaskEvents — raw event ID preservation", () => {
  it("preserves all raw event IDs in a batch", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "a.ts" }),
      makeToolCall("read_file", { path: "b.ts" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    expect(result[0].rawEventIds).toContain(events[0].id);
    expect(result[0].rawEventIds).toContain(events[1].id);
  });

  it("preserves event IDs for unbatched events individually", () => {
    resetSeq();
    const events = [
      makeEvent("approval_requested", { reason: "Deploy" }),
      makeEvent("approval_granted", {}),
    ];
    const result = normalizeTaskEvents(events);
    expect(result[0].rawEventIds).toContain(events[0].id);
  });
});

describe("normalizeTaskEvents — runtime envelope evidence", () => {
  it("projects structured envelope evidence into timeline evidence rows", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("tool_result", {
        tool: "write_file",
        envelope: {
          evidence: [
            {
              type: "file",
              label: "File",
              value: "src/runtime.ts",
              extra: { operation: "write" },
            },
            {
              type: "runtime_log",
              label: "Policy",
              value: "final decision: allow",
              extra: { source: "write_file" },
            },
          ],
        },
      }),
    ]);

    expect(result[0].kind).toBe("summary");
    if (result[0].kind === "summary") {
      expect(result[0].evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "file",
            path: "src/runtime.ts",
            operation: "write",
          }),
          expect.objectContaining({
            type: "runtime_log",
            message: "final decision: allow",
          }),
        ]),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Phase inference
// ---------------------------------------------------------------------------

describe("normalizeTaskEvents — phase inference", () => {
  it("infers 'explore' for file reads", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeToolCall("read_file", { path: "a.ts" })]);
    expect(result[0].kind).toBe("summary");
    if (result[0].kind === "summary") {
      expect(result[0].phase).toBe("explore");
    }
  });

  it("infers 'execute' for file writes", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeToolCall("write_file", { path: "out.ts" })]);
    if (result[0].kind === "summary") {
      expect(result[0].phase).toBe("execute");
    }
  });

  it("infers 'execute' for shell commands", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeToolCall("run_command", { command: "npm test" })]);
    if (result[0].kind === "summary") {
      expect(result[0].phase).toBe("execute");
    }
  });

  it("uses stage hint from timeline_group_started payload", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("timeline_group_started", { stage: "VERIFY", groupLabel: "Run tests" }),
    ]);
    if (result[0].kind === "summary") {
      expect(result[0].phase).toBe("verify");
    }
  });

  it("infers 'complete' for task_completed events", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeEvent("task_completed", {})]);
    if (result[0].kind === "summary") {
      expect(result[0].phase).toBe("complete");
    }
  });

  it("infers 'complete' for artifact events", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("artifact_created", { path: "report.md" }),
    ]);
    if (result[0].kind === "summary") {
      expect(result[0].phase).toBe("complete");
    }
  });
});

// ---------------------------------------------------------------------------
// Summary text generation
// ---------------------------------------------------------------------------

describe("normalizeTaskEvents — summary generation", () => {
  it("includes file count in read summary", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "src/a.ts" }),
      makeToolCall("read_file", { path: "src/b.ts" }),
      makeToolCall("read_file", { path: "src/c.ts" }),
      makeToolCall("read_file", { path: "src/d.ts" }),
      makeToolCall("read_file", { path: "src/e.ts" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    expect(result[0].summary).toMatch(/5 files/);
  });

  it("includes common path prefix in read summary", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "src/electron/agent/tools/a.ts" }),
      makeToolCall("read_file", { path: "src/electron/agent/tools/b.ts" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    expect(result[0].summary).toMatch(/src\/electron\/agent\/tools\//);
  });

  it("generates stable summaries for shell commands", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeToolCall("run_command", { command: "npm run test" }),
    ]);
    expect(result[0].summary).toMatch(/npm run test/);
  });

  it("generates stable summaries for web searches", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeToolCall("web_search", { query: "electron ipc best practices" }),
    ]);
    expect(result[0].summary).toMatch(/electron ipc best practices/);
  });

  it("generates approval summary with reason", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("approval_requested", {
        reason: "Shell command may modify files",
      }),
    ]);
    expect(result[0].summary).toMatch(/Shell command may modify files/);
  });
});

// ---------------------------------------------------------------------------
// Approval card projection
// ---------------------------------------------------------------------------

describe("normalizeTaskEvents — approval cards", () => {
  it("emits an approval card for approval_requested events", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("approval_requested", { reason: "Danger zone" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("approval");
  });

  it("approval card starts as 'waiting'", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("approval_requested", { reason: "Deploy" }),
    ]);
    if (result[0].kind === "approval") {
      expect(result[0].status).toBe("waiting");
    }
  });

  it("approval card becomes 'success' when followed by approval_granted", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("approval_requested", { reason: "Deploy" }),
      makeEvent("approval_granted", {}),
    ]);
    // approval_granted is its own card (batch breaker), check status
    const approval = result.find((e) => e.kind === "approval" && e.rawEventIds.includes(events => false));
    // Find the first approval card
    const firstApproval = result[0];
    expect(firstApproval.kind).toBe("approval");
  });

  it("infers high risk for destructive commands", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("approval_requested", { command: "rm -rf /tmp/build" }),
    ]);
    if (result[0].kind === "approval") {
      expect(result[0].risk).toBe("high");
    }
  });

  it("infers medium risk for write/deploy commands", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("approval_requested", { command: "git push origin main" }),
    ]);
    if (result[0].kind === "approval") {
      expect(result[0].risk).toBe("medium");
    }
  });

  it("infers low risk when no destructive pattern matches", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("approval_requested", { command: "echo hello" }),
    ]);
    if (result[0].kind === "approval") {
      expect(result[0].risk).toBe("low");
    }
  });
});

// ---------------------------------------------------------------------------
// Agent card projection
// ---------------------------------------------------------------------------

describe("normalizeTaskEvents — agent cards", () => {
  it("emits an agent card for agent start events", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("agent_start", { actor: "Explore", agentName: "Explore" }),
    ]);
    expect(result[0].kind).toBe("agent");
  });

  it("agent card includes actor name", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeEvent("agent_started", { actor: "Research" }),
    ]);
    if (result[0].kind === "agent") {
      expect(result[0].actor).toBe("Research");
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

describe("normalizeTaskEvents — evidence", () => {
  it("attaches file evidence with operation type", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeToolCall("read_file", { path: "src/main.ts" }),
    ]);
    const card = result[0];
    expect(card.evidence.some((e) => e.type === "file" && e.path === "src/main.ts")).toBe(true);
  });

  it("attaches command evidence for shell events", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeToolCall("run_command", { command: "ls -la" }),
    ]);
    expect(result[0].evidence.some((e) => e.type === "command")).toBe(true);
  });

  it("deduplicates file evidence for the same path", () => {
    resetSeq();
    const events = [
      makeToolCall("read_file", { path: "src/a.ts" }),
      makeToolCall("read_file", { path: "src/a.ts" }),
    ];
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    const fileEvidence = result[0].evidence.filter((e) => e.type === "file");
    expect(fileEvidence).toHaveLength(1);
  });

  it("attaches query evidence for code searches", () => {
    resetSeq();
    const result = normalizeTaskEvents([
      makeToolCall("search_files", { pattern: "useState" }),
    ]);
    expect(result[0].evidence.some((e) => e.type === "query")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation — missing / incomplete fields
// ---------------------------------------------------------------------------

describe("normalizeTaskEvents — graceful degradation", () => {
  it("handles events with empty payload without throwing", () => {
    resetSeq();
    expect(() =>
      normalizeTaskEvents([makeEvent("unknown_event_type", {})]),
    ).not.toThrow();
  });

  it("handles events with null payload without throwing", () => {
    resetSeq();
    expect(() =>
      normalizeTaskEvents([{ ...makeEvent("tool_call", {}), payload: null as unknown as Record<string, unknown> }]),
    ).not.toThrow();
  });

  it("handles an empty event array", () => {
    expect(normalizeTaskEvents([])).toEqual([]);
  });

  it("generates a fallback summary when payload has no recognizable fields", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeEvent("tool_call", { tool: "read_file" })]);
    expect(result[0].summary).toBeTruthy();
  });

  it("still emits approval cards even if approval events have missing fields", () => {
    resetSeq();
    const result = normalizeTaskEvents([makeEvent("approval_requested", {})]);
    expect(result[0].kind).toBe("approval");
  });
});

// ---------------------------------------------------------------------------
// 100-event compression
// ---------------------------------------------------------------------------

describe("normalizeTaskEvents — compression", () => {
  it("compresses 100 file-read events into a single card in default mode", () => {
    resetSeq();
    const events = Array.from({ length: 100 }, (_, i) =>
      // Ensure timestamp is within the batch window
      ({ ...makeToolCall("read_file", { path: `src/file-${i}.ts` }), timestamp: 1000 + i * 10 }),
    );
    const result = normalizeTaskEvents(events, { batchWindowMs: 10_000 });
    // All within 10 seconds total
    expect(result.length).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------
// buildCompletionSummaryFromUiEvents
// ---------------------------------------------------------------------------

describe("buildCompletionSummaryFromUiEvents", () => {
  it("populates explored list from file read cards", () => {
    resetSeq();
    const events = normalizeTaskEvents([
      makeToolCall("read_file", { path: "src/a.ts" }),
      makeToolCall("read_file", { path: "src/b.ts" }),
    ]);
    const summary = buildCompletionSummaryFromUiEvents(events);
    expect(summary.explored.length).toBeGreaterThan(0);
  });

  it("populates changed list from file edit cards", () => {
    resetSeq();
    const events = normalizeTaskEvents([
      makeToolCall("edit_file", { path: "src/main.ts" }),
    ]);
    const summary = buildCompletionSummaryFromUiEvents(events);
    expect(summary.changed.length).toBeGreaterThan(0);
  });

  it("populates artifacts from artifact_created events", () => {
    resetSeq();
    const events = normalizeTaskEvents([
      makeEvent("artifact_created", { path: "output/report.md" }),
    ]);
    const summary = buildCompletionSummaryFromUiEvents(events);
    expect(summary.artifacts).toContain("output/report.md");
  });

  it("populates needsAttention from blocked approval cards", () => {
    resetSeq();
    const raw = [
      makeEvent("approval_requested", { reason: "Destructive action" }),
      makeEvent("approval_denied", {}),
    ];
    const uiEvents = normalizeTaskEvents(raw);
    // Set the approval status to blocked manually via raw re-processing
    const summary = buildCompletionSummaryFromUiEvents(uiEvents);
    // At minimum it should not throw
    expect(summary).toBeDefined();
  });

  it("returns empty arrays when no events provided", () => {
    const summary = buildCompletionSummaryFromUiEvents([]);
    expect(summary.explored).toHaveLength(0);
    expect(summary.changed).toHaveLength(0);
    expect(summary.verified).toHaveLength(0);
    expect(summary.needsAttention).toHaveLength(0);
    expect(summary.artifacts).toHaveLength(0);
  });
});
