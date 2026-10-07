/** Minimal authenticated routing metadata. No message text, user profile or credentials. */
export interface TeamsDecisionReference {
  channelId: "msteams";
  serviceUrl: string;
  bot: { id: string };
  conversation: { id: string; tenantId: string };
}
export interface TeamsDecisionReferencePersistence {
  save(reference: TeamsDecisionReference): Promise<void>;
  load(chatId: string): Promise<TeamsDecisionReference | undefined>;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, max = 2048): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("Invalid Teams reference");
  return value;
}
export function normalizeTeamsDecisionReference(
  value: unknown,
  tenantId: string,
  chatId?: string,
): TeamsDecisionReference {
  const ref = record(value),
    bot = record(ref.bot),
    conversation = record(ref.conversation);
  if (
    ref.channelId !== "msteams" ||
    conversation.tenantId !== tenantId ||
    !tenantId ||
    (chatId && conversation.id !== chatId)
  )
    throw new Error("Teams reference scope changed");
  const serviceUrl = text(ref.serviceUrl),
    url = new URL(serviceUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
    throw new Error("Invalid Teams service URL");
  return {
    channelId: "msteams",
    serviceUrl,
    bot: { id: text(bot.id, 512) },
    conversation: { id: text(conversation.id), tenantId: text(tenantId, 200) },
  };
}
