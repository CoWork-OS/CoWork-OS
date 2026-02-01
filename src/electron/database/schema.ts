import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';

export class DatabaseManager {
  private db: Database.Database;

  constructor() {
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'cowork-oss.db');
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  private initializeSchema() {
    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        permissions TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        budget_tokens INTEGER,
        budget_cost REAL,
        error TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        prompt TEXT NOT NULL,
        script_path TEXT,
        parameters TEXT
      );

      CREATE TABLE IF NOT EXISTS llm_models (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        anthropic_model_id TEXT NOT NULL,
        bedrock_model_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_llm_models_active ON llm_models(is_active);

      -- Channel Gateway tables
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL,
        security_config TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected',
        bot_username TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_users (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        username TEXT,
        allowed INTEGER NOT NULL DEFAULT 0,
        pairing_code TEXT,
        pairing_attempts INTEGER NOT NULL DEFAULT 0,
        pairing_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        UNIQUE(channel_id, channel_user_id)
      );

      CREATE TABLE IF NOT EXISTS channel_sessions (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT,
        task_id TEXT,
        workspace_id TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        context TEXT,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        FOREIGN KEY (user_id) REFERENCES channel_users(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        session_id TEXT,
        channel_message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT,
        direction TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        FOREIGN KEY (session_id) REFERENCES channel_sessions(id),
        FOREIGN KEY (user_id) REFERENCES channel_users(id)
      );

      -- Channel indexes
      CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(type);
      CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels(enabled);
      CREATE INDEX IF NOT EXISTS idx_channel_users_channel ON channel_users(channel_id);
      CREATE INDEX IF NOT EXISTS idx_channel_users_allowed ON channel_users(allowed);
      CREATE INDEX IF NOT EXISTS idx_channel_sessions_channel ON channel_sessions(channel_id);
      CREATE INDEX IF NOT EXISTS idx_channel_sessions_task ON channel_sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_channel_sessions_state ON channel_sessions(state);
      CREATE INDEX IF NOT EXISTS idx_channel_messages_session ON channel_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_channel_messages_chat ON channel_messages(chat_id);

      -- Gateway Infrastructure Tables

      -- Message Queue for reliable delivery
      CREATE TABLE IF NOT EXISTS message_queue (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_attempt_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        scheduled_at INTEGER
      );

      -- Scheduled Messages
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        sent_message_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      );

      -- Delivery Tracking
      CREATE TABLE IF NOT EXISTS delivery_tracking (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        sent_at INTEGER,
        delivered_at INTEGER,
        read_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL
      );

      -- Rate Limits
      CREATE TABLE IF NOT EXISTS rate_limits (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL,
        is_limited INTEGER NOT NULL DEFAULT 0,
        limit_expires_at INTEGER,
        UNIQUE(channel_type, user_id)
      );

      -- Audit Log
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        action TEXT NOT NULL,
        channel_type TEXT,
        user_id TEXT,
        chat_id TEXT,
        details TEXT,
        severity TEXT NOT NULL DEFAULT 'info'
      );

      -- Gateway Infrastructure Indexes
      CREATE INDEX IF NOT EXISTS idx_message_queue_status ON message_queue(status);
      CREATE INDEX IF NOT EXISTS idx_message_queue_scheduled ON message_queue(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_status ON scheduled_messages(status);
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_scheduled ON scheduled_messages(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_delivery_tracking_status ON delivery_tracking(status);
      CREATE INDEX IF NOT EXISTS idx_delivery_tracking_message ON delivery_tracking(message_id);
      CREATE INDEX IF NOT EXISTS idx_rate_limits_user ON rate_limits(channel_type, user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);

      -- Memory System Tables

      -- Core memories table for persistent context
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        tokens INTEGER NOT NULL DEFAULT 0,
        is_compressed INTEGER NOT NULL DEFAULT 0,
        is_private INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      -- Aggregated semantic summaries
      CREATE TABLE IF NOT EXISTS memory_summaries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        time_period TEXT NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        summary TEXT NOT NULL,
        memory_ids TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      -- Per-workspace memory settings
      CREATE TABLE IF NOT EXISTS memory_settings (
        workspace_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        auto_capture INTEGER NOT NULL DEFAULT 1,
        compression_enabled INTEGER NOT NULL DEFAULT 1,
        retention_days INTEGER NOT NULL DEFAULT 90,
        max_storage_mb INTEGER NOT NULL DEFAULT 100,
        privacy_mode TEXT NOT NULL DEFAULT 'normal',
        excluded_patterns TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      -- Memory System Indexes
      CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_memories_task ON memories(task_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_compressed ON memories(is_compressed);
      CREATE INDEX IF NOT EXISTS idx_memory_summaries_workspace ON memory_summaries(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_memory_summaries_period ON memory_summaries(time_period, period_start);
    `);

    // Initialize FTS5 for memory search (separate exec to handle if not supported)
    this.initializeMemoryFTS();

    // Run migrations for Goal Mode columns (SQLite ALTER TABLE ADD COLUMN is safe if column exists)
    this.runMigrations();

    // Seed default models if table is empty
    this.seedDefaultModels();
  }

  private initializeMemoryFTS() {
    // Create FTS5 virtual table for full-text search on memories
    // Using external content table pattern for efficiency
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          summary,
          content='memories',
          content_rowid='rowid'
        );

        -- Trigger to keep FTS in sync on INSERT
        CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, summary)
          VALUES (NEW.rowid, NEW.content, NEW.summary);
        END;

        -- Trigger to keep FTS in sync on DELETE
        CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, summary)
          VALUES('delete', OLD.rowid, OLD.content, OLD.summary);
        END;

        -- Trigger to keep FTS in sync on UPDATE
        CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, summary)
          VALUES('delete', OLD.rowid, OLD.content, OLD.summary);
          INSERT INTO memories_fts(rowid, content, summary)
          VALUES (NEW.rowid, NEW.content, NEW.summary);
        END;
      `);
    } catch (error) {
      // FTS5 might not be available in all SQLite builds
      console.warn('[DatabaseManager] FTS5 initialization failed, full-text search will be disabled:', error);
    }
  }

  private runMigrations() {
    // Migration: Add Goal Mode columns to tasks table
    // SQLite ALTER TABLE ADD COLUMN fails if column exists, so we catch and ignore
    const goalModeColumns = [
      'ALTER TABLE tasks ADD COLUMN success_criteria TEXT',
      'ALTER TABLE tasks ADD COLUMN max_attempts INTEGER DEFAULT 3',
      'ALTER TABLE tasks ADD COLUMN current_attempt INTEGER DEFAULT 1',
    ];

    for (const sql of goalModeColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    // Migration: Add Sub-Agent / Parallel Agent columns to tasks table
    const subAgentColumns = [
      'ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id)',
      'ALTER TABLE tasks ADD COLUMN agent_type TEXT DEFAULT "main"',
      'ALTER TABLE tasks ADD COLUMN agent_config TEXT',
      'ALTER TABLE tasks ADD COLUMN depth INTEGER DEFAULT 0',
      'ALTER TABLE tasks ADD COLUMN result_summary TEXT',
    ];

    for (const sql of subAgentColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    // Add index for parent_task_id lookups
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)');
    } catch {
      // Index already exists, ignore
    }
  }

  private seedDefaultModels() {
    const count = this.db.prepare('SELECT COUNT(*) as count FROM llm_models').get() as { count: number };
    if (count.count === 0) {
      const now = Date.now();
      const models = [
        {
          id: 'model-opus-4-5',
          key: 'opus-4-5',
          displayName: 'Opus 4.5',
          description: 'Most capable for complex work',
          anthropicModelId: 'claude-opus-4-5-20250514',
          bedrockModelId: 'us.anthropic.claude-opus-4-5-20250514-v1:0',
          sortOrder: 1,
        },
        {
          id: 'model-sonnet-4-5',
          key: 'sonnet-4-5',
          displayName: 'Sonnet 4.5',
          description: 'Best for everyday tasks',
          anthropicModelId: 'claude-sonnet-4-5-20250514',
          bedrockModelId: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
          sortOrder: 2,
        },
        {
          id: 'model-haiku-4-5',
          key: 'haiku-4-5',
          displayName: 'Haiku 4.5',
          description: 'Fastest for quick answers',
          anthropicModelId: 'claude-haiku-4-5-20250514',
          bedrockModelId: 'us.anthropic.claude-haiku-4-5-20250514-v1:0',
          sortOrder: 3,
        },
      ];

      const stmt = this.db.prepare(`
        INSERT INTO llm_models (id, key, display_name, description, anthropic_model_id, bedrock_model_id, sort_order, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);

      for (const model of models) {
        stmt.run(
          model.id,
          model.key,
          model.displayName,
          model.description,
          model.anthropicModelId,
          model.bedrockModelId,
          model.sortOrder,
          now,
          now
        );
      }
    }
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  close() {
    this.db.close();
  }
}
