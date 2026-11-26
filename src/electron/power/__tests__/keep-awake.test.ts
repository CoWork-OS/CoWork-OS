import { describe, expect, it, vi } from "vitest";
import type { TaskStatus } from "../../../shared/types";
import { KeepAwakeController, countWorkingTasks, type KeepAwakeBlocker } from "../keep-awake";

function fakeBlocker() {
  const started = new Set<number>();
  let nextId = 1;
  const blocker: KeepAwakeBlocker = {
    start: vi.fn(() => {
      const id = nextId++;
      started.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => started.delete(id)),
    isStarted: (id: number) => started.has(id),
  };
  return { blocker, started };
}

function source(statuses: Record<string, TaskStatus | undefined>) {
  return {
    getQueueStatus: () => ({ runningTaskIds: Object.keys(statuses) }),
    getTask: (taskId: string) => {
      const status = statuses[taskId];
      return status ? { status } : undefined;
    },
  };
}

describe("countWorkingTasks", () => {
  it("counts tasks that are planning or executing", () => {
    expect(countWorkingTasks(source({ a: "executing", b: "planning" }))).toBe(2);
  });

  it("ignores tasks that hold a slot while they wait on the person", () => {
    expect(countWorkingTasks(source({ a: "blocked", b: "paused", c: "executing" }))).toBe(1);
  });

  it("ignores finished tasks and ids with no task row", () => {
    expect(countWorkingTasks(source({ a: "completed", b: undefined }))).toBe(0);
  });
});

describe("KeepAwakeController", () => {
  it("holds the blocker only while the setting is on and a task is working", () => {
    const { blocker, started } = fakeBlocker();
    let enabled = true;
    let working = false;
    const controller = new KeepAwakeController({
      isEnabled: () => enabled,
      hasWorkingTask: () => working,
      blocker,
    });

    controller.sync();
    expect(controller.holding).toBe(false);

    working = true;
    controller.sync();
    controller.sync();
    expect(blocker.start).toHaveBeenCalledOnce();
    expect(blocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(started.size).toBe(1);

    working = false;
    controller.sync();
    expect(started.size).toBe(0);
    expect(controller.holding).toBe(false);

    working = true;
    enabled = false;
    controller.sync();
    expect(started.size).toBe(0);
  });

  it("lets the computer sleep when the work check fails", () => {
    const { blocker, started } = fakeBlocker();
    let fail = false;
    const controller = new KeepAwakeController({
      isEnabled: () => true,
      hasWorkingTask: () => {
        if (fail) throw new Error("database closed");
        return true;
      },
      blocker,
    });
    controller.sync();
    expect(started.size).toBe(1);
    fail = true;
    expect(() => controller.sync()).not.toThrow();
    expect(started.size).toBe(0);
  });

  it("releases the blocker and stops polling on stop", () => {
    vi.useFakeTimers();
    try {
      const { blocker, started } = fakeBlocker();
      const hasWorkingTask = vi.fn(() => true);
      const controller = new KeepAwakeController({
        isEnabled: () => true,
        hasWorkingTask,
        blocker,
      });
      controller.start(1_000);
      expect(started.size).toBe(1);
      vi.advanceTimersByTime(3_000);
      expect(hasWorkingTask).toHaveBeenCalledTimes(4);

      controller.stop();
      expect(started.size).toBe(0);
      vi.advanceTimersByTime(3_000);
      expect(hasWorkingTask).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
