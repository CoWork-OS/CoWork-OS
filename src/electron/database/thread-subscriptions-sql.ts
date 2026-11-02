import type Database from "better-sqlite3";

export { THREAD_SUBSCRIPTIONS_SCHEMA_SQL } from "./thread-subscriptions-schema";

/**
 * Thread subscriptions: which tasks receive later events of a conversation thread (an IM
 * thread, a pull request or issue, an email chain). The task created for the first event
 * in a thread subscribes; later events in that thread go to it instead of starting new
 * work. Keys: `channelType:channelId:chatId:threadId` (gateway), `github:<repo>:pr:<n>`
 * or `github:<repo>:issue:<n>`, `mail:<threadId>`.
 */

/** Task statuses that can still take a follow-up. */
export const THREAD_SUBSCRIBER_ACTIVE_STATUSES = [
  "pending",
  "planning",
  "executing",
  "paused",
] as const;

export interface ThreadSubscription {
  threadKey: string;
  taskId: string;
  createdAt: number;
}

interface ThreadSubscriptionRow {
  thread_key: string;
  task_id: string;
  created_at: number;
}

function mapRow(row: ThreadSubscriptionRow): ThreadSubscription {
  return { threadKey: row.thread_key, taskId: row.task_id, createdAt: row.created_at };
}

export class ThreadSubscriptionStore {
  constructor(private readonly db: Database.Database) {}

  /** Subscribe a task; true when it was not subscribed yet. */
  subscribe(threadKey: string, taskId: string, createdAt: number): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_subscriptions (thread_key, task_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(threadKey, taskId, createdAt);
    return result.changes > 0;
  }

  unsubscribe(threadKey: string, taskId: string): number {
    return this.db
      .prepare("DELETE FROM thread_subscriptions WHERE thread_key = ? AND task_id = ?")
      .run(threadKey, taskId).changes;
  }

  /** Remove every subscription of a task (it finished or failed). */
  unsubscribeTask(taskId: string): number {
    return this.db.prepare("DELETE FROM thread_subscriptions WHERE task_id = ?").run(taskId)
      .changes;
  }

  listForThread(threadKey: string): ThreadSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT thread_key, task_id, created_at FROM thread_subscriptions
         WHERE thread_key = ? ORDER BY created_at ASC, task_id ASC`,
      )
      .all(threadKey) as ThreadSubscriptionRow[];
    return rows.map(mapRow);
  }

  listForTask(taskId: string): ThreadSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT thread_key, task_id, created_at FROM thread_subscriptions
         WHERE task_id = ? ORDER BY created_at ASC, thread_key ASC`,
      )
      .all(taskId) as ThreadSubscriptionRow[];
    return rows.map(mapRow);
  }

  /** Ids of subscribed tasks that can still take a follow-up, oldest subscription first. */
  findActiveSubscribers(threadKey: string): string[] {
    const placeholders = THREAD_SUBSCRIBER_ACTIVE_STATUSES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT s.task_id FROM thread_subscriptions s
         JOIN tasks t ON t.id = s.task_id
         WHERE s.thread_key = ? AND t.status IN (${placeholders})
         ORDER BY s.created_at ASC, s.task_id ASC`,
      )
      .all(threadKey, ...THREAD_SUBSCRIBER_ACTIVE_STATUSES) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }
}
