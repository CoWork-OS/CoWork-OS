import type { TaskEvent } from "./types";
import { parseAgentMessageProtocolResult } from "./agent-message-receipt";
import { formatUserFacingCompletionSummary } from "./task-completion";

/** One chat message in a bot's history, across all of its conversations. */
export interface BotMessage {
  /** The task event id. */
  id: string;
  /** The conversation (task) the message belongs to. */
  conversationId: string;
  /** `teammate` is another bot whose message was relayed into the chat. */
  role: "user" | "bot" | "teammate";
  /** Who wrote it, when the event names someone (a teammate or a relaying bot). */
  senderLabel?: string;
  /** Raw message text; the renderer applies its display cleanup. */
  text: string;
  timestamp: number;
  /** The text was cut to `BOT_MESSAGE_TEXT_MAX_CHARS`. */
  truncated?: boolean;
}

/** Position of the oldest message already shown; the next page starts below it. */
export interface BotMessageCursor {
  timestamp: number;
  id: string;
}

export interface BotMessagePageRequest {
  workspaceId: string;
  /** Include conversations from prior temporary UI workspaces. */
  includeAllWorkspaces?: boolean;
  agentRoleId: string;
  /** Only conversations that started before this one, which the live transcript shows. */
  beforeConversationId?: string;
  cursor?: BotMessageCursor | null;
  limit?: number;
}

export interface BotMessagePage {
  /** Oldest first. */
  messages: BotMessage[];
  nextCursor: BotMessageCursor | null;
  hasMore: boolean;
}

export const BOT_MESSAGE_PAGE_DEFAULT_LIMIT = 30;
export const BOT_MESSAGE_PAGE_MAX_LIMIT = 100;
export const BOT_MESSAGE_TEXT_MAX_CHARS = 40_000;
/** The event types that can carry a chat message. */
export const BOT_MESSAGE_EVENT_TYPES = ["user_message", "assistant_message", "task_completed"];

/** Prompts the app writes to open a chat (including the legacy reopen seed); never user words. */
const BOT_CONVERSATION_SEED_RE =
  /^(?:start (?:a )?(?:conversation|chatting) with .+|resume the .+ bot conversation)\b/i;

export function isBotConversationSeedPrompt(value: string | null | undefined): boolean {
  return typeof value === "string" && BOT_CONVERSATION_SEED_RE.test(value.trim());
}

/**
 * Recovery attempts used to be persisted as ordinary user-message events. They
 * belong in the activity log, not in the conversation as user instructions.
 */
export const BOT_CONVERSATION_INTERNAL_PROMPT_PATTERNS: readonly RegExp[] = [
  /^\s*\[RETRY CONTEXT\]:/i,
  /^\s*Recovery run(?:\s+for\b|\b)/i,
  /\bread-only\s+opportunity-discovery\b[\s\S]*\b(?:send_agent_message|do not merely describe or simulate)\b/i,
];

/**
 * Approval prompts the bot posted as replies. Their buttons belong to the live
 * conversation, so in history they read as open questions that cannot be answered.
 */
const BOT_APPROVAL_MESSAGE_SOURCES = new Set([
  "assistant_approval_request",
  "assistant_approval_timeout",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  }
  return "";
}

function effectiveType(event: Pick<TaskEvent, "type" | "legacyType">): string {
  return String(event.legacyType || event.type);
}

/** The chat message an event carries, or null for seeds, receipts and internal turns. */
export function toBotMessage(event: TaskEvent): BotMessage | null {
  const type = effectiveType(event);
  const payload = asRecord(event.payload);
  let role: BotMessage["role"];
  let senderLabel = "";
  let text = "";

  if (type === "user_message") {
    text = typeof payload.message === "string" ? payload.message.trim() : "";
    if (payload.messageSource === "agent") {
      role = "teammate";
      senderLabel = firstText(payload.senderLabel) || "Teammate";
    } else {
      role = "user";
      if (isBotConversationSeedPrompt(text)) return null;
      if (BOT_CONVERSATION_INTERNAL_PROMPT_PATTERNS.some((pattern) => pattern.test(text))) {
        return null;
      }
    }
  } else if (type === "assistant_message") {
    if (payload.internal === true) return null;
    if (typeof payload.source === "string" && BOT_APPROVAL_MESSAGE_SOURCES.has(payload.source)) {
      return null;
    }
    text = typeof payload.message === "string" ? payload.message.trim() : "";
    // Delivery receipts are transport status, not something the bot said.
    if (text && parseAgentMessageProtocolResult(text)) return null;
    role = "bot";
    senderLabel = firstText(
      payload.senderAgentRoleName,
      payload.fromAgentRoleName,
      payload.agentName,
    );
  } else if (type === "task_completed") {
    text = formatUserFacingCompletionSummary({
      resultSummary: payload.resultSummary,
      verificationVerdict: payload.verificationVerdict,
      verificationReport: payload.verificationReport,
    }).trim();
    if (text && parseAgentMessageProtocolResult(text)) return null;
    role = "bot";
  } else {
    return null;
  }

  if (!text) return null;
  const truncated = text.length > BOT_MESSAGE_TEXT_MAX_CHARS;
  return {
    id: event.id,
    conversationId: event.taskId,
    role,
    ...(senderLabel ? { senderLabel } : {}),
    text: truncated ? `${text.slice(0, BOT_MESSAGE_TEXT_MAX_CHARS).trimEnd()}…` : text,
    timestamp: Number.isFinite(event.timestamp) ? event.timestamp : 0,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** A retried write can persist the same message twice; keep it once. */
export function botMessageDedupeKey(event: TaskEvent, message: BotMessage): string {
  const payload = asRecord(event.payload);
  const messageId = firstText(payload.messageId, payload.message_id);
  const identity = messageId
    ? `id:${messageId}`
    : `text:${message.text.replace(/\s+/g, " ").trim().toLowerCase()}`;
  return `${message.conversationId}|${effectiveType(event)}|${identity}`;
}

/** Repeats of one message are written within this window of each other. */
export const BOT_MESSAGE_DUPLICATE_WINDOW_MS = 30_000;

/**
 * Tracks the bot's reply to the prompt that opens a conversation ("Start chatting
 * with X"). That greeting repeats in every conversation, so a reply that comes after
 * the seed and before anything the user or a teammate sent is not shown.
 */
export class BotGreetingTracker {
  private readonly awaitingFirstMessage = new Set<string>();

  /** Feed events of one conversation oldest first; returns false for a greeting reply. */
  isShown(event: TaskEvent, message: BotMessage | null): boolean {
    const type = effectiveType(event);
    if (type === "user_message") {
      const payload = asRecord(event.payload);
      const text = typeof payload.message === "string" ? payload.message : "";
      if (payload.messageSource !== "agent" && isBotConversationSeedPrompt(text)) {
        this.awaitingFirstMessage.add(event.taskId);
      } else if (message) {
        this.awaitingFirstMessage.delete(event.taskId);
      }
      return true;
    }
    if (type === "assistant_message" || type === "task_completed") {
      return !this.isAwaitingFirstMessage(event.taskId);
    }
    return true;
  }

  /** Between the opening seed and the first message the user or a teammate sent. */
  isAwaitingFirstMessage(conversationId: string): boolean {
    return this.awaitingFirstMessage.has(conversationId);
  }
}
