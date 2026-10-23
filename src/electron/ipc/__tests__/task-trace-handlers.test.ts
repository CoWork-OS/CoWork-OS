import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS, type Task, type TaskTraceRunDetail } from "../../../shared/types";

const {
  registeredHandlers,
  mockTaskTraceRepo,
  authorizeTaskView,
  listVisibleTasks,
  filterVisibleTaskIds,
} = vi.hoisted(() => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockTaskTraceRepo = {
    listTaskTraceRuns: vi.fn(() => []),
    getTaskTraceRun: vi.fn<() => TaskTraceRunDetail | undefined>(() => undefined),
  };
  return {
    registeredHandlers,
    mockTaskTraceRepo,
    authorizeTaskView: vi.fn(async () => {}),
    listVisibleTasks: vi.fn<() => Promise<Task[] | undefined>>(async () => undefined),
    filterVisibleTaskIds: vi.fn(async (_event, ids: string[]) => ids),
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

import { setupTaskTraceHandlers } from "../task-trace-handlers";

describe("task trace IPC handlers", () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
    authorizeTaskView.mockResolvedValue(undefined);
    listVisibleTasks.mockResolvedValue(undefined);
    mockTaskTraceRepo.getTaskTraceRun.mockReturnValue(undefined);
    setupTaskTraceHandlers({
      taskTraceRepo: mockTaskTraceRepo,
      authorizeTaskView,
      listVisibleTasks,
      filterVisibleTaskIds,
    });
  });

  it("registers list and detail handlers", () => {
    expect(registeredHandlers.has(IPC_CHANNELS.TASK_TRACE_LIST)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.TASK_TRACE_GET)).toBe(true);
  });

  it("validates and delegates task trace requests", async () => {
    const listHandler = registeredHandlers.get(IPC_CHANNELS.TASK_TRACE_LIST)!;
    const detailHandler = registeredHandlers.get(IPC_CHANNELS.TASK_TRACE_GET)!;

    await listHandler(null, {
      workspaceId: "550e8400-e29b-41d4-a716-446655440001",
      status: "completed",
      query: "agentic trace",
      limit: 20,
    });
    await detailHandler(null, "550e8400-e29b-41d4-a716-446655440000");

    expect(mockTaskTraceRepo.listTaskTraceRuns).toHaveBeenCalledWith({
      workspaceId: "550e8400-e29b-41d4-a716-446655440001",
      status: "completed",
      query: "agentic trace",
      limit: 20,
    });
    expect(mockTaskTraceRepo.getTaskTraceRun).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("rejects invalid task ids", async () => {
    const detailHandler = registeredHandlers.get(IPC_CHANNELS.TASK_TRACE_GET)!;

    await expect(detailHandler(null, "not-a-uuid")).rejects.toThrow(/task trace task ID/i);
    expect(mockTaskTraceRepo.getTaskTraceRun).not.toHaveBeenCalled();
  });

  it("does not load a trace when membership authorization rejects", async () => {
    authorizeTaskView.mockRejectedValue(new Error("Principal is not a member"));
    const detailHandler = registeredHandlers.get(IPC_CHANNELS.TASK_TRACE_GET)!;
    await expect(detailHandler(null, "550e8400-e29b-41d4-a716-446655440000")).rejects.toThrow(
      "not a member",
    );
    expect(mockTaskTraceRepo.getTaskTraceRun).not.toHaveBeenCalled();
  });

  it("passes authorized tasks into trace grouping before applying the list limit", async () => {
    const tasks: Task[] = [
      {
        id: "visible-task",
        title: "Visible",
        prompt: "Task",
        workspaceId: "workspace-1",
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    listVisibleTasks.mockResolvedValue(tasks);
    const listHandler = registeredHandlers.get(IPC_CHANNELS.TASK_TRACE_LIST)!;
    await listHandler(null, { limit: 1 });
    expect(mockTaskTraceRepo.listTaskTraceRuns).toHaveBeenCalledWith({ limit: 1 }, tasks);
  });

  it("does not return private sibling runs alongside an authorized trace", async () => {
    mockTaskTraceRepo.getTaskTraceRun.mockReturnValue({
      sessionId: "session-1",
      task: {
        id: "visible-task",
        title: "Visible",
        prompt: "Task",
        workspaceId: "workspace-1",
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      },
      siblingRuns: ["visible-task", "private-task"].map((taskId) => ({
        taskId,
        title: taskId,
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      })),
      metrics: {
        startedAt: 1,
        updatedAt: 1,
        runtimeMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        toolCallCount: 0,
        eventCount: 0,
      },
      rawEvents: [],
      semanticTimeline: [],
    });
    filterVisibleTaskIds.mockResolvedValueOnce(["visible-task"]);
    const detailHandler = registeredHandlers.get(IPC_CHANNELS.TASK_TRACE_GET)!;
    const detail = await detailHandler(null, "550e8400-e29b-41d4-a716-446655440000");
    expect(detail).toMatchObject({ siblingRuns: [{ taskId: "visible-task" }] });
  });
});
