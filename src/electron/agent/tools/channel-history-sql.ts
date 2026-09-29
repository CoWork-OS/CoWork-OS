import type Database from "better-sqlite3";

/**
 * Channel history reads for the channel tools (async SQLite migration plan, DB6): chat
 * summaries and a chat's messages. As services-domain units these run in the database
 * worker when the domain is routed there.
 */
export class ChannelHistoryStore {
  constructor(private readonly db: Database.Database) {}

  chatSummaries(
    channelId: string,
    sinceMs: number | null,
    limit: number,
  ): Array<Record<string, unknown>> {
    const channel = { id: channelId };
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
    return this.db.prepare(sql).all(...params, limit, channel.id, limit) as Array<
      Record<string, unknown>
    >;
  }

  chatMessages(
    channelId: string,
    chatId: string,
    sinceMs: number | null,
    direction: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    const channel = { id: channelId };
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
    return this.db.prepare(sql).all(...params, limit) as Array<Record<string, unknown>>;
  }
}
