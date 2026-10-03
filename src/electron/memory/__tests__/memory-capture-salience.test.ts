import { describe, expect, it } from "vitest";
import {
  buildSalientTaskEventCapture,
  isMemoryRecallTool,
  MEMORY_RECALL_TOOL_NAMES,
} from "../memory-capture-salience";

describe("salience-gated task event capture", () => {
  it.each([
    ["tool_call", { tool: "read_file", input: { path: "a.ts" } }],
    ["tool_result", { tool: "read_file", result: "file body" }],
    ["step_started", { step: { description: "Build" } }],
    ["step_completed", { step: { description: "Build" } }],
    ["plan_created", { plan: { steps: [{ id: "s1" }] } }],
    ["plan_revised", { plan: { steps: [] } }],
    ["assistant_message", { message: "Working on it" }],
    ["user_message", { message: "please continue" }],
    ["file_created", { path: "/tmp/a" }],
    ["file_modified", { path: "/tmp/a" }],
    ["verification_passed", { message: "ok" }],
    ["unknown_event", { anything: true }],
  ])("does not archive raw telemetry: %s", (type, payload) => {
    expect(buildSalientTaskEventCapture(type, payload)).toBeNull();
  });

  it("archives the task outcome as a summary with the request", () => {
    const capture = buildSalientTaskEventCapture(
      "task_completed",
      { message: "done", resultSummary: "Migrated the billing service to the new queue." },
      { title: "Billing migration", prompt: "Move billing to the new queue" },
    );
    expect(capture).toEqual({
      memoryType: "summary",
      content:
        'Task completed: "Billing migration"\nRequest: Move billing to the new queue\nOutcome: Migrated the billing service to the new queue.',
    });
  });

  it("skips a completion without any outcome text", () => {
    expect(buildSalientTaskEventCapture("task_completed", {})).toBeNull();
  });

  it("archives user feedback as a decision", () => {
    expect(
      buildSalientTaskEventCapture("user_feedback", { decision: "reject", reason: "Wrong file" }),
    ).toEqual({ memoryType: "decision", content: "Decision: reject\nReason: Wrong file" });
  });

  it("archives errors compactly", () => {
    const longError = "x".repeat(2_000);
    const capture = buildSalientTaskEventCapture("tool_error", {
      tool: "run_command",
      error: longError,
    });
    expect(capture?.memoryType).toBe("error");
    expect(capture?.content.startsWith("Tool error for run_command: ")).toBe(true);
    expect(capture!.content.length).toBeLessThan(600);

    expect(
      buildSalientTaskEventCapture("step_failed", {
        step: { description: "Run tests" },
        error: "3 failing",
      }),
    ).toEqual({ memoryType: "error", content: "Step failed: Run tests\nError: 3 failing" });
    expect(
      buildSalientTaskEventCapture("verification_failed", { message: "Output missing" }),
    ).toEqual({ memoryType: "error", content: "Verification failed: Output missing" });
    expect(buildSalientTaskEventCapture("error", { error: { message: "boom" } })).toEqual({
      memoryType: "error",
      content: "Task error: boom",
    });
  });

  it("never archives events of memory recall tools", () => {
    for (const tool of [
      "memory_search_index",
      "memory_timeline",
      "memory_details",
      "search_memories",
      "search_quotes",
      "search_sessions",
      "context_grep",
      "context_describe",
      "memory_curated_read",
      "supermemory_search",
      "kg_search",
    ]) {
      expect(isMemoryRecallTool(tool)).toBe(true);
      expect(buildSalientTaskEventCapture("tool_error", { tool, error: "boom" })).toBeNull();
    }
    expect(MEMORY_RECALL_TOOL_NAMES.has("read_file")).toBe(false);
  });
});
