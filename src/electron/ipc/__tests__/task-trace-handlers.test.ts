import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../../../shared/types";

const { registeredHandlers, mockTaskTraceRepo } = vi.hoisted(() => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockTaskTraceRepo = {
    listTaskTraceRuns: vi.fn(() => []),
    getTaskTraceRun: vi.fn(() => undefined),
  };
  return { registeredHandlers, mockTaskTraceRepo };
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
    setupTaskTraceHandlers({ taskTraceRepo: mockTaskTraceRepo });
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
});
