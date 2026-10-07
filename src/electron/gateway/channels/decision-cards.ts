import type { ChannelDecisionEvent, ChannelDecisionMessage } from "./types";

export const DECISION_ACTION_PREFIX = "cowork_decision:";
const ROUTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function id(value: unknown, limit = 200): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= limit && value === value.trim()
  );
}
function action(value: unknown): value is "approve" | "deny" {
  return value === "approve" || value === "deny";
}
export function validateDecisionMessage(message: ChannelDecisionMessage, now = Date.now()): void {
  if (
    !id(message.chatId) ||
    !ROUTE_ID.test(message.routeId) ||
    !id(message.title, 150) ||
    !id(message.summary, 1800) ||
    !Number.isSafeInteger(message.expiresAt) ||
    message.expiresAt <= now ||
    (message.replyTo !== undefined && !id(message.replyTo)) ||
    (message.revisionHash !== undefined && !/^[a-f0-9]{64}$/.test(message.revisionHash)) ||
    (message.draftFiles !== undefined &&
      (!message.revisionHash ||
        !Number.isSafeInteger(message.draftFiles.present) ||
        !Number.isSafeInteger(message.draftFiles.missing) ||
        message.draftFiles.present < 0 ||
        message.draftFiles.missing < 0 ||
        message.draftFiles.present + message.draftFiles.missing < 1 ||
        message.draftFiles.present + message.draftFiles.missing > 4))
  ) {
    throw new Error("Invalid or expired channel decision");
  }
}
function revisionText(message: ChannelDecisionMessage): string {
  if (!message.revisionHash) return "";
  const counts = message.draftFiles;
  return (
    `Request version ${message.revisionHash}` +
    (counts
      ? `\nReviewed files: ${counts.present} present, ${counts.missing} missing. Inspect the captured draft in CoWork before approving.`
      : "")
  );
}
export function decisionFallback(message: ChannelDecisionMessage): string {
  return `${message.title}\n${message.summary}${message.revisionHash ? `\n${revisionText(message)}` : ""}\nExpires ${new Date(message.expiresAt).toISOString()}. Review this request in CoWork if buttons are unavailable.`;
}
export function slackDecisionBlocks(message: ChannelDecisionMessage) {
  validateDecisionMessage(message);
  return [
    { type: "header" as const, text: { type: "plain_text" as const, text: message.title } },
    { type: "section" as const, text: { type: "plain_text" as const, text: message.summary } },
    ...(message.revisionHash
      ? [
          {
            type: "section" as const,
            text: { type: "plain_text" as const, text: revisionText(message) },
          },
        ]
      : []),
    {
      type: "context" as const,
      elements: [
        {
          type: "plain_text" as const,
          text: `Expires ${new Date(message.expiresAt).toISOString()}`,
        },
      ],
    },
    {
      type: "actions" as const,
      block_id: `cowork_decision:${message.routeId}`,
      elements: (["approve", "deny"] as const).map((choice) => ({
        type: "button" as const,
        text: { type: "plain_text" as const, text: choice === "approve" ? "Approve" : "Deny" },
        action_id: `${DECISION_ACTION_PREFIX}${choice}`,
        value: message.routeId,
      })),
    },
  ];
}
function teamsText(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+.!<>~])/g, "\\$1");
}
export function teamsDecisionCard(message: ChannelDecisionMessage) {
  validateDecisionMessage(message);
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.2",
      fallbackText: decisionFallback(message),
      body: [
        { type: "TextBlock", text: teamsText(message.title), weight: "Bolder", wrap: true },
        { type: "TextBlock", text: teamsText(message.summary), wrap: true },
        ...(message.revisionHash
          ? [{ type: "TextBlock", text: teamsText(revisionText(message)), wrap: true }]
          : []),
        {
          type: "TextBlock",
          text: `Expires ${new Date(message.expiresAt).toISOString()}`,
          wrap: true,
        },
      ],
      // Action.Submit matches this adapter's existing Bot Framework message activity path.
      actions: (["approve", "deny"] as const).map((choice) => ({
        type: "Action.Submit",
        title: choice === "approve" ? "Approve" : "Deny",
        data: { coworkDecision: 1, routeId: message.routeId, action: choice },
      })),
    },
  };
}

/** Validation only; call exclusively from the authenticated Bolt Socket Mode handler. */
export function slackDecisionEvent(
  body: unknown,
  teamId: string | undefined,
): ChannelDecisionEvent | null {
  const value = record(body),
    team = record(value.team),
    channel = record(value.channel);
  const container = record(value.container),
    message = record(value.message),
    user = record(value.user);
  if (
    !teamId ||
    value.type !== "block_actions" ||
    team.id !== teamId ||
    !Array.isArray(value.actions) ||
    value.actions.length !== 1
  )
    return null;
  const button = record(value.actions[0]);
  const choice =
    typeof button.action_id === "string"
      ? button.action_id.slice(DECISION_ACTION_PREFIX.length)
      : null;
  if (
    button.type !== "button" ||
    button.action_id !== `${DECISION_ACTION_PREFIX}${choice}` ||
    !action(choice) ||
    typeof button.value !== "string" ||
    !ROUTE_ID.test(button.value) ||
    button.block_id !== `cowork_decision:${button.value}` ||
    container.type !== "message" ||
    !id(channel.id) ||
    container.channel_id !== channel.id ||
    !id(message.ts) ||
    container.message_ts !== message.ts ||
    !id(user.id) ||
    !id(value.trigger_id) ||
    (user.team_id !== undefined && user.team_id !== teamId)
  )
    return null;
  return {
    routeId: button.value,
    action: choice,
    channelType: "slack",
    chatId: channel.id,
    messageId: message.ts,
    actorId: user.id,
    callbackId: value.trigger_id,
    transport: "slack_socket",
  };
}
export function isTeamsDecisionActivity(activity: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(record(record(activity).value), "coworkDecision");
}
/** Validation only; call exclusively after CloudAdapter.process authenticates the turn. */
export function teamsDecisionEvent(
  activity: unknown,
  tenantId: string | undefined,
  botId: string | undefined,
): ChannelDecisionEvent | null {
  const item = record(activity),
    value = record(item.value),
    conversation = record(item.conversation);
  const tenant = record(record(item.channelData).tenant),
    sender = record(item.from),
    recipient = record(item.recipient);
  if (
    !tenantId ||
    !botId ||
    item.channelId !== "msteams" ||
    item.type !== "message" ||
    value.coworkDecision !== 1 ||
    tenant.id !== tenantId ||
    (conversation.tenantId !== undefined && conversation.tenantId !== tenantId) ||
    recipient.id !== botId ||
    !id(sender.id) ||
    !id(conversation.id) ||
    !id(item.id) ||
    !id(item.replyToId) ||
    typeof value.routeId !== "string" ||
    !ROUTE_ID.test(value.routeId) ||
    !action(value.action)
  )
    return null;
  return {
    routeId: value.routeId,
    action: value.action,
    channelType: "teams",
    chatId: conversation.id,
    messageId: item.replyToId,
    actorId: sender.id,
    callbackId: item.id,
    transport: "teams_botframework",
  };
}
