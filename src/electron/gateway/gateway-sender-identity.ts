/**
 * Who sent a gateway message, for memory (audit SEC-16). Only the workspace owner's own
 * messages may become facts about the user (profile facts, awareness beliefs, response
 * style, `user_stated` memory). Anyone else reaching CoWork through a channel — a DM from
 * a paired contact, an open bot, a group — is a third party: what they say about
 * themselves is not about the owner.
 *
 * The owner is recognized only on positive evidence:
 * - a self-chat channel (WhatsApp self-chat mode routes only the owner's own chat), or
 * - the channel config lists the sender in `ownerUserIds` (set in each channel's settings,
 *   "Your Account on This Channel"; validated by shared/gateway-owner-ids.ts).
 * Group messages are never attributed to the owner (several people write there).
 * Pairing and allowlists are deliberately not evidence: they admit anyone the owner lets in,
 * so a paired or allowlisted user is not necessarily the owner. The settings UI offers a
 * "This is me" shortcut on those users instead.
 */
import type { AgentConfig } from "../../shared/types";

export interface GatewaySenderMessage {
  userId: string;
  chatId?: string;
  isGroup?: boolean;
  ingestOnly?: boolean;
}

export interface GatewayOwnerEvidence {
  /** The adapter runs in self-chat mode (only the owner's own chat is routed). */
  selfChatMode?: boolean;
  /** `ownerUserIds` from the channel config: channel user ids that are the owner. */
  ownerUserIds?: unknown;
}

const MAX_REF_CHARS = 200;

/** Whether a gateway message was sent by the workspace owner. */
export function isGatewayOwnerSender(
  message: GatewaySenderMessage,
  evidence: GatewayOwnerEvidence,
): boolean {
  if (message.isGroup === true || message.ingestOnly === true) return false;
  const userId = String(message.userId || "").trim();
  if (!userId) return false;
  if (evidence.selfChatMode === true) return true;
  if (Array.isArray(evidence.ownerUserIds)) {
    return evidence.ownerUserIds.some(
      (entry) => typeof entry === "string" && entry.trim() === userId,
    );
  }
  return false;
}

/** Contact-scope reference for a gateway sender (`gateway:<channel>:<user id>`). */
export function gatewaySenderRef(channel: string, userId: string): string {
  const safe = (value: string) =>
    String(value || "")
      .trim()
      .replace(/[^A-Za-z0-9_.@+:-]+/g, "_");
  return `gateway:${safe(channel) || "unknown"}:${safe(userId) || "unknown"}`.slice(
    0,
    MAX_REF_CHARS,
  );
}

/** The agent-config fields that record the sender of a gateway task. */
export function gatewaySenderAgentConfig(
  channel: string,
  message: GatewaySenderMessage,
  evidence: GatewayOwnerEvidence,
): Pick<AgentConfig, "gatewaySenderIsOwner" | "gatewaySenderRef"> {
  return {
    gatewaySenderIsOwner: isGatewayOwnerSender(message, evidence),
    gatewaySenderRef: gatewaySenderRef(channel, message.userId),
  };
}

/**
 * True for a task that came in through a channel from someone other than the workspace
 * owner. Tasks created before the sender was recorded count as third-party: without
 * evidence, a channel message is not the owner's.
 */
export function isThirdPartyGatewayTask(
  task: { agentConfig?: AgentConfig | null } | null | undefined,
): boolean {
  const config = task?.agentConfig;
  if (!config || typeof config.originChannel !== "string" || !config.originChannel) return false;
  return config.gatewaySenderIsOwner !== true;
}
