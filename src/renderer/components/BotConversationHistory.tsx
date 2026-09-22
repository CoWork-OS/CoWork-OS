import { Archive, Check, Clock3, MessageCircle, Plus } from "lucide-react";
import { BotGlyph } from "./BotGlyph";
import type { Task } from "../../shared/types";
import type { BotConversationProjection } from "../../shared/bot-lifecycle";
import { isBotConversation } from "../utils/bot-conversations";
import "./BotConversationHistory.css";

export interface BotConversationHistoryProps {
  botName: string;
  botRoleId?: string;
  selectedConversationId?: string | null;
  conversations: Task[];
  loading?: boolean;
  selectedConversationProjection?: Pick<
    BotConversationProjection,
    "state" | "lastActivityAt"
  > | null;
  onSelectConversation?: (conversationId: string) => void | Promise<void>;
  onNewConversation?: (botRoleId: string) => void | Promise<void>;
}

function isArchived(task: Task): boolean {
  return task.sessionArchived === true;
}

const SYNTHETIC_BOT_PROMPT_RE =
  /^(?:start (?:a )?(?:conversation|chatting) with .+|resume the .+ bot conversation)\b/i;

function isSyntheticBotPrompt(value: string): boolean {
  return SYNTHETIC_BOT_PROMPT_RE.test(value.trim());
}

export function getBotConversationTitle(task: Task, index: number, botName: string): string {
  const title = String(task.title || "").trim();
  const genericTitle = !title || title.toLocaleLowerCase() === botName.trim().toLocaleLowerCase();
  if (!genericTitle && !isSyntheticBotPrompt(title)) return title;
  const firstMessage = [task.userPrompt, task.sidebarPromptPreview, task.rawPrompt, task.prompt]
    .map((value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((value) => value && !isSyntheticBotPrompt(value));
  if (firstMessage) {
    return firstMessage.length > 58 ? `${firstMessage.slice(0, 57).trimEnd()}…` : firstMessage;
  }
  if (/^reopened bot conversation$/i.test(task.branchLabel || "")) {
    return "Reopened conversation";
  }
  if (/^repaired bot conversation$/i.test(task.branchLabel || "")) {
    return "Repaired conversation";
  }
  return index === 0 ? "New conversation" : `Conversation ${index + 1}`;
}

function formatConversationDate(timestamp?: number): string {
  if (!timestamp) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
      new Date(timestamp),
    );
  } catch {
    return "";
  }
}

export function getBotConversationHistoryStatusLabel(
  task: Pick<Task, "status" | "error"> & Partial<Pick<Task, "resultSummary">>,
  projection?: Pick<BotConversationProjection, "state"> | null,
): string {
  if (projection?.state === "working") return "Working on latest message";
  if (projection?.state === "waiting") return "Waiting on a teammate";
  if (projection?.state === "needs_input") return "Needs attention";
  if (projection?.state === "failed") return "Unavailable — reopen to retry";
  if (projection?.state === "completed") return "Completed";
  if (task.status === "completed") return "Completed";
  if (task.status === "cancelled" && task.resultSummary?.trim()) return "Completed";
  if (task.status === "failed" || task.status === "cancelled") {
    return "Unavailable — reopen to retry";
  }
  if (task.status === "pending" || task.status === "queued") {
    return "Ready for another message";
  }
  if (task.status === "planning" || task.status === "executing") {
    return "Working on latest message";
  }
  if (
    (task.status === "blocked" || task.status === "paused" || task.status === "interrupted") &&
    /^waiting for .+? to reply(?: before finishing this conversation)?\.?$/i.test(
      String(task.error || "")
        .replace(/\s+/g, " ")
        .trim(),
    )
  ) {
    return "Waiting on a teammate";
  }
  if (task.status === "blocked" || task.status === "paused" || task.status === "interrupted") {
    return "Needs attention";
  }
  return "Ready for another message";
}

export function getBotConversationHistoryTimestamp(
  task: Pick<Task, "id" | "updatedAt" | "createdAt">,
  selectedConversationId?: string | null,
  selectedConversationProjection?: Pick<BotConversationProjection, "lastActivityAt"> | null,
): number {
  const taskTimestamp = task.updatedAt || task.createdAt;
  if (task.id !== selectedConversationId) return taskTimestamp;
  return Math.max(taskTimestamp, selectedConversationProjection?.lastActivityAt || 0);
}

export function BotConversationHistory({
  botName,
  botRoleId,
  selectedConversationId,
  conversations,
  loading = false,
  selectedConversationProjection,
  onSelectConversation,
  onNewConversation,
}: BotConversationHistoryProps) {
  const visible = conversations
    .filter(
      (task) =>
        isBotConversation(task) &&
        task.source !== "side_chat" &&
        (!botRoleId || task.assignedAgentRoleId === botRoleId),
    )
    .sort(
      (a, b) =>
        getBotConversationHistoryTimestamp(
          b,
          selectedConversationId,
          selectedConversationProjection,
        ) -
          getBotConversationHistoryTimestamp(
            a,
            selectedConversationId,
            selectedConversationProjection,
          ) || b.createdAt - a.createdAt,
    );

  return (
    <section className="bot-conversation-history" aria-label={`${botName} conversation history`}>
      <div className="bot-conversation-history-heading">
        <h2 className="bot-conversation-history-title">
          Conversation history
          {visible.length > 0 ? (
            <span className="bot-conversation-history-count">{visible.length}</span>
          ) : null}
        </h2>
        {botRoleId && onNewConversation && (
          <button
            type="button"
            className="bot-conversation-new-button"
            onClick={() => void onNewConversation(botRoleId)}
          >
            <Plus size={14} strokeWidth={2.4} /> New
          </button>
        )}
      </div>
      {loading ? (
        <div className="bot-conversation-history-empty" aria-busy="true">
          Loading conversations…
        </div>
      ) : visible.length === 0 ? (
        <div className="bot-conversation-history-empty">
          <span className="bot-conversation-history-empty-icon" aria-hidden="true">
            <BotGlyph size={20} />
          </span>
          <span>No conversations yet. Start one to keep this bot’s work together.</span>
        </div>
      ) : (
        <div className="bot-conversation-history-list" role="list">
          {visible.map((conversation, index) => {
            const archived = isArchived(conversation);
            const selected = conversation.id === selectedConversationId;
            return (
              <button
                type="button"
                role="listitem"
                key={conversation.id}
                className={`bot-conversation-history-row ${selected ? "selected" : ""} ${archived ? "archived" : ""}`}
                aria-current={selected ? "true" : undefined}
                onClick={() => void onSelectConversation?.(conversation.id)}
              >
                <span className="bot-conversation-history-row-icon" aria-hidden="true">
                  {archived ? (
                    <Archive size={15} />
                  ) : selected ? (
                    <Check size={15} />
                  ) : (
                    <MessageCircle size={15} />
                  )}
                </span>
                <span className="bot-conversation-history-row-copy">
                  <strong>{getBotConversationTitle(conversation, index, botName)}</strong>
                  <span>
                    {archived
                      ? "Archived"
                      : getBotConversationHistoryStatusLabel(
                          conversation,
                          selected ? selectedConversationProjection : null,
                        )}
                    {formatConversationDate(
                      getBotConversationHistoryTimestamp(
                        conversation,
                        selectedConversationId,
                        selected ? selectedConversationProjection : null,
                      ),
                    )
                      ? ` · ${formatConversationDate(
                          getBotConversationHistoryTimestamp(
                            conversation,
                            selectedConversationId,
                            selected ? selectedConversationProjection : null,
                          ),
                        )}`
                      : ""}
                  </span>
                </span>
                {conversation.status === "executing" || conversation.status === "planning" ? (
                  <Clock3
                    className="bot-conversation-history-running"
                    size={14}
                    aria-label="Running"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
