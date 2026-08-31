import { describe, expect, it } from "vitest";
import { buildTaskTitle, formatTaskEventFrame, isTerminalTaskFrame, matchesTask } from "../format";

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
