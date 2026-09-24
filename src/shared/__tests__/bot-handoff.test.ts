import { describe, expect, it } from "vitest";

import {
  buildFreshBotHandoffPrompt,
  getCurrentBotHandoffScope,
  getCurrentBotHandoffScopeStart,
  getOutstandingBotHandoffReply,
  getPendingBotHandoff,
} from "../bot-handoff";
import type { TaskEvent } from "../types";

function event(
  id: string,
  type: TaskEvent["type"],
  payload: Record<string, unknown>,
  timestamp: number,
): TaskEvent {
  return { id, taskId: "task-1", type, payload, timestamp, schemaVersion: 2 };
}

describe("buildFreshBotHandoffPrompt", () => {
  it("creates an explicit model-only boundary for each teammate request", () => {
    const prompt = buildFreshBotHandoffPrompt(
      "Find three current launch communities and return verified links.",
      "Atlas",
      "atlas-task",
    );

    expect(prompt).toContain("[NEW TEAMMATE HANDOFF]");
    expect(prompt).toContain("from Atlas");
    expect(prompt).toContain("archived reference only");
    expect(prompt).toContain("Find three current launch communities");
    expect(prompt).toContain('task_id="atlas-task"');
    expect(prompt).toContain("Do not default to Atlas unless Atlas is the requester");
  });

  it("marks correlated teammate replies as receipts that must not be answered", () => {
    const prompt = buildFreshBotHandoffPrompt(
      "Package verification is complete.",
      "Scribe",
      "scribe-task",
      {
        inReplyToMessageId: "handoff-1",
        inReplyToTaskId: "atlas-task",
      },
    );

    expect(prompt).toContain("[CORRELATED TEAM REPLY]");
    expect(prompt).toContain("delivery receipt");
    expect(prompt).toContain("No teammate reply is required");
    expect(prompt).not.toContain('task_id="scribe-task"');
  });

  it("finds an inbound teammate handoff until a correlated reply is durable", () => {
    const inbound = event(
      "inbound-1",
      "user_message",
      {
        messageId: "inbound-1",
        messageSource: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        senderTaskId: "atlas-task",
        senderLabel: "Atlas",
        message: "Find five current opportunities.",
      },
      1,
    );

    expect(getOutstandingBotHandoffReply([inbound])).toMatchObject({
      inboundMessageId: "inbound-1",
      senderTaskId: "atlas-task",
      senderLabel: "Atlas",
    });

    const reply = event(
      "reply-1",
      "agent_message",
      {
        messageId: "reply-1",
        deliveryMode: "message",
        deliveryStatus: "queued",
        inReplyToMessageId: "inbound-1",
        targetTaskId: "atlas-task",
      },
      2,
    );
    expect(getOutstandingBotHandoffReply([inbound, reply])).toBeNull();
  });

  it("does not consume a second request as the reply to an earlier correlated reply", () => {
    const firstRequest = event(
      "request-1",
      "user_message",
      {
        messageId: "request-1",
        messageSource: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        senderTaskId: "cco-task",
        message: "Check the package name.",
      },
      1,
    );
    const firstReply = event(
      "reply-1",
      "agent_message",
      {
        messageId: "reply-1",
        senderType: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        botTeamId: "team-1",
        targetTaskId: "cco-task",
        inReplyToMessageId: "request-1",
        message: "Package check complete.",
      },
      2,
    );
    const secondRequest = event(
      "request-2",
      "user_message",
      {
        messageId: "request-2",
        messageSource: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        senderTaskId: "cco-task",
        message: "Calculate 7 times 3.5.",
      },
      3,
    );

    expect(getCurrentBotHandoffScope([firstRequest, firstReply, secondRequest])).toMatchObject({
      sinceTimestamp: 3,
    });
    expect(getOutstandingBotHandoffReply([firstRequest, firstReply, secondRequest])).toMatchObject({
      inboundMessageId: "request-2",
      senderTaskId: "cco-task",
    });
  });

  it("does not turn a direct reply receipt into a new teammate request", () => {
    const events = [
      event("prompt", "user_message", { message: "Delegate the research." }, 1),
      event(
        "handoff-1",
        "agent_message",
        {
          messageId: "handoff-1",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "scribe-task",
          replyStatus: "received",
          replyMessageId: "reply-1",
        },
        2,
      ),
      // This is the receiver-side copy written by delivery. Older copies did
      // not include inReplyToMessageId, so the sender projection is required.
      event(
        "reply-1",
        "user_message",
        {
          messageId: "reply-1",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          senderTaskId: "scribe-task",
          senderLabel: "Scribe",
          message: "Here are the verified findings.",
        },
        3,
      ),
    ];

    expect(getCurrentBotHandoffScopeStart(events)).toBe(1);
    expect(getPendingBotHandoff(events)).toBeNull();
    expect(getOutstandingBotHandoffReply(events)).toBeNull();
  });

  it("ignores a receiver-side reply when its receipt carries direct correlation", () => {
    const inboundReply = event(
      "reply-2",
      "user_message",
      {
        messageId: "reply-2",
        messageSource: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        senderTaskId: "scribe-task",
        inReplyToMessageId: "handoff-2",
        inReplyToTaskId: "atlas-task",
        message: "The source-backed result is ready.",
      },
      2,
    );

    expect(getCurrentBotHandoffScopeStart([inboundReply])).toBeUndefined();
    expect(getOutstandingBotHandoffReply([inboundReply])).toBeNull();
  });

  it("does not treat a queued receiver receipt as a received reply", () => {
    const events = [
      event("prompt", "user_message", { message: "Delegate the research." }, 1),
      event(
        "handoff-queued-reply",
        "agent_message",
        {
          messageId: "handoff-queued-reply",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "scribe-task",
          recipientLabel: "Scribe",
          replyStatus: "pending",
          message: "Return the source-backed result.",
        },
        2,
      ),
      event(
        "reply-queued",
        "user_message",
        {
          messageId: "reply-queued",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "queued",
          senderTaskId: "scribe-task",
          inReplyToMessageId: "handoff-queued-reply",
          inReplyToTaskId: "atlas-task",
          message: "The result is queued for Atlas.",
        },
        3,
      ),
    ];

    expect(getPendingBotHandoff(events)).toMatchObject({
      messageId: "handoff-queued-reply",
      recipientTaskId: "scribe-task",
    });
  });

  it("does not require a reply before an inbound receipt is delivered", () => {
    for (const deliveryStatus of ["queued", "started"] as const) {
      const events = [
        event("prompt", "user_message", { message: "Handle the handoff." }, 1),
        event(
          `inbound-${deliveryStatus}`,
          "user_message",
          {
            messageId: `inbound-${deliveryStatus}`,
            messageSource: "agent",
            deliveryMode: "message",
            deliveryStatus,
            senderTaskId: "atlas-task",
            senderLabel: "Atlas",
            message: "The request has not been incorporated yet.",
          },
          2,
        ),
      ];

      expect(getOutstandingBotHandoffReply(events)).toBeNull();
    }
  });

  it("correlates legacy receiver receipts without an in-reply-to field", () => {
    const events = [
      event("prompt", "user_message", { message: "Delegate the research." }, 1),
      event(
        "handoff-legacy",
        "agent_message",
        {
          messageId: "handoff-legacy",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "scribe-task",
          recipientLabel: "Scribe",
          replyStatus: "pending",
          message: "Find the source-backed result.",
        },
        2,
      ),
      event(
        "legacy-reply",
        "user_message",
        {
          messageId: "legacy-reply",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          senderTaskId: "scribe-task",
          senderLabel: "Scribe",
          message: "The source-backed result is ready.",
        },
        3,
      ),
    ];

    expect(getPendingBotHandoff(events)).toBeNull();
    expect(getCurrentBotHandoffScopeStart(events)).toBe(1);
    expect(getOutstandingBotHandoffReply(events)).toBeNull();
  });

  it("does not consume a reply from a different teammate", () => {
    const events = [
      event(
        "handoff-forge",
        "agent_message",
        {
          messageId: "handoff-forge",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "forge-task",
          recipientLabel: "Forge",
          message: "Inspect the repository.",
        },
        1,
      ),
      event(
        "reply-from-scribe",
        "user_message",
        {
          messageId: "reply-from-scribe",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          senderTaskId: "scribe-task",
          senderLabel: "Scribe",
          message: "A different teammate replied.",
        },
        2,
      ),
    ];

    expect(getPendingBotHandoff(events, { sinceTimestamp: 0 })).toMatchObject({
      messageId: "handoff-forge",
      recipientTaskId: "forge-task",
    });
  });

  it("projects the coordinator's pending bot-team handoff without treating failure as pending", () => {
    const handoff = event(
      "handoff-1",
      "agent_message",
      {
        messageId: "handoff-1",
        senderType: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        botTeamId: "team-1",
        targetTaskId: "forge-task",
        recipientLabel: "Forge",
        message: "Research developer opportunities.",
      },
      1,
    );
    expect(getPendingBotHandoff([handoff])).toMatchObject({
      messageId: "handoff-1",
      recipientTaskId: "forge-task",
      recipientLabel: "Forge",
      deliveryStatus: "delivered",
    });

    expect(
      getPendingBotHandoff([
        {
          ...handoff,
          payload: { ...handoff.payload, deliveryStatus: "failed" },
        },
      ]),
    ).toBeNull();
  });

  it("uses event time when reconciling repeated handoff receipts", () => {
    const accepted = event(
      "handoff-order-accepted",
      "agent_message",
      {
        messageId: "handoff-order",
        senderType: "agent",
        deliveryMode: "message",
        deliveryStatus: "accepted",
        botTeamId: "team-1",
        targetTaskId: "forge-task",
        recipientLabel: "Forge",
        message: "Inspect the repository.",
      },
      1,
    );
    const failed = event(
      "handoff-order-failed",
      "agent_message",
      {
        ...accepted.payload,
        deliveryStatus: "failed",
        error: "The recipient task stopped before delivery.",
      },
      2,
    );

    expect(getPendingBotHandoff([failed, accepted])).toBeNull();
  });

  it("uses the durable sequence when receipts share an event timestamp", () => {
    const accepted = {
      ...event(
        "handoff-same-ms-accepted",
        "agent_message",
        {
          messageId: "handoff-same-ms",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "accepted",
          botTeamId: "team-1",
          targetTaskId: "forge-task",
          recipientLabel: "Forge",
          message: "Inspect the repository.",
        },
        1_000,
      ),
      seq: 10,
    };
    const failed = {
      ...event(
        "handoff-same-ms-failed",
        "agent_message",
        {
          ...accepted.payload,
          deliveryStatus: "failed",
          error: "The recipient task stopped before delivery.",
        },
        1_000,
      ),
      seq: 11,
    };

    expect(getPendingBotHandoff([failed, accepted])).toBeNull();
  });

  it("uses the durable sequence when a new human turn shares its timestamp with an old handoff", () => {
    const oldHandoff = {
      ...event(
        "old-handoff-same-ms",
        "agent_message",
        {
          messageId: "old-handoff-same-ms",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "forge-task",
          recipientLabel: "Forge",
          message: "Old request",
        },
        2_000,
      ),
      seq: 10,
    };
    const newHumanTurn = {
      ...event(
        "new-human-turn-same-ms",
        "user_message",
        { message: "Start a fresh request." },
        2_000,
      ),
      seq: 11,
    };
    const newHandoff = {
      ...event(
        "new-handoff-same-ms",
        "agent_message",
        {
          messageId: "new-handoff-same-ms",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "scribe-task",
          recipientLabel: "Scribe",
          message: "New request",
        },
        2_000,
      ),
      seq: 12,
    };

    expect(getCurrentBotHandoffScope([oldHandoff, newHumanTurn, newHandoff])).toMatchObject({
      sinceTimestamp: 2_000,
      sinceTaskId: "task-1",
      sinceSeq: 11,
    });
    expect(getPendingBotHandoff([newHandoff, newHumanTurn, oldHandoff])).toMatchObject({
      messageId: "new-handoff-same-ms",
      recipientLabel: "Scribe",
    });
  });

  it("does not correlate a same-millisecond reply that preceded the handoff", () => {
    const earlierReply = {
      ...event(
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
    const handoff = {
      ...event(
        "handoff-same-ms-reply",
        "agent_message",
        {
          messageId: "handoff-same-ms-reply",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "scribe-task",
          recipientLabel: "Scribe",
          message: "The current request.",
        },
        3_000,
      ),
      seq: 10,
    };

    expect(getPendingBotHandoff([earlierReply, handoff])).toMatchObject({
      messageId: "handoff-same-ms-reply",
    });

    const laterReply = {
      ...event(
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

    expect(getPendingBotHandoff([earlierReply, handoff, laterReply])).toBeNull();
  });

  it("returns durable receipt timestamps and excludes a timed-out reply from waiting", () => {
    const handoff = event(
      "handoff-timeout",
      "agent_message",
      {
        messageId: "handoff-timeout",
        senderType: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        botTeamId: "team-1",
        targetTaskId: "forge-task",
        recipientLabel: "Forge",
        message: "Inspect the repository.",
        acceptedAt: 10,
        queuedAt: 11,
        startedAt: 12,
        deliveredAt: 13,
      },
      13,
    );

    expect(getPendingBotHandoff([handoff])).toMatchObject({
      acceptedAt: 10,
      queuedAt: 11,
      startedAt: 12,
      deliveredAt: 13,
    });
    expect(
      getPendingBotHandoff([
        {
          ...handoff,
          payload: { ...handoff.payload, replyStatus: "timed_out" },
        },
      ]),
    ).toBeNull();
  });

  it("ignores stale pending handoffs when a new human turn starts", () => {
    const events = [
      event(
        "old-handoff",
        "agent_message",
        {
          messageId: "old-handoff",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "old-teammate",
          recipientLabel: "Old teammate",
          message: "Old request",
        },
        1,
      ),
      event("new-turn", "user_message", { message: "Start a fresh request." }, 10),
      event(
        "new-handoff",
        "agent_message",
        {
          messageId: "new-handoff",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "new-teammate",
          recipientLabel: "New teammate",
          message: "New request",
        },
        11,
      ),
    ];

    expect(getCurrentBotHandoffScopeStart(events)).toBe(10);
    expect(getPendingBotHandoff(events)).toMatchObject({
      messageId: "new-handoff",
      recipientLabel: "New teammate",
    });
  });

  it("uses a fresh inbound teammate message as the child turn boundary", () => {
    const events = [
      event(
        "old-handoff",
        "agent_message",
        {
          messageId: "old-handoff",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "old-teammate",
          recipientLabel: "Old teammate",
          message: "Old request",
        },
        5,
      ),
      event(
        "inbound",
        "user_message",
        {
          messageId: "inbound",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          senderTaskId: "atlas-task",
          senderLabel: "Atlas",
          message: "Fresh request",
        },
        10,
      ),
    ];

    expect(getCurrentBotHandoffScopeStart(events)).toBe(10);
    expect(getPendingBotHandoff(events)).toBeNull();
    expect(getOutstandingBotHandoffReply(events)).toMatchObject({
      inboundMessageId: "inbound",
      senderTaskId: "atlas-task",
    });
  });

  it("keeps the parent turn open while another teammate reply is still pending", () => {
    const events = [
      event("prompt", "user_message", { message: "Delegate two requests." }, 10),
      event(
        "scribe-handoff",
        "agent_message",
        {
          messageId: "scribe-handoff",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "scribe-task",
          recipientLabel: "Scribe",
          message: "Community research",
        },
        11,
      ),
      event(
        "product-handoff",
        "agent_message",
        {
          messageId: "product-handoff",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "product-task",
          recipientLabel: "Product Engineer",
          message: "Developer research",
        },
        12,
      ),
      event(
        "scribe-reply-inbound",
        "user_message",
        {
          messageId: "scribe-reply-inbound",
          messageSource: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          senderTaskId: "scribe-task",
          senderLabel: "Scribe",
          message: "Community findings",
        },
        13,
      ),
      event(
        "scribe-reply",
        "agent_message",
        {
          messageId: "scribe-reply",
          senderType: "agent",
          deliveryMode: "message",
          deliveryStatus: "delivered",
          botTeamId: "team-1",
          targetTaskId: "atlas-task",
          recipientLabel: "Atlas",
          message: "Community findings",
          inReplyToMessageId: "scribe-handoff",
        },
        14,
      ),
    ];

    expect(getCurrentBotHandoffScopeStart(events)).toBe(10);
    expect(getPendingBotHandoff(events)).toMatchObject({
      messageId: "product-handoff",
      recipientLabel: "Product Engineer",
    });
  });
});
