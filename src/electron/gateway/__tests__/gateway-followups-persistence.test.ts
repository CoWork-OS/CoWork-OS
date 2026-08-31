/**
 * ChannelGateway follow-up persistence tests
 *
 * Follow-up assistant replies are delivered via assistant_message + follow_up_completed/failed.
 * These tests ensure the gateway flushes debounced buffers and finalizes Telegram draft streams
 * so digests/transcripts can include assistant output from follow-ups.
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

const tick = () => new Promise<void>((resolve) => setImmediate(() => resolve()));

describe("ChannelGateway follow-up listeners", () => {
  let agentDaemon: EventEmitter;

  beforeEach(() => {
    agentDaemon = new EventEmitter();
  });

  const emitTimeline = (
    timelineType: string,
    taskId: string,
    legacyType: string,
    payload: Record<string, unknown> = {},
  ) => {
    agentDaemon.emit(timelineType, {
      taskId,
      payload: {
        legacyType,
        ...payload,
      },
      timestamp: Date.now(),
      schemaVersion: 2,
      status: timelineType === "timeline_step_finished" ? "completed" : "in_progress",
    });
  };

  it("flushes + finalizes when a follow-up produced assistant output", async () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn().mockResolvedValue(undefined);
    router.flushStreamingUpdateForTask = vi.fn().mockResolvedValue(undefined);
    router.finalizeDraftStreamForTask = vi.fn().mockResolvedValue(undefined);
    router.sendArtifacts = vi.fn().mockResolvedValue(undefined);

    emitTimeline("timeline_step_updated", "t1", "user_message", { message: "follow-up" });
    emitTimeline("timeline_step_updated", "t1", "assistant_message", {
      message: "Follow-up response",
    });
    emitTimeline("timeline_step_updated", "t1", "follow_up_completed");

    await tick();
    await tick();

    expect(router.flushStreamingUpdateForTask).toHaveBeenCalledWith("t1");
    expect(router.finalizeDraftStreamForTask).toHaveBeenCalledWith("t1", "Follow-up response");
    expect(router.sendArtifacts).toHaveBeenCalledWith("t1");
    // assistant_message should be the only call to sendTaskUpdate (no extra confirmation)
    expect(router.sendTaskUpdate).toHaveBeenCalledTimes(1);
  });

  it("sends a confirmation when a follow-up produced no assistant output", async () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn().mockResolvedValue(undefined);
    router.flushStreamingUpdateForTask = vi.fn().mockResolvedValue(undefined);
    router.finalizeDraftStreamForTask = vi.fn().mockResolvedValue(undefined);
    router.sendArtifacts = vi.fn().mockResolvedValue(undefined);

    emitTimeline("timeline_step_updated", "t2", "user_message", { message: "follow-up" });
    emitTimeline("timeline_step_updated", "t2", "follow_up_completed");

    await tick();
    await tick();

    expect(router.flushStreamingUpdateForTask).not.toHaveBeenCalled();
    expect(router.finalizeDraftStreamForTask).not.toHaveBeenCalled();
    expect(router.sendTaskUpdate).toHaveBeenCalledTimes(1);
    expect(router.sendArtifacts).toHaveBeenCalledWith("t2");
  });

  it("flushes + finalizes partial output on follow-up failure, then sends a failure message", async () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn().mockResolvedValue(undefined);
    router.flushStreamingUpdateForTask = vi.fn().mockResolvedValue(undefined);
    router.finalizeDraftStreamForTask = vi.fn().mockResolvedValue(undefined);

    emitTimeline("timeline_step_updated", "t3", "user_message", { message: "follow-up" });
    emitTimeline("timeline_step_updated", "t3", "assistant_message", { message: "Partial answer" });
    emitTimeline("timeline_step_updated", "t3", "follow_up_failed", { error: "boom" });

    await tick();
    await tick();

    expect(router.flushStreamingUpdateForTask).toHaveBeenCalledWith("t3");
    expect(router.finalizeDraftStreamForTask).toHaveBeenCalledWith("t3", "Partial answer");
    // assistant_message + follow_up_failed each send one update
    expect(router.sendTaskUpdate).toHaveBeenCalledTimes(2);
  });

  it("finalizes paused task output so draft streaming does not leave a dangling cursor", async () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.flushStreamingUpdateForTask = vi.fn().mockResolvedValue(undefined);
    router.finalizeDraftStreamForTask = vi.fn().mockResolvedValue(undefined);

    emitTimeline("timeline_step_updated", "t4", "task_paused", {
      message: "Need more input",
      reason: "user_input",
    });

    await tick();
    await tick();

    expect(router.flushStreamingUpdateForTask).toHaveBeenCalledWith("t4");
    expect(router.finalizeDraftStreamForTask).toHaveBeenCalledWith("t4", "Need more input");
  });
});
