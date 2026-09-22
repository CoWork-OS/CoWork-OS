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

  it("keeps a blocked teammate waiting when its durable error names a reply boundary", () => {
    const projection = deriveBotConversationProjection({
      task: { ...baseTask, id: "atlas-task" },
      botName: "Atlas",
      childTasks: [
        {
          id: "forge-task",
          title: "Forge",
          status: "blocked",
          error: "Waiting for Scribe to reply before finishing this conversation.",
          assignedAgentRoleId: "forge",
        },
      ],
    });

    expect(projection.teammates).toEqual([
      { id: "forge-task", label: "Forge", state: "waiting", detail: "Waiting for a reply" },
    ]);
    expect(projection.collaborationSummary).toBe("1 teammate · 1 waiting");
  });

  it("prefers a newer child completion event over a stale executing task row", () => {
    const projection = deriveBotConversationProjection({
      task: { ...baseTask, id: "atlas-task" },
      botName: "Atlas",
      childTasks: [
        {
          id: "forge-task",
          title: "Forge",
          status: "executing",
          assignedAgentRoleId: "forge",
        },
      ],
      childEvents: [
        {
          ...makeEvent(
            "forge-completed",
            "agent_completed",
            {
              childAgentLabel: "Forge",
              resultSummary: "The handoff is complete.",
            },
            2_000,
          ),
          taskId: "forge-task",
        },
      ],
    });

    expect(projection.teammates).toEqual([
      { id: "forge-task", label: "Forge", state: "completed", detail: "Finished" },
    ]);
    expect(projection.collaborationSummary).toBe("1 teammate · 1 finished");
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

  it("uses the durable sequence for same-millisecond handoff receipts", () => {
    const accepted = {
      ...makeEvent(
        "handoff-same-ms-accepted",
        "agent_message",
        {
          messageId: "handoff-same-ms",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "accepted",
          botTeamId: "team-1",
          targetTaskId: "scribe-task",
          senderLabel: "Atlas",
          recipientLabel: "Scribe",
          message: "Inspect the repository.",
        },
        1_000,
      ),
      seq: 10,
    };
    const failed = {
      ...makeEvent(
        "handoff-same-ms-failed",
        "agent_message",
        {
          messageId: "handoff-same-ms",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "failed",
          botTeamId: "team-1",
          targetTaskId: "scribe-task",
          senderLabel: "Atlas",
          recipientLabel: "Scribe",
          message: "Inspect the repository.",
          error: "The recipient task stopped before delivery.",
        },
        1_000,
      ),
      seq: 11,
    };
    const projection = deriveBotConversationProjection({
      task: baseTask,
      botName: "Atlas",
      events: [failed, accepted],
    });

    expect(projection.handoffs[0]).toMatchObject({ state: "failed" });
    expect(projection.attention).toMatchObject({
      kind: "delivery",
      title: "Message to Scribe failed",
    });
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

  it("surfaces a timed-out handoff even when the task row is still blocked", () => {
    const projection = deriveBotConversationProjection({
      task: {
        status: "blocked",
        error: "Waiting for Forge to reply before finishing this conversation.",
        resultSummary: undefined,
      },
      botName: "Atlas",
      events: [
        makeEvent("message-timeout-blocked", "agent_message", {
          messageId: "message-timeout-blocked",
          senderLabel: "Atlas",
          recipientLabel: "Forge",
          message: "Inspect the repository.",
          deliveryStatus: "delivered",
          replyStatus: "timed_out",
        }),
      ],
    });

    expect(projection.attention).toMatchObject({
      kind: "delivery",
      title: "No reply from Forge",
    });
    expect(projection.activityLabel).toBe("No reply from Forge; partial result available");
  });

  it("prefers a newer handoff failure over an older pending handoff", () => {
    const projection = deriveBotConversationProjection({
      task: {
        status: "blocked",
        error: "Waiting for Forge to reply before finishing this conversation.",
        resultSummary: undefined,
      },
      botName: "Atlas",
      events: [
        makeEvent(
          "old-pending",
          "agent_message",
          {
            messageId: "old-pending",
            senderLabel: "Atlas",
            recipientLabel: "Forge",
            message: "Inspect the repository.",
            deliveryStatus: "delivered",
            replyStatus: "pending",
          },
          1_000,
        ),
        makeEvent(
          "new-failure",
          "agent_message",
          {
            messageId: "new-failure",
            senderLabel: "Atlas",
            recipientLabel: "Scribe",
            message: "Review the result.",
            deliveryStatus: "failed",
            error: "Scribe was unavailable.",
          },
          2_000,
        ),
      ],
    });

    expect(projection.attention).toMatchObject({
      kind: "delivery",
      title: "Message to Scribe failed",
    });
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

  it("does not show a queued child reply as received", () => {
    const projection = deriveBotConversationProjection({
      task: { ...baseTask, id: "atlas-task" },
      botName: "Atlas",
      events: [
        makeEvent("handoff-queued-child", "agent_message", {
          messageId: "handoff-queued-child",
          senderLabel: "Atlas",
          recipientLabel: "Forge",
          targetTaskId: "forge-task",
          message: "Investigate the issue.",
          deliveryStatus: "delivered",
          replyStatus: "pending",
        }),
      ],
      childEvents: [
        {
          ...makeEvent(
            "reply-queued-child",
            "agent_message",
            {
              messageId: "reply-queued-child",
              targetTaskId: "atlas-task",
              senderLabel: "Forge",
              recipientLabel: "Atlas",
              inReplyToMessageId: "handoff-queued-child",
              message: "The result is queued for Atlas.",
              deliveryStatus: "queued",
            },
            2_000,
          ),
          taskId: "forge-task",
        },
      ],
    });

    expect(projection.handoffs[0]).toMatchObject({ replyState: "pending" });
    expect(projection.activityLabel).toBe("Message delivered to Forge; waiting for a reply");
  });

  it("infers a receiver reply from the durable inbound conversation event", () => {
    const projection = deriveBotConversationProjection({
      task: { ...baseTask, id: "atlas-task" },
      botName: "Atlas",
      events: [
        makeEvent(
          "handoff-queued",
          "agent_message",
          {
            messageId: "handoff-1",
            senderLabel: "Atlas",
            recipientLabel: "Scribe",
            targetTaskId: "scribe-task",
            message: "Verify the package metadata.",
            deliveryStatus: "queued",
          },
          1_000,
        ),
        makeEvent(
          "receiver-reply",
          "user_message",
          {
            messageId: "reply-1",
            messageSource: "agent",
            senderTaskId: "scribe-task",
            senderLabel: "Scribe",
            message: "DONE — package metadata verified.",
            deliveryStatus: "delivered",
          },
          1_500,
        ),
        makeEvent(
          "handoff-delivered",
          "agent_message",
          {
            messageId: "handoff-1",
            senderLabel: "Atlas",
            recipientLabel: "Scribe",
            targetTaskId: "scribe-task",
            message: "Verify the package metadata.",
            deliveryStatus: "delivered",
            replyStatus: "pending",
          },
          2_000,
        ),
      ],
    });

    expect(projection.handoffs).toHaveLength(1);
    expect(projection.handoffs[0]).toMatchObject({
      state: "delivered",
      targetTaskId: "scribe-task",
      replyState: "received",
      replyMessageId: "reply-1",
    });
    expect(projection.activityLabel).toBe("Reply received from Scribe");
  });

  it("keeps the collaboration header waiting while a receiver receipt is queued", () => {
    const projection = deriveBotConversationProjection({
      task: { ...baseTask, id: "atlas-task" },
      botName: "Atlas",
      events: [
        makeEvent("handoff-delivered", "agent_message", {
          messageId: "handoff-queued-reply",
          senderLabel: "Atlas",
          recipientLabel: "Scribe",
          targetTaskId: "scribe-task",
          message: "Verify the package metadata.",
          deliveryStatus: "delivered",
          replyStatus: "pending",
        }),
        makeEvent("receiver-reply-queued", "user_message", {
          messageId: "reply-queued",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "queued",
          senderTaskId: "scribe-task",
          senderLabel: "Scribe",
          inReplyToMessageId: "handoff-queued-reply",
          inReplyToTaskId: "atlas-task",
          message: "DONE — package metadata is queued.",
        }),
      ],
    });

    expect(projection.handoffs[0]).toMatchObject({ replyState: "pending" });
    expect(projection.handoffs[0]).not.toHaveProperty("replyMessageId");
    expect(projection.activityLabel).toBe("Message delivered to Scribe; waiting for a reply");
  });

  it("uses durable order when a receiver reply shares the handoff timestamp", () => {
    const handoff = {
      ...makeEvent(
        "handoff-same-ms-reply",
        "agent_message",
        {
          messageId: "handoff-same-ms-reply",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          senderLabel: "Atlas",
          recipientLabel: "Scribe",
          targetTaskId: "scribe-task",
          message: "The current request.",
        },
        3_000,
      ),
      seq: 10,
    };
    const earlierReply = {
      ...makeEvent(
        "reply-before-handoff",
        "user_message",
        {
          messageId: "reply-before-handoff",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          senderTaskId: "scribe-task",
          senderLabel: "Scribe",
          message: "An earlier result.",
        },
        3_000,
      ),
      seq: 9,
    };
    const waitingProjection = deriveBotConversationProjection({
      task: { ...baseTask, id: "atlas-task" },
      botName: "Atlas",
      events: [handoff, earlierReply],
    });

    expect(waitingProjection.handoffs[0]).toMatchObject({
      messageId: "handoff-same-ms-reply",
    });
    expect(waitingProjection.handoffs[0]).not.toHaveProperty("replyState");
    expect(waitingProjection.state).toBe("waiting");

    const laterReply = {
      ...makeEvent(
        "reply-after-handoff",
        "user_message",
        {
          messageId: "reply-after-handoff",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          senderTaskId: "scribe-task",
          senderLabel: "Scribe",
          message: "The current result.",
        },
        3_000,
      ),
      seq: 11,
    };
    const completedProjection = deriveBotConversationProjection({
      task: { ...baseTask, id: "atlas-task" },
      botName: "Atlas",
      events: [handoff, earlierReply, laterReply],
    });

    expect(completedProjection.handoffs[0]).toMatchObject({
      messageId: "handoff-same-ms-reply",
      replyState: "received",
      replyMessageId: "reply-after-handoff",
    });
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

  it("does not resurrect a stale handoff after a new human turn starts", () => {
    const projection = deriveBotConversationProjection({
      task: baseTask,
      botName: "Atlas",
      events: [
        makeEvent(
          "old-handoff",
          "agent_message",
          {
            messageId: "old-handoff",
            senderType: "agent",
            deliveryMode: "message",
            deliveryStatus: "delivered",
            botTeamId: "team-1",
            targetTaskId: "forge-task",
            recipientLabel: "Forge",
            message: "The earlier request is no longer active.",
          },
          1_000,
        ),
        makeEvent("new-human-turn", "user_message", { message: "Start a fresh request." }, 2_000),
      ],
    });

    expect(projection.state).toBe("working");
    expect(projection.activityLabel).toBe("Working on the latest request");
    expect(projection.attention).toBeNull();
  });

  it("does not expose prior-turn handoffs in current collaboration details", () => {
    const projection = deriveBotConversationProjection({
      task: baseTask,
      botName: "Atlas",
      events: [
        makeEvent(
          "old-handoff",
          "agent_message",
          {
            messageId: "old-handoff",
            senderLabel: "Atlas",
            recipientLabel: "Forge",
            targetTaskId: "forge-task",
            message: "Review the old request.",
            deliveryStatus: "delivered",
          },
          1_000,
        ),
        makeEvent("new-human-turn", "user_message", { message: "Start a fresh request." }, 2_000),
        makeEvent(
          "new-handoff",
          "agent_message",
          {
            messageId: "new-handoff",
            senderLabel: "Atlas",
            recipientLabel: "Scribe",
            targetTaskId: "scribe-task",
            message: "Review the new request.",
            deliveryStatus: "queued",
          },
          2_100,
        ),
      ],
    });

    expect(projection.handoffs.map((handoff) => handoff.id)).toEqual(["new-handoff"]);
  });

  it("uses durable sequence order when an old handoff shares the new turn timestamp", () => {
    const projection = deriveBotConversationProjection({
      task: baseTask,
      botName: "Atlas",
      events: [
        {
          ...makeEvent(
            "old-handoff-same-ms",
            "agent_message",
            {
              messageId: "old-handoff-same-ms",
              senderLabel: "Atlas",
              recipientLabel: "Forge",
              targetTaskId: "forge-task",
              message: "Review the old request.",
              deliveryStatus: "delivered",
            },
            2_000,
          ),
          seq: 10,
        },
        {
          ...makeEvent(
            "new-human-turn-same-ms",
            "user_message",
            { message: "Start a fresh request." },
            2_000,
          ),
          seq: 11,
        },
        {
          ...makeEvent(
            "new-handoff-same-ms",
            "agent_message",
            {
              messageId: "new-handoff-same-ms",
              senderLabel: "Atlas",
              recipientLabel: "Scribe",
              targetTaskId: "scribe-task",
              message: "Review the new request.",
              deliveryStatus: "queued",
            },
            2_000,
          ),
          seq: 12,
        },
      ],
    });

    expect(projection.handoffs.map((handoff) => handoff.id)).toEqual(["new-handoff-same-ms"]);
  });

  it("does not carry a previous-turn delivery failure or timeout into a fresh request", () => {
    const projection = deriveBotConversationProjection({
      task: baseTask,
      botName: "Atlas",
      events: [
        makeEvent(
          "old-failure",
          "agent_message",
          {
            messageId: "old-failure",
            senderType: "agent",
            deliveryMode: "message",
            botTeamId: "team-1",
            targetTaskId: "scribe-task",
            senderLabel: "Atlas",
            recipientLabel: "Scribe",
            message: "Review the old draft.",
            deliveryStatus: "failed",
            replyStatus: "timed_out",
            error: "Scribe was unavailable",
          },
          1_000,
        ),
        makeEvent("new-human-turn", "user_message", { message: "Start a fresh request." }, 2_000),
      ],
    });

    expect(projection.state).toBe("working");
    expect(projection.activityLabel).toBe("Working on the latest request");
    expect(projection.attention).toBeNull();
  });

  it("scopes collaborators and child teammates to the current human turn", () => {
    const projection = deriveBotConversationProjection({
      task: { ...baseTask, id: "atlas-task" },
      botName: "Atlas",
      events: [
        makeEvent(
          "old-handoff",
          "agent_message",
          {
            messageId: "old-handoff",
            senderType: "agent",
            deliveryMode: "message",
            deliveryStatus: "delivered",
            botTeamId: "team-1",
            targetTaskId: "forge-task",
            senderLabel: "Atlas",
            recipientLabel: "Forge",
            message: "Review the old request.",
          },
          1_000,
        ),
        makeEvent("new-human-turn", "user_message", { message: "Start a fresh request." }, 2_000),
        makeEvent(
          "new-handoff",
          "agent_message",
          {
            messageId: "new-handoff",
            senderType: "agent",
            deliveryMode: "message",
            deliveryStatus: "delivered",
            botTeamId: "team-1",
            targetTaskId: "scribe-task",
            senderLabel: "Atlas",
            recipientLabel: "Scribe",
            message: "Review the new request.",
          },
          2_100,
        ),
      ],
      childTasks: [
        {
          id: "forge-task",
          title: "Forge",
          status: "completed",
          assignedAgentRoleId: "forge",
          createdAt: 1_000,
        },
        {
          id: "scribe-task",
          title: "Scribe",
          status: "executing",
          assignedAgentRoleId: "scribe",
          createdAt: 2_100,
        },
      ],
    });

    expect(projection.collaborators).toEqual(["Scribe"]);
    expect(projection.teammates).toEqual([
      { id: "scribe-task", label: "Scribe", state: "working", detail: "Working" },
    ]);
  });

  it("does not show a cancelled conversation waiting on a teammate", () => {
    const projection = deriveBotConversationProjection({
      task: {
        status: "cancelled",
        error: null,
        resultSummary: "The partial result is still available.",
      },
      botName: "Atlas",
      events: [
        makeEvent("cancelled-handoff", "agent_message", {
          messageId: "cancelled-handoff",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "scribe-task",
          recipientLabel: "Scribe",
          message: "Review the partial result.",
        }),
      ],
    });

    expect(projection.state).toBe("completed");
    expect(projection.stateLabel).toBe("Finished");
  });
});
