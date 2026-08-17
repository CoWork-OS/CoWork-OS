import { describe, expect, it } from "vitest";
import type { Task, TaskEvent } from "../../../shared/types";
import {
  buildTaskEventDetailForTransport,
  buildTaskEventHistoryForTransport,
  buildTaskTimelinePageForTransport,
  sanitizeTaskTimelinePageRequest,
  serializeTaskEventForTransport,
} from "../task-event-transport";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Remote task",
    prompt: "Prompt",
    status: "executing",
    workspaceId: "workspace-1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Task;
}

function makeEvent(
  id: string,
  type: TaskEvent["type"],
  timestamp: number,
  overrides: Partial<TaskEvent> = {},
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type,
    payload: {},
    ...overrides,
  } as TaskEvent;
}

describe("task-event transport", () => {
  it("preserves verbose timeline metadata when serializing remote history", () => {
    const event = makeEvent("evt-1", "timeline_step_updated", 10, {
      legacyType: "tool_call",
      stepId: "step-1",
      groupId: "tools:web",
      status: "running",
      seq: 7,
      eventId: "event-1",
      actor: "tool",
      payload: {
        tool: "web_search",
        nested: {
          fn: () => "drop me",
          keep: "ok",
        },
      } as unknown as Record<string, unknown>,
    });

    const serialized = serializeTaskEventForTransport(event, (value) =>
      JSON.parse(
        JSON.stringify(value, (_key, innerValue) =>
          typeof innerValue === "function" ? undefined : innerValue,
        ),
      ),
    );

    expect(serialized.legacyType).toBe("tool_call");
    expect(serialized.stepId).toBe("step-1");
    expect(serialized.groupId).toBe("tools:web");
    expect(serialized.status).toBe("running");
    expect(serialized.seq).toBe(7);
    expect(serialized.eventId).toBe("event-1");
    expect(serialized.actor).toBe("tool");
    expect(serialized.payload).toEqual({
      tool: "web_search",
      nested: {
        keep: "ok",
      },
    });
  });

  it("matches local task history behavior for collaborative roots", () => {
    const parentEvents = [
      makeEvent("evt-1", "timeline_step_started", 10),
      makeEvent("evt-2", "timeline_step_finished", 20),
    ];
    const childFileEvent = {
      ...makeEvent("evt-3", "artifact_created", 15),
      taskId: "child-1",
    };
    const taskRepo = {
      findById: () =>
        makeTask({
          agentConfig: { collaborativeMode: true } as Task["agentConfig"],
        }),
      findByParent: () => [makeTask({ id: "child-1", parentTaskId: "task-1" })],
    };
    const eventRepo = {
      findRecentByTaskId: () => parentEvents,
      findByTaskIds: () => [childFileEvent],
    };

    const events = buildTaskEventHistoryForTransport({
      taskId: "task-1",
      limit: 10,
      taskRepo,
      eventRepo,
    });

    expect(events.map((event) => event.id)).toEqual(["evt-1", "evt-3", "evt-2"]);
  });

  it("scopes collaborative timeline pages server-side and sanitizes payloads", () => {
    let receivedRequest: Record<string, unknown> | null = null;
    const taskRepo = {
      findById: () =>
        makeTask({ agentConfig: { collaborativeMode: true } as Task["agentConfig"] }),
      findByParent: () => [makeTask({ id: "child-1", parentTaskId: "task-1" })],
    };
    const eventRepo = {
      findRecentByTaskId: () => [],
      findByTaskIds: () => [],
      findTimelinePage: (request: Record<string, unknown>) => {
        receivedRequest = request;
        return {
          taskId: "task-1",
          events: [makeEvent("evt-1", "artifact_created", 1, { payload: { secret: "drop" } })],
          nextCursor: null,
          hasMoreHistory: false,
          summary: {
            eventCount: 1,
            payloadBytes: 10,
            truncatedEventCount: 0,
            largestEventPayloadBytes: 10,
          },
        };
      },
      findEventDetailById: () => ({ event: null, payloadBytes: 0 }),
    };

    const page = buildTaskTimelinePageForTransport({
      request: { taskId: "task-1", limit: 64 },
      taskRepo,
      eventRepo,
      sanitizeValue: () => ({ redacted: true }),
    });

    expect(receivedRequest).toMatchObject({
      taskId: "task-1",
      additionalTaskIds: ["child-1"],
    });
    expect(page.events[0]?.payload).toEqual({ redacted: true });
  });

  it("scopes event detail requests to the selected task and collaborative children", () => {
    let receivedScope: Record<string, unknown> | undefined;
    const taskRepo = {
      findById: () =>
        makeTask({ agentConfig: { collaborativeMode: true } as Task["agentConfig"] }),
      findByParent: () => [makeTask({ id: "child-1", parentTaskId: "task-1" })],
    };
    const eventRepo = {
      findRecentByTaskId: () => [],
      findByTaskIds: () => [],
      findTimelinePage: () => ({
        taskId: "task-1",
        events: [],
        nextCursor: null,
        hasMoreHistory: false,
        summary: {
          eventCount: 0,
          payloadBytes: 0,
          truncatedEventCount: 0,
          largestEventPayloadBytes: 0,
        },
      }),
      findEventDetailById: (_eventId: string, scope?: Record<string, unknown>) => {
        receivedScope = scope;
        return { event: makeEvent("evt-1", "artifact_created", 1), payloadBytes: 10 };
      },
    };

    buildTaskEventDetailForTransport({
      request: { taskId: "task-1", eventId: "evt-1" },
      taskRepo,
      eventRepo,
      sanitizeValue: (value) => value,
    });

    expect(receivedScope).toMatchObject({ taskId: "task-1", additionalTaskIds: ["child-1"] });
  });

  it("drops client-supplied child task scope from timeline requests", () => {
    expect(
      sanitizeTaskTimelinePageRequest({
        taskId: "task-1",
        additionalTaskIds: ["unrelated"],
        additionalTaskEventTypes: ["llm_usage"],
        limit: 64,
      }),
    ).toEqual({
      taskId: "task-1",
      cursor: null,
      limit: 64,
      byteLimit: undefined,
      singleEventByteLimit: undefined,
    });
  });
});
