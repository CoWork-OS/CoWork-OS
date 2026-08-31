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

  it("prefers task_completed.resultSummary over last streamed assistant message", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn();
    router.handleTaskCompletion = vi.fn();
    router.isPendingTaskTextOnlyChannel = vi.fn().mockReturnValue(false);

    emitTimeline("timeline_step_updated", "t1", "assistant_message", {
      message: "Some streamed content that is not the final summary.",
    });
    emitTimeline("timeline_step_finished", "t1", "task_completed", {
      resultSummary: "Final summary from daemon.",
    });

    expect(router.handleTaskCompletion).toHaveBeenCalledWith("t1", "Final summary from daemon.");
  });

  it("keeps internal semantic summaries out of channel completion messages", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn();
    router.handleTaskCompletion = vi.fn();
    router.isPendingTaskTextOnlyChannel = vi.fn().mockReturnValue(false);

    emitTimeline("timeline_step_finished", "t1", "task_completed", {
      resultSummary: "Final summary from daemon.",
      semanticSummary: "Read auth config",
      verificationVerdict: "PASS",
      verificationReport: "Verifier confirmed the implementation.",
    });

    expect(router.handleTaskCompletion).toHaveBeenCalledWith(
      "t1",
      expect.stringContaining("Final summary from daemon."),
    );
    const completionText = router.handleTaskCompletion.mock.calls[0][1] as string;
    expect(completionText).not.toContain("Read auth config");
    expect(router.handleTaskCompletion).toHaveBeenCalledWith(
      "t1",
      expect.stringContaining("Verification: PASS"),
    );
    expect(router.handleTaskCompletion).toHaveBeenCalledWith(
      "t1",
      expect.stringContaining("Verifier confirmed the implementation."),
    );
  });

  it("does not send a semantic-only completion as the user-facing result", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn();
    router.handleTaskCompletion = vi.fn();
    router.isPendingTaskTextOnlyChannel = vi.fn().mockReturnValue(false);

    emitTimeline("timeline_step_finished", "semantic-only", "task_completed", {
      semanticSummary: "List Directory .cowork/memory",
    });

    expect(router.handleTaskCompletion).toHaveBeenCalledWith("semantic-only", "");
  });

  it("falls back to the latest streamed assistant message when resultSummary is missing", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn();
    router.handleTaskCompletion = vi.fn();
    router.isPendingTaskTextOnlyChannel = vi.fn().mockReturnValue(false);

    const first = "Draft answer with extra background that should not win.";
    const second = "Final answer.";

    emitTimeline("timeline_step_updated", "t2", "assistant_message", { message: first });
    emitTimeline("timeline_step_updated", "t2", "assistant_message", { message: second });
    emitTimeline("timeline_step_finished", "t2", "task_completed");

    expect(router.handleTaskCompletion).toHaveBeenCalledWith("t2", second);
  });

  it("ignores generic task_completed.message and prefers last streamed assistant message", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn();
    router.handleTaskCompletion = vi.fn();
    router.isPendingTaskTextOnlyChannel = vi.fn().mockReturnValue(false);

    const streamed = "Here is the actual result the user should see.";

    emitTimeline("timeline_step_updated", "t3", "assistant_message", { message: streamed });
    emitTimeline("timeline_step_finished", "t3", "task_completed", {
      message: "Task completed successfully",
    });

    expect(router.handleTaskCompletion).toHaveBeenCalledWith("t3", streamed);
  });

  it("prefers the last assistant message over semantic summaries on text-only channels", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn();
    router.handleTaskCompletion = vi.fn();
    router.isPendingTaskTextOnlyChannel = vi.fn().mockReturnValue(true);

    const streamed = "Kitabı bütün metne dayanarak değerlendiriyorum.";

    emitTimeline("timeline_step_updated", "t4", "assistant_message", { message: streamed });
    emitTimeline("timeline_step_finished", "t4", "task_completed", {
      resultSummary: "Final summary from daemon.",
      semanticSummary:
        "Metnin Tamamına Dayalı Değerlendirme Şartını Doğrulama · Bölüm Yapısını Çıkarma",
      verificationVerdict: "PASS",
      verificationReport: "Verifier confirmed the implementation.",
    });

    expect(router.handleTaskCompletion).toHaveBeenCalledWith("t4", streamed);
  });

  it("publishes evidence links only for key-claim evidence events", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.sendTaskUpdate = vi.fn();

    emitTimeline("timeline_evidence_attached", "t4", "citations_collected", {
      gate: "key_claim_evidence_gate",
      keyClaims: ["Median comp is higher than the current offer."],
      evidenceRefs: [
        {
          sourceUrlOrPath: "https://example.com/comp-survey",
          snippet: "Median total compensation is $500k.",
        },
      ],
    });

    expect(router.sendTaskUpdate).toHaveBeenCalledWith(
      "t4",
      expect.stringContaining("Evidence links for key claims"),
    );
    expect(router.sendTaskUpdate).toHaveBeenCalledWith(
      "t4",
      expect.stringContaining("https://example.com/comp-survey"),
    );
  });

  it("clears router-side pending approvals when the daemon resolves them elsewhere", () => {
    const db = createMockDb();
    const gateway = new ChannelGateway(db, { agentDaemon: agentDaemon as Any });

    const router = (gateway as Any).router;
    router.clearPendingApproval = vi.fn();

    emitTimeline("timeline_step_finished", "t5", "approval_granted", {
      approvalId: "approval-123",
    });
    emitTimeline("timeline_step_finished", "t5", "approval_denied", {
      approvalId: "approval-456",
      reason: "task_ended",
    });

    expect(router.clearPendingApproval).toHaveBeenCalledWith("approval-123");
    expect(router.clearPendingApproval).toHaveBeenCalledWith("approval-456");
  });
});
