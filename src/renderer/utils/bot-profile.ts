export const BOT_PROFILE_DESCRIPTION_MAX_LENGTH = 12_000;
export const BOT_PROFILE_INSTRUCTIONS_MAX_LENGTH = 12_000;

export function normalizeBotProfileText(value: string | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim();
}
