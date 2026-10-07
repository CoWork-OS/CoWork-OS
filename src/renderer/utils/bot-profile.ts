import { stripAllEmojis } from "./emoji-replacer";
export const BOT_PROFILE_DESCRIPTION_MAX_LENGTH = 12_000;
export const BOT_PROFILE_INSTRUCTIONS_MAX_LENGTH = 12_000;

export function normalizeBotProfileText(value: string | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim();
}

/** A bot's display name as create and edit both save it: one line, no emoji. */
export function normalizeBotDisplayName(value: string | undefined): string {
  return stripAllEmojis(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
