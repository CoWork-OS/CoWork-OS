import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import { AgentDaemon, BOT_HANDOFF_REPLY_TIMEOUT_MS } from "../daemon";
import type { TaskEvent } from "../../../shared/types";
import { getOutstandingBotHandoffReply, getPendingBotHandoff } from "../../../shared/bot-handoff";
import { QueuedAttachmentStore } from "../runtime/queued-attachment-store";

type Any = Record<string, any>;

function makeEvent(id: string, taskId: string, type: TaskEvent["type"], payload: Any): TaskEvent {
  return {
    id,
    taskId,
    type,
    timestamp: 1,
    payload,
    schemaVersion: 2,
  } as TaskEvent;
}

describe("AgentDaemon agent-message receipts", () => {
  it("returns the repaired bot-team identity with messaging authorization", () => {
    const task = {
      id: "bot-task",
      agentConfig: { botConversation: true },
    };
    const normalizedTask = {
      ...task,
      agentConfig: { botConversation: true, botTeamId: "team-1" },
    };
    const daemonLike = {
      taskRepo: { findById: vi.fn().mockReturnValue(task) },
      ensureBotTaskTeam: vi.fn().mockReturnValue(normalizedTask),
      getBotTeamContext: vi.fn().mockReturnValue({ team: { id: "team-1" } }),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    expect(
      (AgentDaemon.prototype as Any).getBotConversationMessagingContext.call(
        daemonLike,
        "bot-task",
      ),
    ).toEqual({
      authorized: true,
      botTeamId: "team-1",
    });
  });

  it("wakes a dormant bot through the accepted-message drain instead of its seed prompt", () => {
    const executor = { isRunning: false };
    const processOrphanedFollowUps = vi.fn();
    const startTask = vi.fn();
    const task = {
      id: "bot-task",
      status: "pending",
    };
    const daemonLike = {
      activeTasks: new Map([[task.id, { executor }]]),
      taskRepo: { findById: vi.fn().mockReturnValue(task) },
      processOrphanedFollowUps,
      startTask,
      logEvent: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    (AgentDaemon.prototype as Any).wakeBotConversationAfterAccepted.call(
      daemonLike,
      task,
      "bot-message-1",
      "parent-task",
    );

    expect(processOrphanedFollowUps).toHaveBeenCalledWith(task.id, executor);
    expect(startTask).not.toHaveBeenCalled();
  });

  it("holds a coordinator at the handoff boundary until its teammate replies", () => {
    const update = vi.fn();
    const logEvent = vi.fn();
    const daemonLike = {
      taskRepo: { update },
      logEvent,
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const handoffEvents = [
      makeEvent("handoff-1", "atlas-task", "agent_message", {
        messageId: "handoff-1",
        senderType: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        botTeamId: "team-1",
        targetTaskId: "forge-task",
        recipientLabel: "Forge",
        message: "Research the developer opportunities.",
      }),
    ];
    expect(getPendingBotHandoff(handoffEvents)).not.toBeNull();

    const result = (AgentDaemon.prototype as Any).reconcileBotHandoffBeforeCompletion.call(
      daemonLike,
      {
        id: "atlas-task",
        status: "executing",
        agentConfig: { botConversation: true },
      },
      handoffEvents,
      "Partial research",
    );

    expect(result).toEqual({ deferred: true, replySent: false });
    expect(update).toHaveBeenCalledWith(
      "atlas-task",
      expect.objectContaining({
        status: "blocked",
        error: "Waiting for Forge to reply before finishing this conversation.",
        resultSummary: "Partial research",
      }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "atlas-task",
      "task_status",
      expect.objectContaining({ botHandoffWaiting: true }),
    );
  });

  it("marks a handoff timed out when the recipient is already terminal", () => {
    const update = vi.fn();
    const logEvent = vi.fn();
    const updatePayloadById = vi.fn();
    const emitTaskEvent = vi.fn();
    const handoffEvents = [
      makeEvent("handoff-terminal", "atlas-task", "agent_message", {
        messageId: "handoff-terminal",
        senderType: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        botTeamId: "team-1",
        targetTaskId: "forge-task",
        recipientLabel: "Forge",
        message: "Inspect the repository.",
        acceptedAt: Date.now(),
      }),
    ];
    const daemonLike = {
      taskRepo: {
        update,
        findById: vi.fn().mockReturnValue({
          id: "forge-task",
          status: "completed",
          completedAt: Date.now(),
        }),
      },
      eventRepo: { updatePayloadById },
      emitTaskEvent,
      logEvent,
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const result = (AgentDaemon.prototype as Any).reconcileBotHandoffBeforeCompletion.call(
      daemonLike,
      {
        id: "atlas-task",
        status: "executing",
        agentConfig: { botConversation: true, botTeamId: "team-1" },
      },
      handoffEvents,
      "Partial repository inspection",
    );

    expect(result).toEqual({ deferred: false, replySent: false });
    expect(update).not.toHaveBeenCalled();
    expect(updatePayloadById).toHaveBeenCalledWith(
      "handoff-terminal",
      expect.objectContaining({
        replyStatus: "timed_out",
        failureCode: "BOT_HANDOFF_REPLY_TIMEOUT",
      }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "atlas-task",
      "log",
      expect.objectContaining({
        metric: "bot_handoff_reply_timeout",
        recipientTaskId: "forge-task",
        partialResultAvailable: true,
      }),
    );
    expect(getPendingBotHandoff(handoffEvents)).toBeNull();
  });

  it("preserves a partial result after a live recipient exceeds the reply timeout", () => {
    const updatePayloadById = vi.fn();
    const emitTaskEvent = vi.fn();
    const logEvent = vi.fn();
    const handoffEvents = [
      makeEvent("handoff-aged", "atlas-task", "agent_message", {
        messageId: "handoff-aged",
        senderType: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        botTeamId: "team-1",
        targetTaskId: "scribe-task",
        recipientLabel: "Scribe",
        message: "Prepare a source-backed summary.",
        acceptedAt: Date.now() - BOT_HANDOFF_REPLY_TIMEOUT_MS - 1,
      }),
    ];
    const daemonLike = {
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "scribe-task",
          status: "executing",
          completedAt: undefined,
        }),
      },
      eventRepo: { updatePayloadById },
      emitTaskEvent,
      logEvent,
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const result = (AgentDaemon.prototype as Any).reconcileBotHandoffBeforeCompletion.call(
      daemonLike,
      {
        id: "atlas-task",
        status: "executing",
        agentConfig: { botConversation: true, botTeamId: "team-1" },
      },
      handoffEvents,
      "Partial source summary",
    );

    expect(result).toEqual({ deferred: false, replySent: false });
    expect(updatePayloadById).toHaveBeenCalledWith(
      "handoff-aged",
      expect.objectContaining({ replyStatus: "timed_out" }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "atlas-task",
      "log",
      expect.objectContaining({ metric: "bot_handoff_reply_timeout" }),
    );
  });

  it("sends a durable blocked reply when a teammate would otherwise finish silently", () => {
    const queueMessageOnly = vi.fn().mockReturnValue({
      queued: true,
      messageId: "fallback-1",
      deliveryMode: "message",
      deliveryStatus: "queued",
      acceptedAt: 20,
      queuedAt: 20,
    });
    const markBotHandoffReplied = vi.fn();
    const logEvent = vi.fn();
    const sender = {
      id: "atlas-task",
      title: "Atlas",
      agentConfig: { botConversation: true, botTeamId: "team-1" },
    };
    const daemonLike = {
      taskRepo: { findById: vi.fn().mockReturnValue(sender) },
      canDeliverBotMessageBetween: vi.fn().mockReturnValue(true),
      queueMessageOnly,
      markBotHandoffReplied,
      logEvent,
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const inboundEvents = [
      makeEvent("inbound-1", "scribe-task", "user_message", {
        messageId: "inbound-1",
        messageSource: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        senderTaskId: "atlas-task",
        senderLabel: "Atlas",
        message: "Find current opportunities.",
      }),
    ];
    expect(getOutstandingBotHandoffReply(inboundEvents)).not.toBeNull();

    const result = (AgentDaemon.prototype as Any).reconcileBotHandoffBeforeCompletion.call(
      daemonLike,
      {
        id: "scribe-task",
        title: "Scribe",
        status: "executing",
        agentConfig: { botConversation: true, botTeamId: "team-1" },
      },
      inboundEvents,
      "No verified sources were produced.",
    );

    expect(result).toEqual({ deferred: false, replySent: true });
    expect(queueMessageOnly).toHaveBeenCalledWith(
      sender,
      expect.stringContaining("BLOCKED:"),
      undefined,
      undefined,
      expect.objectContaining({
        deliveryMode: "message",
        messageSource: "agent",
        senderTaskId: "scribe-task",
        inReplyToMessageId: "inbound-1",
        inReplyToTaskId: "atlas-task",
        startAfterAccepted: true,
      }),
    );
    expect(markBotHandoffReplied).toHaveBeenCalledWith(
      "atlas-task",
      "inbound-1",
      "scribe-task",
      "scribe-task",
      expect.any(String),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "scribe-task",
      "agent_message",
      expect.objectContaining({
        replyKind: "automatic_blocked_fallback",
        deliveryStatus: "queued",
      }),
    );
  });

  it("does not send a blocked fallback for a durable teammate result", () => {
    const queueMessageOnly = vi.fn();
    const logEvent = vi.fn();
    const daemonLike = {
      taskRepo: { findById: vi.fn() },
      queueMessageOnly,
      logEvent,
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const events = [
      makeEvent("prompt", "atlas-task", "user_message", {
        message: "Delegate the research.",
      }),
      makeEvent("handoff-1", "atlas-task", "agent_message", {
        messageId: "handoff-1",
        senderType: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        botTeamId: "team-1",
        targetTaskId: "scribe-task",
        replyStatus: "received",
        replyMessageId: "reply-1",
      }),
      // Receiver-side durable copy from an older delivery path. It has no
      // inReplyTo field, but the originating handoff projection does.
      makeEvent("reply-1", "scribe-task", "user_message", {
        messageId: "reply-1",
        messageSource: "agent",
        deliveryMode: "message",
        deliveryStatus: "delivered",
        senderTaskId: "scribe-task",
        senderLabel: "Scribe",
        message: "Verified findings are ready.",
      }),
    ];

    const result = (AgentDaemon.prototype as Any).reconcileBotHandoffBeforeCompletion.call(
      daemonLike,
      {
        id: "atlas-task",
        title: "Atlas",
        status: "executing",
        agentConfig: { botConversation: true, botTeamId: "team-1" },
      },
      events,
      "Verified findings are ready.",
    );

    expect(result).toEqual({ deferred: false, replySent: false });
    expect(queueMessageOnly).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("deduplicates a previously accepted queue-only message", () => {
    const prior = makeEvent("receipt-1", "child-task", "user_message", {
      messageId: "message-1",
      deliveryMode: "message",
      deliveryStatus: "queued",
      senderTaskId: "parent-task",
      acceptedAt: 10,
      queuedAt: 10,
    });
    const daemonLike = {
      getTaskEvents: vi.fn().mockReturnValue([prior]),
      activeTasks: new Map([
        [
          "child-task",
          {
            executor: {
              updateTaskAgentConfig: vi.fn(),
              updateWorkspace: vi.fn(),
              hasPendingFollowUpMessage: vi.fn().mockReturnValue(true),
            },
          },
        ],
      ]),
      workspaceRepo: {
        findById: vi.fn().mockReturnValue({
          id: "workspace-1",
          path: "/tmp/workspace",
          permissions: { read: true, write: true, delete: false, network: true, shell: false },
        }),
      },
      applyTaskWorkspaceOverridesForPath: vi.fn((_task: Any, workspace: Any) => workspace),
    } as Any;

    const result = (AgentDaemon.prototype as Any).queueMessageOnly.call(
      daemonLike,
      {
        id: "child-task",
      },
      "Please check the migration",
      undefined,
      undefined,
      {
        deliveryMode: "message",
        messageId: "message-1",
        senderTaskId: "parent-task",
      },
    );

    expect(result).toMatchObject({
      queued: true,
      duplicate: true,
      messageId: "message-1",
      deliveryStatus: "queued",
      acceptedAt: 10,
      queuedAt: 10,
    });
  });

  it("rejects reusing a message id for different content", () => {
    const prior = makeEvent("receipt-content", "child-task", "user_message", {
      message: "Original durable content",
      messageId: "message-content",
      deliveryMode: "message",
      deliveryStatus: "queued",
      senderTaskId: "parent-task",
    });
    const daemonLike = {
      getTaskEvents: vi.fn().mockReturnValue([prior]),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    expect(() =>
      AgentDaemon.prototype.queueMessageOnly.call(
        daemonLike,
        { id: "child-task" },
        "Different durable content",
        undefined,
        undefined,
        {
          deliveryMode: "message",
          messageId: "message-content",
          senderTaskId: "parent-task",
        },
      ),
    ).toThrow("already used for different content");
  });

  it("quarantines a queued handoff and projects the failure to its sender", () => {
    const targetReceipt = makeEvent("receipt-revoked", "child-task", "user_message", {
      message: "Do not deliver",
      messageId: "message-revoked",
      deliveryMode: "message",
      deliveryStatus: "queued",
      senderTaskId: "parent-task",
    });
    const parentActivity = makeEvent("activity-revoked", "parent-task", "agent_message", {
      messageId: "message-revoked",
      targetTaskId: "child-task",
      status: "queued",
      deliveryStatus: "queued",
    });
    const updatePayloadById = vi.fn((eventId: string, payload: Any) => {
      if (eventId === targetReceipt.id) targetReceipt.payload = payload;
      if (eventId === parentActivity.id) parentActivity.payload = payload;
    });
    const daemonLike = {
      getTaskEvents: vi.fn((taskId: string) =>
        taskId === "child-task" ? [targetReceipt] : [parentActivity],
      ),
      eventRepo: { updatePayloadById },
      emitTaskEvent: vi.fn(),
      releaseQueuedAttachmentRefs: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    expect(
      AgentDaemon.prototype.markQueuedAgentMessageFailed.call(
        daemonLike,
        "child-task",
        "message-revoked",
        "team membership revoked",
      ),
    ).toBe(true);
    expect(targetReceipt.payload).toMatchObject({
      status: "failed",
      deliveryStatus: "failed",
      error: "team membership revoked",
    });
    expect(parentActivity.payload).toMatchObject({
      status: "failed",
      deliveryStatus: "failed",
      error: "team membership revoked",
    });
  });

  it("uses a terminal quarantined state for authorization loss and does not deliver it later", () => {
    const targetReceipt = makeEvent("receipt-quarantined", "child-task", "user_message", {
      message: "Do not deliver after membership loss",
      messageId: "message-quarantined",
      deliveryMode: "message",
      deliveryStatus: "queued",
      senderTaskId: "parent-task",
    });
    const parentActivity = makeEvent("activity-quarantined", "parent-task", "agent_message", {
      messageId: "message-quarantined",
      targetTaskId: "child-task",
      status: "queued",
      deliveryStatus: "queued",
    });
    const updatePayloadById = vi.fn((eventId: string, payload: Any) => {
      if (eventId === targetReceipt.id) targetReceipt.payload = payload;
      if (eventId === parentActivity.id) parentActivity.payload = payload;
    });
    const daemonLike = {
      getTaskEvents: vi.fn((taskId: string) =>
        taskId === "child-task" ? [targetReceipt] : [parentActivity],
      ),
      eventRepo: { updatePayloadById },
      emitTaskEvent: vi.fn(),
      releaseQueuedAttachmentRefs: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    expect(
      AgentDaemon.prototype.markQueuedAgentMessageFailed.call(
        daemonLike,
        "child-task",
        "message-quarantined",
        "team membership revoked",
        { quarantined: true, failureCode: "BOT_MESSAGE_TEAM_AUTHORIZATION_REVOKED" },
      ),
    ).toBe(true);
    expect(targetReceipt.payload).toMatchObject({
      status: "quarantined",
      deliveryStatus: "quarantined",
      failureCode: "BOT_MESSAGE_TEAM_AUTHORIZATION_REVOKED",
    });
    expect(parentActivity.payload).toMatchObject({
      status: "quarantined",
      deliveryStatus: "quarantined",
    });
    expect(
      AgentDaemon.prototype.markQueuedAgentMessageDelivered.call(
        daemonLike,
        "child-task",
        "message-quarantined",
      ),
    ).toBe(false);
  });

  it("marks a handoff started before provider execution and projects that state to the sender", () => {
    const targetReceipt = makeEvent("receipt-started", "child-task", "user_message", {
      messageId: "message-started",
      deliveryMode: "message",
      deliveryStatus: "queued",
      senderTaskId: "parent-task",
    });
    const parentActivity = makeEvent("activity-started", "parent-task", "agent_message", {
      messageId: "message-started",
      targetTaskId: "child-task",
      status: "queued",
      deliveryStatus: "queued",
    });
    const updatePayloadById = vi.fn((eventId: string, payload: Any) => {
      if (eventId === targetReceipt.id) targetReceipt.payload = payload;
      if (eventId === parentActivity.id) parentActivity.payload = payload;
    });
    const daemonLike = {
      getTaskEvents: vi.fn((taskId: string) =>
        taskId === "child-task" ? [targetReceipt] : [parentActivity],
      ),
      eventRepo: { updatePayloadById },
      emitTaskEvent: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    expect(
      AgentDaemon.prototype.markQueuedAgentMessageStarted.call(
        daemonLike,
        "child-task",
        "message-started",
      ),
    ).toBe(true);
    expect(targetReceipt.payload).toMatchObject({
      status: "started",
      deliveryStatus: "started",
      attempt: 1,
      startedAt: expect.any(Number),
    });
    expect(parentActivity.payload).toMatchObject({
      status: "started",
      deliveryStatus: "started",
    });
  });

  it("persists opaque attachment refs before the queue-only receipt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cowork-daemon-attachments-"));
    try {
      const store = new QueuedAttachmentStore(path.join(root, "store"));
      const queueFollowUp = vi.fn();
      const logEvent = vi.fn();
      const task = {
        id: "child-task",
        workspaceId: "workspace-1",
        agentConfig: {},
      };
      const daemonLike = {
        queuedAttachmentStore: store,
        getTaskEvents: vi.fn().mockReturnValue([]),
        activeTasks: new Map([
          [
            "child-task",
            {
              executor: {
                updateTaskAgentConfig: vi.fn(),
                updateWorkspace: vi.fn(),
                queueFollowUp,
              },
            },
          ],
        ]),
        workspaceRepo: {
          findById: vi.fn().mockReturnValue({
            id: "workspace-1",
            path: "/tmp/workspace",
            permissions: { read: true, write: true, delete: false, network: true, shell: false },
          }),
        },
        applyTaskWorkspaceOverridesForPath: vi.fn((_task: Any, workspace: Any) => workspace),
        taskRepo: { touch: vi.fn() },
        logEvent,
      } as Any;
      Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

      const result = AgentDaemon.prototype.queueMessageOnly.call(
        daemonLike,
        task,
        "Inspect the image",
        [{ data: "aGVsbG8=", mimeType: "image/png", filename: "hello.png", sizeBytes: 5 }],
        undefined,
        { deliveryMode: "message", messageId: "image-message", messageSource: "agent" },
      );

      expect(result).toMatchObject({
        queued: true,
        messageId: "image-message",
        deliveryStatus: "queued",
      });
      const receipt = logEvent.mock.calls.find((call: Any[]) => call[1] === "user_message")[2];
      expect(receipt.correlationId).toBe("image-message");
      expect(receipt.queuedAttachmentRefs).toEqual([
        expect.objectContaining({
          key: expect.stringMatching(/^[0-9a-f-]{36}$/),
          mimeType: "image/png",
          sizeBytes: 5,
        }),
      ]);
      expect(receipt).not.toHaveProperty("images");
      expect(JSON.stringify(receipt)).not.toContain("aGVsbG8=");
      expect(queueFollowUp).toHaveBeenCalledWith(
        "Inspect the image",
        [expect.objectContaining({ filePath: expect.stringContaining(".png"), tempFile: false })],
        undefined,
        undefined,
        undefined,
        undefined,
        "agent",
        "image-message",
        undefined,
        undefined,
        "message",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates both the target receipt and parent activity when delivery begins", () => {
    const targetReceipt = makeEvent("receipt-1", "child-task", "user_message", {
      messageId: "message-2",
      deliveryMode: "message",
      deliveryStatus: "queued",
      senderTaskId: "parent-task",
    });
    const parentActivity = makeEvent("activity-1", "parent-task", "agent_message", {
      messageId: "message-2",
      targetTaskId: "child-task",
      status: "queued",
      deliveryStatus: "queued",
    });
    const updatePayloadById = vi.fn();
    const emitTaskEvent = vi.fn();
    const daemonLike = {
      getTaskEvents: vi.fn((taskId: string) =>
        taskId === "child-task" ? [targetReceipt] : [parentActivity],
      ),
      eventRepo: { updatePayloadById },
      emitTaskEvent,
    } as Any;

    AgentDaemon.prototype.markQueuedAgentMessageDelivered.call(
      daemonLike,
      "child-task",
      "message-2",
    );

    expect(updatePayloadById).toHaveBeenCalledTimes(2);
    expect(updatePayloadById).toHaveBeenNthCalledWith(
      1,
      "receipt-1",
      expect.objectContaining({ deliveryStatus: "delivered", deliveredAt: expect.any(Number) }),
    );
    expect(updatePayloadById).toHaveBeenNthCalledWith(
      2,
      "activity-1",
      expect.objectContaining({ status: "delivered", deliveryStatus: "delivered" }),
    );
    expect(emitTaskEvent).toHaveBeenCalledTimes(2);
  });

  it("releases durable attachment bytes only after the target receipt is delivered", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cowork-daemon-attachments-"));
    try {
      const store = new QueuedAttachmentStore(path.join(root, "store"));
      const persisted = store.persist("child-task", "delivered-image", [
        { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
      ]);
      const receipt = makeEvent("receipt-cleanup", "child-task", "user_message", {
        messageId: "delivered-image",
        deliveryMode: "message",
        deliveryStatus: "queued",
        queuedAttachmentRefs: persisted.refs,
      });
      const daemonLike = {
        queuedAttachmentStore: store,
        getTaskEvents: vi.fn().mockReturnValue([receipt]),
        eventRepo: { updatePayloadById: vi.fn() },
        emitTaskEvent: vi.fn(),
      } as Any;
      Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

      expect(
        AgentDaemon.prototype.markQueuedAgentMessageDelivered.call(
          daemonLike,
          "child-task",
          "delivered-image",
        ),
      ).toBe(true);
      expect(existsSync(persisted.images[0].filePath!)).toBe(false);
      expect(daemonLike.eventRepo.updatePayloadById).toHaveBeenCalledWith(
        receipt.id,
        expect.objectContaining({ deliveryStatus: "delivered" }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures validated deletion refs before DB removal and releases them afterward", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cowork-daemon-attachments-"));
    try {
      const store = new QueuedAttachmentStore(path.join(root, "store"));
      const persisted = store.persist("deleted-task", "queued-image", [
        { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
      ]);
      const receipt = makeEvent("receipt-delete-after-db", "deleted-task", "user_message", {
        messageId: "queued-image",
        deliveryMode: "message",
        deliveryStatus: "queued",
        queuedAttachmentRefs: persisted.refs,
      });
      const daemonLike = {
        queuedAttachmentStore: store,
        getTaskEvents: vi.fn().mockReturnValue([receipt]),
      } as Any;
      Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

      const captured = daemonLike.captureQueuedAttachmentRefsForTask("deleted-task");
      expect(captured).toHaveLength(1);
      expect(existsSync(persisted.images[0].filePath!)).toBe(true);

      daemonLike.releaseCapturedQueuedAttachmentRefs("deleted-task", captured);
      expect(existsSync(persisted.images[0].filePath!)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a queue-only message retryable when preflight fails before acceptance", async () => {
    const targetReceipt = makeEvent("receipt-preflight", "child-task", "user_message", {
      messageId: "message-preflight",
      deliveryMode: "message",
      deliveryStatus: "queued",
      senderTaskId: "parent-task",
    });
    const followUp = {
      message: "Retry after the workspace is available",
      deliveryMode: "message",
      messageSource: "agent",
      messageId: "message-preflight",
      senderTaskId: "parent-task",
    };
    const requeueFollowUpAtTurnBoundary = vi.fn();
    const queue = [followUp];
    const executor = {
      isRunning: false,
      takeNextFollowUpAtTurnBoundary: vi.fn(() => queue.shift()),
      runtime: { requeueFollowUpAtTurnBoundary },
      suppressNextUserMessageEvent: vi.fn(),
    };
    const updatePayloadById = vi.fn();
    const daemonLike = {
      drainingFollowUps: new Set<string>(),
      getTaskEvents: vi.fn().mockReturnValue([targetReceipt]),
      logEvent: vi.fn(),
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "child-task",
          title: "Child",
          prompt: "Prompt",
          workspaceId: "missing-workspace",
          agentConfig: {},
        }),
      },
      workspaceRepo: { findById: vi.fn().mockReturnValue(undefined) },
      activeTasks: new Map([["child-task", { executor }]]),
      eventRepo: { updatePayloadById },
      isSideChatTask: vi.fn().mockReturnValue(false),
      buildSideChatTurnAgentConfigOverride: vi.fn().mockReturnValue(undefined),
      applyTaskFollowUpOverrides: vi.fn((task: Any) => ({ changed: false, task })),
      applyAgentRoleOverrides: vi.fn((task: Any) => ({ task })),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    AgentDaemon.prototype.processOrphanedFollowUps.call(daemonLike, "child-task", executor);

    await vi.waitFor(() => expect(requeueFollowUpAtTurnBoundary).toHaveBeenCalledTimes(1));
    expect(requeueFollowUpAtTurnBoundary).toHaveBeenCalledWith(followUp);
    expect(updatePayloadById).toHaveBeenCalledWith(
      "receipt-preflight",
      expect.objectContaining({
        status: "started",
        deliveryStatus: "started",
        attempt: 1,
      }),
    );
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "child-task",
      "error",
      expect.objectContaining({ message: "Queued follow-up failed" }),
    );
  });

  it("records acceptance before execution failure and suppresses a restart retry", async () => {
    const targetReceipt = makeEvent("receipt-execution", "child-task", "user_message", {
      messageId: "message-execution",
      deliveryMode: "message",
      deliveryStatus: "queued",
      senderTaskId: "parent-task",
      acceptedAt: 10,
      queuedAt: 10,
    });
    const parentActivity = makeEvent("activity-execution", "parent-task", "agent_message", {
      messageId: "message-execution",
      targetTaskId: "child-task",
      status: "queued",
      deliveryStatus: "queued",
    });
    const updatePayloadById = vi.fn((eventId: string, payload: Any) => {
      if (eventId === targetReceipt.id) targetReceipt.payload = payload;
      if (eventId === parentActivity.id) parentActivity.payload = payload;
    });
    const executorCallOrder: string[] = [];
    const sendMessage = vi.fn().mockImplementation(async (...args: Any[]) => {
      executorCallOrder.push("executor-start");
      await args[3]?.onAccepted?.();
      executorCallOrder.push("accepted");
      throw new Error("provider failed after handoff");
    });
    const executor = {
      isRunning: false,
      sendMessage,
      suppressNextUserMessageEvent: vi.fn(),
      updateTaskAgentConfig: vi.fn(),
      updateWorkspace: vi.fn(),
    };
    const task = {
      id: "child-task",
      title: "Child",
      prompt: "Prompt",
      workspaceId: "workspace-1",
      agentConfig: {},
    };
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace",
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
      createdAt: 1,
    };
    const daemonLike = {
      activeTasks: new Map([["child-task", { executor, lastAccessed: 0, status: "active" }]]),
      taskRepo: {
        findById: vi.fn().mockReturnValue(task),
        touch: vi.fn(),
      },
      workspaceRepo: { findById: vi.fn().mockReturnValue(workspace) },
      annotationRepo: { listOpenByTask: vi.fn().mockReturnValue([]) },
      getTaskEvents: vi.fn((taskId: string) =>
        taskId === "child-task" ? [targetReceipt] : [parentActivity],
      ),
      eventRepo: { updatePayloadById },
      emitTaskEvent: vi.fn(),
      processOrphanedFollowUps: vi.fn(),
      isSideChatTask: vi.fn().mockReturnValue(false),
      buildSideChatTurnAgentConfigOverride: vi.fn().mockReturnValue(undefined),
      applyTaskFollowUpOverrides: vi.fn((nextTask: Any) => ({ changed: false, task: nextTask })),
      applyAgentRoleOverrides: vi.fn((nextTask: Any) => ({ task: nextTask })),
      applyTaskWorkspaceOverridesForPath: vi.fn((_task: Any, nextWorkspace: Any) => nextWorkspace),
      logEvent: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    await expect(
      AgentDaemon.prototype.sendMessage.call(
        daemonLike,
        "child-task",
        "Continue the migration",
        undefined,
        undefined,
        {
          deliveryMode: "follow_up",
          messageSource: "agent",
          messageId: "message-execution",
          senderTaskId: "parent-task",
        },
      ),
    ).rejects.toThrow("provider failed after handoff");

    expect(targetReceipt.payload).toMatchObject({ deliveryStatus: "delivered" });
    expect(parentActivity.payload).toMatchObject({
      status: "delivered",
      deliveryStatus: "delivered",
    });
    expect(executorCallOrder).toEqual(["executor-start", "accepted"]);
    expect(sendMessage.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ onAccepted: expect.any(Function) }),
    );

    // Model a retry after a process restart: the durable receipt is the
    // idempotency key, even if a stale runtime snapshot still contains it.
    const retry = AgentDaemon.prototype.queueMessageOnly.call(
      daemonLike,
      task,
      "Continue the migration",
      undefined,
      undefined,
      {
        deliveryMode: "message",
        messageSource: "agent",
        messageId: "message-execution",
        senderTaskId: "parent-task",
      },
    );
    expect(retry).toMatchObject({
      queued: false,
      duplicate: true,
      messageId: "message-execution",
      deliveryStatus: "delivered",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not install an acceptance callback for an ordinary agent follow-up", async () => {
    const task = {
      id: "child-task",
      title: "Child",
      prompt: "Prompt",
      workspaceId: "workspace-1",
      agentConfig: {},
    };
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace",
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
      createdAt: 1,
    };
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const executor = {
      isRunning: false,
      sendMessage,
      suppressNextUserMessageEvent: vi.fn(),
      updateTaskAgentConfig: vi.fn(),
      updateWorkspace: vi.fn(),
    };
    const daemonLike = {
      activeTasks: new Map([["child-task", { executor, lastAccessed: 0, status: "active" }]]),
      taskRepo: {
        findById: vi.fn().mockReturnValue(task),
        touch: vi.fn(),
      },
      workspaceRepo: { findById: vi.fn().mockReturnValue(workspace) },
      annotationRepo: { listOpenByTask: vi.fn().mockReturnValue([]) },
      getTaskEvents: vi.fn().mockReturnValue([
        makeEvent("ordinary-follow-up", "child-task", "user_message", {
          messageId: "message-ordinary",
          deliveryMode: "follow_up",
          messageSource: "agent",
        }),
      ]),
      processOrphanedFollowUps: vi.fn(),
      isSideChatTask: vi.fn().mockReturnValue(false),
      buildSideChatTurnAgentConfigOverride: vi.fn().mockReturnValue(undefined),
      applyTaskFollowUpOverrides: vi.fn((nextTask: Any) => ({ changed: false, task: nextTask })),
      applyAgentRoleOverrides: vi.fn((nextTask: Any) => ({ task: nextTask })),
      applyTaskWorkspaceOverridesForPath: vi.fn((_task: Any, nextWorkspace: Any) => nextWorkspace),
      logEvent: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const result = await AgentDaemon.prototype.sendMessage.call(
      daemonLike,
      "child-task",
      "Continue normally",
      undefined,
      undefined,
      {
        deliveryMode: "follow_up",
        messageSource: "agent",
        messageId: "message-ordinary",
        senderTaskId: "parent-task",
      },
    );

    expect(result).toMatchObject({
      queued: false,
      deliveryMode: "follow_up",
      deliveryStatus: "delivered",
    });
    expect(sendMessage.mock.calls[0]?.[3]?.onAccepted).toBeUndefined();
  });

  it("returns ordinary follow-ups at durable admission while execution continues", async () => {
    const task = {
      id: "child-task",
      title: "Child",
      prompt: "Prompt",
      workspaceId: "workspace-1",
      agentConfig: {},
    };
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace",
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
      createdAt: 1,
    };
    let finishExecution!: () => void;
    const executionFinished = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    const sendMessage = vi.fn().mockImplementation(async (...args: Any[]) => {
      await args[3]?.onExecutionAccepted?.();
      await executionFinished;
    });
    const executor = {
      isRunning: false,
      sendMessage,
      suppressNextUserMessageEvent: vi.fn(),
      updateTaskAgentConfig: vi.fn(),
      updateWorkspace: vi.fn(),
    };
    const daemonLike = {
      activeTasks: new Map([["child-task", { executor, lastAccessed: 0, status: "active" }]]),
      taskRepo: {
        findById: vi.fn().mockReturnValue(task),
        touch: vi.fn(),
      },
      workspaceRepo: { findById: vi.fn().mockReturnValue(workspace) },
      annotationRepo: { listOpenByTask: vi.fn().mockReturnValue([]) },
      getTaskEvents: vi.fn().mockReturnValue([]),
      processOrphanedFollowUps: vi.fn(),
      isSideChatTask: vi.fn().mockReturnValue(false),
      buildSideChatTurnAgentConfigOverride: vi.fn().mockReturnValue(undefined),
      applyTaskFollowUpOverrides: vi.fn((nextTask: Any) => ({ changed: false, task: nextTask })),
      applyAgentRoleOverrides: vi.fn((nextTask: Any) => ({ task: nextTask })),
      applyTaskWorkspaceOverridesForPath: vi.fn((_task: Any, nextWorkspace: Any) => nextWorkspace),
      logEvent: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const resultPromise = AgentDaemon.prototype.sendMessage.call(
      daemonLike,
      "child-task",
      "Continue normally",
      undefined,
      undefined,
      { returnOnAccepted: true },
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await expect(resultPromise).resolves.toMatchObject({
      queued: false,
      deliveryMode: "follow_up",
      deliveryStatus: "accepted",
      acceptedAt: expect.any(Number),
    });
    expect(daemonLike.processOrphanedFollowUps).not.toHaveBeenCalled();

    finishExecution();
    await vi.waitFor(() => expect(daemonLike.processOrphanedFollowUps).toHaveBeenCalledTimes(1));
  });

  it("retains the full queue item when a worker becomes busy during orphan recovery", async () => {
    const followUp = {
      message: "Inspect the attached report",
      deliveryMode: "message",
      messageSource: "agent",
      messageId: "message-race",
      senderTaskId: "parent-task",
      images: [{ data: "ZmFrZQ==", mimeType: "image/png", filename: "report.png" }],
      quotedAssistantMessage: { eventId: "assistant-1", message: "Earlier context" },
    };
    let runningChecks = 0;
    const requeueFollowUpAtTurnBoundary = vi.fn();
    const queue = [followUp];
    const executor = {
      get isRunning() {
        runningChecks += 1;
        return runningChecks > 1;
      },
      takeNextFollowUpAtTurnBoundary: vi.fn(() => queue[0]),
      queueFollowUp: vi.fn(),
      runtime: { requeueFollowUpAtTurnBoundary },
      updateTaskAgentConfig: vi.fn(),
      updateWorkspace: vi.fn(),
    };
    const task = {
      id: "child-task",
      title: "Child",
      prompt: "Prompt",
      workspaceId: "workspace-1",
      agentConfig: {},
    };
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace",
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
      createdAt: 1,
    };
    const daemonLike = {
      drainingFollowUps: new Set<string>(),
      activeTasks: new Map([["child-task", { executor, lastAccessed: 0, status: "active" }]]),
      taskRepo: {
        findById: vi.fn().mockReturnValue(task),
        touch: vi.fn(),
      },
      workspaceRepo: { findById: vi.fn().mockReturnValue(workspace) },
      annotationRepo: { listOpenByTask: vi.fn().mockReturnValue([]) },
      getTaskEvents: vi.fn().mockReturnValue([]),
      isSideChatTask: vi.fn().mockReturnValue(false),
      buildSideChatTurnAgentConfigOverride: vi.fn().mockReturnValue(undefined),
      applyTaskFollowUpOverrides: vi.fn((nextTask: Any) => ({ changed: false, task: nextTask })),
      applyAgentRoleOverrides: vi.fn((nextTask: Any) => ({ task: nextTask })),
      applyTaskWorkspaceOverridesForPath: vi.fn((_task: Any, nextWorkspace: Any) => nextWorkspace),
      logEvent: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    AgentDaemon.prototype.processOrphanedFollowUps.call(daemonLike, "child-task", executor);

    await vi.waitFor(() => expect(requeueFollowUpAtTurnBoundary).toHaveBeenCalledTimes(1));
    expect(requeueFollowUpAtTurnBoundary).toHaveBeenCalledWith(followUp);
    expect(executor.queueFollowUp).not.toHaveBeenCalled();
    expect(executor.takeNextFollowUpAtTurnBoundary).toHaveBeenCalledTimes(1);
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "child-task",
      "agent_follow_up_started",
      expect.objectContaining({ messageId: followUp.messageId }),
    );
  });

  it("rejects queue-only delivery for ACP before writing a receipt", () => {
    const getTaskEvents = vi.fn().mockReturnValue([]);
    const daemonLike = { getTaskEvents } as Any;
    const task = {
      id: "acp-task",
      workspaceId: "workspace-1",
      agentConfig: {
        externalRuntime: {
          kind: "acpx",
          agent: "codex",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "approve-reads",
        },
      },
    };

    expect(() =>
      (AgentDaemon.prototype as Any).queueMessageOnly.call(
        daemonLike,
        task,
        "Queue this for ACP",
        undefined,
        undefined,
        { deliveryMode: "message", messageId: "acp-message", messageSource: "agent" },
      ),
    ).toThrow(/external ACP runtimes do not expose durable prompt acceptance/i);
    expect(getTaskEvents).toHaveBeenCalledTimes(1);
  });

  it("drops a stale delivered queue copy without dispatching it again", async () => {
    const targetReceipt = makeEvent("receipt-replay", "child-task", "user_message", {
      messageId: "message-replay",
      deliveryMode: "message",
      deliveryStatus: "delivered",
      senderTaskId: "parent-task",
    });
    const followUp = {
      message: "Already accepted",
      deliveryMode: "message",
      messageSource: "agent",
      messageId: "message-replay",
      senderTaskId: "parent-task",
    };
    const queue = [followUp];
    const executor = {
      isRunning: false,
      takeNextFollowUpAtTurnBoundary: vi.fn(() => queue.shift()),
      suppressNextUserMessageEvent: vi.fn(),
    };
    const sendMessage = vi.fn();
    const daemonLike = {
      drainingFollowUps: new Set<string>(),
      getTaskEvents: vi.fn().mockReturnValue([targetReceipt]),
      sendMessage,
      logEvent: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    AgentDaemon.prototype.processOrphanedFollowUps.call(daemonLike, "child-task", executor);

    await vi.waitFor(() =>
      expect(executor.takeNextFollowUpAtTurnBoundary).toHaveBeenCalledTimes(2),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(daemonLike.logEvent).not.toHaveBeenCalledWith(
      "child-task",
      "agent_follow_up_started",
      expect.anything(),
    );
  });
});
