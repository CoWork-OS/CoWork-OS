import { describe, expect, it } from "vitest";
import type { Task, TaskEvent } from "../types";
import { deriveBotConversationProjection } from "../bot-lifecycle";

function makeEvent(
  id: string,
  type: TaskEvent["type"],
  payload: Record<string, unknown>,
  timestamp = 1_000,
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type,
    payload,
    schemaVersion: 2,
  };
}

const baseTask: Pick<Task, "status" | "error" | "resultSummary"> = {
  status: "executing",
  error: null,
  resultSummary: undefined,
};

describe("deriveBotConversationProjection", () => {
  it("keeps a dormant pending bot ready instead of showing a phantom run", () => {
    const projection = deriveBotConversationProjection({
      task: { status: "pending", error: null, resultSummary: undefined },
      botName: "Atlas",
    });

    expect(projection.state).toBe("ready");
    expect(projection.stateLabel).toBe("Ready for another message");
    expect(projection.collaborationSummary).toBe("No teammates involved");
  });

  it("aggregates teammate statuses without exposing their execution trace", () => {
    const projection = deriveBotConversationProjection({
      task: { ...baseTask, id: "atlas-task" },
      botName: "Atlas",
      childTasks: [
        {
          id: "scribe-task",
          title: "Scribe",
          status: "executing",
          assignedAgentRoleId: "scribe",
        },
        {
          id: "forge-task",
          title: "Forge",
          status: "completed",
          assignedAgentRoleId: "forge",
          resultSummary: "Sources ready",
        },
      ],
    });

    expect(projection.teammates).toEqual([
      { id: "scribe-task", label: "Scribe", state: "working", detail: "Working" },
      { id: "forge-task", label: "Forge", state: "completed", detail: "Finished" },
    ]);
    expect(projection.collaborationSummary).toBe("2 teammates · 1 working · 1 finished");
  });

  it("turns a queued teammate message into a waiting activity state", () => {
    const projection = deriveBotConversationProjection({
      task: baseTask,
      botName: "Atlas",
      events: [
        makeEvent(
          "message-1",
          "agent_message",
          {
            messageId: "message-1",
            correlationId: "message-1",
            senderLabel: "Atlas",
            recipientLabel: "Forge",
            message: "Please investigate the issue.",
            deliveryStatus: "queued",
          },
          2_000,
        ),
      ],
    });

    expect(projection.state).toBe("waiting");
    expect(projection.activityLabel).toBe("Message queued for Forge");
    expect(projection.handoffs).toMatchObject([
      {
        id: "message-1",
        state: "queued",
        senderLabel: "Atlas",
        recipientLabel: "Forge",
        correlationId: "message-1",
      },
    ]);
    expect(projection.collaborators).toEqual(["Forge"]);
  });

  it("collapses duplicate handoff lifecycle events to the latest durable receipt", () => {
    const projection = deriveBotConversationProjection({
      task: baseTask,
      botName: "Atlas",
      events: [
        makeEvent("message-queued", "agent_message", {
          messageId: "message-1",
          correlationId: "message-1",
          senderLabel: "Atlas",
          recipientLabel: "Forge",
          message: "Please investigate the issue.",
          deliveryStatus: "queued",
        }),
        makeEvent(
          "message-delivered",
          "agent_message",
          {
            messageId: "message-1",
            correlationId: "message-1",
            senderLabel: "Atlas",
            recipientLabel: "Forge",
            message: "Please investigate the issue.",
            deliveryStatus: "delivered",
            replyStatus: "pending",
          },
          2_000,
        ),
      ],
    });

    expect(projection.handoffs).toHaveLength(1);
    expect(projection.handoffs[0]).toMatchObject({
      id: "message-1",
      state: "delivered",
      replyState: "pending",
    });
    expect(projection.activityLabel).toBe("Message delivered to Forge; waiting for a reply");
  });

  it("shows a correlated teammate reply once the originating handoff is acknowledged", () => {
    const projection = deriveBotConversationProjection({
      task: baseTask,
      botName: "Atlas",
      events: [
        makeEvent("message-delivered", "agent_message", {
          messageId: "message-1",
          senderLabel: "Atlas",
          recipientLabel: "Forge",
          message: "Please investigate the issue.",
          deliveryStatus: "delivered",
          replyStatus: "received",
          replyMessageId: "reply-1",
        }),
      ],
    });

    expect(projection.handoffs[0]).toMatchObject({
      replyState: "received",
      replyMessageId: "reply-1",
    });
    expect(projection.activityLabel).toBe("Reply received from Forge");
  });

  it("does not keep a completed coordinator waiting after a teammate reply times out", () => {
    const projection = deriveBotConversationProjection({
      task: {
        status: "completed",
        error: null,
        resultSummary: "The partial repository inspection is available.",
      },
      botName: "Atlas",
      events: [
        makeEvent("message-timeout", "agent_message", {
          messageId: "message-timeout",
          senderLabel: "Atlas",
          recipientLabel: "Forge",
          message: "Inspect the repository.",
          deliveryStatus: "delivered",
          replyStatus: "timed_out",
          failureCode: "BOT_HANDOFF_REPLY_TIMEOUT",
        }),
      ],
    });

    expect(projection.state).toBe("completed");
    expect(projection.activityLabel).toBe("No reply from Forge; partial result available");
    expect(projection.attention).toMatchObject({
      kind: "delivery",
      title: "No reply from Forge",
    });
    expect(projection.handoffs[0].replyState).toBe("timed_out");
  });

  it("folds a child-task reply into the parent handoff instead of adding a new request", () => {
    const projection = deriveBotConversationProjection({
      task: { ...baseTask, id: "atlas-task" },
      botName: "Atlas",
      events: [
        makeEvent("handoff-1", "agent_message", {
          messageId: "handoff-1",
          senderLabel: "Atlas",
          recipientLabel: "Forge",
          message: "Investigate the issue.",
          deliveryStatus: "delivered",
        }),
      ],
      childEvents: [
        {
          ...makeEvent(
            "reply-1",
            "agent_message",
            {
              messageId: "reply-1",
              targetTaskId: "atlas-task",
              senderLabel: "Forge",
              recipientLabel: "Atlas",
              inReplyToMessageId: "handoff-1",
              message: "DONE — the issue is understood.",
              deliveryStatus: "delivered",
            },
            2_000,
          ),
          taskId: "forge-task",
        },
      ],
    });

    expect(projection.handoffs).toHaveLength(1);
    expect(projection.handoffs[0]).toMatchObject({
      recipientLabel: "Forge",
      replyState: "received",
      replyMessageId: "reply-1",
    });
    expect(projection.activityLabel).toBe("Reply received from Forge");
  });

  it("keeps delivery failure actionable and never requires raw protocol text", () => {
    const projection = deriveBotConversationProjection({
      task: baseTask,
      botName: "Atlas",
      events: [
        makeEvent("message-2", "agent_message", {
          messageId: "message-2",
          senderLabel: "Atlas",
          recipientLabel: "Scribe",
          message: "Draft the final note.",
          deliveryStatus: "failed",
          error: "Recipient unavailable",
        }),
      ],
    });

    expect(projection.attention).toMatchObject({
      kind: "delivery",
      title: "Message to Scribe failed",
      detail: "Recipient unavailable",
    });
    expect(projection.activityLabel).toBe("Couldn’t message Scribe");
    expect(JSON.stringify(projection)).not.toContain('"success":true');
  });

  it("keeps a delivery failure specific when the task also records a generic error", () => {
    const projection = deriveBotConversationProjection({
      task: {
        status: "failed",
        error: "The bot could not finish the request.",
        resultSummary: undefined,
      },
      botName: "Atlas",
      events: [
        makeEvent("message-failed", "agent_message", {
          messageId: "message-failed",
          senderLabel: "Atlas",
          recipientLabel: "Scribe",
          message: "Draft the final note.",
          deliveryStatus: "failed",
          error: "Scribe is unavailable",
        }),
      ],
    });

    expect(projection.attention).toEqual({
      kind: "delivery",
      title: "Message to Scribe failed",
      detail: "Scribe is unavailable",
      handoffId: "message-failed",
    });
  });

  it("projects a completed bot result without exposing execution steps", () => {
    const projection = deriveBotConversationProjection({
      task: {
        status: "completed",
        error: null,
        resultSummary: "The release note is ready with the verified links.",
      },
      botName: "Scribe",
      events: [
        makeEvent("spawn-1", "agent_spawned", {
          childAgentLabel: "Research",
        }),
        makeEvent("done-1", "agent_completed", {
          childAgentLabel: "Research",
          resultSummary: "Sources checked",
        }),
      ],
    });

    expect(projection.state).toBe("completed");
    expect(projection.outcome).toEqual({
      state: "completed",
      summary: "The release note is ready with the verified links.",
    });
    expect(projection.activityLabel).toBe("Research finished");
    expect(projection.collaborators).toEqual(["Research"]);
  });

  it("converts a protocol-only result into a human-facing outcome", () => {
    const projection = deriveBotConversationProjection({
      task: {
        status: "completed",
        error: null,
        resultSummary: '{"success":true,"deliveryStatus":"queued","message_id":"message-3"}',
      },
      botName: "Atlas",
    });

    expect(projection.outcome).toEqual({
      state: "completed",
      summary: "Message queued for the next turn",
    });
  });

  it("strips Markdown markers from outcome previews", () => {
    const projection = deriveBotConversationProjection({
      task: {
        status: "completed",
        error: null,
        resultSummary: "### 1) Current draft **None verified**\n- Confirm the source.",
      },
      botName: "Scribe",
    });

    expect(projection.outcome).toEqual({
      state: "completed",
      summary: "1) Current draft None verified Confirm the source.",
    });
  });

  it("turns blocked and failed tasks into attention states", () => {
    expect(
      deriveBotConversationProjection({
        task: { status: "blocked", error: null, resultSummary: undefined },
      }).attention,
    ).toMatchObject({ kind: "input", title: "The team is waiting for you" });

    expect(
      deriveBotConversationProjection({
        task: { status: "failed", error: "Computer connection lost", resultSummary: undefined },
      }).attention,
    ).toMatchObject({ kind: "failed", detail: "Computer connection lost" });
  });

  it("keeps a pending teammate handoff actionable when the task carries a waiting error", () => {
    const projection = deriveBotConversationProjection({
      task: {
        status: "blocked",
        error: "Waiting for Atlas to reply before finishing this conversation.",
        resultSummary: undefined,
      },
      botName: "Product Engineer",
      events: [
        makeEvent("handoff-1", "agent_message", {
          messageId: "handoff-1",
          senderLabel: "Product Engineer",
          recipientLabel: "Atlas",
          message: "Please review the workspace.",
          deliveryStatus: "delivered",
          replyStatus: "pending",
        }),
      ],
    });

    expect(projection.state).toBe("waiting");
    expect(projection.attention).toMatchObject({
      kind: "blocked",
      title: "Waiting on Atlas",
    });
    expect(projection.attention?.title).not.toBe("The bot could not finish");
  });
});
