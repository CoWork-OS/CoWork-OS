import Database from "better-sqlite3";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";
import { ChannelRepository } from "../../database/repositories";
import { ChannelType } from "../../gateway/channels/types";

type ChannelHistoryDirection = "incoming" | "outgoing" | "both";

function parseDurationMs(input: string): number | null {
  const match = input
    .trim()
    .match(
      /^(\d+(?:\.\d+)?)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)$/i,
    );
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return value * 1000;
    case "m":
    case "min":
    case "minute":
    case "minutes":
      return value * 60 * 1000;
    case "h":
    case "hr":
    case "hour":
    case "hours":
      return value * 60 * 60 * 1000;
    case "d":
    case "day":
    case "days":
      return value * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

function parseAttachments(
  raw: unknown,
): Array<{ type: string; url?: string; fileName?: string }> | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const safe = parsed
      .map((item) => {
        const type = typeof item?.type === "string" ? item.type : undefined;
        if (!type) return null;
        const url = typeof item?.url === "string" ? item.url : undefined;
        const fileName = typeof item?.fileName === "string" ? item.fileName : undefined;
        return { type, ...(url ? { url } : {}), ...(fileName ? { fileName } : {}) };
      })
      .filter(Boolean) as Array<{ type: string; url?: string; fileName?: string }>;
    return safe.length > 0 ? safe : undefined;
  } catch {
    return undefined;
  }
}

export class ChannelTools {
  private channelRepo: ChannelRepository;

  constructor(
    private db: Database.Database,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {
    this.channelRepo = new ChannelRepository(db);
  }

  static getToolDefinitions(): LLMTool[] {
    // Keep this list in sync with src/electron/gateway/channels/types.ts
    const channelEnum: ChannelType[] = [
      "telegram",
      "discord",
      "slack",
      "whatsapp",
      "imessage",
      "signal",
      "mattermost",
      "matrix",
      "twitch",
      "line",
      "bluebubbles",
      "email",
      "teams",
      "googlechat",
      "x",
    ];

    return [
      {
        name: "channel_list_chats",
        description:
          "List recently active chats for a given messaging channel (from the local gateway message log). " +
          "Use this to discover chat IDs before fetching message history. " +
          "This is privacy-sensitive and may be restricted in shared contexts.",
        input_schema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              enum: channelEnum as unknown as string[],
              description: 'Which channel to query (e.g., "imessage", "slack", "telegram")',
            },
            limit: {
              type: "number",
              description: "Max number of chats to return (default: 20, max: 50)",
            },
            since: {
              type: "string",
              description:
                'Optional activity window. Only include chats with messages in the last duration (e.g., "15m", "24h", "7d").',
            },
          },
          required: ["channel"],
        },
      },
      {
        name: "channel_history",
        description:
          "Fetch recent message history for a specific chat from the local gateway message log. " +
          "Use channel_list_chats first if you do not know the chat_id. " +
          "This is privacy-sensitive and may be restricted in shared contexts.",
        input_schema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              enum: channelEnum as unknown as string[],
              description: 'Which channel to query (e.g., "imessage", "slack", "telegram")',
            },
            chat_id: {
              type: "string",
              description: "Chat/conversation ID (from channel_list_chats or prior messages)",
            },
            limit: {
              type: "number",
              description: "Max number of messages to return (default: 50, max: 200)",
            },
            since: {
              type: "string",
              description:
                'Optional time window to include only messages from the last duration (e.g., "15m", "24h", "7d").',
            },
            direction: {
              type: "string",
              enum: ["incoming", "outgoing", "both"],
              description: "Filter by direction (default: both)",
            },
          },
          required: ["channel", "chat_id"],
        },
      },
    ];
  }

  async listChats(input: { channel: unknown; limit?: unknown; since?: unknown }): Promise<Any> {
    const channelType = typeof input?.channel === "string" ? input.channel.trim() : "";
    const limitRaw = typeof input?.limit === "number" ? input.limit : undefined;
    const limit = Math.min(Math.max(limitRaw ?? 20, 1), 50);
    const sinceRaw = typeof input?.since === "string" ? input.since.trim() : "";

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "channel_list_chats",
      channel: channelType,
      limit,
      since: sinceRaw || undefined,
    });

    if (!channelType) {
      throw new Error('Missing required "channel"');
    }

    const channel = this.channelRepo.findByType(channelType);
    if (!channel) {
      return {
        success: false,
        error: `Channel "${channelType}" is not configured in this CoWork OS instance.`,
      };
    }

    const sinceMs =
      sinceRaw.length > 0
        ? (() => {
            const duration = parseDurationMs(sinceRaw);
            return duration ? Date.now() - duration : null;
          })()
        : undefined;

    if (sinceRaw && sinceMs === null) {
      return {
        success: false,
        error: `Invalid "since" duration: "${sinceRaw}". Use formats like "15m", "24h", "7d".`,
      };
    }

    // Get most recent message per chat, plus count within window.
    const whereParts: string[] = ["channel_id = ?"];
    const params: Any[] = [channel.id];
    if (typeof sinceMs === "number") {
      whereParts.push("timestamp >= ?");
      params.push(sinceMs);
    }

    const whereSql = whereParts.join(" AND ");

    const sql = `
      SELECT
        m.chat_id AS chat_id,
        m.timestamp AS timestamp,
        m.direction AS direction,
        m.content AS content,
        latest.cnt AS message_count
      FROM channel_messages m
      INNER JOIN (
        SELECT chat_id, MAX(timestamp) AS max_ts, COUNT(*) AS cnt
        FROM channel_messages
        WHERE ${whereSql}
        GROUP BY chat_id
        ORDER BY max_ts DESC
        LIMIT ?
      ) latest
        ON latest.chat_id = m.chat_id AND latest.max_ts = m.timestamp
      WHERE m.channel_id = ?
      ORDER BY m.timestamp DESC
      LIMIT ?;
    `;

    const rows = this.db.prepare(sql).all(...params, limit, channel.id, limit) as Array<
      Record<string, unknown>
    >;

    const chats = rows.map((r) => {
      const chatId = String(r.chat_id ?? "");
      const ts = typeof r.timestamp === "number" ? r.timestamp : Number(r.timestamp ?? 0);
      const content = String(r.content ?? "");
      const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;
      const directionRaw =
        typeof r.direction === "string" ? r.direction : String(r.direction ?? "");
      const direction =
        directionRaw === "incoming" ||
        directionRaw === "outgoing" ||
        directionRaw === "outgoing_user"
          ? directionRaw
          : "incoming";
      const messageCount =
        typeof r.message_count === "number" ? r.message_count : Number(r.message_count ?? 0);
      return {
        chat_id: chatId,
        last_message_at_ms: ts,
        last_message_at: new Date(ts).toISOString(),
        last_direction: direction,
        last_preview: preview,
        message_count: messageCount,
      };
    });

    const result = {
      success: true,
      channel: channelType,
      channel_id: channel.id,
      channel_name: channel.name,
      channel_enabled: Boolean(channel.enabled),
      channel_status: channel.status,
      since_ms: typeof sinceMs === "number" ? sinceMs : undefined,
      chats,
      ...(chats.length === 0 && (channel.status === "error" || channel.enabled === false)
        ? {
            warning:
              channel.enabled === false
                ? `Channel "${channelType}" is configured but disabled. Enable it in Settings > Channels.`
                : `Channel "${channelType}" is configured but currently in error. Check Settings > Channels for connection issues.`,
          }
        : {}),
    };

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "channel_list_chats",
      success: true,
      channel: channelType,
      count: chats.length,
    });

    return result;
  }

  async channelHistory(input: {
    channel: unknown;
    chat_id: unknown;
    limit?: unknown;
    since?: unknown;
    direction?: unknown;
  }): Promise<Any> {
    const channelType = typeof input?.channel === "string" ? input.channel.trim() : "";
    const chatId = typeof input?.chat_id === "string" ? input.chat_id.trim() : "";
    const limitRaw = typeof input?.limit === "number" ? input.limit : undefined;
    const limit = Math.min(Math.max(limitRaw ?? 50, 1), 200);
    const sinceRaw = typeof input?.since === "string" ? input.since.trim() : "";
    const directionRaw = typeof input?.direction === "string" ? input.direction.trim() : "";
    const direction: ChannelHistoryDirection =
      directionRaw === "incoming" || directionRaw === "outgoing" ? directionRaw : "both";

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "channel_history",
      channel: channelType,
      chatId,
      limit,
      since: sinceRaw || undefined,
      direction,
    });

    if (!channelType) {
      throw new Error('Missing required "channel"');
    }
    if (!chatId) {
      throw new Error('Missing required "chat_id"');
    }

    const channel = this.channelRepo.findByType(channelType);
    if (!channel) {
      return {
        success: false,
        error: `Channel "${channelType}" is not configured in this CoWork OS instance.`,
      };
    }

    const sinceMs =
      sinceRaw.length > 0
        ? (() => {
            const duration = parseDurationMs(sinceRaw);
            return duration ? Date.now() - duration : null;
          })()
        : undefined;

    if (sinceRaw && sinceMs === null) {
      return {
        success: false,
        error: `Invalid "since" duration: "${sinceRaw}". Use formats like "15m", "24h", "7d".`,
      };
    }

    const whereParts: string[] = ["m.channel_id = ?", "m.chat_id = ?"];
    const params: Any[] = [channel.id, chatId];
    if (typeof sinceMs === "number") {
      whereParts.push("m.timestamp >= ?");
      params.push(sinceMs);
    }
    if (direction !== "both") {
      whereParts.push("m.direction = ?");
      params.push(direction);
    }

    const sql = `
      SELECT
        m.id AS id,
        m.channel_message_id AS channel_message_id,
        m.chat_id AS chat_id,
        m.user_id AS user_id,
        m.direction AS direction,
        m.content AS content,
        m.attachments AS attachments,
        m.timestamp AS timestamp,
        u.channel_user_id AS channel_user_id,
        u.display_name AS display_name
      FROM channel_messages m
      LEFT JOIN channel_users u
        ON u.id = m.user_id
      WHERE ${whereParts.join(" AND ")}
      ORDER BY m.timestamp DESC
      LIMIT ?;
    `;

    const rows = this.db.prepare(sql).all(...params, limit) as Array<Record<string, unknown>>;
    const messages = rows
      .map((r) => {
        const ts = typeof r.timestamp === "number" ? r.timestamp : Number(r.timestamp ?? 0);
        const displayName = typeof r.display_name === "string" ? r.display_name : undefined;
        const channelUserId = typeof r.channel_user_id === "string" ? r.channel_user_id : undefined;
        const user =
          channelUserId || displayName ? { id: channelUserId, name: displayName } : undefined;
        const attachments = parseAttachments(r.attachments);
        const directionRaw =
          typeof r.direction === "string" ? r.direction : String(r.direction ?? "");
        const dir =
          directionRaw === "incoming" ||
          directionRaw === "outgoing" ||
          directionRaw === "outgoing_user"
            ? directionRaw
            : "incoming";
        return {
          id: String(r.id ?? ""),
          channel_message_id: String(r.channel_message_id ?? ""),
          direction: dir,
          timestamp_ms: ts,
          timestamp: new Date(ts).toISOString(),
          user,
          content: String(r.content ?? ""),
          attachments,
        };
      })
      .reverse();

    const result = {
      success: true,
      channel: channelType,
      channel_id: channel.id,
      channel_name: channel.name,
      channel_enabled: Boolean(channel.enabled),
      channel_status: channel.status,
      chat_id: chatId,
      since_ms: typeof sinceMs === "number" ? sinceMs : undefined,
      direction,
      messages,
      ...(messages.length === 0 && (channel.status === "error" || channel.enabled === false)
        ? {
            warning:
              channel.enabled === false
                ? `Channel "${channelType}" is configured but disabled. Enable it in Settings > Channels.`
                : `Channel "${channelType}" is configured but currently in error. Check Settings > Channels for connection issues.`,
          }
        : {}),
    };

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "channel_history",
      success: true,
      channel: channelType,
      count: messages.length,
    });

    return result;
  }
}
