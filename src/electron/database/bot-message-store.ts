import type Database from "better-sqlite3";
import type { EventType, TaskEvent } from "../../shared/types";
import {
  BOT_MESSAGE_DUPLICATE_WINDOW_MS,
  BOT_MESSAGE_EVENT_TYPES,
  BOT_MESSAGE_PAGE_DEFAULT_LIMIT,
  BOT_MESSAGE_PAGE_MAX_LIMIT,
  BotGreetingTracker,
  botMessageDedupeKey,
  toBotMessage,
  type BotMessage,
  type BotMessageCursor,
  type BotMessagePage,
  type BotMessagePageRequest,
} from "../../shared/bot-messages";

interface BotMessageEventRow {
  id: string;
  task_id: string;
  timestamp: number;
  type: string;
  legacy_type: string | null;
  payload: string;
}

/** Most message events are kept, so a few batches fill a page even with seeds and receipts. */
const MAX_BATCHES_PER_PAGE = 8;

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toEvent(row: BotMessageEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    timestamp: Number(row.timestamp) || 0,
    type: row.type as EventType,
    ...(row.legacy_type ? { legacyType: row.legacy_type as EventType } : {}),
    payload: parsePayload(row.payload),
    schemaVersion: 2,
  };
}

/**
 * Reads a bot's chat history across all of its conversations, newest first, in
 * pages of messages rather than raw timeline events. Uses the
 * (task_id, effective type, order) index on task_events.
 */
export class BotMessageStore {
  constructor(private readonly db: Database.Database) {}

  findPage(request: BotMessagePageRequest): BotMessagePage {
    const agentRoleId = request.agentRoleId.trim();
    const workspaceId = request.workspaceId.trim();
    const includeAllWorkspaces = request.includeAllWorkspaces === true;
    if (!agentRoleId || (!workspaceId && !includeAllWorkspaces)) {
      return { messages: [], nextCursor: null, hasMore: false };
    }
    const limit = Math.min(
      BOT_MESSAGE_PAGE_MAX_LIMIT,
      Math.max(1, Math.floor(request.limit ?? BOT_MESSAGE_PAGE_DEFAULT_LIMIT)),
    );
    const batchSize = Math.max(40, limit * 2);

    const conversationClauses = [
      "t.assigned_agent_role_id = ?",
      "json_valid(t.agent_config) = 1",
      "json_extract(t.agent_config, '$.botConversation') = 1",
      "COALESCE(t.source, 'manual') <> 'side_chat'",
    ];
    const conversationArgs: Array<string | number> = [agentRoleId];
    if (!includeAllWorkspaces) {
      conversationClauses.push("t.workspace_id = ?");
      conversationArgs.push(workspaceId);
    }
    const beforeConversationId = request.beforeConversationId?.trim();
    if (beforeConversationId) {
      conversationClauses.push(
        "t.id <> ?",
        "t.created_at < COALESCE((SELECT created_at FROM tasks WHERE id = ?), 9e18)",
      );
      conversationArgs.push(beforeConversationId, beforeConversationId);
    }
    const typePlaceholders = BOT_MESSAGE_EVENT_TYPES.map(() => "?").join(", ");
    const pageStatement = this.db.prepare(`
      SELECT e.id, e.task_id, e.timestamp, e.type, e.legacy_type, e.payload
      FROM task_events e
      WHERE e.task_id IN (SELECT t.id FROM tasks t WHERE ${conversationClauses.join(" AND ")})
        AND COALESCE(e.legacy_type, e.type) IN (${typePlaceholders})
        AND (? IS NULL OR e.timestamp < ? OR (e.timestamp = ? AND e.id < ?))
      ORDER BY e.timestamp DESC, e.id DESC
      LIMIT ?
    `);
    // A completion summary repeats the reply written just before it.
    const replyBeforeStatement = this.db.prepare(`
      SELECT 1 FROM task_events
      WHERE task_id = ?
        AND COALESCE(legacy_type, type) = 'assistant_message'
        AND timestamp BETWEEN ? AND ?
      LIMIT 1
    `);

    // Each conversation's greeting window, from its opening seed to the first real message.
    const userMessagesStatement = this.db.prepare(`
      SELECT id, task_id, timestamp, type, legacy_type, payload FROM task_events
      WHERE task_id = ? AND COALESCE(legacy_type, type) = 'user_message'
      ORDER BY timestamp ASC, id ASC
    `);
    const greetingWindows = new Map<string, { from: number; until: number } | null>();
    const isGreetingReply = (taskId: string, timestamp: number): boolean => {
      if (!greetingWindows.has(taskId)) {
        const tracker = new BotGreetingTracker();
        let window: { from: number; until: number } | null = null;
        for (const row of userMessagesStatement.all(taskId) as BotMessageEventRow[]) {
          const event = toEvent(row);
          tracker.isShown(event, toBotMessage(event));
          const awaiting = tracker.isAwaitingFirstMessage(taskId);
          if (awaiting && !window) window = { from: event.timestamp, until: Infinity };
          if (!awaiting && window) {
            window.until = event.timestamp;
            break;
          }
        }
        greetingWindows.set(taskId, window);
      }
      const window = greetingWindows.get(taskId);
      return Boolean(window && timestamp >= window.from && timestamp < window.until);
    };

    const collected: BotMessage[] = [];
    const lastSeenByKey = new Map<string, number>();
    let cursor: BotMessageCursor | null = request.cursor ?? null;
    let hasMore = true;

    for (let batch = 0; batch < MAX_BATCHES_PER_PAGE && collected.length < limit; batch += 1) {
      const rows = pageStatement.all(
        ...conversationArgs,
        ...BOT_MESSAGE_EVENT_TYPES,
        cursor ? cursor.timestamp : null,
        cursor ? cursor.timestamp : null,
        cursor ? cursor.timestamp : null,
        cursor ? cursor.id : "",
        batchSize,
      ) as BotMessageEventRow[];
      if (rows.length < batchSize) hasMore = false;

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        cursor = { timestamp: Number(row.timestamp) || 0, id: row.id };
        const event = toEvent(row);
        const message = toBotMessage(event);
        if (!message) continue;
        const effectiveType = row.legacy_type || row.type;
        if (message.role === "bot" && isGreetingReply(row.task_id, message.timestamp)) continue;
        if (
          effectiveType === "task_completed" &&
          replyBeforeStatement.get(
            row.task_id,
            message.timestamp - BOT_MESSAGE_DUPLICATE_WINDOW_MS,
            message.timestamp,
          )
        ) {
          continue;
        }
        const key = botMessageDedupeKey(event, message);
        const seenAt = lastSeenByKey.get(key);
        lastSeenByKey.set(key, message.timestamp);
        if (
          seenAt !== undefined &&
          Math.abs(seenAt - message.timestamp) <= BOT_MESSAGE_DUPLICATE_WINDOW_MS
        ) {
          continue;
        }
        collected.push(message);
        if (collected.length === limit) {
          // Rows after this one are still unread.
          if (index < rows.length - 1) hasMore = true;
          break;
        }
      }
      if (!hasMore) break;
    }

    return {
      messages: collected.reverse(),
      nextCursor: hasMore ? cursor : null,
      hasMore,
    };
  }
}
