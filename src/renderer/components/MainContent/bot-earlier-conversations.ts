import { resolveBotMascot, type BotMascotId } from "../../../shared/bot-mascots";

/** "Today", "Yesterday", "Mon, Oct 5", or "Oct 5, 2025" for other years. */
export function formatBotHistoryDay(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDifference = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (dayDifference === 0) return "Today";
  if (dayDifference === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    ...(date.getFullYear() === today.getFullYear()
      ? { weekday: "short" as const }
      : { year: "numeric" as const }),
    month: "short",
    day: "numeric",
  });
}

export type BotMascotLookup = (senderLabel: string) => BotMascotId | null;

function normalizeSenderLabel(value: string | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** Finds a teammate's character from the name a relayed message carries. */
export function buildBotMascotLookup(
  roles: ReadonlyArray<{ displayName?: string; name?: string; icon?: string }>,
): BotMascotLookup {
  const byLabel = new Map<string, BotMascotId>();
  for (const role of roles) {
    const mascot = resolveBotMascot(role.icon);
    for (const label of [role.displayName, role.name]) {
      const key = normalizeSenderLabel(label);
      if (key && !byLabel.has(key)) byLabel.set(key, mascot);
    }
  }
  return (senderLabel) => byLabel.get(normalizeSenderLabel(senderLabel)) ?? null;
}
