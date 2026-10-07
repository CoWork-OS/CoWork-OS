import { beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({
  decisionClient: vi.fn(),
  teamsContinue: vi.fn(),
  teamsAuth: vi.fn(),
  post: vi.fn(),
  action: vi.fn(),
  auth: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@slack/bolt", () => ({
  webApi: {
    WebClient: class {
      constructor(token: string, options: Any) {
        sdk.decisionClient(token, options);
      }
      chat = { postMessage: sdk.post };
    },
  },
  LogLevel: { WARN: "warn" },
  SocketModeReceiver: class {
    client = {};
  },
  App: class {
    client = { auth: { test: sdk.auth }, chat: { postMessage: sdk.post } };
    action = sdk.action;
    start = sdk.start;
    stop = sdk.stop;
    message = vi.fn();
    command = vi.fn();
    error = vi.fn();
  },
}));
vi.mock("botbuilder", () => ({
  CloudAdapter: class {
    continueConversationAsync = sdk.teamsContinue;
  },
  ConfigurationBotFrameworkAuthentication: class {
    constructor(...args: Any[]) {
      sdk.teamsAuth(...args);
    }
  },
  ActivityTypes: {
    Message: "message",
    ConversationUpdate: "conversationUpdate",
    MessageReaction: "messageReaction",
  },
  TurnContext: { getConversationReference: vi.fn() },
  MessageFactory: { text: vi.fn() },
}));
import { SlackAdapter } from "../channels/slack";
import { TeamsAdapter } from "../channels/teams";
import { TurnContext } from "botbuilder";
const routeId = "adcae245-4159-4bdf-8099-c714d5528291";
const card = () => ({
  routeId,
  chatId: "chat",
  title: "Review",
  summary: "Review the proposed change",
  expiresAt: Date.now() + 60000,
});
beforeEach(() => {
  vi.clearAllMocks();
  sdk.auth.mockResolvedValue({ team_id: "team", user: "bot", user_id: "bot" });
  sdk.post.mockResolvedValue({ ts: "message" });
});
describe("Slack typed decision adapter", () => {
  it("requires a registered handler before publishing", async () => {
    const adapter = new SlackAdapter({ enabled: true, botToken: "fixture", appToken: "fixture" });
    await adapter.connect();
    await expect(adapter.sendDecision(card())).rejects.toThrow("not ready");
    expect(sdk.post).not.toHaveBeenCalled();
    await adapter.disconnect();
  });
  it("publishes a single card and never retries ambiguous parsing errors", async () => {
    const adapter = new SlackAdapter({ enabled: true, botToken: "fixture", appToken: "fixture" });
    adapter.onDecision(vi.fn());
    await adapter.connect();
    expect(await adapter.sendDecision(card())).toBe("message");
    expect(sdk.decisionClient).toHaveBeenCalledWith("fixture", {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 15000,
    });
    expect(sdk.post).toHaveBeenCalledWith(
      expect.objectContaining({ mrkdwn: false, parse: "none", blocks: expect.any(Array) }),
    );
    sdk.post.mockClear().mockRejectedValueOnce(new Error("invalid response after publication"));
    await expect(adapter.sendDecision(card())).rejects.toThrow("invalid response");
    expect(sdk.post).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });
  it("acknowledges SDK actions and dispatches only normalized installation-scoped decisions", async () => {
    const adapter = new SlackAdapter({ enabled: true, botToken: "fixture", appToken: "fixture" });
    const handler = vi.fn();
    adapter.onDecision(handler);
    await adapter.connect();
    const receive = sdk.action.mock.calls[0][1];
    const ack = vi.fn();
    const body = {
      type: "block_actions",
      team: { id: "team" },
      user: { id: "actor" },
      channel: { id: "chat" },
      container: { type: "message", channel_id: "chat", message_ts: "message" },
      message: { ts: "message" },
      trigger_id: "callback",
      actions: [
        {
          type: "button",
          action_id: "cowork_decision:approve",
          value: routeId,
          block_id: `cowork_decision:${routeId}`,
        },
      ],
    };
    await receive({ ack, body });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    await receive({ ack, body: { ...body, team: { id: "foreign" } } });
    expect(handler).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });
  it("treats a missing published message ID as an ambiguous failure", async () => {
    const adapter = new SlackAdapter({ enabled: true, botToken: "fixture", appToken: "fixture" });
    adapter.onDecision(vi.fn());
    await adapter.connect();
    sdk.post.mockResolvedValueOnce({});
    await expect(adapter.sendDecision(card())).rejects.toThrow("no message ID");
    expect(sdk.post).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });
});
describe("Teams typed decision adapter", () => {
  function fixture() {
    const adapter = new TeamsAdapter({
      enabled: true,
      appId: "app",
      appPassword: "fixture",
      tenantId: "tenant",
    });
    const inner = adapter as Any;
    inner._status = "connected";
    const send = vi.fn().mockResolvedValue({ id: "message" });
    const continueConversationAsync = vi.fn(async (_app, _ref, callback) =>
      callback({ sendActivity: send }),
    );
    inner.adapter = { continueConversationAsync };
    sdk.teamsContinue.mockImplementation(continueConversationAsync);
    inner.conversationReferences.set("chat", {
      bot: { id: "bot" },
      conversation: { id: "chat", tenantId: "tenant" },
    });
    const handler = vi.fn();
    adapter.onDecision(handler);
    return { adapter, inner, send, continueConversationAsync, handler };
  }
  it("publishes one tenant-bound card without retrying failure", async () => {
    const f = fixture();
    expect(await f.adapter.sendDecision(card())).toBe("message");
    expect(f.send.mock.calls[0][0].attachments[0].content.actions).toHaveLength(2);
    f.send.mockClear().mockRejectedValueOnce(new Error("network after publication"));
    await expect(f.adapter.sendDecision(card())).rejects.toThrow("network");
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.adapter.disconnect();
  });
  it("refuses foreign tenant references before any send", async () => {
    const f = fixture();
    f.inner.conversationReferences.get("chat").conversation.tenantId = "other";
    await expect(f.adapter.sendDecision(card())).rejects.toThrow("tenant-bound");
    expect(f.send).not.toHaveBeenCalled();
    await f.adapter.disconnect();
  });
  it("consumes malformed decision activities without treating them as task prompts", async () => {
    const f = fixture();
    const prompt = vi.fn();
    f.adapter.onMessage(prompt);
    await f.inner.handleActivity({
      activity: {
        type: "message",
        conversation: { id: "chat" },
        text: "run arbitrary task",
        value: { coworkDecision: 2 },
      },
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
    await f.adapter.disconnect();
  });
  it("dispatches a scoped submission inside the SDK process callback", async () => {
    const f = fixture();
    const activity = {
      type: "message",
      channelId: "msteams",
      id: "callback",
      replyToId: "message",
      from: { id: "actor" },
      recipient: { id: "bot" },
      conversation: { id: "chat", tenantId: "tenant" },
      channelData: { tenant: { id: "tenant" } },
      value: { coworkDecision: 1, routeId, action: "approve" },
    };
    f.inner.adapter.process = vi.fn(async (_req, _res, callback) => callback({ activity }));
    await f.inner.processIncomingActivity(
      { headers: {}, method: "POST" },
      {},
      JSON.stringify(activity),
    );
    expect(f.handler).toHaveBeenCalledWith(
      expect.objectContaining({ transport: "teams_botframework", messageId: "message" }),
    );
    await f.adapter.disconnect();
  });
  it("never dispatches a callback when SDK authentication rejects the request", async () => {
    const f = fixture();
    const res = { writeHead: vi.fn(), end: vi.fn() };
    f.inner.adapter.process = vi.fn().mockRejectedValue(new Error("Unauthorized"));
    await f.inner.processIncomingActivity(
      { headers: {}, method: "POST" },
      res,
      JSON.stringify({ value: { coworkDecision: 1 } }),
    );
    expect(f.handler).not.toHaveBeenCalled();
    await f.adapter.disconnect();
  });
  it("loads the durable reference after adapter restart and refuses changed service URLs", async () => {
    const original = fixture(),
      reference = {
        channelId: "msteams" as const,
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        bot: { id: "bot" },
        conversation: { id: "chat", tenantId: "tenant" },
      };
    const persistence = { save: vi.fn(), load: vi.fn().mockResolvedValue(reference) };
    original.adapter.setDecisionReferencePersistence(persistence);
    await original.adapter.disconnect();
    const restarted = fixture();
    restarted.inner.conversationReferences.clear();
    restarted.adapter.setDecisionReferencePersistence(persistence);
    const activity = {
      type: "message",
      channelId: "msteams",
      serviceUrl: reference.serviceUrl,
      id: "callback",
      replyToId: "message",
      from: { id: "actor" },
      recipient: { id: "bot" },
      conversation: { id: "chat", tenantId: "tenant" },
      channelData: { tenant: { id: "tenant" } },
      value: { coworkDecision: 1, routeId, action: "approve" },
    };
    await restarted.inner.handleActivity({ activity });
    expect(restarted.handler).toHaveBeenCalledTimes(1);
    expect(persistence.load).toHaveBeenCalledWith("chat");
    expect(persistence.save).not.toHaveBeenCalled();
    await restarted.inner.handleActivity({
      activity: { ...activity, serviceUrl: "https://other.example/" },
});
    expect(restarted.handler).toHaveBeenCalledTimes(1);
    persistence.load.mockRejectedValue(new Error("storage unavailable"));
    await restarted.inner.handleActivity({ activity });
    expect(restarted.handler).toHaveBeenCalledTimes(1);
    await expect(restarted.adapter.sendDecision(card())).rejects.toThrow("storage unavailable");
    expect(restarted.send).not.toHaveBeenCalled();
    await restarted.adapter.disconnect();
  });

  it("saves minimal reference metadata only after SDK authentication accepts a normal turn", async () => {
    const f = fixture();
    const save = vi.fn().mockResolvedValue(undefined);
    f.adapter.setDecisionReferencePersistence({ save, load: vi.fn() });
    const reference = {
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      bot: { id: "bot", name: "private bot name" },
      user: { id: "private user" },
      conversation: { id: "chat", tenantId: "tenant" },
    };
    vi.mocked(TurnContext.getConversationReference).mockReturnValue(reference as Any);
    const activity = {
      type: "messageReaction",
      channelId: "msteams",
      serviceUrl: reference.serviceUrl,
      conversation: { id: "chat", tenantId: "tenant" },
      channelData: { tenant: { id: "tenant" } },
    };
    f.inner.adapter.process = vi.fn(async (_req, _res, callback) => callback({ activity }));
    await f.inner.processIncomingActivity(
      { headers: {}, method: "POST" },
      {},
      JSON.stringify(activity),
    );
    expect(save).toHaveBeenCalledWith({
      channelId: "msteams",
      serviceUrl: reference.serviceUrl,
      bot: { id: "bot" },
      conversation: { id: "chat", tenantId: "tenant" },
    });
    f.inner.adapter.process.mockRejectedValue(new Error("unauthenticated"));
    await f.inner.processIncomingActivity(
      { headers: {}, method: "POST" },
      { writeHead: vi.fn(), end: vi.fn() },
      JSON.stringify(activity),
    );
    expect(save).toHaveBeenCalledTimes(1);
    f.inner.adapter.process.mockImplementation(async (_req, _res, callback) =>
      callback({ activity: { ...activity, channelData: { tenant: { id: "foreign" } } } }),
    );
    await f.inner.processIncomingActivity(
      { headers: {}, method: "POST" },
      {},
      JSON.stringify(activity),
    );
    expect(save).toHaveBeenCalledTimes(1);
    await f.adapter.disconnect();
  });
});
