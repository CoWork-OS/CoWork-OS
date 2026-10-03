/**
 * `ownerUserIds` in a gateway channel config: the channel user ids that belong to the
 * workspace owner (audit SEC-16). A direct message from one of these ids counts as the
 * owner's own message and may teach memory; every other sender is a third party.
 * See src/electron/gateway/gateway-sender-identity.ts.
 *
 * Shared by the settings UI (inline validation) and the main process (which validates
 * every channel update before it is stored).
 */

export const MAX_GATEWAY_OWNER_IDS = 20;
export const MAX_GATEWAY_OWNER_ID_CHARS = 200;

/**
 * One channel user id: no whitespace, no list separators, no control characters.
 * Ids differ per channel (Telegram and Discord use numbers, Slack `U…`, Matrix
 * `@user:server`, Google Chat `users/…`, phone numbers, email addresses), so the check is
 * structural rather than per-channel.
 */
const OWNER_ID_PATTERN = /^[^\s,;\u0000-\u001f\u007f]+$/;

export interface ParsedGatewayOwnerIds {
  ids: string[];
  invalid: string[];
  tooMany: boolean;
}

/** Split, trim, dedupe and check owner ids typed as text (comma, semicolon or newline). */
export function parseGatewayOwnerIds(input: string | readonly unknown[]): ParsedGatewayOwnerIds {
  const parts: unknown[] = typeof input === "string" ? input.split(/[\n,;]+/) : [...input];
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") {
      invalid.push(String(part));
      continue;
    }
    const value = part.trim();
    if (!value) continue;
    if (value.length > MAX_GATEWAY_OWNER_ID_CHARS || !OWNER_ID_PATTERN.test(value)) {
      invalid.push(value);
      continue;
    }
    if (!ids.includes(value)) ids.push(value);
  }
  return { ids, invalid, tooMany: ids.length > MAX_GATEWAY_OWNER_IDS };
}

/** Owner ids for storage, or an error message the settings UI can show. */
export function validateGatewayOwnerIds(
  input: string | readonly unknown[],
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const parsed = parseGatewayOwnerIds(input);
  if (parsed.invalid.length > 0) {
    const shown = parsed.invalid
      .slice(0, 3)
      .map((value) => `"${value.slice(0, 40)}"`)
      .join(", ");
    return { ok: false, error: `Not a valid account ID: ${shown}. Remove spaces inside an ID.` };
  }
  if (parsed.tooMany) {
    return { ok: false, error: `Enter at most ${MAX_GATEWAY_OWNER_IDS} account IDs.` };
  }
  return { ok: true, ids: parsed.ids };
}

/** Where to find your own account id on a channel, for the settings hint. */
export function gatewayOwnerIdHint(channelType: string): string {
  switch (channelType) {
    case "telegram":
      return "Your numeric Telegram user ID (for example 123456789). It is listed under Authorized Users once you message the bot.";
    case "slack":
      return "Your Slack member ID (starts with U or W). In Slack, open your profile, choose More, then Copy member ID.";
    case "discord":
      return "Your Discord user ID (a long number). Enable Developer Mode in Discord, then right-click your name and choose Copy User ID.";
    case "whatsapp":
      return "Your phone number in international format (for example +15551234567). Self-chat mode already counts as you.";
    case "imessage":
    case "bluebubbles":
    case "signal":
      return "Your phone number in international format or your Apple ID email, as shown under Authorized Users.";
    case "matrix":
      return "Your Matrix user ID, for example @you:matrix.org.";
    case "googlechat":
      return "Your Google Chat user resource name, for example users/123456789.";
    default:
      return "Your user ID on this channel, as shown under Authorized Users after you message CoWork.";
  }
}
