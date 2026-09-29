import { describe, expect, it, vi } from "vitest";
import type { TaskEvent, TaskEventMutationPageResult } from "../../../shared/types";
import type {
  TaskEventScopedMutationPageResult,
  TaskEventScopedTimelineHistoryPageResult,
  TaskEventScopedTimelineSnapshotResult,
} from "../../../electron/database/repositories";
import {
  createBrowserTaskEventMethods,
  type BrowserTaskEventSources,
} from "../browser-task-event-methods";

const task = { id: "task-1", workspaceId: "workspace-1" };
const workspace = { id: "workspace-1" };
const context = {
  audience: "web-access",
  identity: {
    installationId: "installation",
    profileId: "profile",
    generation: "generation",
    runtime: "node" as const,
    platform: "linux" as const,
    appVersion: "1.0.0",
  },
  sessionId: "session",
};

function event(type: string, payload: Record<string, unknown>): TaskEvent {
  return {
    id: `event-${type}`,
    taskId: task.id,
    timestamp: 10,
    type: type as TaskEvent["type"],
    schemaVersion: 2,
    payload,
  };
}

function sources(overrides: Partial<BrowserTaskEventSources> = {}): BrowserTaskEventSources {
  return {
    findScopedTimelineSnapshot: vi.fn().mockResolvedValue({
      outcome: "available",
      cursor: { taskId: task.id, position: 7 },
      page: {
        taskId: task.id,
        events: [],
        hasMoreHistory: true,
        nextCursor: { order: 1, timestamp: 1, id: "oldest" },
        summary: {
          eventCount: 0,
          payloadBytes: 0,
          truncatedEventCount: 0,
          largestEventPayloadBytes: 0,
        },
      },
    } satisfies TaskEventScopedTimelineSnapshotResult),
    findScopedTimelineHistoryPage: vi.fn().mockResolvedValue({
      outcome: "available",
      page: {
        taskId: task.id,
        events: [],
        hasMoreHistory: false,
        nextCursor: null,
        summary: {
          eventCount: 0,
          payloadBytes: 0,
          truncatedEventCount: 0,
          largestEventPayloadBytes: 0,
        },
      },
    } satisfies TaskEventScopedTimelineHistoryPageResult),
    findScopedMutationPage: vi.fn().mockResolvedValue({
      outcome: "available",
      page: {
        outcome: "no_changes",
        taskId: task.id,
        changes: [],
        nextCursor: { taskId: task.id, position: 7 },
        hasMore: false,
      } satisfies TaskEventMutationPageResult,
    } satisfies TaskEventScopedMutationPageResult),
    ...overrides,
  };
}

describe("browser task event methods", () => {
  it("returns a bounded newest snapshot with safe event DTOs and a replay cursor", async () => {
    const unsafeEvents = [
      event("approval_requested", {
        approval: {
          id: "approval-1",
          status: "pending",
          type: "run_command",
          requestedAt: 9,
          description: "approval-description-secret",
          details: { command: "command-secret", apiKey: "approval-key-secret" },
        },
        autoApproved: false,
        command: "top-level-command-secret",
      }),
      event("input_request_created", {
        request: {
          id: "request-1",
          status: "pending",
          requestedAt: 10,
          questions: [{ question: "input-question-secret", options: ["input-option-secret"] }],
          answers: ["input-answer-secret"],
        },
      }),
      event("input_request_resolved", {
        requestId: "request-1",
        status: "submitted",
        answers: { mode: { nested: "arbitrary-input-answer-secret" } },
      }),
      event("credential_updated", {
        credential: { value: "known-credential-event-secret" },
        visibleLabel: "private credential text",
      }),
      event("command_output", { output: "tool-output-secret", stdout: "stdout-secret" }),
    ];
    const repository = sources({
      findScopedTimelineSnapshot: vi.fn().mockResolvedValue({
        outcome: "available",
        cursor: { taskId: task.id, position: 7 },
        page: {
          taskId: task.id,
          events: unsafeEvents,
          hasMoreHistory: true,
          nextCursor: { order: 1, timestamp: 1, id: "oldest" },
          summary: {
            eventCount: unsafeEvents.length,
            payloadBytes: 100,
            truncatedEventCount: 0,
            largestEventPayloadBytes: 50,
          },
        },
      } satisfies TaskEventScopedTimelineSnapshotResult),
    });
    const methods = createBrowserTaskEventMethods(repository);
    const request = methods["task.events.snapshot"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      limit: 5,
    });

    const result = (await methods["task.events.snapshot"].handler(context, request)) as {
      events: TaskEvent[];
      cursor: { taskId: string; position: number };
      hasMoreHistory: boolean;
      nextHistoryCursor: unknown;
    };

    expect(repository.findScopedTimelineSnapshot).toHaveBeenCalledWith({
      taskId: task.id,
      workspaceId: workspace.id,
      limit: 5,
    });
    expect(result).toMatchObject({
      cursor: { taskId: task.id, position: 7 },
      hasMoreHistory: true,
      nextHistoryCursor: { id: "oldest" },
    });
    expect(result.events[0]?.payload).toMatchObject({
      approval: { id: "approval-1", status: "pending", type: "run_command", requestedAt: 9 },
      autoApproved: false,
    });
    expect(result.events[1]?.payload).toMatchObject({
      request: { id: "request-1", status: "pending", requestedAt: 10 },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /approval-description-secret|command-secret|approval-key-secret|top-level-command-secret|input-question-secret|input-option-secret|input-answer-secret|arbitrary-input-answer-secret|known-credential-event-secret|private credential text|tool-output-secret|stdout-secret/,
    );
    expect(result.events[0]).not.toHaveProperty("inlineFrames");
  });

  it("loads older history strictly before the complete cursor and projects safe event DTOs", async () => {
    const olderEvent = event("assistant_message", {
      message: "older transcript message",
      apiKey: "secret-input-in-history",
    });
    const repository = sources({
      findScopedTimelineHistoryPage: vi.fn().mockResolvedValue({
        outcome: "available",
        page: {
          taskId: task.id,
          events: [olderEvent],
          hasMoreHistory: true,
          nextCursor: { order: 3, timestamp: 30, id: "event-older" },
          summary: {
            eventCount: 1,
            payloadBytes: 64,
            truncatedEventCount: 0,
            largestEventPayloadBytes: 64,
          },
        },
      } satisfies TaskEventScopedTimelineHistoryPageResult),
    });
    const methods = createBrowserTaskEventMethods(repository);
    const beforeCursor = { order: 8, timestamp: 80, id: "event-anchor" };
    const request = methods["task.events.history"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      beforeCursor,
      limit: 25,
    });

    const result = (await methods["task.events.history"].handler(context, request)) as {
      events: TaskEvent[];
      hasMoreHistory: boolean;
      nextHistoryCursor: unknown;
    };

    expect(repository.findScopedTimelineHistoryPage).toHaveBeenCalledWith({
      taskId: task.id,
      workspaceId: workspace.id,
      beforeCursor,
      limit: 25,
    });
    expect(result).toMatchObject({
      events: [{ payload: { message: "older transcript message", apiKey: "[REDACTED]" } }],
      hasMoreHistory: true,
      nextHistoryCursor: { order: 3, timestamp: 30, id: "event-older" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-input-in-history");
  });

  it("sanitizes upserts and preserves an explicit journal gap response", async () => {
    const repository = sources({
      findScopedMutationPage: vi
        .fn()
        .mockResolvedValueOnce({
          outcome: "available",
          page: {
            outcome: "page",
            taskId: task.id,
            changes: [
              {
                cursor: 8,
                operation: "upsert",
                event: event("input_request_created", {
                  request: {
                    id: "request-1",
                    status: "pending",
                    questions: [{ question: "private-question" }],
                  },
                }),
              },
            ],
            nextCursor: { taskId: task.id, position: 8 },
            hasMore: false,
          },
        })
        .mockResolvedValueOnce({
          outcome: "available",
          page: {
            outcome: "cursor_expired",
            taskId: task.id,
            afterCursor: { taskId: task.id, position: 2 },
            earliestAvailableCursor: 5,
            resyncCursor: { taskId: task.id, position: 8 },
            changes: [],
            hasMore: false,
          },
        }),
    });
    const methods = createBrowserTaskEventMethods(repository);
    const request = methods["task.events.page"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      afterCursor: { taskId: task.id, position: 7 },
      limit: 25,
    });

    const page = (await methods["task.events.page"].handler(context, request)) as {
      outcome: string;
      changes: Array<{ event?: TaskEvent }>;
    };
    expect(page.changes[0]?.event?.payload).toEqual({
      request: { id: "request-1", status: "pending" },
    });
    expect(JSON.stringify(page)).not.toContain("private-question");

    const gap = await methods["task.events.page"].handler(context, request);
    expect(gap).toMatchObject({
      outcome: "cursor_expired",
      earliestAvailableCursor: 5,
      resyncCursor: { taskId: task.id, position: 8 },
      changes: [],
    });
  });

  it("caps mutation response bytes and leaves the cursor at the last returned change", async () => {
    const changes = Array.from({ length: 100 }, (_, index) => ({
      cursor: index + 1,
      operation: "upsert" as const,
      event: {
        ...event("assistant_message", { message: "x".repeat(8_000) }),
        id: `event-${index + 1}`,
      },
    }));
    const repository = sources({
      findScopedMutationPage: vi.fn().mockResolvedValue({
        outcome: "available",
        page: {
          outcome: "page",
          taskId: task.id,
          changes,
          nextCursor: { taskId: task.id, position: 100 },
          hasMore: false,
        },
      }),
    });
    const methods = createBrowserTaskEventMethods(repository);
    const request = methods["task.events.page"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      afterCursor: { taskId: task.id, position: 0 },
      limit: 100,
    });

    const page = (await methods["task.events.page"].handler(context, request)) as {
      outcome: string;
      changes: Array<{ cursor: number }>;
      nextCursor: { taskId: string; position: number };
      hasMore: boolean;
    };

    expect(page.outcome).toBe("page_with_more");
    expect(page.changes.length).toBeGreaterThan(0);
    expect(page.changes.length).toBeLessThan(changes.length);
    expect(page.nextCursor).toEqual({
      taskId: task.id,
      position: page.changes.at(-1)?.cursor,
    });
    expect(page.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(512 * 1024);
  });

  it("shrinks a single oversized event so a replay cursor can always advance", async () => {
    const repository = sources({
      findScopedMutationPage: vi.fn().mockResolvedValue({
        outcome: "available",
        page: {
          outcome: "page",
          taskId: task.id,
          changes: [
            {
              cursor: 1,
              operation: "upsert",
              event: event("assistant_message", { message: "x".repeat(2 * 1024 * 1024) }),
            },
          ],
          nextCursor: { taskId: task.id, position: 1 },
          hasMore: false,
        },
      }),
    });
    const methods = createBrowserTaskEventMethods(repository);
    const request = methods["task.events.page"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      afterCursor: { taskId: task.id, position: 0 },
      limit: 1,
    });

    const page = (await methods["task.events.page"].handler(context, request)) as {
      outcome: string;
      changes: Array<{ cursor: number; event?: TaskEvent }>;
      nextCursor: { position: number };
      hasMore: boolean;
    };

    expect(page).toMatchObject({
      outcome: "page",
      changes: [{ cursor: 1, event: { payload: { message: expect.any(String) } } }],
      nextCursor: { position: 1 },
      hasMore: false,
    });
    const projectedPayload = page.changes[0]?.event?.payload as { message?: string } | undefined;
    expect(projectedPayload?.message?.length).toBeLessThanOrEqual(8_001);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(512 * 1024);
  });

  it("rejects tasks outside the requested workspace before reading event data", async () => {
    const repository = sources({
      findScopedTimelineSnapshot: vi.fn().mockResolvedValue({ outcome: "unavailable" }),
    });
    const methods = createBrowserTaskEventMethods(repository);
    const request = methods["task.events.snapshot"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
    });

    await expect(methods["task.events.snapshot"].handler(context, request)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(repository.findScopedTimelineSnapshot).toHaveBeenCalledWith({
      taskId: task.id,
      workspaceId: workspace.id,
      limit: 160,
    });
  });

  it("rejects malformed cursors and unbounded snapshot pages", () => {
    const methods = createBrowserTaskEventMethods(sources());
    expect(() =>
      methods["task.events.snapshot"].validateParams!({
        taskId: task.id,
        workspaceId: workspace.id,
        limit: 601,
      }),
    ).toThrow("Invalid task event request");
    expect(() =>
      methods["task.events.page"].validateParams!({
        taskId: task.id,
        workspaceId: workspace.id,
        afterCursor: { taskId: "another-task", position: 1 },
      }),
    ).toThrow("Invalid task event request");
    expect(() =>
      methods["task.events.history"].validateParams!({
        taskId: task.id,
        workspaceId: workspace.id,
        beforeCursor: { order: 1, timestamp: 1 },
      }),
    ).toThrow("Invalid task event request");
    expect(() =>
      methods["task.events.history"].validateParams!({
        taskId: task.id,
        workspaceId: workspace.id,
        beforeCursor: { order: 1.5, timestamp: 1, id: "event-anchor" },
      }),
    ).toThrow("Invalid task event request");
    expect(() =>
      methods["task.events.history"].validateParams!({
        taskId: task.id,
        workspaceId: workspace.id,
        beforeCursor: { order: 1, timestamp: 1, id: "event-anchor" },
        limit: 601,
      }),
    ).toThrow("Invalid task event request");
  });
});
