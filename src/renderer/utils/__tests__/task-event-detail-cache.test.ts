import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  buildTaskEventDetailCacheKey,
  estimateTaskEventPayloadBytes,
  eventMatchesDetailId,
} from "../task-event-detail-cache";

function event(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: "row-1",
    eventId: "event-1",
    taskId: "task-1",
    timestamp: 1,
    type: "tool_result",
    payload: { text: "hello" },
    schemaVersion: 2,
    ...overrides,
  };
}

describe("task event detail cache helpers", () => {
  it("isolates identical task and event ids by remote device", () => {
    const first = buildTaskEventDetailCacheKey({
      deviceId: "device-a",
      taskId: "task-1",
      eventId: "event-1",
    });
    const second = buildTaskEventDetailCacheKey({
      deviceId: "device-b",
      taskId: "task-1",
      eventId: "event-1",
    });

    expect(first).not.toBe(second);
    expect(first).toBe("device-a:task-1:event-1");
  });

  it("measures UTF-8 payload bytes and matches either persisted id", () => {
    const value = event({ payload: { text: "€" } });

    expect(estimateTaskEventPayloadBytes(value)).toBe(new TextEncoder().encode('{"text":"€"}').length);
    expect(eventMatchesDetailId(value, "row-1")).toBe(true);
    expect(eventMatchesDetailId(value, "event-1")).toBe(true);
  });
});
