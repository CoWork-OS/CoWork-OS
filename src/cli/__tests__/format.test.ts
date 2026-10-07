import { describe, expect, it } from "vitest";
import {
  buildTaskTitle,
  formatApproval,
  formatTaskEventFrame,
  isTerminalTaskFrame,
  matchesTask,
} from "../format";

describe("CLI formatting", () => {
  it("builds compact task titles from prompts", () => {
    expect(buildTaskTitle("  summarize\n\nthis   repository  ")).toBe("summarize this repository");
    expect(buildTaskTitle("x".repeat(100))).toHaveLength(80);
  });

  it("renders task event messages without raw JSON", () => {
    expect(
      formatTaskEventFrame({
        type: "event",
        event: "task.event",
        payload: {
          taskId: "task-1",
          message: "Reading files",
        },
      }),
    ).toBe("task.event task-1: Reading files");
  });

  it("matches nested task event payloads", () => {
    const frame = {
      type: "event" as const,
      event: "task.event",
      payload: {
        event: {
          taskId: "task-2",
          status: "completed",
        },
      },
    };

    expect(matchesTask(frame, "task-2")).toBe(true);
    expect(isTerminalTaskFrame(frame, "task-2")).toBe(true);
  });

  it("detects terminal top-level task frames", () => {
    expect(
      isTerminalTaskFrame(
        {
          type: "event",
          event: "task.completed",
          payload: { taskId: "task-3" },
        },
        "task-3",
      ),
    ).toBe(true);
  });
});

describe("CLI concrete approval review", () => {
  it("displays exact details and the decision revision without interpreting control characters", () => {
    const hash = "a".repeat(64);
    const result = formatApproval({
      id: "approval-1",
      type: "run_command",
      details: { command: "tool --target draft.md", params: { text: "\u001b[31m" } },
      revisionHash: hash,
    });
    expect(result).toContain("tool --target draft.md");
    expect(result).toContain("\\u001b");
    expect(result).not.toContain("\u001b");
    expect(result).toContain(`--revision-hash ${hash}`);
  });
  it("does not fabricate a missing revision", () => {
    expect(formatApproval({ id: "old" })).toContain("Revision unavailable");
    expect(formatApproval({ id: "old" })).not.toContain("--revision-hash");
  });
});
