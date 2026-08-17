import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import { TaskTimelineCache } from "../task-timeline-cache";

function event(id: string, payload = id): TaskEvent {
  return {
    id,
    eventId: id,
    taskId: "task-1",
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    type: "assistant_message",
    payload: { message: payload },
    schemaVersion: 2,
  } as TaskEvent;
}

describe("TaskTimelineCache", () => {
  it("evicts the least recently used task when the task limit is exceeded", () => {
    const cache = new TaskTimelineCache(2, 1024 * 1024);
    cache.set("task-1", {
      taskId: "task-1",
      events: [event("event-1")],
      cursor: null,
      hasMoreHistory: false,
    });
    cache.set("task-2", {
      taskId: "task-2",
      events: [event("event-2")],
      cursor: null,
      hasMoreHistory: false,
    });
    cache.get("task-1");
    cache.set("task-3", {
      taskId: "task-3",
      events: [event("event-3")],
      cursor: null,
      hasMoreHistory: false,
    });

    expect(cache.peek("task-2")).toBeNull();
    expect(cache.peek("task-1")?.events[0]?.id).toBe("event-1");
  });

  it("enforces the aggregate byte budget", () => {
    const cache = new TaskTimelineCache(5, 100);
    cache.set("task-1", {
      taskId: "task-1",
      events: [event("event-1")],
      cursor: null,
      hasMoreHistory: false,
      payloadBytes: 60,
    });
    cache.set("task-2", {
      taskId: "task-2",
      events: [event("event-2")],
      cursor: null,
      hasMoreHistory: false,
      payloadBytes: 60,
    });

    expect(cache.peek("task-1")).toBeNull();
    expect(cache.totalBytes).toBe(60);
  });
});
