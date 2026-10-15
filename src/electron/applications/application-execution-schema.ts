/**
 * Application execution tables, apart from the store so schema initialization (and its
 * bootstrap worker) can create them without loading zod and the execution contracts.
 */
export const APPLICATION_EXECUTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS application_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  revision INTEGER NOT NULL,
  execution TEXT NOT NULL,
  data TEXT NOT NULL,
  owner TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_application_operations_task ON application_operations(task_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_application_operations_recovery ON application_operations(execution, lease_until);
CREATE TABLE IF NOT EXISTS application_operation_attempts (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES application_operations(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_application_attempts_operation ON application_operation_attempts(operation_id, generation);
CREATE TABLE IF NOT EXISTS application_resource_locks (
  scope TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES application_operations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS application_operation_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES application_operations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_application_events_operation ON application_operation_events(operation_id, sequence);
`;
