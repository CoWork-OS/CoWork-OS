import { describe, expect, it } from "vitest";

import type { Task } from "../types";
import {
  getLatestSynthesisChildTask,
  getRecoveredSynthesisTaskIds,
} from "../synthesis-agent-detection";

function task(id: string, title: string, status: Task["status"], createdAt: number): Task {
  return { id, title, status, createdAt } as Task;
}

describe("synthesis attempt helpers", () => {
  it("treats a failed attempt replaced by a completed retry as recovered", () => {
    const tasks = [
      task("lane", "Learning design", "completed", 1),
      task("first", "Synthesis", "failed", 2),
      task("retry", "Synthesis", "completed", 3),
    ];
    expect(getLatestSynthesisChildTask(tasks)?.id).toBe("retry");
    expect([...getRecoveredSynthesisTaskIds(tasks)]).toEqual(["first"]);
  });

  it("does not recover anything while the retry has not succeeded", () => {
    const running = [
      task("first", "Synthesis", "failed", 2),
      task("retry", "Synthesis", "executing", 3),
    ];
    const failed = [
      task("first", "Synthesis", "failed", 2),
      task("retry", "Synthesis", "failed", 3),
    ];
    expect(getRecoveredSynthesisTaskIds(running).size).toBe(0);
    expect(getRecoveredSynthesisTaskIds(failed).size).toBe(0);
  });

  it("never recovers a failed specialist lane", () => {
    const tasks = [
      task("lane", "Operations", "failed", 1),
      task("synth", "Synthesis", "completed", 2),
    ];
    expect(getRecoveredSynthesisTaskIds(tasks).size).toBe(0);
  });
});
