import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { getUserDataDir } from "../utils/user-data-dir";
import { createLogger } from "../utils/logger";

const schemaLogger = createLogger("DatabaseManager");

export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private db: Database.Database;

  constructor() {
    const userDataPath = getUserDataDir();
    this.ensureRestrictedDirectory(userDataPath);

    // Run migration from old cowork-oss directory before opening database
    this.migrateFromLegacyDirectory(userDataPath);

    const dbPath = path.join(userDataPath, "cowork-os.db");
    this.db = new Database(dbPath);
    this.ensureRestrictedFile(dbPath);
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
      schemaLogger.warn("Cannot determine legacy path from:", newDataPath);
      return;
    }

    // Check if old directory exists
    if (!fs.existsSync(oldDataPath)) {
      schemaLogger.info("No legacy directory found at:", oldDataPath);
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
        schemaLogger.info("Re-running migration (version upgrade)...");
      } catch {
        // Old format marker (just a date string) - re-run migration
        schemaLogger.info("Re-running migration (old marker format)...");
      }
    }

    schemaLogger.info("Migrating data from cowork-oss to cowork-os...");
    schemaLogger.info("Old path:", oldDataPath);
    schemaLogger.info("New path:", normalizedNewPath);

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
        const oldDbHealthy = this.databasePassesIntegrityCheck(oldDbPath);
        const newDbExists = fs.existsSync(newDbPath);
        const newDbSize = newDbExists ? fs.statSync(newDbPath).size : 0;
        const newDbHealthy = newDbExists ? this.databasePassesIntegrityCheck(newDbPath) : false;

        if (!oldDbHealthy) {
          schemaLogger.warn("Legacy database failed integrity_check, skipping copy:", oldDbPath);
        } else if (!newDbExists || !newDbHealthy || oldDbSize > newDbSize) {
          schemaLogger.info(
            `Copying database (old: ${oldDbSize} bytes, new: ${newDbSize} bytes, newHealthy: ${newDbHealthy})...`,
          );
          fs.copyFileSync(oldDbPath, newDbPath);
          migratedFiles.push("cowork-os.db");
        } else {
          schemaLogger.info("Database already exists, passed integrity_check, and is not smaller. Skipping copy.");
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
            schemaLogger.info(
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
            schemaLogger.info(
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

      schemaLogger.info("Migration completed successfully.");
      schemaLogger.info("Migrated files:", migratedFiles);
      schemaLogger.info("Migrated directories:", migratedDirs);
    } catch (error) {
      schemaLogger.error("Migration failed:", error);
      migrationSuccessful = false;
      // Don't create marker if migration failed - allows retry on next startup
    }

    if (!migrationSuccessful) {
      schemaLogger.warn("Migration incomplete - will retry on next startup");
    }
  }

  /**
   * Restrict directory permissions so mailbox and settings data are not
   * accessible to other local users by default.
   */
  private ensureRestrictedDirectory(dirPath: string): void {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
      }
      fs.chmodSync(dirPath, 0o700);
    } catch (error) {
      schemaLogger.warn("Failed to restrict userData directory permissions:", error);
    }
  }

  /**
   * Restrict file permissions for the main SQLite database file.
   */
  private ensureRestrictedFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.chmodSync(filePath, 0o600);
      }
    } catch (error) {
      schemaLogger.warn("Failed to restrict database file permissions:", error);
    }
  }

  private databasePassesIntegrityCheck(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    let probe: Database.Database | null = null;
    try {
      probe = new Database(filePath, { readonly: true, fileMustExist: true });
      const result = probe.prepare("PRAGMA integrity_check").pluck().get() as string | undefined;
      return result === "ok";
    } catch (error) {
      schemaLogger.warn(`integrity_check failed for ${filePath}:`, error);
      return false;
    } finally {
      try {
        probe?.close();
      } catch {
        // Best-effort cleanup only.
      }
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
        raw_prompt TEXT,
        status TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        budget_tokens INTEGER,
        budget_cost REAL,
        error TEXT,
        is_pinned INTEGER DEFAULT 0,
        worker_role TEXT,
        strategy_lock INTEGER DEFAULT 0,
        budget_profile TEXT,
        terminal_status TEXT,
        failure_class TEXT,
        verification_verdict TEXT,
        verification_report TEXT,
        best_known_outcome TEXT,
        budget_usage TEXT,
        continuation_count INTEGER DEFAULT 0,
        continuation_window INTEGER DEFAULT 1,
        lifetime_turns_used INTEGER DEFAULT 0,
        last_progress_score REAL,
        auto_continue_block_reason TEXT,
        compaction_count INTEGER DEFAULT 0,
        last_compaction_at INTEGER,
        last_compaction_tokens_before INTEGER,
        last_compaction_tokens_after INTEGER,
        no_progress_streak INTEGER DEFAULT 0,
        last_loop_fingerprint TEXT,
        risk_level TEXT,
        eval_case_id TEXT,
        eval_run_id TEXT,
        issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
        heartbeat_run_id TEXT REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
        company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
        goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        request_depth INTEGER,
        billing_code TEXT,
        semantic_summary TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS eval_cases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id),
        source_task_id TEXT REFERENCES tasks(id),
        prompt TEXT NOT NULL,
        sanitized_prompt TEXT NOT NULL,
        assertions TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS eval_suites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        case_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS eval_runs (
        id TEXT PRIMARY KEY,
        suite_id TEXT NOT NULL REFERENCES eval_suites(id),
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        pass_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS eval_case_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
        case_id TEXT NOT NULL REFERENCES eval_cases(id),
        status TEXT NOT NULL,
        details TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS hook_sessions (
        session_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hook_session_locks (
        session_key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 2,
        event_id TEXT,
        seq INTEGER,
        ts INTEGER,
        status TEXT,
        step_id TEXT,
        group_id TEXT,
        actor TEXT,
        legacy_type TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS managed_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS managed_agent_versions (
        agent_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        model_json TEXT,
        system_prompt TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        runtime_defaults_json TEXT,
        skills_json TEXT,
        mcp_servers_json TEXT,
        team_template_json TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, version),
        FOREIGN KEY (agent_id) REFERENCES managed_agents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS managed_environments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS managed_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_version INTEGER NOT NULL,
        environment_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        backing_task_id TEXT,
        backing_team_run_id TEXT,
        resumed_from_session_id TEXT,
        latest_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (agent_id) REFERENCES managed_agents(id),
        FOREIGN KEY (environment_id) REFERENCES managed_environments(id),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (backing_task_id) REFERENCES tasks(id),
        FOREIGN KEY (backing_team_run_id) REFERENCES agent_team_runs(id),
        FOREIGN KEY (resumed_from_session_id) REFERENCES managed_sessions(id)
      );

      CREATE TABLE IF NOT EXISTS managed_session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_task_id TEXT,
        source_task_event_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (source_task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_managed_agents_status ON managed_agents(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_managed_agent_versions_agent ON managed_agent_versions(agent_id, version DESC);
      CREATE INDEX IF NOT EXISTS idx_managed_environments_status ON managed_environments(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_managed_sessions_environment ON managed_sessions(environment_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_managed_sessions_workspace ON managed_sessions(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_managed_sessions_task ON managed_sessions(backing_task_id);
      CREATE INDEX IF NOT EXISTS idx_managed_sessions_team_run ON managed_sessions(backing_team_run_id);
      CREATE INDEX IF NOT EXISTS idx_managed_session_events_session_seq ON managed_session_events(session_id, seq ASC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_session_events_source_task_event
        ON managed_session_events(session_id, source_task_event_id)
        WHERE source_task_event_id IS NOT NULL;

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

      CREATE TABLE IF NOT EXISTS workspace_permission_rules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        effect TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_tool_name TEXT,
        scope_path TEXT,
        scope_prefix TEXT,
        scope_server_name TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS input_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        questions TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        answers TEXT,
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

      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        is_default INTEGER NOT NULL DEFAULT 0,
        default_workspace_id TEXT,
        monthly_budget_cost REAL,
        budget_paused_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (default_workspace_id) REFERENCES workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        target_date INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        monthly_budget_cost REAL,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_workspace_links (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, workspace_id)
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        parent_issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        active_run_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'backlog',
        priority INTEGER NOT NULL DEFAULT 1,
        assignee_agent_role_id TEXT REFERENCES agent_roles(id) ON DELETE SET NULL,
        reporter_agent_role_id TEXT REFERENCES agent_roles(id) ON DELETE SET NULL,
        request_depth INTEGER,
        billing_code TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS issue_comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        author_type TEXT NOT NULL,
        author_agent_role_id TEXT REFERENCES agent_roles(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS heartbeat_runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        agent_role_id TEXT REFERENCES agent_roles(id) ON DELETE SET NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        run_type TEXT DEFAULT 'dispatch',
        dispatch_kind TEXT,
        reason TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        error TEXT,
        cost_stats TEXT,
        evidence_refs TEXT,
        resumed_from_run_id TEXT REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS heartbeat_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mission_control_items (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        decision TEXT,
        next_step TEXT,
        agent_role_id TEXT,
        agent_name TEXT,
        workspace_id TEXT,
        workspace_name TEXT,
        company_id TEXT,
        company_name TEXT,
        task_id TEXT,
        issue_id TEXT,
        run_id TEXT,
        timestamp INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mission_control_items_scope
        ON mission_control_items(workspace_id, company_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_mission_control_items_category
        ON mission_control_items(category, severity, timestamp DESC);

      CREATE TABLE IF NOT EXISTS mission_control_item_evidence (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        title TEXT NOT NULL,
        summary TEXT,
        payload_json TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mission_control_evidence_item
        ON mission_control_item_evidence(item_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS company_package_sources (
        id TEXT PRIMARY KEY,
        company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL,
        name TEXT NOT NULL,
        root_uri TEXT NOT NULL,
        local_path TEXT,
        ref TEXT,
        pin TEXT,
        trust_level TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL DEFAULT 'ready',
        notes TEXT,
        last_synced_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(company_id, root_uri)
      );

      CREATE TABLE IF NOT EXISTS company_package_manifests (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES company_package_sources(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        relative_path TEXT NOT NULL,
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(source_id, relative_path)
      );

      CREATE TABLE IF NOT EXISTS company_org_nodes (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        source_id TEXT REFERENCES company_package_sources(id) ON DELETE CASCADE,
        manifest_id TEXT REFERENCES company_package_manifests(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        relative_path TEXT,
        parent_node_id TEXT REFERENCES company_org_nodes(id) ON DELETE SET NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS company_org_edges (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        source_id TEXT REFERENCES company_package_sources(id) ON DELETE CASCADE,
        from_node_id TEXT NOT NULL REFERENCES company_org_nodes(id) ON DELETE CASCADE,
        to_node_id TEXT NOT NULL REFERENCES company_org_nodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS company_sync_states (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        source_id TEXT REFERENCES company_package_sources(id) ON DELETE CASCADE,
        manifest_id TEXT REFERENCES company_package_manifests(id) ON DELETE SET NULL,
        org_node_id TEXT REFERENCES company_org_nodes(id) ON DELETE CASCADE,
        runtime_entity_kind TEXT NOT NULL,
        runtime_entity_id TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'unlinked',
        last_synced_at INTEGER,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_created_at
        ON tasks(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at
        ON tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_completed_at
        ON tasks(workspace_id, completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_completed_at
        ON tasks(completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_hook_sessions_task ON hook_sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_hook_session_locks_expires ON hook_session_locks(expires_at);
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_events_timestamp
        ON task_events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_task_events_type_timestamp_task
        ON task_events(type, timestamp DESC, task_id);
      CREATE INDEX IF NOT EXISTS idx_task_events_task_type_timestamp
        ON task_events(task_id, type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_workspace_permission_rules_workspace
        ON workspace_permission_rules(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspace_permission_rules_scope
        ON workspace_permission_rules(workspace_id, scope_kind);
      CREATE INDEX IF NOT EXISTS idx_input_requests_task_status ON input_requests(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_input_requests_requested ON input_requests(requested_at);
      CREATE INDEX IF NOT EXISTS idx_llm_models_active ON llm_models(is_active);
      CREATE INDEX IF NOT EXISTS idx_eval_cases_workspace ON eval_cases(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_eval_cases_source_task ON eval_cases(source_task_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_suite ON eval_runs(suite_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_eval_case_runs_run ON eval_case_runs(run_id);
      CREATE INDEX IF NOT EXISTS idx_eval_case_runs_case ON eval_case_runs(case_id);
      CREATE INDEX IF NOT EXISTS idx_companies_default ON companies(is_default, created_at);
      CREATE INDEX IF NOT EXISTS idx_goals_company ON goals(company_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_goal ON projects(goal_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_workspace_links_project ON project_workspace_links(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_workspace_links_workspace ON project_workspace_links(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_issues_company ON issues(company_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_issues_goal ON issues(goal_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_issues_workspace ON issues(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_agent_role_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_company_package_sources_company ON company_package_sources(company_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_company_package_manifests_source ON company_package_manifests(source_id, kind, relative_path);
      CREATE INDEX IF NOT EXISTS idx_company_org_nodes_company ON company_org_nodes(company_id, kind, name);
      CREATE INDEX IF NOT EXISTS idx_company_org_nodes_source ON company_org_nodes(source_id, kind, name);
      CREATE INDEX IF NOT EXISTS idx_company_org_edges_company ON company_org_edges(company_id, kind);
      CREATE INDEX IF NOT EXISTS idx_company_sync_states_company ON company_sync_states(company_id, runtime_entity_kind, runtime_entity_id);
      CREATE INDEX IF NOT EXISTS idx_company_sync_states_org_node ON company_sync_states(org_node_id, runtime_entity_kind);
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

      CREATE TABLE IF NOT EXISTS curated_memory_entries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.7,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_confirmed_at INTEGER,
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

      CREATE TABLE IF NOT EXISTS memory_observation_metadata (
        memory_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        origin TEXT NOT NULL DEFAULT 'unknown',
        observation_type TEXT NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT,
        narrative TEXT NOT NULL,
        facts TEXT NOT NULL DEFAULT '[]',
        concepts TEXT NOT NULL DEFAULT '[]',
        files_read TEXT NOT NULL DEFAULT '[]',
        files_modified TEXT NOT NULL DEFAULT '[]',
        tools TEXT NOT NULL DEFAULT '[]',
        source_event_ids TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        capture_reason TEXT NOT NULL DEFAULT 'memory_capture',
        privacy_state TEXT NOT NULL DEFAULT 'normal',
        generated_by TEXT NOT NULL DEFAULT 'capture',
        migration_status TEXT NOT NULL DEFAULT 'current',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
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
      CREATE INDEX IF NOT EXISTS idx_curated_memory_workspace_target
        ON curated_memory_entries(workspace_id, target, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_curated_memory_workspace_kind
        ON curated_memory_entries(workspace_id, kind, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_curated_memory_normalized_key
        ON curated_memory_entries(workspace_id, target, kind, normalized_key, status);
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_workspace ON memory_embeddings(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_memory_summaries_workspace ON memory_summaries(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_memory_summaries_period ON memory_summaries(time_period, period_start);
      CREATE INDEX IF NOT EXISTS idx_memory_observation_workspace_created
        ON memory_observation_metadata(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_observation_type
        ON memory_observation_metadata(workspace_id, observation_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_observation_hash
        ON memory_observation_metadata(workspace_id, content_hash, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_observation_privacy
        ON memory_observation_metadata(workspace_id, privacy_state, created_at DESC);

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

      -- Mailbox domain cache for Inbox Agent
      CREATE TABLE IF NOT EXISTS mailbox_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        address TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'connected',
        capabilities_json TEXT,
        sync_cursor TEXT,
        classification_initial_batch_at INTEGER,
        last_synced_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_threads (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider_thread_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        snippet TEXT NOT NULL,
        participants_json TEXT,
        labels_json TEXT,
        category TEXT NOT NULL DEFAULT 'other',
        today_bucket TEXT NOT NULL DEFAULT 'more_to_browse',
        domain_category TEXT NOT NULL DEFAULT 'other',
        classification_rationale TEXT,
        priority_score REAL NOT NULL DEFAULT 0,
        urgency_score REAL NOT NULL DEFAULT 0,
        needs_reply INTEGER NOT NULL DEFAULT 0,
        stale_followup INTEGER NOT NULL DEFAULT 0,
        cleanup_candidate INTEGER NOT NULL DEFAULT 0,
        handled INTEGER NOT NULL DEFAULT 0,
        local_inbox_hidden INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER NOT NULL,
        last_synced_at INTEGER,
        classification_state TEXT NOT NULL DEFAULT 'pending',
        classification_fingerprint TEXT,
        classification_model_key TEXT,
        classification_prompt_version TEXT,
        classification_confidence REAL NOT NULL DEFAULT 0,
        classification_updated_at INTEGER,
        classification_error TEXT,
        classification_json TEXT,
        sensitive_content_json TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        from_name TEXT,
        from_email TEXT,
        to_json TEXT,
        cc_json TEXT,
        bcc_json TEXT,
        subject TEXT NOT NULL,
        snippet TEXT NOT NULL,
        body_text TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        is_unread INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        provider_attachment_id TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER,
        extraction_status TEXT NOT NULL DEFAULT 'not_indexed',
        extraction_error TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id),
        FOREIGN KEY (message_id) REFERENCES mailbox_messages(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_attachment_text (
        attachment_id TEXT PRIMARY KEY,
        text_content TEXT NOT NULL,
        extraction_mode TEXT NOT NULL,
        extracted_at INTEGER NOT NULL,
        FOREIGN KEY (attachment_id) REFERENCES mailbox_attachments(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_search_embeddings (
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        account_id TEXT,
        thread_id TEXT NOT NULL,
        message_id TEXT,
        attachment_id TEXT,
        source_text_hash TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        snippet TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (record_type, record_id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_folders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider_folder_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'custom',
        unread_count INTEGER,
        total_count INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(account_id, provider_folder_id),
        FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_labels (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider_label_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        unread_count INTEGER,
        total_count INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(account_id, provider_label_id),
        FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_identities (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider_identity_id TEXT,
        email TEXT NOT NULL,
        display_name TEXT,
        signature_id TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_signatures (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        body_html TEXT,
        body_text TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_compose_drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        thread_id TEXT,
        provider_draft_id TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        body_html TEXT,
        to_json TEXT NOT NULL,
        cc_json TEXT NOT NULL,
        bcc_json TEXT NOT NULL,
        identity_id TEXT,
        signature_id TEXT,
        attachments_json TEXT,
        scheduled_at INTEGER,
        send_after INTEGER,
        latest_error TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id),
        FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_outgoing_messages (
        id TEXT PRIMARY KEY,
        draft_id TEXT,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_message_id TEXT,
        scheduled_at INTEGER,
        send_after INTEGER,
        latest_error TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (draft_id) REFERENCES mailbox_compose_drafts(id),
        FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_queued_actions (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        thread_id TEXT,
        draft_id TEXT,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        latest_error TEXT,
        undo_of_action_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id),
        FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id),
        FOREIGN KEY (draft_id) REFERENCES mailbox_compose_drafts(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_client_settings (
        id TEXT PRIMARY KEY,
        remote_content_policy TEXT NOT NULL DEFAULT 'load',
        send_delay_seconds INTEGER NOT NULL DEFAULT 30,
        sync_recent_days INTEGER NOT NULL DEFAULT 30,
        attachment_cache TEXT NOT NULL DEFAULT 'metadata_on_demand',
        notifications TEXT NOT NULL DEFAULT 'needs_reply',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_summaries (
        thread_id TEXT PRIMARY KEY,
        summary_text TEXT NOT NULL,
        key_asks_json TEXT,
        extracted_questions_json TEXT,
        suggested_next_action TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_drafts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        tone TEXT NOT NULL,
        rationale TEXT NOT NULL,
        schedule_notes TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_action_proposals (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        proposal_type TEXT NOT NULL,
        title TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        preview_json TEXT,
        status TEXT NOT NULL DEFAULT 'suggested',
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_contacts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        company TEXT,
        role TEXT,
        encryption_preference TEXT,
        policy_flags_json TEXT,
        crm_links_json TEXT,
        learned_facts_json TEXT,
        response_tendency TEXT,
        last_interaction_at INTEGER,
        open_commitments INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_commitments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        message_id TEXT,
        title TEXT NOT NULL,
        due_at INTEGER,
        state TEXT NOT NULL DEFAULT 'suggested',
        owner_email TEXT,
        source_excerpt TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_events (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        account_id TEXT,
        thread_id TEXT,
        provider TEXT,
        subject TEXT,
        summary_text TEXT,
        evidence_refs_json TEXT,
        payload_json TEXT NOT NULL,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agentmail_workspace_pods (
        workspace_id TEXT PRIMARY KEY,
        pod_id TEXT NOT NULL UNIQUE,
        pod_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS agentmail_inboxes (
        workspace_id TEXT NOT NULL,
        pod_id TEXT NOT NULL,
        inbox_id TEXT NOT NULL,
        email TEXT,
        display_name TEXT,
        client_id TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (pod_id, inbox_id),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS agentmail_domains (
        domain_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        pod_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        status TEXT,
        feedback_enabled INTEGER NOT NULL DEFAULT 0,
        records_json TEXT,
        client_id TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS agentmail_lists (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        pod_id TEXT,
        inbox_id TEXT,
        direction TEXT NOT NULL,
        list_type TEXT NOT NULL,
        entry_value TEXT NOT NULL,
        entry_type TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS agentmail_api_keys (
        api_key_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        pod_id TEXT,
        inbox_id TEXT,
        name TEXT,
        prefix TEXT NOT NULL,
        permissions_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS agentmail_realtime_state (
        id TEXT PRIMARY KEY,
        connection_state TEXT NOT NULL,
        last_event_at INTEGER,
        last_error TEXT,
        subscribed_inboxes_json TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_identities (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        primary_email TEXT,
        company_hint TEXT,
        kg_entity_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_identity_handles (
        id TEXT PRIMARY KEY,
        contact_identity_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        handle_type TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        display_value TEXT NOT NULL,
        source TEXT NOT NULL,
        channel_id TEXT,
        channel_type TEXT,
        channel_user_id TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (contact_identity_id) REFERENCES contact_identities(id)
      );

      CREATE TABLE IF NOT EXISTS contact_identity_suggestions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        contact_identity_id TEXT NOT NULL,
        handle_type TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        display_value TEXT NOT NULL,
        source TEXT NOT NULL,
        source_label TEXT NOT NULL,
        channel_id TEXT,
        channel_type TEXT,
        channel_user_id TEXT,
        confidence REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'suggested',
        reason_codes_json TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (contact_identity_id) REFERENCES contact_identities(id)
      );

      CREATE TABLE IF NOT EXISTS contact_identity_audit (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        contact_identity_id TEXT,
        handle_id TEXT,
        suggestion_id TEXT,
        action TEXT NOT NULL,
        detail_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (contact_identity_id) REFERENCES contact_identities(id),
        FOREIGN KEY (handle_id) REFERENCES contact_identity_handles(id),
        FOREIGN KEY (suggestion_id) REFERENCES contact_identity_suggestions(id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_automations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        thread_id TEXT,
        source TEXT NOT NULL,
        recipe_json TEXT NOT NULL,
        backing_trigger_id TEXT,
        backing_cron_job_id TEXT,
        latest_outcome TEXT,
        latest_fire_at INTEGER,
        latest_run_at INTEGER,
        next_run_at INTEGER,
        latest_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_automation_audit (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_mission_control_handoffs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        company_name TEXT NOT NULL,
        operator_role_id TEXT NOT NULL,
        operator_display_name TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        issue_title TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'mailbox_handoff',
        latest_outcome TEXT,
        latest_wake_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_snippets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        shortcut TEXT NOT NULL,
        body_text TEXT NOT NULL,
        subject_hint TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_saved_views (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        instructions TEXT NOT NULL,
        seed_thread_id TEXT,
        show_in_inbox INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mailbox_saved_view_threads (
        view_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        score REAL,
        PRIMARY KEY (view_id, thread_id)
      );

      CREATE TABLE IF NOT EXISTS mailbox_triage_feedback (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        feedback_kind TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mailbox_snippets_workspace ON mailbox_snippets(workspace_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_snippets_workspace_shortcut ON mailbox_snippets(workspace_id, shortcut);
      CREATE INDEX IF NOT EXISTS idx_mailbox_saved_views_workspace ON mailbox_saved_views(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_saved_view_threads_thread ON mailbox_saved_view_threads(thread_id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_saved_view_threads_view ON mailbox_saved_view_threads(view_id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_triage_feedback_thread ON mailbox_triage_feedback(thread_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_mailbox_threads_account ON mailbox_threads(account_id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_threads_priority ON mailbox_threads(priority_score DESC, urgency_score DESC, last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_threads_flags ON mailbox_threads(needs_reply, cleanup_candidate, stale_followup);
      CREATE INDEX IF NOT EXISTS idx_mailbox_messages_thread ON mailbox_messages(thread_id, received_at);
      CREATE INDEX IF NOT EXISTS idx_mailbox_attachments_thread ON mailbox_attachments(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_attachments_message ON mailbox_attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_attachments_status ON mailbox_attachments(extraction_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_search_embeddings_thread ON mailbox_search_embeddings(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_search_embeddings_account ON mailbox_search_embeddings(account_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_folders_account ON mailbox_folders(account_id, role, name);
      CREATE INDEX IF NOT EXISTS idx_mailbox_labels_account ON mailbox_labels(account_id, name);
      CREATE INDEX IF NOT EXISTS idx_mailbox_identities_account ON mailbox_identities(account_id, is_default DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_signatures_account ON mailbox_signatures(account_id, is_default DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_compose_drafts_account ON mailbox_compose_drafts(account_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_compose_drafts_thread ON mailbox_compose_drafts(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_outgoing_status ON mailbox_outgoing_messages(status, send_after, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_queued_actions_status ON mailbox_queued_actions(status, next_attempt_at, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_queued_actions_thread ON mailbox_queued_actions(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_drafts_thread ON mailbox_drafts(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_proposals_thread ON mailbox_action_proposals(thread_id, status, proposal_type);
      CREATE INDEX IF NOT EXISTS idx_mailbox_commitments_thread ON mailbox_commitments(thread_id, state, due_at);
      CREATE INDEX IF NOT EXISTS idx_mailbox_contacts_email ON mailbox_contacts(email);
      CREATE INDEX IF NOT EXISTS idx_mailbox_events_workspace ON mailbox_events(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_events_thread ON mailbox_events(thread_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agentmail_inboxes_workspace ON agentmail_inboxes(workspace_id, pod_id);
      CREATE INDEX IF NOT EXISTS idx_agentmail_domains_workspace ON agentmail_domains(workspace_id, pod_id);
      CREATE INDEX IF NOT EXISTS idx_agentmail_lists_workspace ON agentmail_lists(workspace_id, inbox_id, direction, list_type);
      CREATE INDEX IF NOT EXISTS idx_agentmail_api_keys_workspace ON agentmail_api_keys(workspace_id, inbox_id);
      CREATE INDEX IF NOT EXISTS idx_contact_identities_workspace ON contact_identities(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_identities_email ON contact_identities(primary_email);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_identity_handles_unique
        ON contact_identity_handles(workspace_id, handle_type, normalized_value);
      CREATE INDEX IF NOT EXISTS idx_contact_identity_handles_identity
        ON contact_identity_handles(contact_identity_id, handle_type);
      CREATE INDEX IF NOT EXISTS idx_contact_identity_handles_channel
        ON contact_identity_handles(channel_type, channel_user_id);
      CREATE INDEX IF NOT EXISTS idx_contact_identity_suggestions_workspace
        ON contact_identity_suggestions(workspace_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_identity_suggestions_identity
        ON contact_identity_suggestions(contact_identity_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_identity_audit_identity
        ON contact_identity_audit(contact_identity_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_workspace ON mailbox_automations(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_thread ON mailbox_automations(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_kind ON mailbox_automations(kind, status);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_trigger ON mailbox_automations(backing_trigger_id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automations_cron ON mailbox_automations(backing_cron_job_id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_automation_audit_automation
        ON mailbox_automation_audit(automation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_mc_handoffs_thread
        ON mailbox_mission_control_handoffs(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailbox_mc_handoffs_issue
        ON mailbox_mission_control_handoffs(issue_id);
      CREATE INDEX IF NOT EXISTS idx_mailbox_mc_handoffs_company_operator
        ON mailbox_mission_control_handoffs(company_id, operator_role_id, updated_at DESC);
    `);

    // Initialize FTS5 for memory search (separate exec to handle if not supported)
    this.initializeMemoryFTS();
    this.initializeMarkdownMemoryFTS();
    this.initializeMailboxSearchFTS();
    // Run migrations for task-retry tracking columns (SQLite ALTER TABLE ADD COLUMN is safe if column exists)
    this.runMigrations();
    this.initializeKnowledgeGraphFTS();

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
      schemaLogger.warn(
        "[DatabaseManager] FTS5 initialization failed, full-text search will be disabled:",
        error,
      );
    }

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_observation_metadata_fts USING fts5(
          title,
          subtitle,
          narrative,
          facts,
          concepts,
          files_read,
          files_modified,
          tools,
          content='memory_observation_metadata',
          content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS memory_observation_metadata_fts_insert
        AFTER INSERT ON memory_observation_metadata BEGIN
          INSERT INTO memory_observation_metadata_fts(
            rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified, tools
          )
          VALUES (
            NEW.rowid, NEW.title, NEW.subtitle, NEW.narrative, NEW.facts, NEW.concepts,
            NEW.files_read, NEW.files_modified, NEW.tools
          );
        END;

        CREATE TRIGGER IF NOT EXISTS memory_observation_metadata_fts_delete
        AFTER DELETE ON memory_observation_metadata BEGIN
          INSERT INTO memory_observation_metadata_fts(
            memory_observation_metadata_fts, rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified, tools
          )
          VALUES (
            'delete', OLD.rowid, OLD.title, OLD.subtitle, OLD.narrative, OLD.facts, OLD.concepts,
            OLD.files_read, OLD.files_modified, OLD.tools
          );
        END;

        CREATE TRIGGER IF NOT EXISTS memory_observation_metadata_fts_update
        AFTER UPDATE ON memory_observation_metadata BEGIN
          INSERT INTO memory_observation_metadata_fts(
            memory_observation_metadata_fts, rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified, tools
          )
          VALUES (
            'delete', OLD.rowid, OLD.title, OLD.subtitle, OLD.narrative, OLD.facts, OLD.concepts,
            OLD.files_read, OLD.files_modified, OLD.tools
          );
          INSERT INTO memory_observation_metadata_fts(
            rowid, title, subtitle, narrative, facts, concepts, files_read, files_modified, tools
          )
          VALUES (
            NEW.rowid, NEW.title, NEW.subtitle, NEW.narrative, NEW.facts, NEW.concepts,
            NEW.files_read, NEW.files_modified, NEW.tools
          );
        END;
      `);
    } catch (error) {
      schemaLogger.warn(
        "[DatabaseManager] Observation metadata FTS5 initialization failed:",
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
      schemaLogger.warn(
        "[DatabaseManager] Markdown FTS5 initialization failed, markdown full-text search will be limited:",
        error,
      );
    }
  }

  private initializeMailboxSearchFTS() {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS mailbox_search_fts USING fts5(
          record_type UNINDEXED,
          record_id UNINDEXED,
          thread_id UNINDEXED,
          message_id UNINDEXED,
          attachment_id UNINDEXED,
          subject,
          sender,
          body,
          attachment_filename,
          attachment_text
        );
      `);
    } catch (error) {
      schemaLogger.warn(
        "[DatabaseManager] Mailbox FTS5 initialization failed, mailbox search will use fallback matching:",
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

    // Migration: Add strategy routing + execution result metadata columns to tasks table
    const strategyAndResultColumns = [
      "ALTER TABLE tasks ADD COLUMN raw_prompt TEXT",
      "ALTER TABLE tasks ADD COLUMN strategy_lock INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN budget_profile TEXT",
      "ALTER TABLE tasks ADD COLUMN terminal_status TEXT",
      "ALTER TABLE tasks ADD COLUMN failure_class TEXT",
      "ALTER TABLE tasks ADD COLUMN best_known_outcome TEXT",
      "ALTER TABLE tasks ADD COLUMN budget_usage TEXT",
      "ALTER TABLE tasks ADD COLUMN continuation_count INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN continuation_window INTEGER DEFAULT 1",
      "ALTER TABLE tasks ADD COLUMN lifetime_turns_used INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN last_progress_score REAL",
      "ALTER TABLE tasks ADD COLUMN auto_continue_block_reason TEXT",
      "ALTER TABLE tasks ADD COLUMN compaction_count INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN last_compaction_at INTEGER",
      "ALTER TABLE tasks ADD COLUMN last_compaction_tokens_before INTEGER",
      "ALTER TABLE tasks ADD COLUMN last_compaction_tokens_after INTEGER",
      "ALTER TABLE tasks ADD COLUMN no_progress_streak INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN last_loop_fingerprint TEXT",
      "ALTER TABLE tasks ADD COLUMN risk_level TEXT",
      "ALTER TABLE tasks ADD COLUMN eval_case_id TEXT",
      "ALTER TABLE tasks ADD COLUMN eval_run_id TEXT",
    ];

    for (const sql of strategyAndResultColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    // Migration: Task timeline v2 columns
    const taskEventColumns = [
      "ALTER TABLE task_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 2",
      "ALTER TABLE task_events ADD COLUMN event_id TEXT",
      "ALTER TABLE task_events ADD COLUMN seq INTEGER",
      "ALTER TABLE task_events ADD COLUMN ts INTEGER",
      "ALTER TABLE task_events ADD COLUMN status TEXT",
      "ALTER TABLE task_events ADD COLUMN step_id TEXT",
      "ALTER TABLE task_events ADD COLUMN group_id TEXT",
      "ALTER TABLE task_events ADD COLUMN actor TEXT",
      "ALTER TABLE task_events ADD COLUMN legacy_type TEXT",
    ];

    for (const sql of taskEventColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events(task_id, seq)");
    } catch {
      // Index already exists, ignore
    }
    try {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_task_events_task_seq_timestamp ON task_events(task_id, seq, timestamp)",
      );
    } catch {
      // Index already exists, ignore
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS managed_agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          current_version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS managed_agent_versions (
          agent_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          model_json TEXT,
          system_prompt TEXT NOT NULL,
          execution_mode TEXT NOT NULL,
          runtime_defaults_json TEXT,
          skills_json TEXT,
          mcp_servers_json TEXT,
          team_template_json TEXT,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (agent_id, version),
          FOREIGN KEY (agent_id) REFERENCES managed_agents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS managed_environments (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          config_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS managed_sessions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          agent_version INTEGER NOT NULL,
          environment_id TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          backing_task_id TEXT,
          backing_team_run_id TEXT,
          resumed_from_session_id TEXT,
          latest_summary TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY (agent_id) REFERENCES managed_agents(id),
          FOREIGN KEY (environment_id) REFERENCES managed_environments(id),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (backing_task_id) REFERENCES tasks(id),
          FOREIGN KEY (backing_team_run_id) REFERENCES agent_team_runs(id),
          FOREIGN KEY (resumed_from_session_id) REFERENCES managed_sessions(id)
        );

        CREATE TABLE IF NOT EXISTS managed_session_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          source_task_id TEXT,
          source_task_event_id TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES managed_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (source_task_id) REFERENCES tasks(id)
        );

        CREATE INDEX IF NOT EXISTS idx_managed_agents_status
          ON managed_agents(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_managed_agent_versions_agent
          ON managed_agent_versions(agent_id, version DESC);
        CREATE INDEX IF NOT EXISTS idx_managed_environments_status
          ON managed_environments(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_managed_sessions_environment
          ON managed_sessions(environment_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_managed_sessions_workspace
          ON managed_sessions(workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_managed_sessions_task
          ON managed_sessions(backing_task_id);
        CREATE INDEX IF NOT EXISTS idx_managed_sessions_team_run
          ON managed_sessions(backing_team_run_id);
        CREATE INDEX IF NOT EXISTS idx_managed_session_events_session_seq
          ON managed_session_events(session_id, seq ASC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_session_events_source_task_event
          ON managed_session_events(session_id, source_task_event_id)
          WHERE source_task_event_id IS NOT NULL;
      `);
    } catch (error) {
      schemaLogger.error("[DatabaseManager] Failed managed agents migration:", error);
    }

    // These indexes depend on the timeline-v2 legacy_type column, so create them
    // only after the migration above has had a chance to add the column on older DBs.
    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_task_events_legacy_type_timestamp_task
          ON task_events(legacy_type, timestamp DESC, task_id);
        CREATE INDEX IF NOT EXISTS idx_task_events_task_legacy_type_timestamp
          ON task_events(task_id, legacy_type, timestamp DESC);
      `);
    } catch {
      // Column may still be unavailable on partially-corrupt DBs; a later repair can retry.
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

    // Migration: Add reliability indexes for risk/eval metadata
    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_risk_level ON tasks(risk_level)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_eval_case_id ON tasks(eval_case_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_eval_run_id ON tasks(eval_run_id)");
    } catch {
      // Index already exists, ignore
    }

    // Migration: Create eval corpus and run tracking tables
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS eval_cases (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          workspace_id TEXT REFERENCES workspaces(id),
          source_task_id TEXT REFERENCES tasks(id),
          prompt TEXT NOT NULL,
          sanitized_prompt TEXT NOT NULL,
          assertions TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS eval_suites (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          case_ids TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS eval_runs (
          id TEXT PRIMARY KEY,
          suite_id TEXT NOT NULL REFERENCES eval_suites(id),
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          pass_count INTEGER NOT NULL DEFAULT 0,
          fail_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS eval_case_runs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
          case_id TEXT NOT NULL REFERENCES eval_cases(id),
          status TEXT NOT NULL,
          details TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          duration_ms INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_eval_cases_workspace ON eval_cases(workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_eval_cases_source_task ON eval_cases(source_task_id);
        CREATE INDEX IF NOT EXISTS idx_eval_runs_suite ON eval_runs(suite_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_eval_case_runs_run ON eval_case_runs(run_id);
        CREATE INDEX IF NOT EXISTS idx_eval_case_runs_case ON eval_case_runs(case_id);
      `);
    } catch {
      // Table or index already exists, ignore
    }

    // Migration: Create agent_roles table for Agent Squad feature
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_roles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          role_kind TEXT DEFAULT 'custom',
          source_template_id TEXT,
          source_template_version TEXT,
          company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
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
          autonomy_level TEXT DEFAULT 'specialist',
          soul TEXT,
          heartbeat_enabled INTEGER DEFAULT 0,
          heartbeat_interval_minutes INTEGER DEFAULT 15,
          heartbeat_stagger_offset INTEGER DEFAULT 0,
          heartbeat_pulse_every_minutes INTEGER DEFAULT 15,
          heartbeat_dispatch_cooldown_minutes INTEGER DEFAULT 120,
          heartbeat_max_dispatches_per_day INTEGER DEFAULT 6,
          heartbeat_profile TEXT DEFAULT 'observer',
          heartbeat_active_hours TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_heartbeat_at INTEGER,
          last_pulse_at INTEGER,
          last_dispatch_at INTEGER,
          heartbeat_last_pulse_result TEXT,
          heartbeat_last_dispatch_kind TEXT,
          heartbeat_status TEXT DEFAULT 'idle',
          operator_mandate TEXT,
          allowed_loop_types TEXT,
          output_types TEXT,
          suppression_policy TEXT,
          max_autonomous_outputs_per_cycle INTEGER DEFAULT 1,
          last_useful_output_at INTEGER,
          operator_health_score REAL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_roles_active ON agent_roles(is_active);
        CREATE INDEX IF NOT EXISTS idx_agent_roles_name ON agent_roles(name);
        CREATE INDEX IF NOT EXISTS idx_agent_roles_company ON agent_roles(company_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    // Migration: Add assigned_agent_role_id to tasks table
    const agentRoleColumns = [
      "ALTER TABLE tasks ADD COLUMN assigned_agent_role_id TEXT REFERENCES agent_roles(id)",
      "ALTER TABLE tasks ADD COLUMN worker_role TEXT",
      'ALTER TABLE tasks ADD COLUMN board_column TEXT DEFAULT "backlog"',
      "ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN verification_verdict TEXT",
      "ALTER TABLE tasks ADD COLUMN verification_report TEXT",
      "ALTER TABLE tasks ADD COLUMN semantic_summary TEXT",
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

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mission_control_items (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          decision TEXT,
          next_step TEXT,
          agent_role_id TEXT,
          agent_name TEXT,
          workspace_id TEXT,
          workspace_name TEXT,
          company_id TEXT,
          company_name TEXT,
          task_id TEXT,
          issue_id TEXT,
          run_id TEXT,
          timestamp INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mission_control_items_scope
          ON mission_control_items(workspace_id, company_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_mission_control_items_category
          ON mission_control_items(category, severity, timestamp DESC);

        CREATE TABLE IF NOT EXISTS mission_control_item_evidence (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT,
          title TEXT NOT NULL,
          summary TEXT,
          payload_json TEXT,
          timestamp INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mission_control_evidence_item
          ON mission_control_item_evidence(item_id, timestamp DESC);
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

    // Migration: Create supervisor exchange tables for Discord supervisor protocol
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS supervisor_exchanges (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          coordination_channel_id TEXT NOT NULL,
          source_channel_id TEXT,
          source_message_id TEXT,
          source_peer_user_id TEXT,
          worker_agent_role_id TEXT,
          supervisor_agent_role_id TEXT,
          linked_task_id TEXT,
          escalation_target TEXT,
          status TEXT NOT NULL,
          last_intent TEXT,
          turn_count INTEGER NOT NULL DEFAULT 0,
          terminal_reason TEXT,
          evidence_refs_json TEXT,
          human_resolution TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          closed_at INTEGER,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (worker_agent_role_id) REFERENCES agent_roles(id),
          FOREIGN KEY (supervisor_agent_role_id) REFERENCES agent_roles(id),
          FOREIGN KEY (linked_task_id) REFERENCES tasks(id)
        );

        CREATE INDEX IF NOT EXISTS idx_supervisor_exchanges_workspace
          ON supervisor_exchanges(workspace_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_supervisor_exchanges_status
          ON supervisor_exchanges(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_supervisor_exchanges_source
          ON supervisor_exchanges(source_message_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS supervisor_exchange_messages (
          id TEXT PRIMARY KEY,
          exchange_id TEXT NOT NULL REFERENCES supervisor_exchanges(id) ON DELETE CASCADE,
          discord_message_id TEXT NOT NULL UNIQUE,
          channel_id TEXT NOT NULL,
          author_user_id TEXT,
          actor_kind TEXT NOT NULL,
          intent TEXT NOT NULL,
          raw_content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_supervisor_exchange_messages_exchange
          ON supervisor_exchange_messages(exchange_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_supervisor_exchange_messages_channel
          ON supervisor_exchange_messages(channel_id, created_at DESC);
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

    try {
      const missionControlForeignKeys = [
        ...(this.db
          .prepare("PRAGMA foreign_key_list(mission_control_items)")
          .all() as Array<unknown>),
        ...(this.db
          .prepare("PRAGMA foreign_key_list(mission_control_item_evidence)")
          .all() as Array<unknown>),
      ];

      if (missionControlForeignKeys.length > 0) {
        this.db.exec(`
          DROP TABLE IF EXISTS mission_control_item_evidence;
          DROP TABLE IF EXISTS mission_control_items;
        `);
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mission_control_items (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          decision TEXT,
          next_step TEXT,
          agent_role_id TEXT,
          agent_name TEXT,
          workspace_id TEXT,
          workspace_name TEXT,
          company_id TEXT,
          company_name TEXT,
          task_id TEXT,
          issue_id TEXT,
          run_id TEXT,
          timestamp INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mission_control_items_scope
          ON mission_control_items(workspace_id, company_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_mission_control_items_category
          ON mission_control_items(category, severity, timestamp DESC);

        CREATE TABLE IF NOT EXISTS mission_control_item_evidence (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT,
          title TEXT NOT NULL,
          summary TEXT,
          payload_json TEXT,
          timestamp INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mission_control_evidence_item
          ON mission_control_item_evidence(item_id, timestamp DESC);
      `);
    } catch (error) {
      schemaLogger.warn("[DatabaseManager] Mission Control projection migration failed:", error);
    }

    // Migration: Add heartbeat and autonomy columns to agent_roles
    const missionControlColumns = [
      "ALTER TABLE agent_roles ADD COLUMN role_kind TEXT DEFAULT 'custom'",
      "ALTER TABLE agent_roles ADD COLUMN source_template_id TEXT",
      "ALTER TABLE agent_roles ADD COLUMN source_template_version TEXT",
      "ALTER TABLE agent_roles ADD COLUMN autonomy_level TEXT DEFAULT 'specialist'",
      "ALTER TABLE agent_roles ADD COLUMN soul TEXT",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_enabled INTEGER DEFAULT 0",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_interval_minutes INTEGER DEFAULT 15",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_stagger_offset INTEGER DEFAULT 0",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_pulse_every_minutes INTEGER DEFAULT 15",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_dispatch_cooldown_minutes INTEGER DEFAULT 120",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_max_dispatches_per_day INTEGER DEFAULT 6",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_profile TEXT DEFAULT 'observer'",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_active_hours TEXT",
      "ALTER TABLE agent_roles ADD COLUMN last_heartbeat_at INTEGER",
      "ALTER TABLE agent_roles ADD COLUMN last_pulse_at INTEGER",
      "ALTER TABLE agent_roles ADD COLUMN last_dispatch_at INTEGER",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_last_pulse_result TEXT",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_last_dispatch_kind TEXT",
      "ALTER TABLE agent_roles ADD COLUMN heartbeat_status TEXT DEFAULT 'idle'",
      "ALTER TABLE agent_roles ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE SET NULL",
      "ALTER TABLE agent_roles ADD COLUMN operator_mandate TEXT",
      "ALTER TABLE agent_roles ADD COLUMN allowed_loop_types TEXT",
      "ALTER TABLE agent_roles ADD COLUMN output_types TEXT",
      "ALTER TABLE agent_roles ADD COLUMN suppression_policy TEXT",
      "ALTER TABLE agent_roles ADD COLUMN max_autonomous_outputs_per_cycle INTEGER DEFAULT 1",
      "ALTER TABLE agent_roles ADD COLUMN last_useful_output_at INTEGER",
      "ALTER TABLE agent_roles ADD COLUMN operator_health_score REAL",
    ];

    for (const sql of missionControlColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_agent_roles_company ON agent_roles(company_id)");
    } catch {
      // Index already exists, ignore
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS heartbeat_policies (
          id TEXT PRIMARY KEY,
          agent_role_id TEXT NOT NULL UNIQUE REFERENCES agent_roles(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 0,
          cadence_minutes INTEGER NOT NULL DEFAULT 15,
          stagger_offset_minutes INTEGER NOT NULL DEFAULT 0,
          dispatch_cooldown_minutes INTEGER NOT NULL DEFAULT 120,
          max_dispatches_per_day INTEGER NOT NULL DEFAULT 6,
          profile TEXT NOT NULL DEFAULT 'observer',
          active_hours TEXT,
          primary_categories TEXT,
          proactive_tasks TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_heartbeat_policies_enabled ON heartbeat_policies(enabled, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_heartbeat_policies_agent_role ON heartbeat_policies(agent_role_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    try {
      const existingPolicyRoleIds = new Set(
        (
          this.db.prepare("SELECT agent_role_id FROM heartbeat_policies").all() as Array<{
            agent_role_id?: string;
          }>
        )
          .map((row) => (typeof row.agent_role_id === "string" ? row.agent_role_id : ""))
          .filter(Boolean),
      );
      const roles = this.db.prepare(
        `SELECT id, name, role_kind, source_template_id, source_template_version, soul,
                heartbeat_enabled, heartbeat_interval_minutes, heartbeat_stagger_offset,
                heartbeat_pulse_every_minutes, heartbeat_dispatch_cooldown_minutes,
                heartbeat_max_dispatches_per_day, heartbeat_profile, heartbeat_active_hours,
                created_at, updated_at
         FROM agent_roles`,
      ).all() as Array<Record<string, unknown>>;
      const insertPolicy = this.db.prepare(
        `INSERT INTO heartbeat_policies (
          id, agent_role_id, enabled, cadence_minutes, stagger_offset_minutes,
          dispatch_cooldown_minutes, max_dispatches_per_day, profile, active_hours,
          primary_categories, proactive_tasks, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updateRoleMetadata = this.db.prepare(
        `UPDATE agent_roles
         SET role_kind = COALESCE(role_kind, ?),
             source_template_id = COALESCE(source_template_id, ?),
             source_template_version = COALESCE(source_template_version, ?)
         WHERE id = ?`,
      );

      for (const role of roles) {
        const roleId = typeof role.id === "string" ? role.id : "";
        if (!roleId) continue;

        let primaryCategories: unknown[] = [];
        let proactiveTasks: unknown[] = [];
        let sourceTemplateId: string | null = null;
        let sourceTemplateVersion: string | null = null;

        if (typeof role.soul === "string" && role.soul.trim().length > 0) {
          try {
            const parsed = JSON.parse(role.soul) as Record<string, unknown>;
            const cognitiveOffload =
              parsed.cognitiveOffload && typeof parsed.cognitiveOffload === "object"
                ? (parsed.cognitiveOffload as Record<string, unknown>)
                : null;
            primaryCategories = Array.isArray(cognitiveOffload?.primaryCategories)
              ? (cognitiveOffload?.primaryCategories as unknown[])
              : [];
            proactiveTasks = Array.isArray(cognitiveOffload?.proactiveTasks)
              ? (cognitiveOffload?.proactiveTasks as unknown[])
              : [];
            sourceTemplateId =
              typeof parsed.sourceTemplateId === "string" ? parsed.sourceTemplateId : null;
            sourceTemplateVersion =
              typeof parsed.sourceTemplateVersion === "string" ? parsed.sourceTemplateVersion : null;
          } catch {
            // Ignore malformed soul JSON during migration.
          }
        }

        const derivedRoleKind =
          sourceTemplateId || (typeof role.name === "string" && role.name.startsWith("twin-"))
            ? "persona_template"
            : "custom";
        updateRoleMetadata.run(
          derivedRoleKind,
          sourceTemplateId,
          sourceTemplateVersion,
          roleId,
        );

        if (!existingPolicyRoleIds.has(roleId)) {
          insertPolicy.run(
            typeof crypto?.randomUUID === "function"
              ? crypto.randomUUID()
              : `${roleId}-heartbeat-policy`,
            roleId,
            role.heartbeat_enabled === 1 ? 1 : 0,
            Number(role.heartbeat_pulse_every_minutes || role.heartbeat_interval_minutes || 15),
            Number(role.heartbeat_stagger_offset || 0),
            Number(role.heartbeat_dispatch_cooldown_minutes || 120),
            Number(role.heartbeat_max_dispatches_per_day || 6),
            typeof role.heartbeat_profile === "string" ? role.heartbeat_profile : "observer",
            typeof role.heartbeat_active_hours === "string" ? role.heartbeat_active_hours : null,
            JSON.stringify(primaryCategories),
            JSON.stringify(proactiveTasks),
            Number(role.created_at || Date.now()),
            Number(role.updated_at || Date.now()),
          );
        }
      }
    } catch (error) {
      schemaLogger.error("Failed to migrate heartbeat policies:", error);
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS automation_profiles (
          id TEXT PRIMARY KEY,
          agent_role_id TEXT NOT NULL UNIQUE REFERENCES agent_roles(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 0,
          cadence_minutes INTEGER NOT NULL DEFAULT 15,
          stagger_offset_minutes INTEGER NOT NULL DEFAULT 0,
          dispatch_cooldown_minutes INTEGER NOT NULL DEFAULT 120,
          max_dispatches_per_day INTEGER NOT NULL DEFAULT 6,
          profile TEXT NOT NULL DEFAULT 'observer',
          active_hours TEXT,
          heartbeat_status TEXT NOT NULL DEFAULT 'idle',
          last_heartbeat_at INTEGER,
          last_pulse_at INTEGER,
          last_dispatch_at INTEGER,
          heartbeat_last_pulse_result TEXT,
          heartbeat_last_dispatch_kind TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_automation_profiles_enabled
          ON automation_profiles(enabled, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_automation_profiles_agent_role
          ON automation_profiles(agent_role_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    try {
      const existingAutomationRoleIds = new Set(
        (
          this.db.prepare("SELECT agent_role_id FROM automation_profiles").all() as Array<{
            agent_role_id?: string;
          }>
        )
          .map((row) => (typeof row.agent_role_id === "string" ? row.agent_role_id : ""))
          .filter(Boolean),
      );
      const policies = this.db.prepare(
        `SELECT hp.*, ar.role_kind, ar.name,
                ar.last_heartbeat_at, ar.last_pulse_at, ar.last_dispatch_at,
                ar.heartbeat_status, ar.heartbeat_last_pulse_result, ar.heartbeat_last_dispatch_kind,
                ar.created_at AS role_created_at, ar.updated_at AS role_updated_at
         FROM heartbeat_policies hp
         JOIN agent_roles ar ON ar.id = hp.agent_role_id`,
      ).all() as Array<Record<string, unknown>>;
      const insertAutomationProfile = this.db.prepare(
        `INSERT INTO automation_profiles (
          id, agent_role_id, enabled, cadence_minutes, stagger_offset_minutes,
          dispatch_cooldown_minutes, max_dispatches_per_day, profile, active_hours,
          heartbeat_status, last_heartbeat_at, last_pulse_at, last_dispatch_at,
          heartbeat_last_pulse_result, heartbeat_last_dispatch_kind, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const deleteTwinProfiles = this.db.prepare(
        `DELETE FROM automation_profiles
         WHERE agent_role_id IN (
           SELECT id FROM agent_roles WHERE role_kind = 'persona_template'
         )`,
      );

      deleteTwinProfiles.run();

      for (const policy of policies) {
        const agentRoleId =
          typeof policy.agent_role_id === "string" ? policy.agent_role_id : "";
        if (!agentRoleId || existingAutomationRoleIds.has(agentRoleId)) {
          continue;
        }
        if (policy.role_kind === "persona_template") {
          continue;
        }
        const createdAt = Number(policy.role_created_at || policy.created_at || Date.now());
        const updatedAt = Number(policy.role_updated_at || policy.updated_at || Date.now());
        insertAutomationProfile.run(
          typeof crypto?.randomUUID === "function"
            ? crypto.randomUUID()
            : `${agentRoleId}-automation-profile`,
          agentRoleId,
          policy.enabled === 1 ? 1 : 0,
          Number(policy.cadence_minutes || 15),
          Number(policy.stagger_offset_minutes || 0),
          Number(policy.dispatch_cooldown_minutes || 120),
          Number(policy.max_dispatches_per_day || 6),
          typeof policy.profile === "string" ? policy.profile : "observer",
          typeof policy.active_hours === "string" ? policy.active_hours : null,
          typeof policy.heartbeat_status === "string" ? policy.heartbeat_status : "idle",
          Number(policy.last_heartbeat_at || 0) || null,
          Number(policy.last_pulse_at || 0) || null,
          Number(policy.last_dispatch_at || 0) || null,
          typeof policy.heartbeat_last_pulse_result === "string"
            ? policy.heartbeat_last_pulse_result
            : null,
          typeof policy.heartbeat_last_dispatch_kind === "string"
            ? policy.heartbeat_last_dispatch_kind
            : null,
          createdAt,
          updatedAt,
        );
      }
    } catch (error) {
      schemaLogger.error("Failed to migrate automation profiles:", error);
    }

    // Fix broken FK reference in tasks table caused by previous heartbeat_runs migration.
    // SQLite 3.26.0+ automatically updates FK references in other tables when renaming a table.
    // If the prior migration renamed heartbeat_runs → heartbeat_runs_legacy without
    // PRAGMA legacy_alter_table = ON, the tasks table now has a broken FK to heartbeat_runs_legacy
    // (which was subsequently dropped), causing every INSERT INTO tasks to fail.
    try {
      const tasksSchema = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
        .get() as { sql?: string } | undefined;

      if (tasksSchema?.sql?.includes("heartbeat_runs_legacy")) {
        schemaLogger.info(
          "Fixing broken tasks FK reference (heartbeat_runs_legacy -> heartbeat_runs)...",
        );
        this.db.exec("PRAGMA foreign_keys = OFF");
        try {
          // writable_schema is blocked in this SQLite build — use standard table reconstruction instead.
          const fixedSql = tasksSchema.sql
            .replace(/heartbeat_runs_legacy/g, "heartbeat_runs")
            .replace(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?tasks["'`]?/i, "CREATE TABLE tasks_rebuild");
          this.db.exec(fixedSql);
          const columns = (
            this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
          )
            .map((col) => `"${col.name}"`)
            .join(", ");
          this.db.exec(`INSERT INTO tasks_rebuild (${columns}) SELECT ${columns} FROM tasks`);
          this.db.exec("DROP TABLE tasks");
          this.db.exec("ALTER TABLE tasks_rebuild RENAME TO tasks");
          schemaLogger.info("Fixed broken FK reference in tasks table.");
        } catch (rebuildErr) {
          try {
            this.db.exec("DROP TABLE IF EXISTS tasks_rebuild");
          } catch {
            // ignore cleanup error
          }
          throw rebuildErr;
        } finally {
          this.db.exec("PRAGMA foreign_keys = OFF");
        }
      }
    } catch (error) {
      schemaLogger.error("Failed to fix broken FK reference in tasks table:", error);
    }

    try {
      const heartbeatRunColumns = this.db
        .prepare("PRAGMA table_info(heartbeat_runs)")
        .all() as Array<{ name?: string; notnull?: number }>;
      const heartbeatRunColumnNames = new Set(
        heartbeatRunColumns
          .map((column) => (typeof column.name === "string" ? column.name : ""))
          .filter(Boolean),
      );
      const requiresHeartbeatRunMigration =
        heartbeatRunColumnNames.has("issue_id") &&
        (!heartbeatRunColumnNames.has("run_type") ||
          !heartbeatRunColumnNames.has("dispatch_kind") ||
          !heartbeatRunColumnNames.has("reason") ||
          !heartbeatRunColumnNames.has("cost_stats") ||
          !heartbeatRunColumnNames.has("evidence_refs") ||
          heartbeatRunColumns.some((column) => column.name === "issue_id" && column.notnull === 1));

      const heartbeatRunIndexStatements = [
        "CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_issue ON heartbeat_runs(issue_id, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_status ON heartbeat_runs(status, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_agent ON heartbeat_runs(agent_role_id, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_workspace ON heartbeat_runs(workspace_id, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_type ON heartbeat_runs(run_type, updated_at DESC)",
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_heartbeat_runs_active_issue
          ON heartbeat_runs(issue_id)
          WHERE issue_id IS NOT NULL AND status IN ('queued', 'running')`,
        "CREATE INDEX IF NOT EXISTS idx_heartbeat_run_events_run ON heartbeat_run_events(run_id, timestamp ASC)",
      ];

      if (requiresHeartbeatRunMigration) {
        this.db.exec("PRAGMA foreign_keys = OFF");
        // Prevent SQLite 3.26.0+ from automatically rewriting FK references in other tables
        // (e.g. tasks.heartbeat_run_id) when we rename heartbeat_runs → heartbeat_runs_legacy.
        // Without this, those FK refs point to the legacy table after it is dropped.
        this.db.exec("PRAGMA legacy_alter_table = ON");
        try {
          this.db.exec(`
          DROP INDEX IF EXISTS idx_heartbeat_runs_issue;
          DROP INDEX IF EXISTS idx_heartbeat_runs_status;
          DROP INDEX IF EXISTS idx_heartbeat_runs_agent;
          DROP INDEX IF EXISTS idx_heartbeat_runs_workspace;
          DROP INDEX IF EXISTS idx_heartbeat_runs_type;
          DROP INDEX IF EXISTS idx_heartbeat_runs_active_issue;

          ALTER TABLE heartbeat_runs RENAME TO heartbeat_runs_legacy;
          ALTER TABLE heartbeat_run_events RENAME TO heartbeat_run_events_legacy;

          CREATE TABLE heartbeat_runs (
            id TEXT PRIMARY KEY,
            issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
            agent_role_id TEXT REFERENCES agent_roles(id) ON DELETE SET NULL,
            workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
            run_type TEXT DEFAULT 'dispatch',
            dispatch_kind TEXT,
            reason TEXT,
            status TEXT NOT NULL,
            summary TEXT,
            error TEXT,
            cost_stats TEXT,
            evidence_refs TEXT,
            resumed_from_run_id TEXT REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER
          );

          CREATE TABLE heartbeat_run_events (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
            timestamp INTEGER NOT NULL,
            type TEXT NOT NULL,
            payload TEXT NOT NULL
          );

          INSERT INTO heartbeat_runs (
            id, issue_id, task_id, agent_role_id, workspace_id, run_type, dispatch_kind, reason,
            status, summary, error, cost_stats, evidence_refs, resumed_from_run_id,
            created_at, updated_at, started_at, completed_at
          )
          SELECT
            id,
            issue_id,
            task_id,
            agent_role_id,
            workspace_id,
            'dispatch',
            CASE
              WHEN task_id IS NOT NULL THEN 'task'
              ELSE 'silent'
            END,
            'migrated_v2_run',
            status,
            summary,
            error,
            NULL,
            NULL,
            resumed_from_run_id,
            created_at,
            updated_at,
            started_at,
            completed_at
          FROM heartbeat_runs_legacy;

          INSERT INTO heartbeat_run_events (id, run_id, timestamp, type, payload)
          SELECT id, run_id, timestamp, type, payload
          FROM heartbeat_run_events_legacy;

          DROP TABLE heartbeat_run_events_legacy;
          DROP TABLE heartbeat_runs_legacy;
        `);
        } finally {
          this.db.exec("PRAGMA legacy_alter_table = OFF");
          this.db.exec("PRAGMA foreign_keys = ON");
        }
        for (const sql of heartbeatRunIndexStatements) {
          this.db.exec(sql);
        }
      } else {
        for (const sql of heartbeatRunIndexStatements) {
          this.db.exec(sql);
        }
      }
    } catch (error) {
      schemaLogger.error("[DatabaseManager] Failed heartbeat_runs migration:", error);
    }

    const taskLinkageColumns = [
      "ALTER TABLE tasks ADD COLUMN issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL",
      "ALTER TABLE tasks ADD COLUMN heartbeat_run_id TEXT REFERENCES heartbeat_runs(id) ON DELETE SET NULL",
      "ALTER TABLE tasks ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE SET NULL",
      "ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL",
      "ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL",
      "ALTER TABLE tasks ADD COLUMN request_depth INTEGER",
      "ALTER TABLE tasks ADD COLUMN billing_code TEXT",
    ];

    for (const sql of taskLinkageColumns) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_issue_id ON tasks(issue_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_heartbeat_run_id ON tasks(heartbeat_run_id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_company_id ON tasks(company_id)");
    } catch {
      // Index already exists, ignore
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

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS council_configs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          schedule_json TEXT NOT NULL,
          participants_json TEXT NOT NULL,
          judge_seat_index INTEGER NOT NULL DEFAULT 0,
          rotating_idea_seat_index INTEGER NOT NULL DEFAULT 0,
          source_bundle_json TEXT NOT NULL,
          delivery_config_json TEXT NOT NULL,
          execution_policy_json TEXT NOT NULL,
          managed_cron_job_id TEXT,
          next_idea_seat_index INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_council_configs_workspace ON council_configs(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_council_configs_cron_job ON council_configs(managed_cron_job_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS council_runs (
          id TEXT PRIMARY KEY,
          council_config_id TEXT NOT NULL REFERENCES council_configs(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          task_id TEXT REFERENCES tasks(id),
          status TEXT NOT NULL,
          proposer_seat_index INTEGER NOT NULL DEFAULT 0,
          summary TEXT,
          error TEXT,
          memo_id TEXT,
          source_snapshot_json TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_council_runs_config ON council_runs(council_config_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_council_runs_task ON council_runs(task_id);
      `);
    } catch {
      // Table already exists, ignore
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS council_memos (
          id TEXT PRIMARY KEY,
          council_run_id TEXT NOT NULL REFERENCES council_runs(id) ON DELETE CASCADE,
          council_config_id TEXT NOT NULL REFERENCES council_configs(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          task_id TEXT REFERENCES tasks(id),
          proposer_seat_index INTEGER NOT NULL DEFAULT 0,
          content TEXT NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0,
          delivery_error TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_council_memos_config ON council_memos(council_config_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_council_memos_run ON council_memos(council_run_id);
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
      "ALTER TABLE tasks ADD COLUMN session_id TEXT",
      "ALTER TABLE tasks ADD COLUMN branch_from_task_id TEXT REFERENCES tasks(id)",
      "ALTER TABLE tasks ADD COLUMN branch_from_event_id TEXT",
      "ALTER TABLE tasks ADD COLUMN branch_label TEXT",
      "ALTER TABLE tasks ADD COLUMN resume_strategy TEXT",
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
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id)");
    } catch {
      // Index already exists
    }
    try {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_session_updated_at ON tasks(session_id, updated_at DESC)",
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
    try {
      this.db.exec("ALTER TABLE companies ADD COLUMN default_workspace_id TEXT");
    } catch {
      // Column already exists
    }

    // ============ User Prompt for Agent-Dispatched Tasks ============
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN user_prompt TEXT");
    } catch {
      // Column already exists
    }

    // ============ Task Source (manual, cron, hook, api) ============
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT 'manual'");
    } catch {
      // Column already exists
    }

    // ============ Hook Session Idempotency ============
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS hook_sessions (
          session_key TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hook_sessions_task ON hook_sessions(task_id);
      `);
    } catch {
      // Table/index already exists
    }

    // ============ Hook Session Locks ============
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS hook_session_locks (
          session_key TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hook_session_locks_expires ON hook_session_locks(expires_at);
      `);
    } catch {
      // Table/index already exists
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
        CREATE TRIGGER IF NOT EXISTS prevent_automation_profile_delete_with_core_history
        BEFORE DELETE ON automation_profiles
        FOR EACH ROW
        WHEN EXISTS (SELECT 1 FROM core_traces WHERE profile_id = OLD.id LIMIT 1)
          OR EXISTS (SELECT 1 FROM core_memory_candidates WHERE profile_id = OLD.id LIMIT 1)
          OR EXISTS (SELECT 1 FROM core_memory_distill_runs WHERE profile_id = OLD.id LIMIT 1)
          OR EXISTS (SELECT 1 FROM core_failure_records WHERE profile_id = OLD.id LIMIT 1)
          OR EXISTS (SELECT 1 FROM core_failure_clusters WHERE profile_id = OLD.id LIMIT 1)
          OR EXISTS (SELECT 1 FROM core_eval_cases WHERE profile_id = OLD.id LIMIT 1)
          OR EXISTS (SELECT 1 FROM core_harness_experiments WHERE profile_id = OLD.id LIMIT 1)
          OR EXISTS (SELECT 1 FROM core_learnings_log WHERE profile_id = OLD.id LIMIT 1)
        BEGIN
          SELECT RAISE(ABORT, 'Cannot delete automation profile with preserved core history');
        END;
      `);
    } catch (error) {
      schemaLogger.warn("[DatabaseManager] Failed to install automation profile delete guard:", error);
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
          valid_from INTEGER,
          valid_to INTEGER,
          FOREIGN KEY (source_entity_id) REFERENCES kg_entities(id) ON DELETE CASCADE,
          FOREIGN KEY (target_entity_id) REFERENCES kg_entities(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_kg_edges_workspace ON kg_edges(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_entity_id);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_entity_id);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(edge_type);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_validity ON kg_edges(valid_from, valid_to);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_edges_current_unique
          ON kg_edges(workspace_id, source_entity_id, target_entity_id, edge_type)
          WHERE valid_to IS NULL;
      `);
    } catch {
      // Table already exists
    }

    this.upgradeKnowledgeGraphEdgesForTemporalValidity();

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

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS improvement_candidates (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          readiness TEXT,
          readiness_reason TEXT,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          severity REAL NOT NULL DEFAULT 0,
          recurrence_count INTEGER NOT NULL DEFAULT 1,
          fixability_score REAL NOT NULL DEFAULT 0,
          priority_score REAL NOT NULL DEFAULT 0,
          evidence TEXT NOT NULL,
          last_task_id TEXT,
          last_event_type TEXT,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          last_experiment_at INTEGER,
          failure_streak INTEGER NOT NULL DEFAULT 0,
          cooldown_until INTEGER,
          park_reason TEXT,
          parked_at INTEGER,
          last_skip_reason TEXT,
          last_skip_at INTEGER,
          last_attempt_fingerprint TEXT,
          last_failure_class TEXT,
          resolved_at INTEGER
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_improvement_candidates_fingerprint
          ON improvement_candidates(workspace_id, fingerprint);
        CREATE INDEX IF NOT EXISTS idx_improvement_candidates_status
          ON improvement_candidates(status, priority_score DESC, last_seen_at DESC);
        CREATE INDEX IF NOT EXISTS idx_improvement_candidates_workspace
          ON improvement_candidates(workspace_id, status, priority_score DESC);

        CREATE TABLE IF NOT EXISTS improvement_runs (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          status TEXT NOT NULL,
          review_status TEXT NOT NULL,
          promotion_status TEXT DEFAULT 'idle',
          task_id TEXT,
          branch_name TEXT,
          merge_result TEXT,
          pull_request TEXT,
          promotion_error TEXT,
          baseline_metrics TEXT,
          outcome_metrics TEXT,
          verdict_summary TEXT,
          evaluation_notes TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          promoted_at INTEGER,
          FOREIGN KEY (candidate_id) REFERENCES improvement_candidates(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_improvement_runs_candidate
          ON improvement_runs(candidate_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_improvement_runs_status
          ON improvement_runs(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_improvement_runs_review
          ON improvement_runs(review_status, created_at DESC);

        CREATE TABLE IF NOT EXISTS improvement_campaigns (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          execution_workspace_id TEXT,
          root_task_id TEXT,
          status TEXT NOT NULL,
          stage TEXT,
          review_status TEXT NOT NULL,
          promotion_status TEXT DEFAULT 'idle',
          stop_reason TEXT,
          provider_health_snapshot TEXT,
          stage_budget TEXT,
          verification_commands TEXT,
          observability TEXT,
          pr_required INTEGER NOT NULL DEFAULT 1,
          winner_variant_id TEXT,
          promoted_task_id TEXT,
          promoted_branch_name TEXT,
          merge_result TEXT,
          pull_request TEXT,
          promotion_error TEXT,
          baseline_metrics TEXT,
          outcome_metrics TEXT,
          verdict_summary TEXT,
          evaluation_notes TEXT,
          training_evidence TEXT NOT NULL,
          holdout_evidence TEXT NOT NULL,
          replay_cases TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          promoted_at INTEGER,
          FOREIGN KEY (candidate_id) REFERENCES improvement_candidates(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_improvement_campaigns_candidate
          ON improvement_campaigns(candidate_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_improvement_campaigns_status
          ON improvement_campaigns(status, created_at DESC);

        CREATE TABLE IF NOT EXISTS improvement_variant_runs (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          execution_workspace_id TEXT,
          lane TEXT NOT NULL,
          status TEXT NOT NULL,
          task_id TEXT,
          branch_name TEXT,
          baseline_metrics TEXT,
          outcome_metrics TEXT,
          verdict_summary TEXT,
          evaluation_notes TEXT,
          observability TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY (campaign_id) REFERENCES improvement_campaigns(id) ON DELETE CASCADE,
          FOREIGN KEY (candidate_id) REFERENCES improvement_candidates(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_improvement_variant_runs_campaign
          ON improvement_variant_runs(campaign_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_improvement_variant_runs_task
          ON improvement_variant_runs(task_id);

        CREATE TABLE IF NOT EXISTS improvement_judge_verdicts (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL UNIQUE,
          winner_variant_id TEXT,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          notes TEXT NOT NULL,
          variant_rankings TEXT NOT NULL,
          replay_cases TEXT NOT NULL,
          compared_at INTEGER NOT NULL,
          FOREIGN KEY (campaign_id) REFERENCES improvement_campaigns(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS subconscious_targets (
          target_key TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          workspace_id TEXT,
          ref_json TEXT NOT NULL,
          health TEXT NOT NULL,
          state TEXT NOT NULL,
          persistence TEXT NOT NULL DEFAULT 'durable',
          missed_run_policy TEXT NOT NULL DEFAULT 'catchUp',
          next_eligible_at INTEGER,
          last_observed_at INTEGER,
          last_action_at INTEGER,
          expires_at INTEGER,
          jitter_ms INTEGER,
          last_meaningful_outcome TEXT,
          last_winner TEXT,
          last_run_at INTEGER,
          last_evidence_at INTEGER,
          backlog_count INTEGER NOT NULL DEFAULT 0,
          evidence_fingerprint TEXT,
          last_dispatch_kind TEXT,
          last_dispatch_status TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_subconscious_targets_workspace
          ON subconscious_targets(workspace_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_subconscious_targets_kind
          ON subconscious_targets(kind, updated_at DESC);

        CREATE TABLE IF NOT EXISTS subconscious_runs (
          id TEXT PRIMARY KEY,
          target_key TEXT NOT NULL,
          workspace_id TEXT,
          stage TEXT NOT NULL,
          outcome TEXT,
          evidence_fingerprint TEXT NOT NULL,
          evidence_summary TEXT NOT NULL,
          artifact_root TEXT NOT NULL,
          dispatch_kind TEXT,
          dispatch_status TEXT,
          blocked_reason TEXT,
          error TEXT,
          confidence REAL,
          risk_level TEXT,
          evidence_sources_json TEXT,
          evidence_freshness REAL,
          permission_decision TEXT,
          notification_intent TEXT,
          rejected_hypothesis_ids_json TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (target_key) REFERENCES subconscious_targets(target_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_subconscious_runs_target
          ON subconscious_runs(target_key, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_subconscious_runs_stage
          ON subconscious_runs(stage, created_at DESC);

        CREATE TABLE IF NOT EXISTS subconscious_hypotheses (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          target_key TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          rationale TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0,
          evidence_refs_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES subconscious_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (target_key) REFERENCES subconscious_targets(target_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_subconscious_hypotheses_run
          ON subconscious_hypotheses(run_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS subconscious_critiques (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          target_key TEXT NOT NULL,
          hypothesis_id TEXT NOT NULL,
          verdict TEXT NOT NULL,
          objection TEXT NOT NULL,
          response TEXT,
          evidence_refs_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES subconscious_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (target_key) REFERENCES subconscious_targets(target_key) ON DELETE CASCADE,
          FOREIGN KEY (hypothesis_id) REFERENCES subconscious_hypotheses(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_subconscious_critiques_run
          ON subconscious_critiques(run_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS subconscious_decisions (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE,
          target_key TEXT NOT NULL,
          winning_hypothesis_id TEXT NOT NULL,
          winner_summary TEXT NOT NULL,
          recommendation TEXT NOT NULL,
          rejected_hypothesis_ids_json TEXT NOT NULL,
          rationale TEXT NOT NULL,
          next_backlog_json TEXT NOT NULL,
          outcome TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES subconscious_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (target_key) REFERENCES subconscious_targets(target_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_subconscious_decisions_target
          ON subconscious_decisions(target_key, created_at DESC);

        CREATE TABLE IF NOT EXISTS subconscious_backlog_items (
          id TEXT PRIMARY KEY,
          target_key TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          status TEXT NOT NULL,
          priority REAL NOT NULL DEFAULT 0,
          executor_kind TEXT,
          source_run_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (target_key) REFERENCES subconscious_targets(target_key) ON DELETE CASCADE,
          FOREIGN KEY (source_run_id) REFERENCES subconscious_runs(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_subconscious_backlog_target
          ON subconscious_backlog_items(target_key, status, priority DESC, updated_at DESC);

        CREATE TABLE IF NOT EXISTS subconscious_dispatch_records (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          target_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          task_id TEXT,
          external_ref_id TEXT,
          summary TEXT NOT NULL,
          error TEXT,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          FOREIGN KEY (run_id) REFERENCES subconscious_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (target_key) REFERENCES subconscious_targets(target_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_subconscious_dispatch_target
          ON subconscious_dispatch_records(target_key, created_at DESC);

        CREATE TABLE IF NOT EXISTS core_traces (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES automation_profiles(id) ON DELETE CASCADE,
          workspace_id TEXT,
          target_key TEXT,
          source_surface TEXT NOT NULL,
          trace_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          task_id TEXT,
          heartbeat_run_id TEXT,
          subconscious_run_id TEXT,
          summary TEXT,
          error TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_core_traces_profile
          ON core_traces(profile_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_core_traces_workspace
          ON core_traces(workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_core_traces_target
          ON core_traces(target_key, created_at DESC);

        CREATE TABLE IF NOT EXISTS core_trace_events (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL REFERENCES core_traces(id) ON DELETE CASCADE,
          phase TEXT NOT NULL,
          event_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          details_json TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_core_trace_events_trace
          ON core_trace_events(trace_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS core_memory_candidates (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL REFERENCES core_traces(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES automation_profiles(id) ON DELETE CASCADE,
          workspace_id TEXT,
          scope_kind TEXT NOT NULL,
          scope_ref TEXT NOT NULL,
          candidate_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          details TEXT,
          confidence REAL NOT NULL,
          novelty_score REAL NOT NULL,
          stability_score REAL NOT NULL,
          status TEXT NOT NULL,
          resolution TEXT,
          source_run_id TEXT,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_core_memory_candidates_scope
          ON core_memory_candidates(scope_kind, scope_ref, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_core_memory_candidates_status
          ON core_memory_candidates(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_core_memory_candidates_profile
          ON core_memory_candidates(profile_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS core_memory_distill_runs (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES automation_profiles(id) ON DELETE CASCADE,
          workspace_id TEXT,
          mode TEXT NOT NULL,
          source_trace_count INTEGER NOT NULL DEFAULT 0,
          candidate_count INTEGER NOT NULL DEFAULT 0,
          accepted_count INTEGER NOT NULL DEFAULT 0,
          pruned_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          summary_json TEXT,
          error TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_core_memory_distill_runs_profile
          ON core_memory_distill_runs(profile_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS core_memory_scope_state (
          scope_kind TEXT NOT NULL,
          scope_ref TEXT NOT NULL,
          last_trace_at INTEGER,
          last_distill_at INTEGER,
          last_prune_at INTEGER,
          stability_version INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope_kind, scope_ref)
        );

        CREATE TABLE IF NOT EXISTS core_failure_records (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL REFERENCES core_traces(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES automation_profiles(id) ON DELETE CASCADE,
          workspace_id TEXT,
          target_key TEXT,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          summary TEXT NOT NULL,
          details TEXT,
          status TEXT NOT NULL,
          source_surface TEXT NOT NULL,
          task_id TEXT,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_core_failure_records_profile
          ON core_failure_records(profile_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_core_failure_records_trace
          ON core_failure_records(trace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_core_failure_records_fingerprint
          ON core_failure_records(fingerprint, created_at DESC);

        CREATE TABLE IF NOT EXISTS core_failure_clusters (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES automation_profiles(id) ON DELETE CASCADE,
          workspace_id TEXT,
          category TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          root_cause_summary TEXT NOT NULL,
          status TEXT NOT NULL,
          recurrence_count INTEGER NOT NULL DEFAULT 1,
          linked_eval_case_id TEXT,
          linked_experiment_id TEXT,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_core_failure_clusters_profile
          ON core_failure_clusters(profile_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_core_failure_clusters_fingerprint
          ON core_failure_clusters(fingerprint, updated_at DESC);

        CREATE TABLE IF NOT EXISTS core_failure_cluster_members (
          cluster_id TEXT NOT NULL REFERENCES core_failure_clusters(id) ON DELETE CASCADE,
          failure_record_id TEXT NOT NULL REFERENCES core_failure_records(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (cluster_id, failure_record_id)
        );

        CREATE TABLE IF NOT EXISTS core_eval_cases (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES automation_profiles(id) ON DELETE CASCADE,
          workspace_id TEXT,
          cluster_id TEXT NOT NULL REFERENCES core_failure_clusters(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          status TEXT NOT NULL,
          pass_count INTEGER NOT NULL DEFAULT 0,
          fail_count INTEGER NOT NULL DEFAULT 0,
          last_run_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_core_eval_cases_profile
          ON core_eval_cases(profile_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_core_eval_cases_cluster
          ON core_eval_cases(cluster_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS core_eval_case_runs (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL REFERENCES core_eval_cases(id) ON DELETE CASCADE,
          passed INTEGER NOT NULL,
          summary TEXT NOT NULL,
          details_json TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS core_harness_experiments (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES automation_profiles(id) ON DELETE CASCADE,
          workspace_id TEXT,
          cluster_id TEXT NOT NULL REFERENCES core_failure_clusters(id) ON DELETE CASCADE,
          change_kind TEXT NOT NULL,
          proposal_json TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT,
          promoted_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_core_harness_experiments_profile
          ON core_harness_experiments(profile_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_core_harness_experiments_cluster
          ON core_harness_experiments(cluster_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS core_harness_experiment_runs (
          id TEXT PRIMARY KEY,
          experiment_id TEXT NOT NULL REFERENCES core_harness_experiments(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          baseline_json TEXT,
          outcome_json TEXT,
          gate_result_id TEXT,
          summary TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS core_regression_gate_results (
          id TEXT PRIMARY KEY,
          experiment_run_id TEXT NOT NULL REFERENCES core_harness_experiment_runs(id) ON DELETE CASCADE,
          passed INTEGER NOT NULL,
          target_improved INTEGER NOT NULL,
          regressions_detected_json TEXT NOT NULL,
          summary TEXT NOT NULL,
          details_json TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS core_learnings_log (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES automation_profiles(id) ON DELETE CASCADE,
          workspace_id TEXT,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          details TEXT,
          related_cluster_id TEXT,
          related_experiment_id TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_core_learnings_profile
          ON core_learnings_log(profile_id, created_at DESC);
      `);
    } catch {
      // Table already exists
    }

    try {
      this.db.exec(`
        INSERT OR IGNORE INTO core_traces (
          id, profile_id, workspace_id, target_key, source_surface, trace_kind, status,
          task_id, heartbeat_run_id, subconscious_run_id, summary, error, started_at, completed_at, created_at
        )
        SELECT
          'hbtrace:' || r.id,
          ap.id,
          r.workspace_id,
          CASE WHEN r.agent_role_id IS NOT NULL THEN 'agent_role:' || r.agent_role_id ELSE NULL END,
          'heartbeat',
          'pulse_cycle',
          CASE
            WHEN r.status = 'failed' THEN 'failed'
            WHEN r.status = 'cancelled' THEN 'skipped'
            WHEN r.status = 'running' THEN 'running'
            ELSE 'completed'
          END,
          r.task_id,
          r.id,
          NULL,
          COALESCE(r.summary, r.reason),
          r.error,
          COALESCE(r.started_at, r.created_at),
          r.completed_at,
          r.created_at
        FROM heartbeat_runs r
        JOIN automation_profiles ap ON ap.agent_role_id = r.agent_role_id;

        INSERT OR IGNORE INTO core_trace_events (
          id, trace_id, phase, event_type, summary, details_json, created_at
        )
        SELECT
          'hbtrace-event:start:' || r.id,
          'hbtrace:' || r.id,
          'start',
          'heartbeat.run_started',
          COALESCE(r.reason, 'Heartbeat run started'),
          NULL,
          COALESCE(r.started_at, r.created_at)
        FROM heartbeat_runs r
        JOIN automation_profiles ap ON ap.agent_role_id = r.agent_role_id;

        INSERT OR IGNORE INTO core_trace_events (
          id, trace_id, phase, event_type, summary, details_json, created_at
        )
        SELECT
          'hbtrace-event:complete:' || r.id,
          'hbtrace:' || r.id,
          CASE
            WHEN r.status = 'failed' THEN 'error'
            WHEN r.run_type = 'dispatch' THEN 'dispatch'
            ELSE 'complete'
          END,
          CASE
            WHEN r.status = 'failed' THEN 'heartbeat.run_failed'
            WHEN r.run_type = 'dispatch' THEN 'heartbeat.dispatch_finished'
            ELSE 'heartbeat.run_finished'
          END,
          COALESCE(r.summary, r.reason, 'Heartbeat run completed'),
          NULL,
          COALESCE(r.completed_at, r.updated_at, r.created_at)
        FROM heartbeat_runs r
        JOIN automation_profiles ap ON ap.agent_role_id = r.agent_role_id
        WHERE r.status != 'running';

        INSERT OR IGNORE INTO core_traces (
          id, profile_id, workspace_id, target_key, source_surface, trace_kind, status,
          task_id, heartbeat_run_id, subconscious_run_id, summary, error, started_at, completed_at, created_at
        )
        SELECT
          'sctrace:' || r.id,
          ap.id,
          r.workspace_id,
          r.target_key,
          'subconscious',
          'subconscious_cycle',
          CASE
            WHEN r.stage = 'failed' OR r.outcome = 'failed' THEN 'failed'
            WHEN r.stage = 'blocked' THEN 'skipped'
            WHEN r.stage = 'completed' THEN 'completed'
            ELSE 'running'
          END,
          dr.task_id,
          NULL,
          r.id,
          r.evidence_summary,
          r.error,
          r.started_at,
          r.completed_at,
          r.created_at
        FROM subconscious_runs r
        LEFT JOIN subconscious_dispatch_records dr ON dr.run_id = r.id
        JOIN automation_profiles ap ON r.target_key = 'agent_role:' || ap.agent_role_id;

        INSERT OR IGNORE INTO core_trace_events (
          id, trace_id, phase, event_type, summary, details_json, created_at
        )
        SELECT
          'sctrace-event:start:' || r.id,
          'sctrace:' || r.id,
          'start',
          'subconscious.run_started',
          COALESCE(r.evidence_summary, 'Subconscious run started'),
          NULL,
          r.started_at
        FROM subconscious_runs r
        JOIN automation_profiles ap ON r.target_key = 'agent_role:' || ap.agent_role_id;

        INSERT OR IGNORE INTO core_trace_events (
          id, trace_id, phase, event_type, summary, details_json, created_at
        )
        SELECT
          'sctrace-event:complete:' || r.id,
          'sctrace:' || r.id,
          CASE
            WHEN r.stage = 'failed' OR r.outcome = 'failed' THEN 'error'
            WHEN r.dispatch_kind IS NOT NULL THEN 'dispatch'
            ELSE 'complete'
          END,
          CASE
            WHEN r.stage = 'failed' OR r.outcome = 'failed' THEN 'subconscious.run_failed'
            WHEN r.dispatch_kind IS NOT NULL THEN 'subconscious.dispatch_finished'
            ELSE 'subconscious.run_finished'
          END,
          COALESCE(r.evidence_summary, r.outcome, 'Subconscious run completed'),
          NULL,
          COALESCE(r.completed_at, r.created_at)
        FROM subconscious_runs r
        JOIN automation_profiles ap ON r.target_key = 'agent_role:' || ap.agent_role_id
        WHERE r.stage IN ('completed', 'failed', 'blocked');

        INSERT OR IGNORE INTO core_memory_scope_state (
          scope_kind, scope_ref, last_trace_at, last_distill_at, last_prune_at, stability_version, updated_at
        )
        SELECT
          'automation_profile',
          ap.id,
          MAX(ct.created_at),
          NULL,
          NULL,
          1,
          COALESCE(MAX(ct.created_at), CAST(strftime('%s','now') AS INTEGER) * 1000)
        FROM automation_profiles ap
        LEFT JOIN core_traces ct ON ct.profile_id = ap.id
        GROUP BY ap.id;

        INSERT OR IGNORE INTO core_failure_records (
          id, trace_id, profile_id, workspace_id, target_key, category, severity, fingerprint,
          summary, details, status, source_surface, task_id, created_at, resolved_at
        )
        SELECT
          'core-failure:' || ct.id,
          ct.id,
          ct.profile_id,
          ct.workspace_id,
          ct.target_key,
          CASE
            WHEN LOWER(COALESCE(ct.summary, '') || ' ' || COALESCE(ct.error, '')) LIKE '%cooldown%' THEN 'cooldown_policy_mismatch'
            WHEN LOWER(COALESCE(ct.summary, '') || ' ' || COALESCE(ct.error, '')) LIKE '%active hours%' THEN 'wake_timing'
            WHEN LOWER(COALESCE(ct.summary, '') || ' ' || COALESCE(ct.error, '')) LIKE '%no evidence%' THEN 'subconscious_low_signal'
            WHEN LOWER(COALESCE(ct.summary, '') || ' ' || COALESCE(ct.error, '')) LIKE '%duplicate%' THEN 'subconscious_duplication'
            WHEN LOWER(COALESCE(ct.summary, '') || ' ' || COALESCE(ct.error, '')) LIKE '%budget%' THEN 'budget_policy_mismatch'
            ELSE 'unknown'
          END,
          CASE WHEN ct.status = 'failed' THEN 'high' ELSE 'medium' END,
          LOWER(COALESCE(ct.source_surface, '') || '::' || COALESCE(ct.trace_kind, '') || '::' || COALESCE(ct.target_key, '') || '::' || COALESCE(ct.summary, '') || '::' || COALESCE(ct.error, '')),
          COALESCE(ct.summary, ct.error, 'Core runtime issue detected'),
          ct.error,
          CASE WHEN ct.status = 'completed' THEN 'clustered' ELSE 'open' END,
          ct.source_surface,
          ct.task_id,
          COALESCE(ct.completed_at, ct.created_at),
          CASE WHEN ct.status = 'completed' THEN COALESCE(ct.completed_at, ct.created_at) ELSE NULL END
        FROM core_traces ct
        WHERE ct.status IN ('failed', 'skipped')
           OR LOWER(COALESCE(ct.summary, '') || ' ' || COALESCE(ct.error, '')) LIKE '%no evidence%'
           OR LOWER(COALESCE(ct.summary, '') || ' ' || COALESCE(ct.error, '')) LIKE '%duplicate%'
           OR LOWER(COALESCE(ct.summary, '') || ' ' || COALESCE(ct.error, '')) LIKE '%cooldown%';
      `);
    } catch (error) {
      schemaLogger.error("[DatabaseManager] Failed core trace backfill:", error);
    }

    for (const statement of [
      "ALTER TABLE subconscious_targets ADD COLUMN persistence TEXT NOT NULL DEFAULT 'durable'",
      "ALTER TABLE subconscious_targets ADD COLUMN missed_run_policy TEXT NOT NULL DEFAULT 'catchUp'",
      "ALTER TABLE subconscious_targets ADD COLUMN next_eligible_at INTEGER",
      "ALTER TABLE subconscious_targets ADD COLUMN last_observed_at INTEGER",
      "ALTER TABLE subconscious_targets ADD COLUMN last_action_at INTEGER",
      "ALTER TABLE subconscious_targets ADD COLUMN expires_at INTEGER",
      "ALTER TABLE subconscious_targets ADD COLUMN jitter_ms INTEGER",
      "ALTER TABLE subconscious_targets ADD COLUMN last_meaningful_outcome TEXT",
      "ALTER TABLE subconscious_runs ADD COLUMN confidence REAL",
      "ALTER TABLE subconscious_runs ADD COLUMN risk_level TEXT",
      "ALTER TABLE subconscious_runs ADD COLUMN evidence_sources_json TEXT",
      "ALTER TABLE subconscious_runs ADD COLUMN evidence_freshness REAL",
      "ALTER TABLE subconscious_runs ADD COLUMN permission_decision TEXT",
      "ALTER TABLE subconscious_runs ADD COLUMN notification_intent TEXT",
      "ALTER TABLE improvement_runs ADD COLUMN promotion_status TEXT DEFAULT 'idle'",
      "ALTER TABLE improvement_runs ADD COLUMN merge_result TEXT",
      "ALTER TABLE improvement_runs ADD COLUMN pull_request TEXT",
      "ALTER TABLE improvement_runs ADD COLUMN promotion_error TEXT",
      "ALTER TABLE improvement_runs ADD COLUMN promoted_at INTEGER",
      "ALTER TABLE improvement_campaigns ADD COLUMN root_task_id TEXT",
      "ALTER TABLE improvement_candidates ADD COLUMN failure_streak INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE improvement_candidates ADD COLUMN cooldown_until INTEGER",
      "ALTER TABLE improvement_candidates ADD COLUMN park_reason TEXT",
      "ALTER TABLE improvement_candidates ADD COLUMN parked_at INTEGER",
      "ALTER TABLE improvement_candidates ADD COLUMN readiness TEXT",
      "ALTER TABLE improvement_candidates ADD COLUMN readiness_reason TEXT",
      "ALTER TABLE improvement_candidates ADD COLUMN last_skip_reason TEXT",
      "ALTER TABLE improvement_candidates ADD COLUMN last_skip_at INTEGER",
      "ALTER TABLE improvement_candidates ADD COLUMN last_attempt_fingerprint TEXT",
      "ALTER TABLE improvement_candidates ADD COLUMN last_failure_class TEXT",
      "ALTER TABLE improvement_campaigns ADD COLUMN stage TEXT",
      "ALTER TABLE improvement_campaigns ADD COLUMN stop_reason TEXT",
      "ALTER TABLE improvement_campaigns ADD COLUMN provider_health_snapshot TEXT",
      "ALTER TABLE improvement_campaigns ADD COLUMN stage_budget TEXT",
      "ALTER TABLE improvement_campaigns ADD COLUMN verification_commands TEXT",
      "ALTER TABLE improvement_campaigns ADD COLUMN observability TEXT",
      "ALTER TABLE improvement_campaigns ADD COLUMN pr_required INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE improvement_variant_runs ADD COLUMN observability TEXT",
    ]) {
      try {
        this.db.exec(statement);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/duplicate column name|already exists/i.test(msg)) {
          continue; // Expected when column exists
        }
        schemaLogger.error("[DatabaseManager] Migration failed (schema may be inconsistent):", statement, msg);
        throw err;
      }
    }

    // Device management: target_node_id on tasks + device_profiles table
    for (const statement of [
      "ALTER TABLE tasks ADD COLUMN target_node_id TEXT",
    ]) {
      try {
        this.db.exec(statement);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/duplicate column name|already exists/i.test(msg)) {
          continue; // Expected when column exists
        }
        schemaLogger.error("[DatabaseManager] Migration failed (schema may be inconsistent):", statement, msg);
        throw err;
      }
    }

    // Orchestration runs: DAG-based sub-agent orchestration persistence
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS orchestration_runs (
          id TEXT PRIMARY KEY,
          root_task_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          tasks TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          completed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_orchestration_runs_root
          ON orchestration_runs(root_task_id);
        CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status
          ON orchestration_runs(status, created_at DESC);
      `);
    } catch {
      // Table already exists
    }

    // Unified orchestration graph persistence
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS orchestration_graph_runs (
          id TEXT PRIMARY KEY,
          root_task_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          max_parallel INTEGER NOT NULL DEFAULT 1,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_runs_root
          ON orchestration_graph_runs(root_task_id);
        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_runs_status
          ON orchestration_graph_runs(status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS orchestration_graph_nodes (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES orchestration_graph_runs(id) ON DELETE CASCADE,
          node_key TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          dispatch_target TEXT NOT NULL,
          worker_role TEXT,
          parent_task_id TEXT,
          assigned_agent_role_id TEXT,
          capability_hint TEXT,
          acp_agent_id TEXT,
          agent_config TEXT,
          task_id TEXT,
          remote_task_id TEXT,
          public_handle TEXT,
          summary TEXT,
          output TEXT,
          error TEXT,
          team_run_id TEXT,
          team_item_id TEXT,
          workflow_phase_id TEXT,
          acp_task_id TEXT,
          metadata TEXT,
          verification_verdict TEXT,
          verification_report TEXT,
          semantic_summary TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_nodes_run
          ON orchestration_graph_nodes(run_id);
        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_nodes_status
          ON orchestration_graph_nodes(run_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_nodes_handle
          ON orchestration_graph_nodes(public_handle);
        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_nodes_task
          ON orchestration_graph_nodes(task_id);
        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_nodes_remote_task
          ON orchestration_graph_nodes(remote_task_id);
        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_nodes_team_item
          ON orchestration_graph_nodes(team_item_id);
        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_nodes_acp_task
          ON orchestration_graph_nodes(acp_task_id);

        CREATE TABLE IF NOT EXISTS orchestration_graph_edges (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES orchestration_graph_runs(id) ON DELETE CASCADE,
          from_node_id TEXT NOT NULL REFERENCES orchestration_graph_nodes(id) ON DELETE CASCADE,
          to_node_id TEXT NOT NULL REFERENCES orchestration_graph_nodes(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_edges_run
          ON orchestration_graph_edges(run_id);
        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_edges_to
          ON orchestration_graph_edges(run_id, to_node_id);

        CREATE TABLE IF NOT EXISTS orchestration_graph_node_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES orchestration_graph_runs(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL REFERENCES orchestration_graph_nodes(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_node_events_node
          ON orchestration_graph_node_events(node_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_orchestration_graph_node_events_run
          ON orchestration_graph_node_events(run_id, created_at DESC);
      `);
    } catch {
      // Tables already exist
    }

    // Migration: add worker-role and verifier metadata to orchestration graph nodes
    for (const statement of [
      "ALTER TABLE orchestration_graph_nodes ADD COLUMN worker_role TEXT",
      "ALTER TABLE orchestration_graph_nodes ADD COLUMN verification_verdict TEXT",
      "ALTER TABLE orchestration_graph_nodes ADD COLUMN verification_report TEXT",
      "ALTER TABLE orchestration_graph_nodes ADD COLUMN semantic_summary TEXT",
    ]) {
      try {
        this.db.exec(statement);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/duplicate column name|already exists/i.test(msg)) {
          continue;
        }
        schemaLogger.error("[DatabaseManager] Migration failed:", statement, msg);
      }
    }

    // Memory tier promotion: adds tier and reference tracking to memories
    for (const statement of [
      "ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'short'",
      "ALTER TABLE memories ADD COLUMN reference_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE memories ADD COLUMN last_referenced_at INTEGER",
    ]) {
      try {
        this.db.exec(statement);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/duplicate column name|already exists/i.test(msg)) {
          continue;
        }
        schemaLogger.error("[DatabaseManager] Migration failed:", statement, msg);
      }
    }

    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_tier
          ON memories(workspace_id, tier, reference_count DESC);
      `);
    } catch {
      // Index already exists
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS curated_memory_entries (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          task_id TEXT,
          target TEXT NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          normalized_key TEXT NOT NULL,
          source TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.7,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_confirmed_at INTEGER,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS idx_curated_memory_workspace_target
          ON curated_memory_entries(workspace_id, target, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_curated_memory_workspace_kind
          ON curated_memory_entries(workspace_id, kind, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_curated_memory_normalized_key
          ON curated_memory_entries(workspace_id, target, kind, normalized_key, status);
      `);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      schemaLogger.error("[DatabaseManager] Curated memory migration failed:", msg);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_profiles (
        device_id TEXT PRIMARY KEY,
        custom_name TEXT,
        platform TEXT,
        model_identifier TEXT,
        last_seen_at INTEGER,
        settings_json TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );
    `);

    // Migration: Add body_html column to mailbox_messages for rendering original HTML email content
    try {
      this.db.exec("ALTER TABLE mailbox_messages ADD COLUMN body_html TEXT");
    } catch {
      // Column already exists, ignore
    }

    // Mailbox classifier state/provenance
    try {
      this.db.exec("ALTER TABLE mailbox_accounts ADD COLUMN classification_initial_batch_at INTEGER");
    } catch {
      // Column already exists, ignore
    }
    const mailboxThreadMigrations = [
      "ALTER TABLE mailbox_threads ADD COLUMN local_inbox_hidden INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE mailbox_threads ADD COLUMN classification_state TEXT NOT NULL DEFAULT 'pending'",
      "ALTER TABLE mailbox_threads ADD COLUMN classification_fingerprint TEXT",
      "ALTER TABLE mailbox_threads ADD COLUMN classification_model_key TEXT",
      "ALTER TABLE mailbox_threads ADD COLUMN classification_prompt_version TEXT",
      "ALTER TABLE mailbox_threads ADD COLUMN classification_confidence REAL NOT NULL DEFAULT 0",
      "ALTER TABLE mailbox_threads ADD COLUMN classification_updated_at INTEGER",
      "ALTER TABLE mailbox_threads ADD COLUMN classification_error TEXT",
      "ALTER TABLE mailbox_threads ADD COLUMN classification_json TEXT",
      "ALTER TABLE mailbox_threads ADD COLUMN today_bucket TEXT NOT NULL DEFAULT 'more_to_browse'",
      "ALTER TABLE mailbox_threads ADD COLUMN domain_category TEXT NOT NULL DEFAULT 'other'",
      "ALTER TABLE mailbox_threads ADD COLUMN classification_rationale TEXT",
    ];
    for (const migration of mailboxThreadMigrations) {
      try {
        this.db.exec(migration);
      } catch {
        // Column already exists, ignore
      }
    }
    try {
      this.db.exec(
        "UPDATE mailbox_threads SET classification_state = 'backfill_pending' WHERE classification_state = 'pending' AND classification_updated_at IS NULL",
      );
    } catch {
      // Ignore migration update failures
    }
    try {
      this.db.exec(
        "UPDATE mailbox_threads SET classification_state = 'backfill_pending' WHERE classification_state = 'classified' AND (classification_prompt_version IS NULL OR classification_prompt_version != 'v3')",
      );
    } catch {
      // Ignore migration update failures
    }

    // Migration: Add metadata_json to mailbox_commitments for follow-up task tracking
    try {
      this.db.exec("ALTER TABLE mailbox_commitments ADD COLUMN metadata_json TEXT");
    } catch {
      // Column already exists, ignore
    }

    // Migration: drop mailbox_summaries.confidence (no longer used)
    try {
      this.db.exec("ALTER TABLE mailbox_summaries DROP COLUMN confidence");
    } catch {
      // Column absent or SQLite without DROP COLUMN — ignore
    }

    // Mailbox rollout migrations: sensitive-content flags, contact preferences, and event log
    for (const sql of [
      "ALTER TABLE mailbox_threads ADD COLUMN sensitive_content_json TEXT",
      "ALTER TABLE mailbox_contacts ADD COLUMN encryption_preference TEXT",
      "ALTER TABLE mailbox_contacts ADD COLUMN policy_flags_json TEXT",
    ]) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists, ignore
      }
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mailbox_events (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE,
          workspace_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          account_id TEXT,
          thread_id TEXT,
          provider TEXT,
          subject TEXT,
          summary_text TEXT,
          evidence_refs_json TEXT,
          payload_json TEXT NOT NULL,
          duplicate_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mailbox_events_workspace ON mailbox_events(workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_events_thread ON mailbox_events(thread_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS mailbox_attachments (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          provider_message_id TEXT NOT NULL,
          provider_attachment_id TEXT,
          filename TEXT NOT NULL,
          mime_type TEXT,
          size INTEGER,
          extraction_status TEXT NOT NULL DEFAULT 'not_indexed',
          extraction_error TEXT,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id),
          FOREIGN KEY (message_id) REFERENCES mailbox_messages(id)
        );
        CREATE TABLE IF NOT EXISTS mailbox_attachment_text (
          attachment_id TEXT PRIMARY KEY,
          text_content TEXT NOT NULL,
          extraction_mode TEXT NOT NULL,
          extracted_at INTEGER NOT NULL,
          FOREIGN KEY (attachment_id) REFERENCES mailbox_attachments(id)
        );
        CREATE TABLE IF NOT EXISTS mailbox_search_embeddings (
          record_type TEXT NOT NULL,
          record_id TEXT NOT NULL,
          account_id TEXT,
          thread_id TEXT NOT NULL,
          message_id TEXT,
          attachment_id TEXT,
          source_text_hash TEXT NOT NULL,
          embedding_json TEXT NOT NULL,
          snippet TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (record_type, record_id)
        );
        CREATE INDEX IF NOT EXISTS idx_mailbox_threads_today_bucket ON mailbox_threads(today_bucket, last_message_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_threads_domain_category ON mailbox_threads(domain_category, last_message_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_attachments_thread ON mailbox_attachments(thread_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_attachments_message ON mailbox_attachments(message_id);
        CREATE INDEX IF NOT EXISTS idx_mailbox_attachments_status ON mailbox_attachments(extraction_status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_search_embeddings_thread ON mailbox_search_embeddings(thread_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_search_embeddings_account ON mailbox_search_embeddings(account_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS mailbox_folders (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          provider_folder_id TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'custom',
          unread_count INTEGER,
          total_count INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(account_id, provider_folder_id),
          FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
        );
        CREATE TABLE IF NOT EXISTS mailbox_labels (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          provider_label_id TEXT NOT NULL,
          name TEXT NOT NULL,
          color TEXT,
          unread_count INTEGER,
          total_count INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(account_id, provider_label_id),
          FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
        );
        CREATE TABLE IF NOT EXISTS mailbox_identities (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          provider_identity_id TEXT,
          email TEXT NOT NULL,
          display_name TEXT,
          signature_id TEXT,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
        );
        CREATE TABLE IF NOT EXISTS mailbox_signatures (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          name TEXT NOT NULL,
          body_html TEXT,
          body_text TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
        );
        CREATE TABLE IF NOT EXISTS mailbox_compose_drafts (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          thread_id TEXT,
          provider_draft_id TEXT,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          subject TEXT NOT NULL,
          body_text TEXT NOT NULL,
          body_html TEXT,
          to_json TEXT NOT NULL,
          cc_json TEXT NOT NULL,
          bcc_json TEXT NOT NULL,
          identity_id TEXT,
          signature_id TEXT,
          attachments_json TEXT,
          scheduled_at INTEGER,
          send_after INTEGER,
          latest_error TEXT,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id),
          FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id)
        );
        CREATE TABLE IF NOT EXISTS mailbox_outgoing_messages (
          id TEXT PRIMARY KEY,
          draft_id TEXT,
          account_id TEXT NOT NULL,
          status TEXT NOT NULL,
          provider_message_id TEXT,
          scheduled_at INTEGER,
          send_after INTEGER,
          latest_error TEXT,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (draft_id) REFERENCES mailbox_compose_drafts(id),
          FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id)
        );
        CREATE TABLE IF NOT EXISTS mailbox_queued_actions (
          id TEXT PRIMARY KEY,
          account_id TEXT,
          thread_id TEXT,
          draft_id TEXT,
          action_type TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER,
          latest_error TEXT,
          undo_of_action_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (account_id) REFERENCES mailbox_accounts(id),
          FOREIGN KEY (thread_id) REFERENCES mailbox_threads(id),
          FOREIGN KEY (draft_id) REFERENCES mailbox_compose_drafts(id)
        );
        CREATE TABLE IF NOT EXISTS mailbox_client_settings (
          id TEXT PRIMARY KEY,
          remote_content_policy TEXT NOT NULL DEFAULT 'load',
          send_delay_seconds INTEGER NOT NULL DEFAULT 30,
          sync_recent_days INTEGER NOT NULL DEFAULT 30,
          attachment_cache TEXT NOT NULL DEFAULT 'metadata_on_demand',
          notifications TEXT NOT NULL DEFAULT 'needs_reply',
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mailbox_folders_account ON mailbox_folders(account_id, role, name);
        CREATE INDEX IF NOT EXISTS idx_mailbox_labels_account ON mailbox_labels(account_id, name);
        CREATE INDEX IF NOT EXISTS idx_mailbox_identities_account ON mailbox_identities(account_id, is_default DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_signatures_account ON mailbox_signatures(account_id, is_default DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_compose_drafts_account ON mailbox_compose_drafts(account_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_compose_drafts_thread ON mailbox_compose_drafts(thread_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_outgoing_status ON mailbox_outgoing_messages(status, send_after, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_queued_actions_status ON mailbox_queued_actions(status, next_attempt_at, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_queued_actions_thread ON mailbox_queued_actions(thread_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS mailbox_automations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          thread_id TEXT,
          source TEXT NOT NULL,
          recipe_json TEXT NOT NULL,
          backing_trigger_id TEXT,
          backing_cron_job_id TEXT,
          latest_outcome TEXT,
          latest_fire_at INTEGER,
          latest_run_at INTEGER,
          next_run_at INTEGER,
          latest_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mailbox_automations_workspace ON mailbox_automations(workspace_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_automations_thread ON mailbox_automations(thread_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_automations_kind ON mailbox_automations(kind, status);
        CREATE INDEX IF NOT EXISTS idx_mailbox_automations_trigger ON mailbox_automations(backing_trigger_id);
        CREATE INDEX IF NOT EXISTS idx_mailbox_automations_cron ON mailbox_automations(backing_cron_job_id);

        CREATE TABLE IF NOT EXISTS mailbox_automation_audit (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mailbox_automation_audit_automation
          ON mailbox_automation_audit(automation_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS mailbox_mission_control_handoffs (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          company_id TEXT NOT NULL,
          company_name TEXT NOT NULL,
          operator_role_id TEXT NOT NULL,
          operator_display_name TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          issue_title TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'mailbox_handoff',
          latest_outcome TEXT,
          latest_wake_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mailbox_mc_handoffs_thread
          ON mailbox_mission_control_handoffs(thread_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mailbox_mc_handoffs_issue
          ON mailbox_mission_control_handoffs(issue_id);
        CREATE INDEX IF NOT EXISTS idx_mailbox_mc_handoffs_company_operator
          ON mailbox_mission_control_handoffs(company_id, operator_role_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS contact_identities (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          primary_email TEXT,
          company_hint TEXT,
          kg_entity_id TEXT,
          confidence REAL NOT NULL DEFAULT 0.5,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contact_identities_workspace ON contact_identities(workspace_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_contact_identities_email ON contact_identities(primary_email);

        CREATE TABLE IF NOT EXISTS contact_identity_handles (
          id TEXT PRIMARY KEY,
          contact_identity_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          handle_type TEXT NOT NULL,
          normalized_value TEXT NOT NULL,
          display_value TEXT NOT NULL,
          source TEXT NOT NULL,
          channel_id TEXT,
          channel_type TEXT,
          channel_user_id TEXT,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (contact_identity_id) REFERENCES contact_identities(id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_identity_handles_unique
          ON contact_identity_handles(workspace_id, handle_type, normalized_value);
        CREATE INDEX IF NOT EXISTS idx_contact_identity_handles_identity
          ON contact_identity_handles(contact_identity_id, handle_type);
        CREATE INDEX IF NOT EXISTS idx_contact_identity_handles_channel
          ON contact_identity_handles(channel_type, channel_user_id);

        CREATE TABLE IF NOT EXISTS contact_identity_suggestions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          contact_identity_id TEXT NOT NULL,
          handle_type TEXT NOT NULL,
          normalized_value TEXT NOT NULL,
          display_value TEXT NOT NULL,
          source TEXT NOT NULL,
          source_label TEXT NOT NULL,
          channel_id TEXT,
          channel_type TEXT,
          channel_user_id TEXT,
          confidence REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'suggested',
          reason_codes_json TEXT NOT NULL,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (contact_identity_id) REFERENCES contact_identities(id)
        );
        CREATE INDEX IF NOT EXISTS idx_contact_identity_suggestions_workspace
          ON contact_identity_suggestions(workspace_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_contact_identity_suggestions_identity
          ON contact_identity_suggestions(contact_identity_id, status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS contact_identity_audit (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          contact_identity_id TEXT,
          handle_id TEXT,
          suggestion_id TEXT,
          action TEXT NOT NULL,
          detail_json TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (contact_identity_id) REFERENCES contact_identities(id),
          FOREIGN KEY (handle_id) REFERENCES contact_identity_handles(id),
          FOREIGN KEY (suggestion_id) REFERENCES contact_identity_suggestions(id)
        );
        CREATE INDEX IF NOT EXISTS idx_contact_identity_audit_identity
          ON contact_identity_audit(contact_identity_id, created_at DESC);
      `);
    } catch {
      // Table already exists or SQLite build lacks support; best effort only.
    }

    // Seed built-in entity types for all workspaces that don't have them yet
    this.seedKnowledgeGraphTypes();

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS llm_pricing (
          model_key TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          display_name TEXT NOT NULL,
          input_cost_per_mtok REAL NOT NULL DEFAULT 0,
          output_cost_per_mtok REAL NOT NULL DEFAULT 0,
          cached_input_cost_per_mtok REAL NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
      `);
    } catch {
      // Table already exists, ignore
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS llm_call_events (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          workspace_id TEXT,
          task_id TEXT,
          source_kind TEXT NOT NULL,
          source_id TEXT,
          provider_type TEXT,
          model_key TEXT,
          model_id TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          cost REAL NOT NULL DEFAULT 0,
          success INTEGER NOT NULL DEFAULT 1,
          error_code TEXT,
          error_message TEXT,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

        CREATE INDEX IF NOT EXISTS idx_llm_call_events_timestamp
          ON llm_call_events(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_llm_call_events_workspace
          ON llm_call_events(workspace_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_llm_call_events_source
          ON llm_call_events(source_kind, timestamp DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_call_events_source_id
          ON llm_call_events(source_kind, source_id);
      `);
    } catch {
      // Table or indexes already exist, ignore
    }
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS usage_insights_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS usage_insights_day (
          workspace_id TEXT NOT NULL,
          date_key TEXT NOT NULL,
          task_created_total INTEGER NOT NULL DEFAULT 0,
          task_completed_created INTEGER NOT NULL DEFAULT 0,
          task_failed_created INTEGER NOT NULL DEFAULT 0,
          task_cancelled_created INTEGER NOT NULL DEFAULT 0,
          completed_duration_total_ms_created INTEGER NOT NULL DEFAULT 0,
          completed_duration_count_created INTEGER NOT NULL DEFAULT 0,
          attempt_sum_created REAL NOT NULL DEFAULT 0,
          attempt_count_created INTEGER NOT NULL DEFAULT 0,
          retried_tasks_created INTEGER NOT NULL DEFAULT 0,
          max_attempt_created INTEGER NOT NULL DEFAULT 0,
          feedback_total INTEGER NOT NULL DEFAULT 0,
          feedback_accepted INTEGER NOT NULL DEFAULT 0,
          feedback_rejected INTEGER NOT NULL DEFAULT 0,
          awu_completed_ok INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (workspace_id, date_key),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_usage_insights_day_date
          ON usage_insights_day(date_key);

        CREATE TABLE IF NOT EXISTS usage_insights_hour (
          workspace_id TEXT NOT NULL,
          date_key TEXT NOT NULL,
          day_of_week INTEGER NOT NULL,
          hour_of_day INTEGER NOT NULL,
          task_created_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (workspace_id, date_key, day_of_week, hour_of_day),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_usage_insights_hour_date
          ON usage_insights_hour(date_key);

        CREATE TABLE IF NOT EXISTS usage_insights_skill_day (
          workspace_id TEXT NOT NULL,
          date_key TEXT NOT NULL,
          skill TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (workspace_id, date_key, skill),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_usage_insights_skill_day_date
          ON usage_insights_skill_day(date_key);

        CREATE TABLE IF NOT EXISTS usage_insights_tool_day (
          workspace_id TEXT NOT NULL,
          date_key TEXT NOT NULL,
          tool TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0,
          results INTEGER NOT NULL DEFAULT 0,
          errors INTEGER NOT NULL DEFAULT 0,
          blocked INTEGER NOT NULL DEFAULT 0,
          warnings INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (workspace_id, date_key, tool),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_usage_insights_tool_day_date
          ON usage_insights_tool_day(date_key);

        CREATE TABLE IF NOT EXISTS usage_insights_persona_day (
          workspace_id TEXT NOT NULL,
          date_key TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          persona_name TEXT NOT NULL,
          total INTEGER NOT NULL DEFAULT 0,
          completed INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0,
          cancelled INTEGER NOT NULL DEFAULT 0,
          completion_duration_total_ms INTEGER NOT NULL DEFAULT 0,
          completion_duration_count INTEGER NOT NULL DEFAULT 0,
          attempt_sum REAL NOT NULL DEFAULT 0,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          total_cost REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (workspace_id, date_key, persona_id),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_usage_insights_persona_day_date
          ON usage_insights_persona_day(date_key);

        CREATE TABLE IF NOT EXISTS usage_insights_feedback_reason_day (
          workspace_id TEXT NOT NULL,
          date_key TEXT NOT NULL,
          reason TEXT NOT NULL,
          rejected_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (workspace_id, date_key, reason),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_usage_insights_feedback_reason_day_date
          ON usage_insights_feedback_reason_day(date_key);
      `);
    } catch {
      // Usage insights rollup tables already exist, ignore.
    }
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS acp_agents (
          id TEXT PRIMARY KEY,
          origin TEXT NOT NULL,
          endpoint TEXT,
          name TEXT NOT NULL,
          provider TEXT,
          status TEXT NOT NULL,
          registered_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          card_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_acp_agents_origin_status
          ON acp_agents(origin, status, updated_at DESC);
      `);
    } catch {
      // Table or indexes already exist, ignore
    }
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS acp_tasks (
          id TEXT PRIMARY KEY,
          requester_id TEXT NOT NULL,
          assignee_id TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          cowork_task_id TEXT,
          remote_task_id TEXT,
          workspace_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_acp_tasks_requester_status
          ON acp_tasks(requester_id, status, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_acp_tasks_assignee_status
          ON acp_tasks(assignee_id, status, updated_at DESC);
      `);
    } catch {
      // Table or indexes already exist, ignore
    }
    this.seedLlmPricing();
  }

  private initializeKnowledgeGraphFTS() {
    const hasKnowledgeGraphEntitiesTable = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kg_entities' LIMIT 1",
      )
      .get();
    if (!hasKnowledgeGraphEntitiesTable) {
      return;
    }

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
      schemaLogger.warn("[DatabaseManager] Knowledge Graph FTS5 initialization failed:", error);
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
      schemaLogger.warn("[DatabaseManager] Failed to seed knowledge graph types:", error);
    }
  }

  private seedLlmPricing() {
    try {
      const now = Date.now();
      type P = { key: string; provider: string; display: string; input: number; output: number; cached: number };
      const models: P[] = [
        // ── OpenAI 5.4 ──
        { key: "gpt-5.4",              provider: "OpenAI", display: "GPT-5.4",             input: 2.50,   output: 15.00,  cached: 0.25 },
        { key: "gpt-5.4-mini",         provider: "OpenAI", display: "GPT-5.4 Mini",        input: 0.75,   output: 4.50,   cached: 0.075 },
        { key: "gpt-5.4-nano",         provider: "OpenAI", display: "GPT-5.4 Nano",        input: 0.20,   output: 1.25,   cached: 0.02 },
        { key: "gpt-5.4-pro",          provider: "OpenAI", display: "GPT-5.4 Pro",         input: 30.00,  output: 180.00, cached: 0 },
        // ── OpenAI 5.3 ──
        { key: "gpt-5.3-chat",         provider: "OpenAI", display: "GPT-5.3 Chat",        input: 1.75,   output: 14.00,  cached: 0.175 },
        { key: "gpt-5.3-codex-spark",  provider: "OpenAI", display: "GPT-5.3 Codex Spark", input: 1.75,   output: 14.00,  cached: 0.175 },
        { key: "gpt-5.3-codex",        provider: "OpenAI", display: "GPT-5.3 Codex",       input: 1.75,   output: 14.00,  cached: 0.175 },
        // ── OpenAI 5.2 ──
        { key: "gpt-5.2",              provider: "OpenAI", display: "GPT-5.2",             input: 1.75,   output: 14.00,  cached: 0.175 },
        { key: "gpt-5.2-pro",          provider: "OpenAI", display: "GPT-5.2 Pro",         input: 21.00,  output: 168.00, cached: 0 },
        // ── OpenAI 5.1 / 5.0 ──
        { key: "gpt-5.1",              provider: "OpenAI", display: "GPT-5.1",             input: 1.25,   output: 10.00,  cached: 0.125 },
        { key: "gpt-5.1-codex-mini",   provider: "OpenAI", display: "GPT-5.1 Codex Mini",  input: 0.25,   output: 2.00,   cached: 0.025 },
        { key: "gpt-5",                provider: "OpenAI", display: "GPT-5",               input: 1.25,   output: 10.00,  cached: 0.125 },
        { key: "gpt-5-mini",           provider: "OpenAI", display: "GPT-5 Mini",          input: 0.25,   output: 2.00,   cached: 0.025 },
        { key: "gpt-5-nano",           provider: "OpenAI", display: "GPT-5 Nano",          input: 0.05,   output: 0.40,   cached: 0.005 },
        { key: "gpt-5-pro",            provider: "OpenAI", display: "GPT-5 Pro",           input: 15.00,  output: 120.00, cached: 0 },
        // ── OpenAI 4.x ──
        { key: "gpt-4.1",              provider: "OpenAI", display: "GPT-4.1",             input: 2.00,   output: 8.00,   cached: 0.50 },
        { key: "gpt-4.1-mini",         provider: "OpenAI", display: "GPT-4.1 Mini",        input: 0.40,   output: 1.60,   cached: 0.10 },
        { key: "gpt-4.1-nano",         provider: "OpenAI", display: "GPT-4.1 Nano",        input: 0.10,   output: 0.40,   cached: 0.025 },
        { key: "gpt-4o",               provider: "OpenAI", display: "GPT-4o",              input: 2.50,   output: 10.00,  cached: 1.25 },
        { key: "gpt-4o-mini",          provider: "OpenAI", display: "GPT-4o Mini",         input: 0.15,   output: 0.60,   cached: 0.075 },
        { key: "gpt-4-turbo",          provider: "OpenAI", display: "GPT-4 Turbo",         input: 10.00,  output: 30.00,  cached: 0 },
        { key: "gpt-3.5-turbo",        provider: "OpenAI", display: "GPT-3.5 Turbo",       input: 0.50,   output: 1.50,   cached: 0 },
        // ── OpenAI reasoning ──
        { key: "o4-mini",              provider: "OpenAI", display: "o4-mini",             input: 1.10,   output: 4.40,   cached: 0.275 },
        { key: "o3",                   provider: "OpenAI", display: "o3",                  input: 2.00,   output: 8.00,   cached: 0.50 },
        { key: "o3-mini",              provider: "OpenAI", display: "o3-mini",             input: 1.10,   output: 4.40,   cached: 0.55 },
        { key: "o3-pro",               provider: "OpenAI", display: "o3-pro",              input: 20.00,  output: 80.00,  cached: 0 },
        { key: "o1",                   provider: "OpenAI", display: "o1",                  input: 15.00,  output: 60.00,  cached: 7.50 },
        { key: "o1-mini",              provider: "OpenAI", display: "o1-mini",             input: 1.10,   output: 4.40,   cached: 0.55 },
        { key: "o1-pro",               provider: "OpenAI", display: "o1-pro",              input: 150.00, output: 600.00, cached: 0 },

        // ── Anthropic ──
        { key: "claude-opus-4-6",      provider: "Anthropic", display: "Claude Opus 4.6",      input: 5.00,  output: 25.00, cached: 0.50 },
        { key: "claude-sonnet-4-6",    provider: "Anthropic", display: "Claude Sonnet 4.6",    input: 3.00,  output: 15.00, cached: 0.30 },
        { key: "claude-opus-4-5",      provider: "Anthropic", display: "Claude Opus 4.5",      input: 5.00,  output: 25.00, cached: 0.50 },
        { key: "claude-sonnet-4-5",    provider: "Anthropic", display: "Claude Sonnet 4.5",    input: 3.00,  output: 15.00, cached: 0.30 },
        { key: "claude-opus-4-1",      provider: "Anthropic", display: "Claude Opus 4.1",      input: 15.00, output: 75.00, cached: 1.50 },
        { key: "claude-sonnet-4",      provider: "Anthropic", display: "Claude Sonnet 4",      input: 3.00,  output: 15.00, cached: 0.30 },
        { key: "claude-opus-4",        provider: "Anthropic", display: "Claude Opus 4",        input: 15.00, output: 75.00, cached: 1.50 },
        { key: "claude-haiku-4-5",     provider: "Anthropic", display: "Claude Haiku 4.5",     input: 1.00,  output: 5.00,  cached: 0.10 },
        { key: "claude-haiku-3-5",     provider: "Anthropic", display: "Claude Haiku 3.5",     input: 0.80,  output: 4.00,  cached: 0.08 },
        { key: "claude-3-haiku",       provider: "Anthropic", display: "Claude 3 Haiku",       input: 0.25,  output: 1.25,  cached: 0.03 },
        { key: "claude-3-opus",        provider: "Anthropic", display: "Claude 3 Opus",        input: 15.00, output: 75.00, cached: 1.50 },
        { key: "claude-3-sonnet",      provider: "Anthropic", display: "Claude 3 Sonnet",      input: 3.00,  output: 15.00, cached: 0.30 },
        { key: "claude-sonnet-3-7",    provider: "Anthropic", display: "Claude Sonnet 3.7",    input: 3.00,  output: 15.00, cached: 0.30 },

        // ── Google Gemini ──
        { key: "gemini-3.1-pro",       provider: "Google", display: "Gemini 3.1 Pro",         input: 2.00,  output: 12.00, cached: 0.20 },
        { key: "gemini-3.1-flash-lite", provider: "Google", display: "Gemini 3.1 Flash Lite", input: 0.25,  output: 1.50,  cached: 0.025 },
        { key: "gemini-3-flash",       provider: "Google", display: "Gemini 3 Flash",         input: 0.50,  output: 3.00,  cached: 0.05 },
        { key: "gemini-2.5-pro",       provider: "Google", display: "Gemini 2.5 Pro",         input: 1.25,  output: 10.00, cached: 0.125 },
        { key: "gemini-2.5-flash",     provider: "Google", display: "Gemini 2.5 Flash",       input: 0.30,  output: 2.50,  cached: 0.03 },
        { key: "gemini-2.5-flash-lite", provider: "Google", display: "Gemini 2.5 Flash Lite", input: 0.10,  output: 0.40,  cached: 0.01 },
        { key: "gemini-2.0-flash",     provider: "Google", display: "Gemini 2.0 Flash",       input: 0.10,  output: 0.40,  cached: 0.025 },
        { key: "gemini-1.5-pro",       provider: "Google", display: "Gemini 1.5 Pro",         input: 1.25,  output: 5.00,  cached: 0.3125 },
        { key: "gemini-1.5-flash",     provider: "Google", display: "Gemini 1.5 Flash",       input: 0.075, output: 0.30,  cached: 0.01875 },

        // ── xAI Grok ──
        { key: "grok-4",               provider: "xAI", display: "Grok 4",                 input: 3.00,  output: 15.00, cached: 0.75 },
        { key: "grok-4.20",            provider: "xAI", display: "Grok 4.20",              input: 2.00,  output: 6.00,  cached: 0.20 },
        { key: "grok-4-1-fast",        provider: "xAI", display: "Grok 4.1 Fast",          input: 0.20,  output: 0.50,  cached: 0.05 },
        { key: "grok-4.1-fast",        provider: "xAI", display: "Grok 4.1 Fast",          input: 0.20,  output: 0.50,  cached: 0.05 },
        { key: "grok-3",               provider: "xAI", display: "Grok 3",                 input: 3.00,  output: 15.00, cached: 0.75 },
        { key: "grok-3-mini",          provider: "xAI", display: "Grok 3 Mini",            input: 0.30,  output: 0.50,  cached: 0.075 },
        { key: "grok-code-fast-1",     provider: "xAI", display: "Grok Code Fast 1",       input: 0.20,  output: 1.50,  cached: 0.05 },

        // ── DeepSeek ──
        { key: "deepseek-chat",        provider: "DeepSeek", display: "DeepSeek Chat V3.2",   input: 0.28,  output: 0.42,  cached: 0.028 },
        { key: "deepseek-reasoner",    provider: "DeepSeek", display: "DeepSeek Reasoner",    input: 0.55,  output: 2.19,  cached: 0.14 },
        { key: "deepseek-v3",          provider: "DeepSeek", display: "DeepSeek V3",          input: 0.28,  output: 0.42,  cached: 0.028 },
        { key: "deepseek-v3.1",        provider: "DeepSeek", display: "DeepSeek V3.1",        input: 0.15,  output: 0.75,  cached: 0.015 },
        { key: "deepseek-r1",          provider: "DeepSeek", display: "DeepSeek R1",          input: 0.55,  output: 2.19,  cached: 0.14 },

        // ── Mistral ──
        { key: "mistral-large",        provider: "Mistral", display: "Mistral Large 3",      input: 0.50,  output: 1.50,  cached: 0.05 },
        { key: "mistral-small",        provider: "Mistral", display: "Mistral Small 3.2",    input: 0.07,  output: 0.20,  cached: 0.007 },
        { key: "mistral-small-4",      provider: "Mistral", display: "Mistral Small 4",      input: 0.15,  output: 0.60,  cached: 0.015 },
        { key: "codestral",            provider: "Mistral", display: "Codestral",            input: 0.30,  output: 0.90,  cached: 0.03 },
        { key: "mistral-medium",       provider: "Mistral", display: "Mistral Medium",       input: 2.75,  output: 8.10,  cached: 0.275 },

        // ── Meta Llama ──
        { key: "llama-4-maverick",     provider: "Meta", display: "Llama 4 Maverick",       input: 0.15,  output: 0.60,  cached: 0 },
        { key: "llama-4-scout",        provider: "Meta", display: "Llama 4 Scout",          input: 0.08,  output: 0.30,  cached: 0 },
        { key: "llama-3.3-70b",        provider: "Meta", display: "Llama 3.3 70B",          input: 0.10,  output: 0.30,  cached: 0 },
        { key: "llama-3.1-405b",       provider: "Meta", display: "Llama 3.1 405B",         input: 0.80,  output: 0.80,  cached: 0 },
        { key: "llama-3.1-70b",        provider: "Meta", display: "Llama 3.1 70B",          input: 0.10,  output: 0.30,  cached: 0 },
        { key: "llama-3.1-8b",         provider: "Meta", display: "Llama 3.1 8B",           input: 0.03,  output: 0.05,  cached: 0 },

        // ── Moonshot Kimi ──
        { key: "kimi-k2.5",            provider: "Moonshot", display: "Kimi K2.5",           input: 0.42,  output: 2.20,  cached: 0 },
        { key: "kimi-k2",              provider: "Moonshot", display: "Kimi K2",             input: 0.40,  output: 2.00,  cached: 0 },
        { key: "kimi-k2.5-turbo",      provider: "Moonshot", display: "Kimi K2.5 Turbo",    input: 0.60,  output: 3.00,  cached: 0 },
        { key: "moonshot-v1-8k",       provider: "Moonshot", display: "Moonshot v1 8K",      input: 0.42,  output: 2.20,  cached: 0 },

        // ── Cohere ──
        { key: "command-a",            provider: "Cohere", display: "Command A",             input: 2.50,  output: 10.00, cached: 0 },
        { key: "command-r",            provider: "Cohere", display: "Command R",             input: 0.15,  output: 0.60,  cached: 0 },
        { key: "command-r-plus",       provider: "Cohere", display: "Command R+",            input: 2.50,  output: 10.00, cached: 0 },
        { key: "command-r7b",          provider: "Cohere", display: "Command R7B",           input: 0.037, output: 0.15,  cached: 0 },

        // ── MiniMax ──
        { key: "MiniMax-M2.7",         provider: "MiniMax", display: "MiniMax M2.7",         input: 0.30,  output: 1.20,  cached: 0 },
        { key: "MiniMax-M2.5",         provider: "MiniMax", display: "MiniMax M2.5",         input: 0.20,  output: 1.10,  cached: 0.10 },
        { key: "MiniMax-M2.5-highspeed", provider: "MiniMax", display: "MiniMax M2.5 Highspeed", input: 0.20, output: 2.40, cached: 0.10 },
        { key: "MiniMax-M2.1",         provider: "MiniMax", display: "MiniMax M2.1",         input: 0.20,  output: 1.10,  cached: 0.10 },
        { key: "MiniMax-M2",           provider: "MiniMax", display: "MiniMax M2",           input: 0.20,  output: 1.10,  cached: 0.10 },

        // ── Free: ":free" suffix ──
        { key: "nvidia/nemotron-3-nano-30b-a3b:free",   provider: "NVIDIA", display: "Nemotron 3 Nano 30B (free)", input: 0, output: 0, cached: 0 },
        { key: "nvidia/nemotron-3-super-120b-a12b:free", provider: "NVIDIA", display: "Nemotron 3 Super 120B (free)", input: 0, output: 0, cached: 0 },

        // ── Local / Ollama — always free ──
        { key: "qwen3.5:latest",       provider: "Local", display: "Qwen 3.5 (Ollama)",     input: 0, output: 0, cached: 0 },
        { key: "llama3:latest",         provider: "Local", display: "Llama 3 (Ollama)",      input: 0, output: 0, cached: 0 },
        { key: "mistral:latest",        provider: "Local", display: "Mistral (Ollama)",      input: 0, output: 0, cached: 0 },
        { key: "codellama:latest",      provider: "Local", display: "Code Llama (Ollama)",   input: 0, output: 0, cached: 0 },
        { key: "phi-3:latest",          provider: "Local", display: "Phi-3 (Ollama)",        input: 0, output: 0, cached: 0 },
        { key: "gemma:latest",          provider: "Local", display: "Gemma (Ollama)",        input: 0, output: 0, cached: 0 },
      ];

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO llm_pricing
          (model_key, provider, display_name, input_cost_per_mtok, output_cost_per_mtok, cached_input_cost_per_mtok, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const m of models) {
        stmt.run(m.key, m.provider, m.display, m.input, m.output, m.cached, now);
      }
    } catch (error) {
      schemaLogger.warn("[DatabaseManager] Failed to seed LLM pricing:", error);
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
          anthropicModelId: "claude-opus-4-5-20251101",
          bedrockModelId: "anthropic.claude-opus-4-5-20251101",
          sortOrder: 1,
        },
        {
          id: "model-sonnet-4-5",
          key: "sonnet-4-5",
          displayName: "Sonnet 4.5",
          description: "Best for everyday tasks",
          anthropicModelId: "claude-sonnet-4-5",
          bedrockModelId: "anthropic.claude-sonnet-4-5-20250514",
          sortOrder: 2,
        },
        {
          id: "model-haiku-4-5",
          key: "haiku-4-5",
          displayName: "Haiku 4.5",
          description: "Fastest for quick answers",
          anthropicModelId: "claude-haiku-4-5",
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

  private upgradeKnowledgeGraphEdgesForTemporalValidity(): void {
    try {
      const tableInfo = this.db
        .prepare("PRAGMA table_info(kg_edges)")
        .all() as Array<{ name?: string }>;
      const columns = new Set(tableInfo.map((column) => String(column.name || "")));
      const tableSqlRow = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kg_edges'")
        .get() as { sql?: string } | undefined;
      const tableSql = String(tableSqlRow?.sql || "");
      const hasLegacyUniqueConstraint = /UNIQUE\s*\(\s*workspace_id\s*,\s*source_entity_id\s*,\s*target_entity_id\s*,\s*edge_type\s*\)/i.test(
        tableSql,
      );

      if (hasLegacyUniqueConstraint) {
        const foreignKeysEnabled = this.db.pragma("foreign_keys", { simple: true }) as number;
        try {
          this.db.pragma("foreign_keys = OFF");
          this.db.transaction(() => {
            this.db.exec("ALTER TABLE kg_edges RENAME TO kg_edges_legacy_temporal");
            this.db.exec(`
              CREATE TABLE kg_edges (
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
                valid_from INTEGER,
                valid_to INTEGER,
                FOREIGN KEY (source_entity_id) REFERENCES kg_entities(id) ON DELETE CASCADE,
                FOREIGN KEY (target_entity_id) REFERENCES kg_entities(id) ON DELETE CASCADE
              );
            `);
            this.db.exec(`
              INSERT INTO kg_edges (
                id,
                workspace_id,
                source_entity_id,
                target_entity_id,
                edge_type,
                properties,
                confidence,
                source,
                source_task_id,
                created_at,
                valid_from,
                valid_to
              )
              SELECT
                id,
                workspace_id,
                source_entity_id,
                target_entity_id,
                edge_type,
                properties,
                confidence,
                source,
                source_task_id,
                created_at,
                created_at,
                NULL
              FROM kg_edges_legacy_temporal;
            `);
            this.db.exec("DROP TABLE kg_edges_legacy_temporal");
          })();
        } finally {
          this.db.pragma(`foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
        }
      } else {
        if (!columns.has("valid_from")) {
          this.db.exec("ALTER TABLE kg_edges ADD COLUMN valid_from INTEGER");
          this.db.exec("UPDATE kg_edges SET valid_from = created_at WHERE valid_from IS NULL");
        }
        if (!columns.has("valid_to")) {
          this.db.exec("ALTER TABLE kg_edges ADD COLUMN valid_to INTEGER");
        }
      }

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_kg_edges_workspace ON kg_edges(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_entity_id);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_entity_id);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(edge_type);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_validity ON kg_edges(valid_from, valid_to);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_edges_current_unique
          ON kg_edges(workspace_id, source_entity_id, target_entity_id, edge_type)
          WHERE valid_to IS NULL;
      `);
    } catch (error) {
      schemaLogger.error("[DatabaseManager] Failed temporal KG edge migration:", error);
    }
  }
}
