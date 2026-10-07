import type Database from "better-sqlite3";
import { assertSchedulerFence, type SchedulerFence } from "./scheduler-lease-store";

/** Matches the trigger occurrence journal's deduplication window. */
export const BOT_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface BotReceiptPruneResult {
  notificationIntents: number;
  channelDecisionRoutes: number;
}

/**
 * Bounded retention for the high-volume bot delivery history. After the retention
 * window it removes notification intents that were stored or cancelled for work that
 * has finished with no pending decision (so rediscovery cannot re-create them), and
 * handled or sent channel decision routes not bound to an approval consumption record
 * (their approvals expired long ago, and a callback needs a live route). Idempotency
 * receipts for user requests, unresolved deliveries, stop intents, approvals, tasks
 * and lineage are never pruned. Runs in the storage domain under the scheduler fence.
 */
export class BotReceiptRetentionStore {
  constructor(private db: Database.Database) {}

  prune(now: number, fence: SchedulerFence): BotReceiptPruneResult {
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid retention time");
    const cutoff = now - BOT_RECEIPT_RETENTION_MS;
    const has = (table: string) =>
      !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    return this.db
      .transaction((): BotReceiptPruneResult => {
        // A process that lost scheduler ownership must not mutate shared history.
        assertSchedulerFence(this.db, fence, now);
        const run = (table: string, sql: string, ...args: unknown[]) =>
          has(table) ? this.db.prepare(sql).run(...args).changes : 0;
        return {
          notificationIntents: run(
            "bot_notification_intents",
            `DELETE FROM bot_notification_intents
             WHERE state IN ('stored_in_inbox','cancelled') AND created_at < ?
               AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=bot_notification_intents.task_id
                 AND t.status IN ('completed','failed','cancelled'))
               AND NOT EXISTS (SELECT 1 FROM approvals a
                 WHERE a.task_id=bot_notification_intents.task_id AND a.status='pending')
               AND NOT EXISTS (SELECT 1 FROM input_requests i
                 WHERE i.task_id=bot_notification_intents.task_id AND i.status='pending')`,
            cutoff,
          ),
          channelDecisionRoutes: run(
            "channel_decision_routes",
            `DELETE FROM channel_decision_routes
             WHERE state IN ('handled','sent') AND updated_at < ?
               AND NOT EXISTS (SELECT 1 FROM channel_approval_consumption c
                 WHERE c.route_id=channel_decision_routes.id)`,
            cutoff,
          ),
        };
      })
      .immediate();
  }
}
