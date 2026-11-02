import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", () => ({
  default: vi.fn().mockImplementation(() => ({
    exec: vi.fn(),
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1 }),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    close: vi.fn(),
  })),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp/test-cowork") },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}));

const gate = vi.hoisted(() => ({
  chatMode: "explicit_only" as "explicit_only" | "candidate" | "ignore",
  run: vi.fn(),
}));

vi.mock("../../settings/event-gate-manager", () => ({
  EventGateSettingsManager: {
    resolveChatMode: vi.fn(() => gate.chatMode),
    enabledPolicyTexts: vi.fn(() => ["Act on outage reports"]),
  },
}));

vi.mock("../../triggers/semantic-gate", () => ({
  runSemanticGate: gate.run,
}));

import { MessageRouter } from "../router";

function makeRouter() {
  const agentDaemon = {
    startTask: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registerArtifact: vi.fn(),
  };
  const db = {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1 }),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    transaction: vi.fn((fn: Any) => fn),
  } as Any;
  const router = new MessageRouter(db, {}, agentDaemon as Any);
  const subscriptions = {
    findActiveSubscribers: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn().mockResolvedValue(true),
  };
  (router as Any).threadSubscriptionRepo = subscriptions;
  const adapter = { type: "slack", sendMessage: vi.fn().mockResolvedValue("sent-1") } as Any;
  return { router, adapter, agentDaemon, subscriptions };
}

function slackMessage(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "1700.0002",
    channel: "slack",
    userId: "U1",
    userName: "Ada",
    chatId: "C1",
    isGroup: true,
    text: "the API is down for everyone",
    timestamp: new Date(),
    ...overrides,
  };
}

describe("MessageRouter ingest-only admission", () => {
  beforeEach(() => {
    gate.chatMode = "explicit_only";
    gate.run.mockReset();
  });

  it("delivers an unaddressed thread message to the thread's running task, untrusted", async () => {
    const { router, adapter, agentDaemon, subscriptions } = makeRouter();
    subscriptions.findActiveSubscribers.mockResolvedValue(["task-a"]);
    gate.chatMode = "candidate";

    const admitted = await (router as Any).admitIngestOnlyMessage(
      adapter,
      "channel-1",
      slackMessage({ threadId: "1700.0001" }),
      { allowed: true },
    );

    expect(admitted).toBe(false);
    expect(subscriptions.findActiveSubscribers).toHaveBeenCalledWith(
      "slack:channel-1:C1:1700.0001",
    );
    expect(agentDaemon.sendMessage).toHaveBeenCalledTimes(1);
    const [taskId, text, ...rest] = agentDaemon.sendMessage.mock.calls[0];
    expect(taskId).toBe("task-a");
    expect(text).toContain("[Untrusted external event]");
    expect(text).toContain("the API is down for everyone");
    // No user_typed provenance options.
    expect(rest).toEqual([]);
    expect(gate.run).not.toHaveBeenCalled();
  });

  it("routes an ambient message in a candidate chat when the gate says act", async () => {
    const { router, adapter } = makeRouter();
    gate.chatMode = "candidate";
    gate.run.mockResolvedValue({ decision: "act", reason: "Outage report" });

    const admitted = await (router as Any).admitIngestOnlyMessage(
      adapter,
      "channel-1",
      slackMessage(),
      { allowed: true },
    );

    expect(admitted).toBe(true);
    expect(gate.run).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "channel_message",
        policies: ["Act on outage reports"],
        fields: expect.objectContaining({ chatId: "C1", text: "the API is down for everyone" }),
      }),
    );

    gate.run.mockResolvedValue({ decision: "ignore", reason: "Chit-chat" });
    expect(
      await (router as Any).admitIngestOnlyMessage(adapter, "channel-1", slackMessage(), {
        allowed: true,
      }),
    ).toBe(false);
  });

  it("keeps explicit-only chats, unauthorized senders and the owner's own messages stored only", async () => {
    const { router, adapter, subscriptions } = makeRouter();
    expect(
      await (router as Any).admitIngestOnlyMessage(adapter, "channel-1", slackMessage(), {
        allowed: true,
      }),
    ).toBe(false);
    expect(gate.run).not.toHaveBeenCalled();

    gate.chatMode = "candidate";
    expect(
      await (router as Any).admitIngestOnlyMessage(
        adapter,
        "channel-1",
        slackMessage({ threadId: "1.0" }),
        { allowed: false },
      ),
    ).toBe(false);
    expect(
      await (router as Any).admitIngestOnlyMessage(
        adapter,
        "channel-1",
        slackMessage({ direction: "outgoing_user" }),
        { allowed: true },
      ),
    ).toBe(false);
    expect(subscriptions.findActiveSubscribers).not.toHaveBeenCalled();
    expect(gate.run).not.toHaveBeenCalled();
  });

  it("feeds an admitted ambient message into normal routing", async () => {
    const { router, adapter } = makeRouter();
    gate.chatMode = "candidate";
    gate.run.mockResolvedValue({ decision: "act", reason: "Outage report" });
    const channel = { id: "channel-1", type: "slack", config: { ambientMode: true } };
    (router as Any).getChannelForAdapter = vi.fn().mockResolvedValue(channel);
    (router as Any).securityManager.checkAccess = vi
      .fn()
      .mockResolvedValue({ allowed: true, user: { id: "user-row" } });
    (router as Any).messageRepo.create = vi.fn().mockResolvedValue(undefined);
    (router as Any).userRepo.update = vi.fn().mockResolvedValue(undefined);
    (router as Any).resolveChannelSpecialization = vi.fn().mockResolvedValue(undefined);
    (router as Any).sessionManager.getOrCreateSession = vi
      .fn()
      .mockResolvedValue({ id: "session-1" });
    (router as Any).sessionManager.updateSessionContext = vi.fn().mockResolvedValue(undefined);
    const routeMessage = vi.fn().mockResolvedValue(undefined);
    (router as Any).routeMessage = routeMessage;

    await (router as Any).handleMessage(adapter, slackMessage());
    expect(routeMessage).toHaveBeenCalledTimes(1);

    gate.run.mockResolvedValue({ decision: "ignore", reason: "Chit-chat" });
    await (router as Any).handleMessage(adapter, slackMessage({ messageId: "1700.0003" }));
    expect(routeMessage).toHaveBeenCalledTimes(1);
  });
});

describe("MessageRouter thread subscriptions", () => {
  it("subscribes the task it creates for a thread's first message", async () => {
    const { router, adapter, subscriptions } = makeRouter();
    (router as Any).getChannelForAdapter = vi.fn().mockReturnValue({
      id: "channel-1",
      type: "slack",
      config: {},
    });
    (router as Any).getChannelIdForAdapter = vi.fn().mockReturnValue("channel-1");
    (router as Any).persistInboundAttachments = vi.fn().mockResolvedValue([]);
    (router as Any).maybeUpdatePrioritiesFromVoiceMessage = vi.fn().mockResolvedValue(undefined);
    (router as Any).sessionRepo.findById = vi.fn().mockReturnValue({
      id: "session-1",
      channelId: "channel-1",
      workspaceId: "ws-1",
      context: {},
    });
    (router as Any).workspaceRepo.findById = vi.fn().mockReturnValue({
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/ws-1",
      permissions: {},
    });
    (router as Any).taskRepo.create = vi
      .fn()
      .mockImplementation((input: Any) => ({ id: "task-1", ...input }));
    (router as Any).taskRepo.update = vi.fn();
    (router as Any).sessionManager.linkSessionToTask = vi.fn();
    (router as Any).sessionManager.updateSessionContext = vi.fn();

    await (router as Any).forwardToDesktopApp(
      adapter,
      slackMessage({ threadId: "1700.0001", text: "please triage" }),
      "session-1",
      { contextType: "group" },
    );

    expect(subscriptions.subscribe).toHaveBeenCalledWith(
      "slack:channel-1:C1:1700.0001",
      "task-1",
      expect.any(Number),
    );
  });
});
