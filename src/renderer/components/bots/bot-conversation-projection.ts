import type { ManagedSessionEvent } from "../../../shared/types";

export interface BotConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

function payloadText(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const contentText = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
  if (contentText) return contentText;

  for (const key of ["message", "text", "summary", "result"]) {
    if (typeof payload[key] === "string" && payload[key]) return String(payload[key]);
  }
  return "";
}

function legacyType(event: ManagedSessionEvent): string {
  const direct = event.payload.legacyType;
  if (typeof direct === "string") return direct;
  const nested = event.payload.payload;
  if (nested && typeof nested === "object") {
    const nestedType = (nested as Record<string, unknown>).legacyType;
    if (typeof nestedType === "string") return nestedType;
  }
  return "";
}

export function cleanBotUserMessage(text: string): string {
  return text
    .replace(/^Message from the user(?:\s*\([^\n]*\))?:\s*/i, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export function projectBotConversation(events: ManagedSessionEvent[]): BotConversationMessage[] {
  const messages: BotConversationMessage[] = [];

  for (const event of events) {
    const bridgedType = legacyType(event);
    const role =
      event.type === "user.message"
        ? "user"
        : event.type === "assistant.message" || bridgedType === "assistant_message"
          ? "assistant"
          : undefined;

    // The runtime also bridges an expanded user prompt containing agent policy and
    // execution context. The canonical user.message is the user-facing source.
    if (!role || bridgedType === "user_message") continue;

    const rawText = payloadText(event.payload);
    const text = role === "user" ? cleanBotUserMessage(rawText) : rawText.trim();
    if (!text) continue;

    const previous = messages.at(-1);
    if (previous?.role === role && previous.text === text) continue;
    messages.push({ id: event.id, role, text, timestamp: event.timestamp });
  }

  return messages;
}

export function latestBotConversationFailure(events: ManagedSessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "session.failed" && legacyType(event) !== "error") continue;
    const error = event.payload.error;
    const message = event.payload.message;
    const text = typeof error === "string" ? error : typeof message === "string" ? message : "";
    if (text.trim()) return text.trim();
  }
  return undefined;
}
