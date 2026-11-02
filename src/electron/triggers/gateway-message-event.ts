import { createHash } from "crypto";
import type { GatewayEvent } from "../gateway/channels/types";
import type { TriggerEvent } from "./types";

const MAX_IDENTITY_PART_CHARS = 1024;

/**
 * The `channel_message` trigger event for a gateway `message:received` event, or null for any
 * other gateway event. Reads the fields the router emits (see `MessageReceivedEventData`).
 */
export function channelMessageTriggerEvent(event: GatewayEvent): TriggerEvent | null {
  if (event.type !== "message:received" || !event.data) return null;
  const data = event.data;
  const channelType = event.channel || "";
  const chatId = String(data.chatId || "");
  const messageId = String(data.messageId || "");
  const channelDbId = String(data.channelId || "");
  const identityParts = [channelType, channelDbId, chatId, messageId];
  const eventId = identityParts.every(
    (part) => part.length > 0 && part.length <= MAX_IDENTITY_PART_CHARS,
  )
    ? `gateway-message-v1:${createHash("sha256")
        .update(JSON.stringify(["gateway-message-v1", ...identityParts]))
        .digest("hex")}`
    : undefined;
  return {
    source: "channel_message",
    ...(eventId ? { eventId } : {}),
    timestamp: event.timestamp.getTime(),
    fields: {
      channelType,
      channelInstanceId: channelDbId,
      chatId,
      text: String(data.text || ""),
      senderName: String(data.senderName || ""),
    },
  };
}
