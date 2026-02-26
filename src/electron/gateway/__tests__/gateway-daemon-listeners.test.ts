/**
 * ChannelGateway daemon listener tests
 *
 * These ensure that remote channels (WhatsApp/Telegram/etc) receive a useful
 * completion payload even when the last streamed assistant message is missing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// Mock better-sqlite3 (native module) before importing ChannelGateway
vi.mock("better-sqlite3", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 1 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
      close: vi.fn(),
    })),
  };
});

// Mock electron APIs used by gateway modules
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
  BrowserWindow: {
    getAllWindows: vi.fn().mockReturnValue([]),
  },
}));

import { ChannelGateway } from "../index";

function createMockDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1 }),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    transaction: vi.fn((fn: Any) => fn),
  } as Any;
}

describe("ChannelGateway daemon listeners", () => {
  let agentDaemon: EventEmitter;

  beforeEach(() => {
    agentDaemon = new EventEmitter();
  });

  it("prefers task_completed.resultSummary over last streamed assistant message", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn();
    router.handleTaskCompletion = vi.fn();

    agentDaemon.emit("assistant_message", {
      taskId: "t1",
      message: "Some streamed content that is not the final summary.",
    });
    agentDaemon.emit("task_completed", {
      taskId: "t1",
      resultSummary: "Final summary from daemon.",
    });

    expect(router.handleTaskCompletion).toHaveBeenCalledWith("t1", "Final summary from daemon.");
  });

  it("falls back to last streamed assistant message when resultSummary is missing", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn();
    router.handleTaskCompletion = vi.fn();

    const first = "First streamed message (short).";
    const second = "Second streamed message that is longer and should win.";

    agentDaemon.emit("assistant_message", { taskId: "t2", message: first });
    agentDaemon.emit("assistant_message", { taskId: "t2", message: second });
    agentDaemon.emit("task_completed", { taskId: "t2" });

    expect(router.handleTaskCompletion).toHaveBeenCalledWith("t2", second);
  });

  it("ignores generic task_completed.message and prefers last streamed assistant message", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn();
    router.handleTaskCompletion = vi.fn();

    const streamed = "Here is the actual result the user should see.";

    agentDaemon.emit("assistant_message", { taskId: "t3", message: streamed });
    agentDaemon.emit("task_completed", { taskId: "t3", message: "Task completed successfully" });

    expect(router.handleTaskCompletion).toHaveBeenCalledWith("t3", streamed);
  });
});
