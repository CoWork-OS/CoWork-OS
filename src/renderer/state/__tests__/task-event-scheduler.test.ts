import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventType, TaskEvent } from "../../../shared/types";
import {
  createTaskEventScheduler,
  type TaskEventScheduler,
  type TaskEventTarget,
} from "../task-event-scheduler";

function target(
  taskId: string,
  source: "local" | "remote" = "local",
  surfaceId = "main",
): TaskEventTarget {
  return { surfaceId, taskId, source };
}

function event(
  id: string,
  type: string,
  options: Partial<Pick<TaskEvent, "eventId" | "seq" | "timestamp" | "taskId">> & {
    payload?: Record<string, unknown>;
  } = {},
): TaskEvent {
  return {
    id,
    eventId: options.eventId,
    taskId: options.taskId ?? "task-a",
    timestamp: options.timestamp ?? 1_000,
    seq: options.seq,
    type: type as EventType,
    payload: options.payload ?? {},
    schemaVersion: 2,
  };
}

function enqueue(
  scheduler: TaskEventScheduler,
  taskTarget: TaskEventTarget,
  generation: number,
  taskEvent: TaskEvent,
): boolean {
  return scheduler.enqueue({ target: taskTarget, generation, event: taskEvent });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskEventScheduler", () => {
  it("rejects stale generations across an A -> B -> C switch", () => {
    const scheduler = createTaskEventScheduler();
    const a = target("task-a");
    const b = target("task-b");
    const c = target("task-c");
    const generationA = scheduler.switchTarget(a);
    const generationB = scheduler.switchTarget(b);
    const generationC = scheduler.switchTarget(c);

    expect(generationB).toBe(generationA + 1);
    expect(generationC).toBe(generationB + 1);
    expect(enqueue(scheduler, a, generationA, event("stale-a", "assistant_message"))).toBe(false);
    expect(enqueue(scheduler, b, generationB, event("stale-b", "assistant_message"))).toBe(false);
    expect(
      enqueue(
        scheduler,
        c,
        generationC,
        event("current-c", "assistant_message", { taskId: "task-c" }),
      ),
    ).toBe(true);
    expect(scheduler.getSnapshot(c).events.map((item) => item.id)).toEqual(["current-c"]);
  });

  it("keeps local and remote sources on the same scheduling path", () => {
    vi.useFakeTimers();
    const localScheduler = createTaskEventScheduler({ batchIntervalMs: 50 });
    const remoteScheduler = createTaskEventScheduler({ batchIntervalMs: 50 });
    const local = target("task-a", "local");
    const remote = target("task-a", "remote");
    const localGeneration = localScheduler.switchTarget(local);
    const remoteGeneration = remoteScheduler.switchTarget(remote);
    const frames = [
      event("tool-call", "tool_call", { seq: 1, timestamp: 1_001 }),
      event("tool-result", "tool_result", { seq: 2, timestamp: 1_002 }),
    ];

    for (const frame of frames) {
      expect(enqueue(localScheduler, local, localGeneration, frame)).toBe(true);
      expect(enqueue(remoteScheduler, remote, remoteGeneration, frame)).toBe(true);
    }

    expect(localScheduler.getSnapshot(local).events).toEqual([]);
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(50);
    expect(remoteScheduler.getSnapshot(remote).events.map((item) => item.id)).toEqual(
      localScheduler.getSnapshot(local).events.map((item) => item.id),
    );
  });

  it("deduplicates eventId/id aliases and orders out-of-order arrivals", () => {
    const scheduler = createTaskEventScheduler();
    const taskTarget = target("task-a");
    const generation = scheduler.switchTarget(taskTarget);
    const second = event("id-2", "tool_result", {
      eventId: "event-2",
      seq: 2,
      timestamp: 2_000,
    });
    const first = event("id-1", "tool_call", { seq: 1, timestamp: 1_000 });
    const updatedByEventId = event("id-2-updated", "tool_result", {
      eventId: "event-2",
      seq: 2,
      timestamp: 2_000,
      payload: { updated: true },
    });
    const updatedById = event("id-2-updated", "tool_result", {
      eventId: "event-2-new-alias",
      seq: 2,
      timestamp: 2_000,
      payload: { updatedAgain: true },
    });

    expect(enqueue(scheduler, taskTarget, generation, second)).toBe(true);
    expect(enqueue(scheduler, taskTarget, generation, first)).toBe(true);
    expect(enqueue(scheduler, taskTarget, generation, updatedByEventId)).toBe(true);
    expect(enqueue(scheduler, taskTarget, generation, updatedById)).toBe(true);
    scheduler.flush(taskTarget);

    const retained = scheduler.getSnapshot(taskTarget).events;
    expect(retained.map((item) => item.id)).toEqual(["id-1", "id-2-updated"]);
    expect(retained[1]?.payload).toEqual({ updatedAgain: true });
  });

  it("retains distinct tool calls and tool results instead of coalescing them", () => {
    const scheduler = createTaskEventScheduler();
    const taskTarget = target("task-a");
    const generation = scheduler.switchTarget(taskTarget);

    enqueue(scheduler, taskTarget, generation, event("call-1", "tool_call", { seq: 1 }));
    enqueue(scheduler, taskTarget, generation, event("result-1", "tool_result", { seq: 2 }));
    scheduler.flush(taskTarget);

    expect(scheduler.getSnapshot(taskTarget).events.map((item) => item.id)).toEqual([
      "call-1",
      "result-1",
    ]);
  });

  it("coalesces progress and streaming frames, then flushes them before terminal delivery", () => {
    const scheduler = createTaskEventScheduler();
    const taskTarget = target("task-a");
    const generation = scheduler.switchTarget(taskTarget);
    let deliveries = 0;
    const unsubscribe = scheduler.subscribe(taskTarget, () => {
      deliveries += 1;
    });

    enqueue(
      scheduler,
      taskTarget,
      generation,
      event("progress-1", "progress_update", { seq: 1, payload: { stage: "work", value: 1 } }),
    );
    enqueue(
      scheduler,
      taskTarget,
      generation,
      event("progress-2", "progress_update", { seq: 2, payload: { stage: "work", value: 2 } }),
    );
    enqueue(
      scheduler,
      taskTarget,
      generation,
      event("stream-1", "llm_streaming", { seq: 3, payload: { text: "partial" } }),
    );
    enqueue(
      scheduler,
      taskTarget,
      generation,
      event("stream-2", "llm_streaming", { seq: 4, payload: { text: "complete" } }),
    );

    expect(scheduler.getSnapshot(taskTarget).events).toEqual([]);
    expect(deliveries).toBe(0);
    enqueue(
      scheduler,
      taskTarget,
      generation,
      event("terminal", "task_completed", { seq: 5, timestamp: 2_000 }),
    );

    const retained = scheduler.getSnapshot(taskTarget).events;
    expect(deliveries).toBe(1);
    expect(retained.map((item) => item.id)).toEqual(["progress-2", "stream-2", "terminal"]);
    expect(retained.at(-1)?.type).toBe("task_completed");
    unsubscribe();
  });

  it("flushes pending work when switching or unsubscribing a target", () => {
    const scheduler = createTaskEventScheduler();
    const a = target("task-a");
    const b = target("task-b");
    const generationA = scheduler.switchTarget(a);
    let flushedDeliveries = 0;
    const unsubscribeA = scheduler.subscribe(a, () => {
      flushedDeliveries += 1;
    });
    enqueue(scheduler, a, generationA, event("pending-a", "tool_result"));
    scheduler.switchTarget(b);

    expect(scheduler.getSnapshot(a).events.map((item) => item.id)).toEqual(["pending-a"]);
    expect(flushedDeliveries).toBe(1);
    const generationB = scheduler.getGeneration("main");
    let unsubscribedDeliveries = 0;
    const unsubscribeB = scheduler.subscribe(b, () => {
      unsubscribedDeliveries += 1;
    });
    enqueue(scheduler, b, generationB, event("pending-b", "tool_result", { taskId: "task-b" }));
    scheduler.unsubscribe(b);
    expect(scheduler.getSnapshot(b).events.map((item) => item.id)).toEqual(["pending-b"]);
    expect(unsubscribedDeliveries).toBe(1);
    expect(
      enqueue(
        scheduler,
        b,
        generationB,
        event("stale-b", "assistant_message", { taskId: "task-b" }),
      ),
    ).toBe(false);
    unsubscribeB();
    unsubscribeA();
  });

  it("bounds command output payloads and retained event count", () => {
    const scheduler = createTaskEventScheduler({
      maxEventsPerBuffer: 2,
      maxPayloadBytes: 32 * 1024,
    });
    const taskTarget = target("task-a");
    const generation = scheduler.switchTarget(taskTarget);
    const hugeOutput = "x".repeat(80 * 1024);

    enqueue(
      scheduler,
      taskTarget,
      generation,
      event("output", "command_output", { payload: { output: hugeOutput } }),
    );
    enqueue(scheduler, taskTarget, generation, event("message-1", "assistant_message", { seq: 1 }));
    enqueue(scheduler, taskTarget, generation, event("message-2", "assistant_message", { seq: 2 }));
    enqueue(
      scheduler,
      taskTarget,
      generation,
      event("output", "command_output", { seq: 3, payload: { output: hugeOutput } }),
    );

    const retained = scheduler.getSnapshot(taskTarget).events;
    expect(retained).toHaveLength(2);
    expect(retained.map((item) => item.id)).toEqual(["message-2", "output"]);
    const output = retained.find((item) => item.id === "output");
    expect(output).toBeDefined();
    expect(String(output?.payload?.output ?? "").length).toBeLessThan(20 * 1024);
    expect(String(output?.payload?.output ?? "")).toContain("renderer payload truncated");
  });
});
