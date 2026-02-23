import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { getUserDataDir } from "../utils/user-data-dir";

export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private db: Database.Database;

  constructor() {
    const userDataPath = getUserDataDir();

    // Run migration from old cowork-oss directory before opening database
    this.migrateFromLegacyDirectory(userDataPath);

    const dbPath = path.join(userDataPath, "cowork-os.db");
    this.db = new Database(dbPath);
    this.initializeSchema();

    // Store as singleton instance
    DatabaseManager.instance = this;
  }

  /**
   * Get the singleton instance of DatabaseManager.
   * Must be called after the instance has been created in main.ts.
   */
  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      throw new Error(
        "DatabaseManager has not been initialized. Call new DatabaseManager() first in main.ts.",
      );
    }
    return DatabaseManager.instance;
  }

  // Migration version - increment this to force re-migration for users with partial migrations
  private static readonly MIGRATION_VERSION = 2;

  /**
   * Migrate data from the old cowork-oss directory to the new cowork-os directory.
   * This ensures users don't lose their data when upgrading.
   */
  private migrateFromLegacyDirectory(newDataPath: string): void {
    // Normalize path - remove trailing slash if present
    const normalizedNewPath = newDataPath.replace(/\/+$/, "");

    // Determine the old directory path
    // Handle both 'cowork-os' and 'cowork-os/' patterns
    const oldDataPath = normalizedNewPath.replace(/cowork-os$/, "cowork-oss");

    // Verify the replacement actually happened (paths should be different)
    if (oldDataPath === normalizedNewPath) {
      console.log("[DatabaseManager] Cannot determine legacy path from:", newDataPath);
      return;
    }

    // Check if old directory exists
    if (!fs.existsSync(oldDataPath)) {
      console.log("[DatabaseManager] No legacy directory found at:", oldDataPath);
      return; // No legacy data to migrate
    }

    const newDbPath = path.join(normalizedNewPath, "cowork-os.db");
    const oldDbPath = path.join(oldDataPath, "cowork-oss.db");
    const migrationMarker = path.join(normalizedNewPath, ".migrated-from-cowork-oss");

    // Check if migration already completed with current version
    if (fs.existsSync(migrationMarker)) {
      try {
        const markerContent = fs.readFileSync(migrationMarker, "utf-8");
        const markerData = JSON.parse(markerContent);
        if (markerData.version >= DatabaseManager.MIGRATION_VERSION) {
          return; // Already migrated with current or newer version
        }
        console.log("[DatabaseManager] Re-running migration (version upgrade)...");
      } catch {
        // Old format marker (just a date string) - re-run migration
        console.log("[DatabaseManager] Re-running migration (old marker format)...");
      }
    }

    console.log("[DatabaseManager] Migrating data from cowork-oss to cowork-os...");
    console.log("[DatabaseManager] Old path:", oldDataPath);
    console.log("[DatabaseManager] New path:", normalizedNewPath);

    let migrationSuccessful = true;
    const migratedFiles: string[] = [];
    const migratedDirs: string[] = [];

    try {
      // Ensure new directory exists
      if (!fs.existsSync(normalizedNewPath)) {
        fs.mkdirSync(normalizedNewPath, { recursive: true });
      }

      // 1. Migrate database if old exists and new doesn't (or new is smaller)
      if (fs.existsSync(oldDbPath)) {
        const oldDbSize = fs.statSync(oldDbPath).size;
        const newDbExists = fs.existsSync(newDbPath);
        const newDbSize = newDbExists ? fs.statSync(newDbPath).size : 0;

        // Copy if new doesn't exist, or old is significantly larger (has more data)
        if (!newDbExists || oldDbSize > newDbSize) {
          console.log(
            `[DatabaseManager] Copying database (old: ${oldDbSize} bytes, new: ${newDbSize} bytes)...`,
          );
          fs.copyFileSync(oldDbPath, newDbPath);
          migratedFiles.push("cowork-os.db");
        } else {
          console.log("[DatabaseManager] Database already exists and is larger, skipping...");
        }
      }

      // 2. Migrate settings files - copy if old exists and (new doesn't exist OR old is larger)
      const settingsFiles = [
        "appearance-settings.json",
        "builtin-tools-settings.json",
        "claude-auth.enc",
        "control-plane-settings.json",
        "guardrail-settings.json",
        "hooks-settings.json",
        "llm-settings.json",
        "mcp-settings.json",
        "personality-settings.json",
        "search-settings.json",
      ];

      for (const file of settingsFiles) {
        const oldFile = path.join(oldDataPath, file);
        const newFile = path.join(normalizedNewPath, file);

        if (fs.existsSync(oldFile)) {
          const oldSize = fs.statSync(oldFile).size;
          const newExists = fs.existsSync(newFile);
          const newSize = newExists ? fs.statSync(newFile).size : 0;

          // Copy if new doesn't exist, or old file is larger (has more data)
          if (!newExists || oldSize > newSize) {
            console.log(
              `[DatabaseManager] Migrating ${file} (old: ${oldSize} bytes, new: ${newSize} bytes)...`,
            );
            fs.copyFileSync(oldFile, newFile);
            migratedFiles.push(file);
          }
        }
      }

      // 3. Migrate directories (skills, whatsapp-auth, cron, canvas, notifications)
      const directories = ["skills", "whatsapp-auth", "cron", "canvas", "notifications"];

      for (const dir of directories) {
        const oldDir = path.join(oldDataPath, dir);
        const newDir = path.join(normalizedNewPath, dir);

        if (fs.existsSync(oldDir) && fs.statSync(oldDir).isDirectory()) {
          const oldDirCount = this.countFilesRecursive(oldDir);
          const newDirExists = fs.existsSync(newDir);
          const newDirCount = newDirExists ? this.countFilesRecursive(newDir) : 0;

          // Copy if new doesn't exist, is empty, or has significantly fewer files
          if (!newDirExists || newDirCount === 0 || oldDirCount > newDirCount * 2) {
            console.log(
              `[DatabaseManager] Migrating ${dir}/ (old: ${oldDirCount} files, new: ${newDirCount} files)...`,
            );
            this.copyDirectoryRecursive(oldDir, newDir);
            migratedDirs.push(dir);
          }
        }
      }

      // Create migration marker with version info
      const markerData = {
        version: DatabaseManager.MIGRATION_VERSION,
        timestamp: new Date().toISOString(),
        migratedFiles,
        migratedDirs,
      };
      fs.writeFileSync(migrationMarker, JSON.stringify(markerData, null, 2));

      console.log("[DatabaseManager] Migration completed successfully.");
      console.log("[DatabaseManager] Migrated files:", migratedFiles);
      console.log("[DatabaseManager] Migrated directories:", migratedDirs);
    } catch (error) {
      console.error("[DatabaseManager] Migration failed:", error);
      migrationSuccessful = false;
      // Don't create marker if migration failed - allows retry on next startup
    }

    if (!migrationSuccessful) {
      console.warn("[DatabaseManager] Migration incomplete - will retry on next startup");
    }
  }

  /**
   * Count files recursively in a directory
   */
  private countFilesRecursive(dirPath: string): number {
    let count = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          count += this.countFilesRecursive(path.join(dirPath, entry.name));
        } else {
          count++;
        }
      }
    } catch {
      // Directory might not be readable
    }
    return count;
  }

  /**
   * Recursively copy a directory
   */
  private copyDirectoryRecursive(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectoryRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  private initializeSchema() {
    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
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
        is_pinned INTEGER DEFAULT 0,
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
      CREATE INDEX IF NOT EXISTS idx_channel_sessions_workspace ON channel_sessions(workspace_id);
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

      -- Local semantic embeddings for hybrid memory retrieval (offline)
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (memory_id) REFERENCES memories(id)
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
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_workspace ON memory_embeddings(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_memory_summaries_workspace ON memory_summaries(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_memory_summaries_period ON memory_summaries(time_period, period_start);

      -- Workspace Markdown Memory Index (for kit notes, docs, and other durable markdown context)
      CREATE TABLE IF NOT EXISTS memory_markdown_files (
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, path),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS memory_markdown_chunks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_markdown_files_workspace ON memory_markdown_files(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_memory_markdown_files_mtime ON memory_markdown_files(workspace_id, mtime);
      CREATE INDEX IF NOT EXISTS idx_memory_markdown_chunks_workspace ON memory_markdown_chunks(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_memory_markdown_chunks_path ON memory_markdown_chunks(workspace_id, path);
      CREATE INDEX IF NOT EXISTS idx_memory_markdown_chunks_mtime ON memory_markdown_chunks(workspace_id, mtime);
    `);

    // Initialize FTS5 for memory search (separate exec to handle if not supported)
    this.initializeMemoryFTS();
    this.initializeMarkdownMemoryFTS();
    this.initializeKnowledgeGraphFTS();

    // Run migrations for task-retry tracking columns (SQLite ALTER TABLE ADD COLUMN is safe if column exists)
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
      console.warn(
        "[DatabaseManager] FTS5 initialization failed, full-text search will be disabled:",
        error,
      );
    }
  }

  private initializeMarkdownMemoryFTS() {
    // Optional FTS5 index for workspace markdown notes (kit files, docs, etc).
    // When unavailable, MarkdownMemoryIndexService falls back to LIKE-based search.
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_markdown_chunks_fts USING fts5(
          text,
          chunk_id UNINDEXED,
          workspace_id UNINDEXED,
          path UNINDEXED,
          start_line UNINDEXED,
          end_line UNINDEXED
        );
      `);
    } catch (error) {
      console.warn(
        "[DatabaseManager] Markdown FTS5 initialization failed, markdown full-text search will be limited:",
        error,
      );
    }
  }

  private runMigrations() {
    // Migration: Add task-retry tracking columns to tasks table
    // SQLite ALTER TABLE ADD COLUMN fails if column exists, so we catch and ignore
    const taskRetryColumns = [
      "ALTER TABLE tasks ADD COLUMN success_criteria TEXT",
      "ALTER TABLE tasks ADD COLUMN max_attempts INTEGER DEFAULT 3",
      "ALTER TABLE tasks ADD COLUMN current_attempt INTEGER DEFAULT 1",
    ];

    for (const sql of taskRetryColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    // Migration: Add last_used_at to workspaces for recency ordering
    try {
      this.db.exec("ALTER TABLE workspaces ADD COLUMN last_used_at INTEGER");
    } catch {
      // Column already exists, ignore
    }

    // Migration: Add Sub-Agent / Parallel Agent columns to tasks table
    const subAgentColumns = [
      "ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id)",
      'ALTER TABLE tasks ADD COLUMN agent_type TEXT DEFAULT "main"',
      "ALTER TABLE tasks ADD COLUMN agent_config TEXT",
      "ALTER TABLE tasks ADD COLUMN depth INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN result_summary TEXT",
    ];

    for (const sql of subAgentColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    // Migration: Add pinned marker to tasks table
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN is_pinned INTEGER DEFAULT 0");
    } catch {
      // Column already exists, ignore
    }

    // Add index for parent_task_id lookups
    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)");
    } catch {
      // Index already exists, ignore
    }

    // Migration: Create agent_roles table for Agent Squad feature
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_roles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          description TEXT,
          icon TEXT DEFAULT '🤖',
          color TEXT DEFAULT '#6366f1',
          personality_id TEXT,
          model_key TEXT,
          provider_type TEXT,
          system_prompt TEXT,
          capabilities TEXT NOT NULL,
          tool_restrictions TEXT,
          is_system INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 100,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_roles_active ON agent_roles(is_active);
        CREATE INDEX IF NOT EXISTS idx_agent_roles_name ON agent_roles(name);
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: Add assigned_agent_role_id to tasks table
    const agentRoleColumns = [
      "ALTER TABLE tasks ADD COLUMN assigned_agent_role_id TEXT REFERENCES agent_roles(id)",
      'ALTER TABLE tasks ADD COLUMN board_column TEXT DEFAULT "backlog"',
      "ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0",
    ];

    for (const sql of agentRoleColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    // Add index for agent role lookups on tasks
    try {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_agent_role ON tasks(assigned_agent_role_id)",
      );
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_board_column ON tasks(board_column)");
    } catch {
      // Index already exists, ignore
    }

    // Migration: Create activity_feed table for cross-agent activity stream
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS activity_feed (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          task_id TEXT,
          agent_role_id TEXT,
          actor_type TEXT NOT NULL,
          activity_type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          metadata TEXT,
          is_read INTEGER DEFAULT 0,
          is_pinned INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (agent_role_id) REFERENCES agent_roles(id)
        );

        CREATE INDEX IF NOT EXISTS idx_activity_workspace ON activity_feed(workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_activity_unread ON activity_feed(workspace_id, is_read);
        CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_feed(activity_type);
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: Create agent_mentions table for inter-agent communication
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_mentions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          from_agent_role_id TEXT,
          to_agent_role_id TEXT NOT NULL,
          mention_type TEXT NOT NULL,
          context TEXT,
          status TEXT DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          acknowledged_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (from_agent_role_id) REFERENCES agent_roles(id),
          FOREIGN KEY (to_agent_role_id) REFERENCES agent_roles(id)
        );

        CREATE INDEX IF NOT EXISTS idx_mentions_to_agent ON agent_mentions(to_agent_role_id, status);
        CREATE INDEX IF NOT EXISTS idx_mentions_task ON agent_mentions(task_id);
        CREATE INDEX IF NOT EXISTS idx_mentions_workspace ON agent_mentions(workspace_id, created_at DESC);
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: Add mentioned_agent_role_ids to tasks table
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN mentioned_agent_role_ids TEXT");
    } catch {
      // Column already exists, ignore
    }

    // Migration: Add task board columns to tasks table (Phase 1.4)
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN board_column TEXT DEFAULT 'backlog'");
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0");
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN labels TEXT");
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN due_date INTEGER");
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN estimated_minutes INTEGER");
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN actual_minutes INTEGER");
    } catch {
      // Column already exists, ignore
    }

    // Migration: Create task_labels table for custom labels
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_labels (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          color TEXT DEFAULT '#6366f1',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          UNIQUE(workspace_id, name)
        );

        CREATE INDEX IF NOT EXISTS idx_task_labels_workspace ON task_labels(workspace_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: Create index for task board queries
    try {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(workspace_id, board_column)",
      );
    } catch {
      // Index already exists, ignore
    }
    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC)");
    } catch {
      // Index already exists, ignore
    }

    // Migration: Create agent_working_state table (Phase 1.5)
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_working_state (
          id TEXT PRIMARY KEY,
          agent_role_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          task_id TEXT,
          state_type TEXT NOT NULL,
          content TEXT NOT NULL,
          file_references TEXT,
          is_current INTEGER DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (agent_role_id) REFERENCES agent_roles(id),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

        CREATE INDEX IF NOT EXISTS idx_working_state_agent ON agent_working_state(agent_role_id, workspace_id, is_current);
        CREATE INDEX IF NOT EXISTS idx_working_state_task ON agent_working_state(task_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: Create context_policies table for per-context security (DM vs group)
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS context_policies (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          context_type TEXT NOT NULL CHECK(context_type IN ('dm', 'group')),
          security_mode TEXT NOT NULL DEFAULT 'pairing' CHECK(security_mode IN ('open', 'allowlist', 'pairing')),
          tool_restrictions TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          UNIQUE(channel_id, context_type)
        );

        CREATE INDEX IF NOT EXISTS idx_context_policies_channel ON context_policies(channel_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: Add shell_enabled and debug_mode columns to channel_sessions
    try {
      this.db.exec("ALTER TABLE channel_sessions ADD COLUMN shell_enabled INTEGER DEFAULT 0");
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec("ALTER TABLE channel_sessions ADD COLUMN debug_mode INTEGER DEFAULT 0");
    } catch {
      // Column already exists, ignore
    }

    // Migration: Add lockout_until column to channel_users
    // Separates brute-force lockout timestamp from pairing code expiration
    try {
      this.db.exec("ALTER TABLE channel_users ADD COLUMN lockout_until INTEGER");
    } catch {
      // Column already exists, ignore
    }

    // ============ Secure Settings Table ============
    // All settings are encrypted using OS keychain (Electron safeStorage)
    // Only this app can decrypt the values
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS secure_settings (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          encrypted_data TEXT NOT NULL,
          checksum TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(category)
        );

        CREATE INDEX IF NOT EXISTS idx_secure_settings_category ON secure_settings(category);
      `);
    } catch {
      // Table already exists, ignore
    }

    // ============ Mission Control Migrations ============

    // Migration: Add heartbeat and autonomy columns to agent_roles
    const missionControlColumns = [
      "ALTER TABLE agent_roles ADD COLUMN autonomy_level TEXT DEFAULT 'specialist'",
      "ALTER TABLE agent_roles ADD COLUMN soul TEXT",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_enabled INTEGER DEFAULT 0",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_interval_minutes INTEGER DEFAULT 15",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_stagger_offset INTEGER DEFAULT 0",
      "ALTER TABLE agent_roles ADD COLUMN last_heartbeat_at INTEGER",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_status TEXT DEFAULT 'idle'",
    ];

    for (const sql of missionControlColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    // Migration: Create task_subscriptions table for thread subscriptions
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_subscriptions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          agent_role_id TEXT NOT NULL,
          subscription_reason TEXT NOT NULL,
          subscribed_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (agent_role_id) REFERENCES agent_roles(id) ON DELETE CASCADE,
          UNIQUE(task_id, agent_role_id)
        );

        CREATE INDEX IF NOT EXISTS idx_task_subscriptions_task ON task_subscriptions(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_subscriptions_agent ON task_subscriptions(agent_role_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: Create standup_reports table for daily standups
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS standup_reports (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          report_date TEXT NOT NULL,
          completed_task_ids TEXT,
          in_progress_task_ids TEXT,
          blocked_task_ids TEXT,
          summary TEXT NOT NULL,
          delivered_to_channel TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          UNIQUE(workspace_id, report_date)
        );

        CREATE INDEX IF NOT EXISTS idx_standup_reports_workspace ON standup_reports(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_standup_reports_date ON standup_reports(report_date);
      `);
    } catch {
      // Table already exists, ignore
    }

    // ============ Agent Teams (Mission Control) ============

    // Migration: Create agent team tables (teams, members, runs, items)
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_teams (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          name TEXT NOT NULL,
          description TEXT,
          lead_agent_role_id TEXT NOT NULL REFERENCES agent_roles(id),
          max_parallel_agents INTEGER NOT NULL DEFAULT 4,
          default_model_preference TEXT,
          default_personality TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id, name)
        );

        CREATE INDEX IF NOT EXISTS idx_agent_teams_workspace ON agent_teams(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_agent_teams_active ON agent_teams(workspace_id, is_active);
      `);
    } catch {
      // Table already exists, ignore
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_team_members (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES agent_teams(id) ON DELETE CASCADE,
          agent_role_id TEXT NOT NULL REFERENCES agent_roles(id),
          member_order INTEGER NOT NULL DEFAULT 0,
          is_required INTEGER NOT NULL DEFAULT 0,
          role_guidance TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(team_id, agent_role_id)
        );

        CREATE INDEX IF NOT EXISTS idx_team_members_team ON agent_team_members(team_id);
        CREATE INDEX IF NOT EXISTS idx_team_members_role ON agent_team_members(agent_role_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_team_runs (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES agent_teams(id),
          root_task_id TEXT NOT NULL REFERENCES tasks(id),
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          error TEXT,
          summary TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_team_runs_team ON agent_team_runs(team_id);
        CREATE INDEX IF NOT EXISTS idx_team_runs_root_task ON agent_team_runs(root_task_id);
        CREATE INDEX IF NOT EXISTS idx_team_runs_status ON agent_team_runs(status);
      `);
    } catch {
      // Table already exists, ignore
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_team_items (
          id TEXT PRIMARY KEY,
          team_run_id TEXT NOT NULL REFERENCES agent_team_runs(id) ON DELETE CASCADE,
          parent_item_id TEXT REFERENCES agent_team_items(id),
          title TEXT NOT NULL,
          description TEXT,
          owner_agent_role_id TEXT REFERENCES agent_roles(id),
          source_task_id TEXT REFERENCES tasks(id),
          status TEXT NOT NULL,
          result_summary TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_team_items_run ON agent_team_items(team_run_id);
        CREATE INDEX IF NOT EXISTS idx_team_items_source_task ON agent_team_items(source_task_id);
        CREATE INDEX IF NOT EXISTS idx_team_items_status ON agent_team_items(status);
      `);
    } catch {
      // Table already exists, ignore
    }

    // ============ Collaborative Thoughts (Team Multi-Agent Thinking) ============

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_team_thoughts (
          id TEXT PRIMARY KEY,
          team_run_id TEXT NOT NULL REFERENCES agent_team_runs(id) ON DELETE CASCADE,
          team_item_id TEXT REFERENCES agent_team_items(id),
          agent_role_id TEXT NOT NULL REFERENCES agent_roles(id),
          agent_display_name TEXT NOT NULL,
          agent_icon TEXT NOT NULL DEFAULT '🤖',
          agent_color TEXT NOT NULL DEFAULT '#6366f1',
          phase TEXT NOT NULL,
          content TEXT NOT NULL,
          is_streaming INTEGER NOT NULL DEFAULT 0,
          source_task_id TEXT REFERENCES tasks(id),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_team_thoughts_run ON agent_team_thoughts(team_run_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_team_thoughts_source_task ON agent_team_thoughts(source_task_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: Add phase and collaborative_mode columns to agent_team_runs
    try {
      this.db.exec("ALTER TABLE agent_team_runs ADD COLUMN phase TEXT DEFAULT 'dispatch'");
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec("ALTER TABLE agent_team_runs ADD COLUMN collaborative_mode INTEGER DEFAULT 0");
    } catch {
      // Column already exists, ignore
    }
    try {
      this.db.exec("ALTER TABLE agent_team_runs ADD COLUMN multi_llm_mode INTEGER DEFAULT 0");
    } catch {
      // Column already exists, ignore
    }

    // ============ Agent Performance Reviews (Mission Control) ============

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_performance_reviews (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          agent_role_id TEXT NOT NULL REFERENCES agent_roles(id),
          period_start INTEGER NOT NULL,
          period_end INTEGER NOT NULL,
          rating INTEGER NOT NULL,
          summary TEXT NOT NULL,
          metrics TEXT,
          recommended_autonomy_level TEXT,
          recommendation_rationale TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_reviews_workspace ON agent_performance_reviews(workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_reviews_role ON agent_performance_reviews(agent_role_id, created_at DESC);
      `);
    } catch {
      // Table already exists, ignore
    }

    // ============ Git Worktree Support ============

    // Add worktree columns to tasks table
    const worktreeColumns = [
      "ALTER TABLE tasks ADD COLUMN worktree_path TEXT",
      "ALTER TABLE tasks ADD COLUMN worktree_branch TEXT",
      "ALTER TABLE tasks ADD COLUMN worktree_status TEXT",
      "ALTER TABLE tasks ADD COLUMN comparison_session_id TEXT",
    ];
    for (const sql of worktreeColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists
      }
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS worktree_info (
          task_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          repo_path TEXT,
          worktree_path TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          base_commit TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'creating',
          created_at INTEGER NOT NULL,
          last_commit_sha TEXT,
          last_commit_message TEXT,
          merge_result TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_worktree_info_workspace ON worktree_info(workspace_id);
      `);
    } catch {
      // Table already exists
    }

    try {
      this.db.exec("ALTER TABLE worktree_info ADD COLUMN repo_path TEXT");
    } catch {
      // Column already exists
    }

    // ============ Agent Comparison Sessions ============

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS comparison_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          task_ids TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          comparison_result TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_comparison_sessions_workspace ON comparison_sessions(workspace_id);
      `);
    } catch {
      // Table already exists
    }

    try {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_comparison_session ON tasks(comparison_session_id)",
      );
    } catch {
      // Index already exists
    }

    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_tasks_comparison_session_insert
        AFTER INSERT ON tasks
        WHEN NEW.comparison_session_id IS NOT NULL
        BEGIN
          UPDATE comparison_sessions
          SET task_ids = COALESCE((
            SELECT json_group_array(id)
            FROM (
              SELECT id
              FROM tasks
              WHERE comparison_session_id = NEW.comparison_session_id
              ORDER BY created_at ASC
            )
          ), '[]')
          WHERE id = NEW.comparison_session_id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_tasks_comparison_session_update
        AFTER UPDATE OF comparison_session_id ON tasks
        WHEN OLD.comparison_session_id IS NOT NEW.comparison_session_id
        BEGIN
          UPDATE comparison_sessions
          SET task_ids = COALESCE((
            SELECT json_group_array(id)
            FROM (
              SELECT id
              FROM tasks
              WHERE comparison_session_id = OLD.comparison_session_id
              ORDER BY created_at ASC
            )
          ), '[]')
          WHERE OLD.comparison_session_id IS NOT NULL AND id = OLD.comparison_session_id;

          UPDATE comparison_sessions
          SET task_ids = COALESCE((
            SELECT json_group_array(id)
            FROM (
              SELECT id
              FROM tasks
              WHERE comparison_session_id = NEW.comparison_session_id
              ORDER BY created_at ASC
            )
          ), '[]')
          WHERE NEW.comparison_session_id IS NOT NULL AND id = NEW.comparison_session_id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_tasks_comparison_session_delete
        AFTER DELETE ON tasks
        WHEN OLD.comparison_session_id IS NOT NULL
        BEGIN
          UPDATE comparison_sessions
          SET task_ids = COALESCE((
            SELECT json_group_array(id)
            FROM (
              SELECT id
              FROM tasks
              WHERE comparison_session_id = OLD.comparison_session_id
              ORDER BY created_at ASC
            )
          ), '[]')
          WHERE id = OLD.comparison_session_id;
        END;
      `);
    } catch {
      // Trigger already exists
    }

    try {
      this.db.exec(`
        UPDATE comparison_sessions
        SET task_ids = COALESCE((
          SELECT json_group_array(id)
          FROM (
            SELECT id
            FROM tasks
            WHERE comparison_session_id = comparison_sessions.id
            ORDER BY created_at ASC
          )
        ), '[]')
      `);
    } catch {
      // Best-effort reconciliation for older databases
    }

    // ============ Persistent Teams Migration ============
    try {
      this.db.exec("ALTER TABLE agent_teams ADD COLUMN persistent INTEGER DEFAULT 0");
    } catch {
      // Column already exists
    }
    try {
      this.db.exec("ALTER TABLE agent_teams ADD COLUMN default_workspace_id TEXT");
    } catch {
      // Column already exists
    }

    // ============ User Prompt for Agent-Dispatched Tasks ============
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN user_prompt TEXT");
    } catch {
      // Column already exists
    }

    // ============ Knowledge Graph Tables ============

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kg_entity_types (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          color TEXT,
          icon TEXT,
          is_builtin INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE(workspace_id, name)
        );

        CREATE INDEX IF NOT EXISTS idx_kg_entity_types_workspace ON kg_entity_types(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_kg_entity_types_name ON kg_entity_types(workspace_id, name);
      `);
    } catch {
      // Table already exists
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kg_entities (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          entity_type_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          properties TEXT DEFAULT '{}',
          confidence REAL DEFAULT 1.0,
          source TEXT DEFAULT 'manual',
          source_task_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (entity_type_id) REFERENCES kg_entity_types(id),
          UNIQUE(workspace_id, entity_type_id, name)
        );

        CREATE INDEX IF NOT EXISTS idx_kg_entities_workspace ON kg_entities(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(entity_type_id);
        CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(workspace_id, name);
        CREATE INDEX IF NOT EXISTS idx_kg_entities_source ON kg_entities(source);
        CREATE INDEX IF NOT EXISTS idx_kg_entities_confidence ON kg_entities(confidence);
      `);
    } catch {
      // Table already exists
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kg_edges (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source_entity_id TEXT NOT NULL,
          target_entity_id TEXT NOT NULL,
          edge_type TEXT NOT NULL,
          properties TEXT DEFAULT '{}',
          confidence REAL DEFAULT 1.0,
          source TEXT DEFAULT 'manual',
          source_task_id TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (source_entity_id) REFERENCES kg_entities(id) ON DELETE CASCADE,
          FOREIGN KEY (target_entity_id) REFERENCES kg_entities(id) ON DELETE CASCADE,
          UNIQUE(workspace_id, source_entity_id, target_entity_id, edge_type)
        );

        CREATE INDEX IF NOT EXISTS idx_kg_edges_workspace ON kg_edges(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_entity_id);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_entity_id);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(edge_type);
      `);
    } catch {
      // Table already exists
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kg_observations (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT DEFAULT 'manual',
          source_task_id TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (entity_id) REFERENCES kg_entities(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_kg_observations_entity ON kg_observations(entity_id);
        CREATE INDEX IF NOT EXISTS idx_kg_observations_created ON kg_observations(created_at);
      `);
    } catch {
      // Table already exists
    }

    // Seed built-in entity types for all workspaces that don't have them yet
    this.seedKnowledgeGraphTypes();
  }

  private initializeKnowledgeGraphFTS() {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS kg_entities_fts USING fts5(
          name,
          description,
          content='kg_entities',
          content_rowid='rowid'
        );

        -- Trigger to keep FTS in sync on INSERT
        CREATE TRIGGER IF NOT EXISTS kg_entities_fts_insert AFTER INSERT ON kg_entities BEGIN
          INSERT INTO kg_entities_fts(rowid, name, description)
          VALUES (NEW.rowid, NEW.name, NEW.description);
        END;

        -- Trigger to keep FTS in sync on DELETE
        CREATE TRIGGER IF NOT EXISTS kg_entities_fts_delete AFTER DELETE ON kg_entities BEGIN
          INSERT INTO kg_entities_fts(kg_entities_fts, rowid, name, description)
          VALUES('delete', OLD.rowid, OLD.name, OLD.description);
        END;

        -- Trigger to keep FTS in sync on UPDATE
        CREATE TRIGGER IF NOT EXISTS kg_entities_fts_update AFTER UPDATE ON kg_entities BEGIN
          INSERT INTO kg_entities_fts(kg_entities_fts, rowid, name, description)
          VALUES('delete', OLD.rowid, OLD.name, OLD.description);
          INSERT INTO kg_entities_fts(rowid, name, description)
          VALUES (NEW.rowid, NEW.name, NEW.description);
        END;
      `);
    } catch (error) {
      console.warn("[DatabaseManager] Knowledge Graph FTS5 initialization failed:", error);
    }
  }

  private seedKnowledgeGraphTypes() {
    try {
      const workspaces = this.db.prepare("SELECT id FROM workspaces").all() as Array<{
        id: string;
      }>;
      if (workspaces.length === 0) return;

      const builtinTypes: Array<{
        name: string;
        description: string;
        color: string;
        icon: string;
      }> = [
        { name: "person", description: "A person or individual", color: "#3b82f6", icon: "👤" },
        {
          name: "organization",
          description: "A company, team, or organization",
          color: "#8b5cf6",
          icon: "🏢",
        },
        {
          name: "project",
          description: "A project or initiative",
          color: "#10b981",
          icon: "📁",
        },
        {
          name: "technology",
          description: "A programming language, framework, or tool",
          color: "#f59e0b",
          icon: "⚙️",
        },
        {
          name: "concept",
          description: "An abstract idea, pattern, or principle",
          color: "#6366f1",
          icon: "💡",
        },
        {
          name: "file",
          description: "A file or document in the codebase",
          color: "#64748b",
          icon: "📄",
        },
        {
          name: "service",
          description: "A running service, microservice, or daemon",
          color: "#ef4444",
          icon: "🔧",
        },
        {
          name: "api_endpoint",
          description: "An API endpoint or route",
          color: "#14b8a6",
          icon: "🔌",
        },
        {
          name: "database_table",
          description: "A database table or collection",
          color: "#f97316",
          icon: "🗃️",
        },
        {
          name: "environment",
          description: "A deployment environment (dev, staging, production)",
          color: "#a855f7",
          icon: "🌐",
        },
      ];

      const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO kg_entity_types (id, workspace_id, name, description, color, icon, is_builtin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `);

      const now = Date.now();
      for (const ws of workspaces) {
        for (const t of builtinTypes) {
          // Use deterministic ID: workspace_id + type name
          const id = `kg-builtin-${ws.id.slice(0, 8)}-${t.name}`;
          insertStmt.run(id, ws.id, t.name, t.description, t.color, t.icon, now);
        }
      }
    } catch (error) {
      console.warn("[DatabaseManager] Failed to seed knowledge graph types:", error);
    }
  }

  private seedDefaultModels() {
    const count = this.db.prepare("SELECT COUNT(*) as count FROM llm_models").get() as {
      count: number;
    };
    if (count.count === 0) {
      const now = Date.now();
      const models = [
        {
          id: "model-opus-4-5",
          key: "opus-4-5",
          displayName: "Opus 4.5",
          description: "Most capable for complex work",
          anthropicModelId: "claude-opus-4-5-20250514",
          bedrockModelId: "anthropic.claude-opus-4-5-20250514",
          sortOrder: 1,
        },
        {
          id: "model-sonnet-4-5",
          key: "sonnet-4-5",
          displayName: "Sonnet 4.5",
          description: "Best for everyday tasks",
          anthropicModelId: "claude-sonnet-4-5-20250514",
          bedrockModelId: "anthropic.claude-sonnet-4-5-20250514",
          sortOrder: 2,
        },
        {
          id: "model-haiku-4-5",
          key: "haiku-4-5",
          displayName: "Haiku 4.5",
          description: "Fastest for quick answers",
          anthropicModelId: "claude-haiku-4-5-20250514",
          bedrockModelId: "anthropic.claude-haiku-4-5-20250514",
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
          now,
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
