/**
 * Notification inbox tables, apart from the store so schema initialization (and its
 * bootstrap worker) can create them without loading the store's dependencies.
 */
export const NOTIFICATION_INBOX_SCHEMA = `
 CREATE TABLE IF NOT EXISTS notification_inbox_items(id TEXT PRIMARY KEY,payload_json TEXT,dedupe_key TEXT UNIQUE,created_at INTEGER NOT NULL,scope_key TEXT NOT NULL,retired_at INTEGER);
 CREATE INDEX IF NOT EXISTS idx_notification_inbox_current ON notification_inbox_items(retired_at,created_at DESC);
 CREATE TABLE IF NOT EXISTS notification_inbox_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
`;
