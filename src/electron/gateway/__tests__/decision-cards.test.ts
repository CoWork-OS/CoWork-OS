import { describe, expect, it } from "vitest";
import {
  slackDecisionBlocks,
  slackDecisionEvent,
  teamsDecisionCard,
  teamsDecisionEvent,
  isTeamsDecisionActivity,
} from "../channels/decision-cards";
const routeId = "adcae245-4159-4bdf-8099-c714d5528291";
const card = () => ({
  routeId,
  chatId: "chat",
  title: "Review",
  summary: "Review the proposed change",
  expiresAt: Date.now() + 60000,
});
const slack = () => ({
  type: "block_actions",
  team: { id: "team" },
  user: { id: "actor", team_id: "team" },
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
});
const teams = () => ({
  type: "message",
  channelId: "msteams",
  id: "callback",
  replyToId: "message",
  from: { id: "actor" },
  recipient: { id: "bot" },
  conversation: { id: "chat", tenantId: "tenant" },
  channelData: { tenant: { id: "tenant" } },
  value: { coworkDecision: 1, routeId, action: "deny" },
});

describe("typed decision cards", () => {
  it("puts only the opaque route ID in Slack action values and uses plain display text", () => {
    const blocks = slackDecisionBlocks(card());
    const actions = blocks[3] as Any;
    expect(actions.elements.map((item: Any) => item.value)).toEqual([routeId, routeId]);
    expect((blocks[1] as Any).text.type).toBe("plain_text");
    expect(actions.elements.map((item: Any) => item.action_id)).toEqual([
      "cowork_decision:approve",
      "cowork_decision:deny",
    ]);
  });
  it("renders compatible Teams submit actions with desktop text fallback", () => {
    const result = teamsDecisionCard(card());
    expect(result.content.fallbackText).toContain("Review this request in CoWork");
    expect(result.content.actions.map((item) => item.data)).toEqual([
      { coworkDecision: 1, routeId, action: "approve" },
      { coworkDecision: 1, routeId, action: "deny" },
    ]);
  });
  it.each(["expired", "route", "summary", "title", "chat"])(
    "refuses invalid %s before rendering",
    (kind) => {
      const input = card();
      if (kind === "expired") input.expiresAt = Date.now();
      if (kind === "route") input.routeId = "approve:secret";
      if (kind === "summary") input.summary = "x".repeat(1801);
      if (kind === "title") input.title = "";
      if (kind === "chat") input.chatId = " chat";
      expect(() => slackDecisionBlocks(input)).toThrow();
      expect(() => teamsDecisionCard(input)).toThrow();
    },
  );
});
describe("SDK callback normalization", () => {
  it("binds the Slack callback to authenticated team, actor and original message", () => {
    expect(slackDecisionEvent(slack(), "team")).toEqual({
      routeId,
      action: "approve",
      channelType: "slack",
      chatId: "chat",
      messageId: "message",
      actorId: "actor",
      callbackId: "callback",
      transport: "slack_socket",
    });
  });
  it.each([
    "team",
    "actorTeam",
    "channel",
    "message",
    "container",
    "route",
    "block",
    "action",
    "multiple",
    "callback",
    "actor",
  ])("drops mismatched Slack %s", (kind) => {
    const input: Any = slack();
    if (kind === "team") input.team.id = "foreign";
    if (kind === "actorTeam") input.user.team_id = "foreign";
    if (kind === "channel") input.container.channel_id = "other";
    if (kind === "message") input.container.message_ts = "other";
    if (kind === "container") input.container.type = "view";
    if (kind === "route") input.actions[0].value = "approval-id";
    if (kind === "block") input.actions[0].block_id = "other";
    if (kind === "action") input.actions[0].action_id = "cowork_decision:stop";
    if (kind === "multiple") input.actions.push(input.actions[0]);
    if (kind === "callback") delete input.trigger_id;
    if (kind === "actor") input.user.id = "";
    expect(slackDecisionEvent(input, "team")).toBeNull();
  });
  it("requires established installation scope on each SDK", () => {
    expect(slackDecisionEvent(slack(), undefined)).toBeNull();
    expect(teamsDecisionEvent(teams(), undefined, "bot")).toBeNull();
    expect(teamsDecisionEvent(teams(), "tenant", undefined)).toBeNull();
  });
  it("binds Teams callback to tenant, recipient and the card's message ID", () => {
    expect(teamsDecisionEvent(teams(), "tenant", "bot")).toEqual({
      routeId,
      action: "deny",
      channelType: "teams",
      chatId: "chat",
      messageId: "message",
      actorId: "actor",
      callbackId: "callback",
      transport: "teams_botframework",
    });
  });
  it.each([
    "tenant",
    "conversationTenant",
    "bot",
    "channel",
    "reply",
    "action",
    "route",
    "version",
    "actor",
    "callback",
  ])("drops mismatched Teams %s", (kind) => {
    const input: Any = teams();
    if (kind === "tenant") input.channelData.tenant.id = "foreign";
    if (kind === "conversationTenant") input.conversation.tenantId = "foreign";
    if (kind === "bot") input.recipient.id = "foreign";
    if (kind === "channel") input.channelId = "webchat";
    if (kind === "reply") delete input.replyToId;
    if (kind === "action") input.value.action = "stop";
    if (kind === "route") input.value.routeId = "secret";
    if (kind === "version") input.value.coworkDecision = 2;
    if (kind === "actor") input.from.id = "";
    if (kind === "callback") input.id = "";
    expect(teamsDecisionEvent(input, "tenant", "bot")).toBeNull();
    expect(isTeamsDecisionActivity(input)).toBe(true);
  });
  it("does not interpret ordinary text as a decision", () => {
    expect(isTeamsDecisionActivity({ text: "approve:123" })).toBe(false);
    expect(teamsDecisionEvent({ text: "approve:123" }, "tenant", "bot")).toBeNull();
  });
});

describe("decision revision presentation", () => {
  it("renders the same request revision and file counts in cards and text fallback", () => {
    const message = {
      ...card(),
      revisionHash: "b".repeat(64),
      draftFiles: { present: 1, missing: 1 },
    };
    const slack = JSON.stringify(slackDecisionBlocks(message));
    const teams = JSON.stringify(teamsDecisionCard(message));
    for (const rendered of [slack, teams]) {
      expect(rendered).toContain(message.revisionHash);
      expect(rendered).toContain("1 present, 1 missing");
      expect(rendered).toContain("captured draft in CoWork");
    }
  });
  it.each([
    { revisionHash: "forged" },
    { draftFiles: { present: 1, missing: 0 } },
    { revisionHash: "b".repeat(64), draftFiles: { present: 5, missing: 0 } },
    { revisionHash: "b".repeat(64), draftFiles: { present: -1, missing: 1 } },
  ])("rejects invalid revision metadata before publication", (metadata) => {
    expect(() => slackDecisionBlocks({ ...card(), ...metadata })).toThrow();
    expect(() => teamsDecisionCard({ ...card(), ...metadata })).toThrow();
  });
});
