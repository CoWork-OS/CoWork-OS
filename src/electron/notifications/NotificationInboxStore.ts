import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AppNotification } from "../../shared/types";
import { BotNotificationStore } from "./BotNotificationStore";
import type { SchedulerFence } from "../automation/scheduler-lease-store";
export const NOTIFICATION_INBOX_SCHEMA = `
 CREATE TABLE IF NOT EXISTS notification_inbox_items(id TEXT PRIMARY KEY,payload_json TEXT,dedupe_key TEXT UNIQUE,created_at INTEGER NOT NULL,scope_key TEXT NOT NULL,retired_at INTEGER);
 CREATE INDEX IF NOT EXISTS idx_notification_inbox_current ON notification_inbox_items(retired_at,created_at DESC);
 CREATE TABLE IF NOT EXISTS notification_inbox_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
`;
export interface BotInboxAuthority {
  ids: string[];
  fence: SchedulerFence;
}
interface Row {
  id: string;
  payload_json: string | null;
  created_at: number;
  scope_key: string;
  retired_at: number | null;
}
function scopeKey(notification: AppNotification): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        notification.workspaceId ?? null,
        notification.agentRoleId ?? null,
        notification.taskId ?? null,
      ]),
    )
    .digest("hex");
}
/** Canonical profile inbox. Mutations and bounded retention are SQLite transactions. */
export class NotificationInboxStore {
  constructor(private db: Database.Database) {}
  initialize(legacy: Array<{ notification: AppNotification; key: string | null }>): void {
    this.db
      .transaction(() => {
        if (
          this.db.prepare("SELECT 1 FROM notification_inbox_meta WHERE key='legacy_import'").get()
        )
          return;
        for (const { notification, key } of [...legacy]
          .sort((a, b) => b.notification.createdAt - a.notification.createdAt)
          .slice(0, 100))
          this.db
            .prepare(
              "INSERT OR IGNORE INTO notification_inbox_items(id,payload_json,dedupe_key,created_at,scope_key) VALUES(?,?,?,?,?)",
            )
            .run(
              notification.id,
              JSON.stringify(notification),
              key,
              notification.createdAt,
              scopeKey(notification),
            );
        this.trim();
        this.db.prepare("INSERT INTO notification_inbox_meta VALUES('legacy_import','1')").run();
      })
      .immediate();
  }
  list(): AppNotification[] {
    return (
      this.db
        .prepare(
          "SELECT payload_json FROM notification_inbox_items WHERE payload_json IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 100",
        )
        .all() as Array<{ payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json) as AppNotification);
  }
  contains(id: string): boolean {
    return !!this.db.prepare("SELECT id FROM notification_inbox_items WHERE id=?").get(id);
  }
  add(
    notification: AppNotification,
    key: string | null,
    authority?: BotInboxAuthority,
  ): { notification: AppNotification; added: boolean } {
    return this.db
      .transaction(() => {
        if (authority) {
          if (
            !authority.ids.length ||
            authority.ids.length > 50 ||
            new Set(authority.ids).size !== authority.ids.length
          )
            throw Error("Invalid bot inbox authority");
          new BotNotificationStore(this.db).assertDelivery(authority.ids, authority.fence);
          for (const id of authority.ids) {
            const row = this.db
              .prepare(
                "SELECT workspace_id,agent_role_id,notification_id,task_id FROM bot_notification_intents WHERE id=?",
              )
              .get(id) as {
              workspace_id: string;
              agent_role_id: string;
              notification_id: string;
              task_id: string;
            };
            if (
              row.workspace_id !== notification.workspaceId ||
              row.agent_role_id !== notification.agentRoleId ||
              row.notification_id !== notification.id ||
              (authority.ids.length === 1
                ? row.task_id !== notification.taskId
                : notification.taskId !== undefined)
            )
              throw Error("Inbox delivery belongs to another scope or identity");
          }
        }
        if (authority) {
          const cohort = this.db
            .prepare(
              "SELECT COUNT(*) count FROM bot_notification_intents WHERE notification_id=? AND state='delivering'",
            )
            .get(notification.id) as { count: number };
          if (cohort.count !== authority.ids.length) throw Error("Inbox delivery cohort changed");
        }
        const exact = this.db
          .prepare("SELECT * FROM notification_inbox_items WHERE id=?")
          .get(notification.id) as Row | undefined;
        if (exact) {
          const stored = exact.payload_json
            ? (JSON.parse(exact.payload_json) as AppNotification)
            : undefined;
          if (exact.scope_key !== scopeKey(notification))
            throw Error("Notification identity belongs to another scope");
          return {
            notification: stored ?? { ...notification, read: true, createdAt: exact.created_at },
            added: false,
          };
        }
        if (key) {
          const existing = this.db
            .prepare(
              "SELECT payload_json FROM notification_inbox_items WHERE dedupe_key=? AND payload_json IS NOT NULL",
            )
            .get(key) as { payload_json: string } | undefined;
          if (existing)
            return {
              notification: JSON.parse(existing.payload_json) as AppNotification,
              added: false,
            };
        }
        this.db
          .prepare(
            "INSERT INTO notification_inbox_items(id,payload_json,dedupe_key,created_at,scope_key) VALUES(?,?,?,?,?)",
          )
          .run(
            notification.id,
            JSON.stringify(notification),
            key,
            notification.createdAt,
            scopeKey(notification),
          );
        this.trim();
        return { notification, added: true };
      })
      .immediate();
  }
  markRead(id: string): AppNotification | null {
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            "SELECT payload_json FROM notification_inbox_items WHERE id=? AND payload_json IS NOT NULL",
          )
          .get(id) as { payload_json: string } | undefined;
        if (!row) return null;
        const value = { ...JSON.parse(row.payload_json), read: true } as AppNotification;
        this.db
          .prepare("UPDATE notification_inbox_items SET payload_json=? WHERE id=?")
          .run(JSON.stringify(value), id);
        return value;
      })
      .immediate();
  }
  markAllRead(): AppNotification[] {
    return this.db
      .transaction(() => {
        for (const value of this.list()) {
          if (value.read) continue;
          this.db
            .prepare(
              "UPDATE notification_inbox_items SET payload_json=? WHERE id=? AND payload_json IS NOT NULL",
            )
            .run(JSON.stringify({ ...value, read: true }), value.id);
        }
        return this.list();
      })
      .immediate();
  }
  delete(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE notification_inbox_items SET payload_json=NULL,dedupe_key=NULL,retired_at=? WHERE id=? AND payload_json IS NOT NULL",
        )
        .run(Date.now(), id).changes > 0
    );
  }
  deleteAll(): void {
    this.db
      .prepare(
        "UPDATE notification_inbox_items SET payload_json=NULL,dedupe_key=NULL,retired_at=? WHERE payload_json IS NOT NULL",
      )
      .run(Date.now());
  }
  private trim(): void {
    this.db
      .prepare(
        "UPDATE notification_inbox_items SET payload_json=NULL,dedupe_key=NULL,retired_at=? WHERE payload_json IS NOT NULL AND id NOT IN(SELECT id FROM notification_inbox_items WHERE payload_json IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 100)",
      )
      .run(Date.now());
  }
}
