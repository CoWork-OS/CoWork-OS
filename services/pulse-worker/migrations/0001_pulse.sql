PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pulse_installations (
  installation_key TEXT PRIMARY KEY,
  deletion_token_hash TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  first_active_date TEXT,
  first_value_date TEXT
);

CREATE TABLE IF NOT EXISTS pulse_daily_usage (
  installation_key TEXT NOT NULL REFERENCES pulse_installations(installation_key) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  package_id TEXT NOT NULL UNIQUE,
  received_at INTEGER NOT NULL,
  client_version TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('macos','windows','linux','other')),
  architecture TEXT NOT NULL CHECK (architecture IN ('arm64','x64','other')),
  runtime TEXT NOT NULL CHECK (runtime IN ('desktop','daemon','cli')),
  sessions_started INTEGER NOT NULL,
  tasks_started INTEGER NOT NULL,
  tasks_completed INTEGER NOT NULL,
  useful_tasks INTEGER NOT NULL,
  active_minutes_bucket TEXT NOT NULL CHECK (active_minutes_bucket IN ('0','1-15','16-60','61-240','240+')),
  tool_shell INTEGER NOT NULL,
  tool_filesystem INTEGER NOT NULL,
  tool_browser INTEGER NOT NULL,
  tool_connector INTEGER NOT NULL,
  tool_code INTEGER NOT NULL,
  tool_other INTEGER NOT NULL,
  failed_tasks INTEGER NOT NULL,
  cancelled_tasks INTEGER NOT NULL,
  approval_requests INTEGER NOT NULL,
  approval_denials INTEGER NOT NULL,
  tool_errors INTEGER NOT NULL,
  llm_errors INTEGER NOT NULL,
  PRIMARY KEY (installation_key, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_pulse_daily_usage_date ON pulse_daily_usage(usage_date);
CREATE INDEX IF NOT EXISTS idx_pulse_installations_value ON pulse_installations(first_value_date);

CREATE TABLE IF NOT EXISTS pulse_deletion_totals (
  deletion_date TEXT PRIMARY KEY,
  deletion_count INTEGER NOT NULL DEFAULT 0
);
