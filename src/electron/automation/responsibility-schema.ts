import type Database from "better-sqlite3";

/**
 * Bot responsibility tables and their one-time upgrade, apart from the store so schema
 * initialization (and its bootstrap worker) can run them without loading zod and the
 * responsibility definitions.
 */

export const BOT_RESPONSIBILITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_responsibilities (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_role_id TEXT NOT NULL,
  engine_kind TEXT NOT NULL CHECK (engine_kind IN ('routine','trigger')), engine_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0), state TEXT NOT NULL DEFAULT 'paused' CHECK (state IN ('paused','active')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(engine_kind, engine_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_responsibility_scope ON bot_responsibilities(workspace_id, agent_role_id, updated_at);
CREATE TABLE IF NOT EXISTS bot_responsibility_revisions (
  responsibility_id TEXT NOT NULL, revision INTEGER NOT NULL, definition_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (responsibility_id, revision),
  FOREIGN KEY (responsibility_id) REFERENCES bot_responsibilities(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bot_responsibility_runs (
  task_id TEXT PRIMARY KEY, run_ref_json TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bot_responsibility_run_channel_instances (
  task_id TEXT NOT NULL, channel_type TEXT NOT NULL, channel_id TEXT NOT NULL,
  PRIMARY KEY (task_id, channel_type),
  FOREIGN KEY (task_id) REFERENCES bot_responsibility_runs(task_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bot_responsibility_signal_heads (
 responsibility_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, control_version INTEGER NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0), fingerprint TEXT NOT NULL, task_id TEXT,
 FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS bot_responsibility_signal_runs (
 task_id TEXT PRIMARY KEY, run_ref_json TEXT NOT NULL, sequence INTEGER NOT NULL, fingerprint TEXT NOT NULL,
 FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bot_responsibility_future_controls (
 responsibility_id TEXT PRIMARY KEY, paused INTEGER NOT NULL CHECK(paused IN (0,1)),
 version INTEGER NOT NULL CHECK(version>=0)
);
CREATE TABLE IF NOT EXISTS bot_responsibility_future_receipts (
 responsibility_id TEXT NOT NULL, request_id TEXT NOT NULL, request_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
 PRIMARY KEY(responsibility_id,request_id)
);
CREATE TABLE IF NOT EXISTS bot_work_control_receipts (
 workspace_id TEXT NOT NULL,agent_role_id TEXT NOT NULL,request_id TEXT NOT NULL,
 request_json TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(workspace_id,agent_role_id,request_id)
);
CREATE TABLE IF NOT EXISTS bot_future_controls (
 workspace_id TEXT NOT NULL,agent_role_id TEXT NOT NULL,paused INTEGER NOT NULL CHECK(paused IN (0,1)),
 version INTEGER NOT NULL CHECK(version>0),PRIMARY KEY(workspace_id,agent_role_id)
);
CREATE TABLE IF NOT EXISTS bot_task_stop_intents (
 task_id TEXT PRIMARY KEY,requested_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bot_responsibility_controls (
 responsibility_id TEXT PRIMARY KEY, control_version INTEGER NOT NULL CHECK(control_version>=0)
);
`;

/** Upgrade the earlier paused-only constraint without losing immutable revisions.
 * Called while the profile migration lock is held, before any service starts. */
export function upgradeResponsibilityStateSchema(db: Database.Database): void {
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bot_responsibilities'")
    .get() as { sql: string } | undefined;
  if (!schema || !/CHECK\s*\(state\s*=\s*'paused'\)/i.test(schema.sql)) return;
  db.transaction(() => {
    const parent = BOT_RESPONSIBILITY_SCHEMA.split("CREATE INDEX")[0].replaceAll(
      "bot_responsibilities",
      "bot_responsibilities_v2",
    );
    const child = BOT_RESPONSIBILITY_SCHEMA.slice(
      BOT_RESPONSIBILITY_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS bot_responsibility_revisions"),
    )
      .replaceAll("bot_responsibility_revisions", "bot_responsibility_revisions_v2")
      .replaceAll("REFERENCES bot_responsibilities(", "REFERENCES bot_responsibilities_v2(");
    db.exec(parent);
    db.exec("INSERT INTO bot_responsibilities_v2 SELECT * FROM bot_responsibilities");
    db.exec(child);
    db.exec(
      "INSERT INTO bot_responsibility_revisions_v2 SELECT * FROM bot_responsibility_revisions",
    );
    db.exec(
      "DROP TABLE bot_responsibility_revisions; DROP TABLE bot_responsibilities; ALTER TABLE bot_responsibilities_v2 RENAME TO bot_responsibilities; ALTER TABLE bot_responsibility_revisions_v2 RENAME TO bot_responsibility_revisions;",
    );
  }).immediate();
}
