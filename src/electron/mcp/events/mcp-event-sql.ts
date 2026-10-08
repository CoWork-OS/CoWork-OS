import type Database from "better-sqlite3";

/** Subscription state shared by the desktop and headless MCP event runtimes. */
export const MCP_EVENT_SCHEMA = `CREATE TABLE IF NOT EXISTS mcp_event_subscriptions (
  trigger_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  delivery TEXT NOT NULL,
  callback_url TEXT,
  secret_encrypted TEXT,
  server_subscription_id TEXT,
  cursor TEXT,
  refresh_before INTEGER,
  next_poll_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT
)`;

export interface SubscriptionRow {
  trigger_id: string;
  server_id: string;
  event_name: string;
  arguments_json: string;
  delivery: "webhook" | "poll";
  callback_url: string | null;
  secret_encrypted: string | null;
  server_subscription_id: string | null;
  cursor: string | null;
  refresh_before: number | null;
  next_poll_at: number | null;
  status: string;
  last_error: string | null;
}

/** SQL only runs inside services-domain units, on the worker when enabled. */
export class MCPEventSqlStore {
  constructor(private readonly db: Database.Database) {}

  list(): SubscriptionRow[] {
    return this.db.prepare("SELECT * FROM mcp_event_subscriptions").all() as SubscriptionRow[];
  }

  get(triggerId: string): SubscriptionRow | undefined {
    return this.db
      .prepare("SELECT * FROM mcp_event_subscriptions WHERE trigger_id=?")
      .get(triggerId) as SubscriptionRow | undefined;
  }

  insert(
    row: Pick<
      SubscriptionRow,
      | "trigger_id"
      | "server_id"
      | "event_name"
      | "arguments_json"
      | "delivery"
      | "callback_url"
      | "secret_encrypted"
    >,
  ): void {
    this.db
      .prepare(`INSERT INTO mcp_event_subscriptions
        (trigger_id, server_id, event_name, arguments_json, delivery, callback_url,
         secret_encrypted, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(
        row.trigger_id,
        row.server_id,
        row.event_name,
        row.arguments_json,
        row.delivery,
        row.callback_url,
        row.secret_encrypted,
      );
  }

  insertError(
    triggerId: string,
    serverId: string,
    eventName: string,
    argumentsJson: string,
    delivery: "webhook" | "poll",
    message: string,
    nextPollAt: number,
  ): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO mcp_event_subscriptions
        (trigger_id, server_id, event_name, arguments_json, delivery,
         callback_url, secret_encrypted, status, last_error, next_poll_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 'error', ?, ?)`)
      .run(triggerId, serverId, eventName, argumentsJson, delivery, message, nextPollAt);
  }

  setSecret(triggerId: string, encrypted: string): void {
    this.db
      .prepare("UPDATE mcp_event_subscriptions SET secret_encrypted=? WHERE trigger_id=?")
      .run(encrypted, triggerId);
  }

  setSubscribed(
    triggerId: string,
    subscriptionId: string,
    cursor: string | null,
    refreshBefore: number | null,
    nextPollAt: number,
    status: string,
    error: string | null,
  ): void {
    this.db
      .prepare(`UPDATE mcp_event_subscriptions SET server_subscription_id=?, cursor=?,
        refresh_before=?, next_poll_at=?, status=?, last_error=? WHERE trigger_id=?`)
      .run(subscriptionId, cursor, refreshBefore, nextPollAt, status, error, triggerId);
  }

  setPolled(
    triggerId: string,
    cursor: string | null,
    nextPollAt: number,
    status: string,
    error: string | null,
  ): void {
    this.db
      .prepare(`UPDATE mcp_event_subscriptions SET cursor=?, next_poll_at=?,
        status=?, last_error=? WHERE trigger_id=?`)
      .run(cursor, nextPollAt, status, error, triggerId);
  }

  delete(triggerId: string): void {
    this.db.prepare("DELETE FROM mcp_event_subscriptions WHERE trigger_id=?").run(triggerId);
  }

  setGap(triggerId: string, cursor: string | null, message: string): void {
    this.db
      .prepare(
        "UPDATE mcp_event_subscriptions SET cursor=?, status='gap', last_error=? WHERE trigger_id=?",
      )
      .run(cursor, message, triggerId);
  }

  setCursor(triggerId: string, cursor: string): void {
    this.db
      .prepare("UPDATE mcp_event_subscriptions SET cursor=? WHERE trigger_id=?")
      .run(cursor, triggerId);
  }

  setError(triggerId: string, status: string, message: string, nextPollAt: number): void {
    this.db
      .prepare(
        "UPDATE mcp_event_subscriptions SET status=?, last_error=?, next_poll_at=? WHERE trigger_id=?",
      )
      .run(status, message, nextPollAt, triggerId);
  }
}
