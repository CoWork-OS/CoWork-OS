/**
 * Table SQL for thread subscriptions (ThreadSubscriptionRepository.ts), kept in a leaf
 * module so the schema bootstrap worker loads it without the store.
 */
export const THREAD_SUBSCRIPTIONS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS thread_subscriptions (
    thread_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_key, task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_thread_subscriptions_task ON thread_subscriptions(task_id);
`;
