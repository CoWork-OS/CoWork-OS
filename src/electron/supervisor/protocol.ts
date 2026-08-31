import type { SupervisorProtocolIntent, DiscordSupervisorConfig } from "../../shared/types";

const MARKER_TO_INTENT: Record<string, SupervisorProtocolIntent> = {
  CW_STATUS_REQUEST: "status_request",
  CW_REVIEW_REQUEST: "review_request",
  CW_ESCALATION_NOTICE: "escalation_notice",
  CW_ACK: "ack",
};

const INTENT_TO_MARKER: Record<SupervisorProtocolIntent, string> = {
  status_request: "[CW_STATUS_REQUEST]",
  review_request: "[CW_REVIEW_REQUEST]",
  escalation_notice: "[CW_ESCALATION_NOTICE]",
  ack: "[CW_ACK]",
};

export interface ParsedSupervisorProtocolMessage {
  intent: SupervisorProtocolIntent;
  marker: string;
  exchangeId?: string;
  mentionedPeerUserId: string;
  mentionCount: number;
  markerCount: number;
}

const EXCHANGE_TOKEN_REGEX = /\[CW_EXCHANGE:([0-9a-fA-F-]{36})\]/;

const PROMPT_INJECTION_PATTERNS =
  /^(?:rules:|system:|instructions:|you are|ignore previous|disregard|\[cw_|<@)/i;
const PROMPT_MAX_INCOMING_CHARS = 1500;

export function sanitizeForPrompt(text: string): string {
  const truncated =
    text.length > PROMPT_MAX_INCOMING_CHARS ? `${text.slice(0, PROMPT_MAX_INCOMING_CHARS)}…` : text;
  return truncated
    .split("\n")
    .filter((line) => !PROMPT_INJECTION_PATTERNS.test(line.trim()))
    .join("\n")
    .trim();
}

export function getSupervisorMarker(intent: SupervisorProtocolIntent): string {
  return INTENT_TO_MARKER[intent];
}

export function parseSupervisorProtocolMessage(
  text: string,
  config: Pick<DiscordSupervisorConfig, "peerBotUserIds" | "strictMode">,
): ParsedSupervisorProtocolMessage | null {
  const normalized = String(text || "");
  const markers = Array.from(normalized.matchAll(/\[(CW_[A-Z_]+)\]/g)).map((match) => match[1]);
  if (markers.length === 0) return null;
  const exchangeId = normalized.match(EXCHANGE_TOKEN_REGEX)?.[1];

  const mentions = Array.from(normalized.matchAll(/<@!?(\d+)>/g)).map((match) => match[1]);
  const allowedPeers = new Set((config.peerBotUserIds || []).filter(Boolean));
  const peerMentions = mentions.filter((id) => allowedPeers.has(id));
  const strict = config.strictMode !== false;

  if (strict) {
    if (markers.length !== 1 || peerMentions.length !== 1) {
      return null;
    }
  } else if (peerMentions.length < 1) {
    return null;
  }

  const marker = markers[0];
  const intent = MARKER_TO_INTENT[marker];
  if (!intent) return null;

  return {
    intent,
    marker: `[${marker}]`,
    exchangeId,
    mentionedPeerUserId: peerMentions[0],
    mentionCount: peerMentions.length,
    markerCount: markers.length,
  };
}

export function formatPeerSupervisorMessage(
  peerUserId: string,
  intent: SupervisorProtocolIntent,
  body: string,
  options?: { exchangeId?: string },
): string {
  const mention = `<@${peerUserId}>`;
  const marker = getSupervisorMarker(intent);
  const exchangeToken = options?.exchangeId ? ` [CW_EXCHANGE:${options.exchangeId}]` : "";
  const suffix = body.trim();
  return suffix
    ? `${mention} ${marker}${exchangeToken}\n${suffix}`
    : `${mention} ${marker}${exchangeToken}`;
}
