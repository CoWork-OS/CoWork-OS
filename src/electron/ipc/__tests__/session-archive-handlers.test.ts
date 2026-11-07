import { beforeEach, describe, expect, it, vi } from "vitest";

const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel, handler) => registered.set(channel, handler)) },
}));

import { IPC_CHANNELS } from "../../../shared/types";
import { setupSessionArchiveHandlers } from "../session-archive-handlers";

const TASK_ID = "6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d";
const CONTINUED_TASK_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("session archive IPC", () => {
  const findTask = vi.fn(async (taskId: string) => {
    if (taskId === TASK_ID) return { id: TASK_ID };
    if (taskId === CONTINUED_TASK_ID) return { id: CONTINUED_TASK_ID, sessionId: "session-1" };
    return undefined;
  });
  const sessions = {
    archiveSession: vi.fn((sessionId: string) => ({
      metadata: { sessionId, archivedAt: 1, createdAt: 1, updatedAt: 1 },
      taskCount: 1,
    })),
    unarchiveSession: vi.fn((sessionId: string) => ({
      metadata: { sessionId, createdAt: 1, updatedAt: 2 },
      taskCount: 2,
    })),
  };

  beforeEach(() => {
    registered.clear();
    findTask.mockClear();
    sessions.archiveSession.mockClear();
    sessions.unarchiveSession.mockClear();
    setupSessionArchiveHandlers({ findTask, sessions });
  });

  it("registers both channels under their constants", () => {
    expect(IPC_CHANNELS.TASK_UNARCHIVE).toBe("task:unarchive");
    expect(registered.has(IPC_CHANNELS.TASK_ARCHIVE)).toBe(true);
    expect(registered.has(IPC_CHANNELS.TASK_UNARCHIVE)).toBe(true);
  });

  it("unarchives the stored task's session, not an id the renderer chose", async () => {
    const unarchive = registered.get(IPC_CHANNELS.TASK_UNARCHIVE)!;

    await expect(unarchive({}, CONTINUED_TASK_ID)).resolves.toMatchObject({
      metadata: { sessionId: "session-1" },
      taskCount: 2,
    });
    expect(sessions.unarchiveSession).toHaveBeenCalledWith("session-1");

    await unarchive({}, TASK_ID);
    expect(sessions.unarchiveSession).toHaveBeenLastCalledWith(TASK_ID);
    expect(sessions.archiveSession).not.toHaveBeenCalled();
  });

  it("archives through the same session lookup", async () => {
    const archive = registered.get(IPC_CHANNELS.TASK_ARCHIVE)!;

    await archive({}, CONTINUED_TASK_ID);

    expect(sessions.archiveSession).toHaveBeenCalledWith("session-1");
    expect(sessions.unarchiveSession).not.toHaveBeenCalled();
  });

  it.each([
    ["a session id", "session-1"],
    ["an object", { taskId: TASK_ID }],
    ["nothing", undefined],
  ])("rejects %s before touching storage", async (_label, raw) => {
    const unarchive = registered.get(IPC_CHANNELS.TASK_UNARCHIVE)!;

    await expect(unarchive({}, raw)).rejects.toThrow(/task ID/i);
    expect(findTask).not.toHaveBeenCalled();
    expect(sessions.unarchiveSession).not.toHaveBeenCalled();
  });

  it("reports an unknown task", async () => {
    const unarchive = registered.get(IPC_CHANNELS.TASK_UNARCHIVE)!;

    await expect(unarchive({}, "11111111-2222-4333-8444-555555555555")).rejects.toThrow(
      "Task not found: 11111111-2222-4333-8444-555555555555",
    );
    expect(sessions.unarchiveSession).not.toHaveBeenCalled();
  });
});
