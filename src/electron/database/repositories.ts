import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  Task,
  TaskEvent,
  Artifact,
  Workspace,
  ApprovalRequest,
  Skill,
  WorkspacePermissions,
  isTempWorkspaceId,
  WorktreeInfo,
  WorktreeStatus,
  MergeResult,
  ComparisonSession,
  ComparisonSessionStatus,
  ComparisonResult,
} from "../../shared/types";

/**
 * Safely parse JSON with error handling
 * Returns defaultValue if parsing fails
 */
function safeJsonParse<T>(jsonString: string, defaultValue: T, context?: string): T {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error(
      `Failed to parse JSON${context ? ` in ${context}` : ""}:`,
      error,
      "Input:",
      jsonString?.slice(0, 100),
    );
    return defaultValue;
  }
}

export class WorkspaceRepository {
  constructor(private db: Database.Database) {}

  create(name: string, path: string, permissions: WorkspacePermissions): Workspace {
    const now = Date.now();
    const workspace: Workspace = {
      id: uuidv4(),
      name,
      path,
      createdAt: now,
      lastUsedAt: now,
      permissions,
    };

    const stmt = this.db.prepare(`
      INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      workspace.id,
      workspace.name,
      workspace.path,
      workspace.createdAt,
      workspace.lastUsedAt,
      JSON.stringify(workspace.permissions),
    );

    return workspace;
  }

  findById(id: string): Workspace | undefined {
    const stmt = this.db.prepare("SELECT * FROM workspaces WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToWorkspace(row) : undefined;
  }

  findAll(): Workspace[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM workspaces
      ORDER BY COALESCE(last_used_at, created_at) DESC
    `);
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToWorkspace(row));
  }

  /**
   * Check if a workspace with the given path already exists
   */
  existsByPath(path: string): boolean {
    const stmt = this.db.prepare("SELECT 1 FROM workspaces WHERE path = ?");
    const row = stmt.get(path);
    return !!row;
  }

  /**
   * Find a workspace by its path
   */
  findByPath(path: string): Workspace | undefined {
    const stmt = this.db.prepare("SELECT * FROM workspaces WHERE path = ?");
    const row = stmt.get(path) as Any;
    return row ? this.mapRowToWorkspace(row) : undefined;
  }

  /**
   * Update workspace permissions
   */
  updatePermissions(id: string, permissions: WorkspacePermissions): void {
    const stmt = this.db.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?");
    stmt.run(JSON.stringify(permissions), id);
  }

  /**
   * Update last used timestamp for recency ordering
   */
  updateLastUsedAt(id: string, lastUsedAt: number = Date.now()): void {
    const stmt = this.db.prepare("UPDATE workspaces SET last_used_at = ? WHERE id = ?");
    stmt.run(lastUsedAt, id);
  }

  /**
   * Delete a workspace by ID
   */
  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM workspaces WHERE id = ?");
    stmt.run(id);
  }

  private mapRowToWorkspace(row: Any): Workspace {
    // Note: network is true by default for browser tools (web access)
    const defaultPermissions: WorkspacePermissions = {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
    };
    const storedPermissions = safeJsonParse(
      row.permissions,
      defaultPermissions,
      "workspace.permissions",
    );

    // Merge with defaults to ensure new fields (like network) get proper defaults
    // for workspaces created before those fields existed
    const mergedPermissions: WorkspacePermissions = {
      ...defaultPermissions,
      ...storedPermissions,
    };

    // Migration: if network was explicitly false (old default), upgrade it to true
    // This ensures existing workspaces get browser tool access
    if (storedPermissions.network === false) {
      mergedPermissions.network = true;
    }

    return {
      id: row.id,
      name: row.name,
      path: row.path,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
      permissions: mergedPermissions,
      isTemp: isTempWorkspaceId(typeof row.id === "string" ? row.id : undefined),
    };
  }
}

export class TaskRepository {
  constructor(private db: Database.Database) {}

  create(task: Omit<Task, "id" | "createdAt" | "updatedAt">): Task {
    const newTask: Task = {
      ...task,
      id: uuidv4(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, prompt, raw_prompt, user_prompt, status, workspace_id, created_at, updated_at, budget_tokens, budget_cost, success_criteria, max_attempts, current_attempt, parent_task_id, agent_type, agent_config, depth, result_summary, source, strategy_lock, budget_profile, terminal_status, failure_class, budget_usage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newTask.id,
      newTask.title,
      newTask.prompt,
      newTask.rawPrompt || null,
      newTask.userPrompt || null,
      newTask.status,
      newTask.workspaceId,
      newTask.createdAt,
      newTask.updatedAt,
      newTask.budgetTokens || null,
      newTask.budgetCost || null,
      newTask.successCriteria ? JSON.stringify(newTask.successCriteria) : null,
      newTask.maxAttempts || null,
      newTask.currentAttempt || 1,
      newTask.parentTaskId || null,
      newTask.agentType || "main",
      newTask.agentConfig ? JSON.stringify(newTask.agentConfig) : null,
      newTask.depth ?? 0,
      newTask.resultSummary || null,
      newTask.source || "manual",
      newTask.strategyLock ? 1 : 0,
      newTask.budgetProfile || null,
      newTask.terminalStatus || null,
      newTask.failureClass || null,
      newTask.budgetUsage ? JSON.stringify(newTask.budgetUsage) : null,
    );

    return newTask;
  }

  // Whitelist of allowed update fields to prevent SQL injection
  private static readonly ALLOWED_UPDATE_FIELDS = new Set([
    "title",
    "status",
    "error",
    "result",
    "budgetTokens",
    "budgetCost",
    "successCriteria",
    "maxAttempts",
    "currentAttempt",
    "completedAt",
    "workspaceId",
    "parentTaskId",
    "agentType",
    "agentConfig",
    "depth",
    "resultSummary",
    // Agent Squad fields
    "assignedAgentRoleId",
    "boardColumn",
    "priority",
    // Task Board fields
    "labels",
    "dueDate",
    "estimatedMinutes",
    "actualMinutes",
    "mentionedAgentRoleIds",
    "userPrompt",
    "pinned",
    "rawPrompt",
    "strategyLock",
    "budgetProfile",
    "terminalStatus",
    "failureClass",
    "budgetUsage",
    // Git Worktree fields
    "worktreePath",
    "worktreeBranch",
    "worktreeStatus",
    "comparisonSessionId",
    "source",
  ]);

  update(id: string, updates: Partial<Task>): void {
    const fields: string[] = [];
    const values: Any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      // Validate field name against whitelist
      if (!TaskRepository.ALLOWED_UPDATE_FIELDS.has(key)) {
        console.warn(`Ignoring unknown field in task update: ${key}`);
        return;
      }
      const dbKey =
        key === "pinned"
          ? "is_pinned"
          : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      fields.push(`${dbKey} = ?`);

      // JSON serialize object/array fields
      if (
        (key === "successCriteria" ||
          key === "agentConfig" ||
          key === "labels" ||
          key === "mentionedAgentRoleIds" ||
          key === "budgetUsage") &&
        value != null
      ) {
        values.push(JSON.stringify(value));
      } else if (key === "pinned") {
        values.push(Number(Boolean(value)));
      } else if (key === "strategyLock") {
        values.push(Number(Boolean(value)));
      } else {
        values.push(value);
      }
    });

    if (fields.length === 0) {
      return; // No valid fields to update
    }

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  togglePin(id: string): Task | undefined {
    const result = this.db
      .prepare(`
      UPDATE tasks
      SET is_pinned = CASE
          WHEN CAST(is_pinned AS INTEGER) = 1 THEN 0
          ELSE 1
        END,
        updated_at = ?
      WHERE id = ?
    `)
      .run(Date.now(), id);

    if (result.changes === 0) {
      return undefined;
    }

    return this.findById(id);
  }

  findById(id: string): Task | undefined {
    const stmt = this.db.prepare("SELECT * FROM tasks WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToTask(row) : undefined;
  }

  findAll(limit = 100, offset = 0): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(limit, offset) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  /**
   * Find tasks by status (single status or array of statuses)
   */
  findByStatus(status: string | string[]): Task[] {
    const statuses = Array.isArray(status) ? status : [status];
    const placeholders = statuses.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN (${placeholders})
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(...statuses) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  /**
   * Find tasks by workspace ID
   */
  findByWorkspace(workspaceId: string, limit?: number, offset?: number): Task[] {
    if (typeof limit === "number" && Number.isFinite(limit)) {
      const safeLimit = Math.max(1, Math.floor(limit));
      const safeOffset =
        typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
      const stmt = this.db.prepare(`
        SELECT * FROM tasks
        WHERE workspace_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(workspaceId, safeLimit, safeOffset) as Any[];
      return rows.map((row) => this.mapRowToTask(row));
    }

    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(workspaceId) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  countByWorkspace(workspaceId: string): number {
    const stmt = this.db.prepare("SELECT COUNT(1) as count FROM tasks WHERE workspace_id = ?");
    const row = stmt.get(workspaceId) as Any;
    const count = row?.count;
    if (typeof count === "number") return count;
    const parsed = Number(count);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Find tasks within a created_at time range (inclusive start, exclusive end).
   * Optionally filter by workspace and a simple substring query over title/prompt.
   */
  findByCreatedAtRange(params: {
    startMs: number;
    endMs: number;
    limit?: number;
    workspaceId?: string;
    query?: string;
  }): Task[] {
    const startMs = Number(params.startMs);
    const endMs = Number(params.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    if (endMs <= startMs) return [];

    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.min(Math.max(Math.floor(params.limit), 1), 200)
        : 50;

    const where: string[] = ["created_at >= ?", "created_at < ?"];
    const args: Any[] = [startMs, endMs];

    const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId.trim() : "";
    if (workspaceId) {
      where.push("workspace_id = ?");
      args.push(workspaceId);
    }

    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (query) {
      // Simple LIKE match (SQLite default collation is case-insensitive for ASCII).
      where.push("(title LIKE ? OR prompt LIKE ?)");
      args.push(`%${query}%`, `%${query}%`);
    }

    args.push(limit);

    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(...args) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  delete(id: string): void {
    // Use transaction to ensure atomic deletion
    const deleteTransaction = this.db.transaction((taskId: string) => {
      // Delete related records from all tables with foreign keys to tasks
      const deleteEvents = this.db.prepare("DELETE FROM task_events WHERE task_id = ?");
      deleteEvents.run(taskId);

      const deleteArtifacts = this.db.prepare("DELETE FROM artifacts WHERE task_id = ?");
      deleteArtifacts.run(taskId);

      const deleteApprovals = this.db.prepare("DELETE FROM approvals WHERE task_id = ?");
      deleteApprovals.run(taskId);

      // Delete activity feed entries for this task
      const deleteActivities = this.db.prepare("DELETE FROM activity_feed WHERE task_id = ?");
      deleteActivities.run(taskId);

      // Delete agent mentions for this task
      const deleteMentions = this.db.prepare("DELETE FROM agent_mentions WHERE task_id = ?");
      deleteMentions.run(taskId);

      // Delete working state entries for this task
      const deleteWorkingState = this.db.prepare(
        "DELETE FROM agent_working_state WHERE task_id = ?",
      );
      deleteWorkingState.run(taskId);

      // Nullify task_id in memories rather than deleting them
      const clearMemoryTaskId = this.db.prepare(
        "UPDATE memories SET task_id = NULL WHERE task_id = ?",
      );
      clearMemoryTaskId.run(taskId);

      // Nullify task_id in channel_sessions rather than deleting the session
      const clearSessionTaskId = this.db.prepare(
        "UPDATE channel_sessions SET task_id = NULL WHERE task_id = ?",
      );
      clearSessionTaskId.run(taskId);

      // Delete worktree_info record if it exists
      const deleteWorktreeInfo = this.db.prepare("DELETE FROM worktree_info WHERE task_id = ?");
      deleteWorktreeInfo.run(taskId);

      // Finally delete the task
      const deleteTask = this.db.prepare("DELETE FROM tasks WHERE id = ?");
      deleteTask.run(taskId);
    });

    deleteTransaction(id);
  }

  private mapRowToTask(row: Any): Task {
    return {
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      rawPrompt: row.raw_prompt || undefined,
      userPrompt: row.user_prompt || undefined,
      status: row.status,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || undefined,
      pinned: Number(row.is_pinned) === 1,
      budgetTokens: row.budget_tokens || undefined,
      budgetCost: row.budget_cost || undefined,
      error: row.error || undefined,
      // Verification/retry metadata
      successCriteria: row.success_criteria
        ? safeJsonParse(row.success_criteria, undefined, "task.successCriteria")
        : undefined,
      maxAttempts: row.max_attempts || undefined,
      currentAttempt: row.current_attempt || undefined,
      // Sub-Agent / Parallel Agent fields
      parentTaskId: row.parent_task_id || undefined,
      agentType: row.agent_type || undefined,
      agentConfig: row.agent_config
        ? safeJsonParse(row.agent_config, undefined, "task.agentConfig")
        : undefined,
      depth: row.depth ?? undefined,
      resultSummary: row.result_summary || undefined,
      // Agent Squad fields
      assignedAgentRoleId: row.assigned_agent_role_id || undefined,
      boardColumn: row.board_column || undefined,
      priority: row.priority ?? undefined,
      // Task Board fields
      labels: row.labels ? safeJsonParse<string[]>(row.labels, [], "task.labels") : undefined,
      dueDate: row.due_date || undefined,
      estimatedMinutes: row.estimated_minutes || undefined,
      actualMinutes: row.actual_minutes || undefined,
      mentionedAgentRoleIds: row.mentioned_agent_role_ids
        ? safeJsonParse<string[]>(row.mentioned_agent_role_ids, [], "task.mentionedAgentRoleIds")
        : undefined,
      // Git Worktree fields
      worktreePath: row.worktree_path || undefined,
      worktreeBranch: row.worktree_branch || undefined,
      worktreeStatus: (row.worktree_status as Task["worktreeStatus"]) || undefined,
      comparisonSessionId: row.comparison_session_id || undefined,
      source: (row.source as Task["source"]) || undefined,
      strategyLock: Number(row.strategy_lock) === 1,
      budgetProfile: row.budget_profile || undefined,
      terminalStatus: row.terminal_status || undefined,
      failureClass: row.failure_class || undefined,
      budgetUsage: row.budget_usage
        ? safeJsonParse(row.budget_usage, undefined, "task.budgetUsage")
        : undefined,
    };
  }

  /**
   * Find tasks by parent task ID
   */
  findByParent(parentTaskId: string): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE parent_task_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(parentTaskId) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  // ============ Task Board Methods ============

  /**
   * Find tasks by workspace and board column
   */
  findByBoardColumn(workspaceId: string, boardColumn: string): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ? AND board_column = ?
      ORDER BY priority DESC, created_at ASC
    `);
    const rows = stmt.all(workspaceId, boardColumn) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  /**
   * Get tasks grouped by board column for a workspace
   */
  getTaskBoard(workspaceId: string): Record<string, Task[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ? AND parent_task_id IS NULL
      ORDER BY board_column, priority DESC, created_at ASC
    `);
    const rows = stmt.all(workspaceId) as Any[];
    const tasks = rows.map((row) => this.mapRowToTask(row));

    // Group tasks by board column
    const board: Record<string, Task[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      review: [],
      done: [],
    };

    for (const task of tasks) {
      const column = task.boardColumn || "backlog";
      if (board[column]) {
        board[column].push(task);
      } else {
        board.backlog.push(task);
      }
    }

    return board;
  }

  /**
   * Move a task to a different board column
   */
  moveToColumn(id: string, boardColumn: string): Task | undefined {
    this.update(id, { boardColumn: boardColumn as Any });
    return this.findById(id);
  }

  /**
   * Set task priority
   */
  setPriority(id: string, priority: number): Task | undefined {
    this.update(id, { priority });
    return this.findById(id);
  }

  /**
   * Set task due date
   */
  setDueDate(id: string, dueDate: number | null): Task | undefined {
    this.update(id, { dueDate: dueDate || undefined } as Any);
    return this.findById(id);
  }

  /**
   * Set task time estimate
   */
  setEstimate(id: string, estimatedMinutes: number | null): Task | undefined {
    this.update(id, { estimatedMinutes: estimatedMinutes || undefined } as Any);
    return this.findById(id);
  }

  /**
   * Add a label to a task
   */
  addLabel(id: string, labelId: string): Task | undefined {
    const task = this.findById(id);
    if (!task) return undefined;

    const labels = task.labels || [];
    if (!labels.includes(labelId)) {
      labels.push(labelId);
      this.update(id, { labels } as Any);
    }
    return this.findById(id);
  }

  /**
   * Remove a label from a task
   */
  removeLabel(id: string, labelId: string): Task | undefined {
    const task = this.findById(id);
    if (!task) return undefined;

    const labels = task.labels || [];
    const newLabels = labels.filter((l) => l !== labelId);
    this.update(id, { labels: newLabels } as Any);
    return this.findById(id);
  }

  /**
   * Assign an agent role to a task
   */
  assignAgentRole(id: string, agentRoleId: string | null): Task | undefined {
    this.update(id, { assignedAgentRoleId: agentRoleId || undefined } as Any);
    return this.findById(id);
  }
}

export class TaskEventRepository {
  constructor(private db: Database.Database) {}

  create(event: Omit<TaskEvent, "id">): TaskEvent {
    const newEvent: TaskEvent = {
      ...event,
      id: uuidv4(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO task_events (id, task_id, timestamp, type, payload)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      newEvent.id,
      newEvent.taskId,
      newEvent.timestamp,
      newEvent.type,
      JSON.stringify(newEvent.payload),
    );

    return newEvent;
  }

  findByTaskId(taskId: string): TaskEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM task_events
      WHERE task_id = ?
      ORDER BY timestamp ASC
    `);
    const rows = stmt.all(taskId) as Any[];
    return rows.map((row) => this.mapRowToEvent(row));
  }

  findByTaskIds(taskIds: string[], types?: string[]): TaskEvent[] {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return [];
    }

    const normalizedTaskIds = taskIds
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean);
    if (normalizedTaskIds.length === 0) {
      return [];
    }

    const normalizedTypes = (types || [])
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter(Boolean);

    // Chunk task IDs to stay under SQLite's SQLITE_MAX_VARIABLE_NUMBER (999).
    const CHUNK_SIZE = 500;
    const allRows: Any[] = [];

    for (let i = 0; i < normalizedTaskIds.length; i += CHUNK_SIZE) {
      const chunk = normalizedTaskIds.slice(i, i + CHUNK_SIZE);
      const taskPlaceholders = chunk.map(() => "?").join(", ");
      const args: Any[] = [...chunk];

      let sql = `
        SELECT * FROM task_events
        WHERE task_id IN (${taskPlaceholders})
      `;

      if (normalizedTypes.length > 0) {
        const typePlaceholders = normalizedTypes.map(() => "?").join(", ");
        sql += ` AND type IN (${typePlaceholders})`;
        args.push(...normalizedTypes);
      }

      sql += " ORDER BY task_id ASC, timestamp ASC";

      const stmt = this.db.prepare(sql);
      allRows.push(...(stmt.all(...args) as Any[]));
    }

    return allRows.map((row) => this.mapRowToEvent(row));
  }

  private mapRowToEvent(row: Any): TaskEvent {
    return {
      id: row.id,
      taskId: row.task_id,
      timestamp: row.timestamp,
      type: row.type,
      payload: safeJsonParse(row.payload, {}, "taskEvent.payload"),
    };
  }

  /**
   * Prune old conversation snapshots for a task, keeping only the most recent one.
   * This prevents database bloat from accumulating snapshots over time.
   */
  pruneOldSnapshots(taskId: string): void {
    // Find all conversation_snapshot events for this task, ordered by timestamp descending
    const findStmt = this.db.prepare(`
      SELECT id, timestamp FROM task_events
      WHERE task_id = ? AND type = 'conversation_snapshot'
      ORDER BY timestamp DESC
    `);
    const snapshots = findStmt.all(taskId) as { id: string; timestamp: number }[];

    // Keep only the most recent one, delete the rest
    if (snapshots.length > 1) {
      const idsToDelete = snapshots.slice(1).map((s) => s.id);
      const deleteStmt = this.db.prepare(`
        DELETE FROM task_events WHERE id = ?
      `);

      for (const id of idsToDelete) {
        deleteStmt.run(id);
      }

      console.log(
        `[TaskEventRepository] Pruned ${idsToDelete.length} old snapshot(s) for task ${taskId}`,
      );
    }
  }
}

export class ArtifactRepository {
  constructor(private db: Database.Database) {}

  create(artifact: Omit<Artifact, "id">): Artifact {
    const newArtifact: Artifact = {
      ...artifact,
      id: uuidv4(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO artifacts (id, task_id, path, mime_type, sha256, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newArtifact.id,
      newArtifact.taskId,
      newArtifact.path,
      newArtifact.mimeType,
      newArtifact.sha256,
      newArtifact.size,
      newArtifact.createdAt,
    );

    return newArtifact;
  }

  findByTaskId(taskId: string): Artifact[] {
    const stmt = this.db.prepare(
      "SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC",
    );
    const rows = stmt.all(taskId) as Any[];
    return rows.map((row) => this.mapRowToArtifact(row));
  }

  private mapRowToArtifact(row: Any): Artifact {
    return {
      id: row.id,
      taskId: row.task_id,
      path: row.path,
      mimeType: row.mime_type,
      sha256: row.sha256,
      size: row.size,
      createdAt: row.created_at,
    };
  }
}

export class ApprovalRepository {
  constructor(private db: Database.Database) {}

  create(approval: Omit<ApprovalRequest, "id">): ApprovalRequest {
    const newApproval: ApprovalRequest = {
      ...approval,
      id: uuidv4(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO approvals (id, task_id, type, description, details, status, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newApproval.id,
      newApproval.taskId,
      newApproval.type,
      newApproval.description,
      JSON.stringify(newApproval.details),
      newApproval.status,
      newApproval.requestedAt,
    );

    return newApproval;
  }

  update(id: string, status: "approved" | "denied"): void {
    const stmt = this.db.prepare(`
      UPDATE approvals
      SET status = ?, resolved_at = ?
      WHERE id = ?
    `);
    stmt.run(status, Date.now(), id);
  }

  findPendingByTaskId(taskId: string): ApprovalRequest[] {
    const stmt = this.db.prepare(`
      SELECT * FROM approvals
      WHERE task_id = ? AND status = 'pending'
      ORDER BY requested_at ASC
    `);
    const rows = stmt.all(taskId) as Any[];
    return rows.map((row) => this.mapRowToApproval(row));
  }

  private mapRowToApproval(row: Any): ApprovalRequest {
    return {
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      description: row.description,
      details: safeJsonParse(row.details, {}, "approval.details"),
      status: row.status,
      requestedAt: row.requested_at,
      resolvedAt: row.resolved_at || undefined,
    };
  }
}

export class SkillRepository {
  constructor(private db: Database.Database) {}

  create(skill: Omit<Skill, "id">): Skill {
    const newSkill: Skill = {
      ...skill,
      id: uuidv4(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO skills (id, name, description, category, prompt, script_path, parameters)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newSkill.id,
      newSkill.name,
      newSkill.description,
      newSkill.category,
      newSkill.prompt,
      newSkill.scriptPath || null,
      newSkill.parameters ? JSON.stringify(newSkill.parameters) : null,
    );

    return newSkill;
  }

  findAll(): Skill[] {
    const stmt = this.db.prepare("SELECT * FROM skills ORDER BY name ASC");
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToSkill(row));
  }

  findById(id: string): Skill | undefined {
    const stmt = this.db.prepare("SELECT * FROM skills WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToSkill(row) : undefined;
  }

  private mapRowToSkill(row: Any): Skill {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      prompt: row.prompt,
      scriptPath: row.script_path || undefined,
      parameters: row.parameters
        ? safeJsonParse(row.parameters, undefined, "skill.parameters")
        : undefined,
    };
  }
}

export interface LLMModel {
  id: string;
  key: string;
  displayName: string;
  description: string;
  anthropicModelId: string;
  bedrockModelId: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export class LLMModelRepository {
  constructor(private db: Database.Database) {}

  findAll(): LLMModel[] {
    const stmt = this.db.prepare(`
      SELECT * FROM llm_models
      WHERE is_active = 1
      ORDER BY sort_order ASC
    `);
    const rows = stmt.all() as Any[];
    return rows.map((row) => this.mapRowToModel(row));
  }

  findByKey(key: string): LLMModel | undefined {
    const stmt = this.db.prepare("SELECT * FROM llm_models WHERE key = ?");
    const row = stmt.get(key) as Any;
    return row ? this.mapRowToModel(row) : undefined;
  }

  findById(id: string): LLMModel | undefined {
    const stmt = this.db.prepare("SELECT * FROM llm_models WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToModel(row) : undefined;
  }

  private mapRowToModel(row: Any): LLMModel {
    return {
      id: row.id,
      key: row.key,
      displayName: row.display_name,
      description: row.description,
      anthropicModelId: row.anthropic_model_id,
      bedrockModelId: row.bedrock_model_id,
      sortOrder: row.sort_order,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ============================================================
// Channel Gateway Repositories
// ============================================================

export interface Channel {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  securityConfig: {
    mode: "open" | "allowlist" | "pairing";
    allowedUsers?: string[];
    pairingCodeTTL?: number;
    maxPairingAttempts?: number;
    rateLimitPerMinute?: number;
  };
  status: string;
  botUsername?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelUser {
  id: string;
  channelId: string;
  channelUserId: string;
  displayName: string;
  username?: string;
  allowed: boolean;
  pairingCode?: string;
  pairingAttempts: number;
  pairingExpiresAt?: number;
  /** Separate field for brute-force lockout timestamp (distinct from pairing code expiration) */
  lockoutUntil?: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface ChannelSession {
  id: string;
  channelId: string;
  chatId: string;
  userId?: string;
  taskId?: string;
  workspaceId?: string;
  state: "idle" | "active" | "waiting_approval";
  context?: Record<string, unknown>;
  shellEnabled?: boolean;
  debugMode?: boolean;
  createdAt: number;
  lastActivityAt: number;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  sessionId?: string;
  channelMessageId: string;
  chatId: string;
  userId?: string;
  /**
   * Message direction as recorded by the gateway.
   * - incoming: message received from another user/device
   * - outgoing: message sent by CoWork OS back into the chat
   * - outgoing_user: message sent by the local user (captured from some channels when enabled)
   */
  direction: "incoming" | "outgoing" | "outgoing_user";
  content: string;
  attachments?: Array<{ type: string; url?: string; fileName?: string }>;
  timestamp: number;
}

export class ChannelRepository {
  constructor(private db: Database.Database) {}

  create(channel: Omit<Channel, "id" | "createdAt" | "updatedAt">): Channel {
    const now = Date.now();
    const newChannel: Channel = {
      ...channel,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO channels (id, type, name, enabled, config, security_config, status, bot_username, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newChannel.id,
      newChannel.type,
      newChannel.name,
      newChannel.enabled ? 1 : 0,
      JSON.stringify(newChannel.config),
      JSON.stringify(newChannel.securityConfig),
      newChannel.status,
      newChannel.botUsername || null,
      newChannel.createdAt,
      newChannel.updatedAt,
    );

    return newChannel;
  }

  update(id: string, updates: Partial<Channel>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.config !== undefined) {
      fields.push("config = ?");
      values.push(JSON.stringify(updates.config));
    }
    if (updates.securityConfig !== undefined) {
      fields.push("security_config = ?");
      values.push(JSON.stringify(updates.securityConfig));
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.botUsername !== undefined) {
      fields.push("bot_username = ?");
      values.push(updates.botUsername);
    }

    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    const stmt = this.db.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): Channel | undefined {
    const stmt = this.db.prepare("SELECT * FROM channels WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToChannel(row) : undefined;
  }

  findByType(type: string): Channel | undefined {
    const stmt = this.db.prepare("SELECT * FROM channels WHERE type = ?");
    const row = stmt.get(type) as Record<string, unknown> | undefined;
    return row ? this.mapRowToChannel(row) : undefined;
  }

  findAll(): Channel[] {
    const stmt = this.db.prepare("SELECT * FROM channels ORDER BY created_at ASC");
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToChannel(row));
  }

  findEnabled(): Channel[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channels WHERE enabled = 1 ORDER BY created_at ASC",
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToChannel(row));
  }

  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM channels WHERE id = ?");
    stmt.run(id);
  }

  private mapRowToChannel(row: Record<string, unknown>): Channel {
    const defaultSecurityConfig = { mode: "pairing" as const };
    return {
      id: row.id as string,
      type: row.type as string,
      name: row.name as string,
      enabled: row.enabled === 1,
      config: safeJsonParse(row.config as string, {}, "channel.config"),
      securityConfig: safeJsonParse(
        row.security_config as string,
        defaultSecurityConfig,
        "channel.securityConfig",
      ),
      status: row.status as string,
      botUsername: (row.bot_username as string) || undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

export class ChannelUserRepository {
  constructor(private db: Database.Database) {}

  create(
    user: Omit<ChannelUser, "id" | "createdAt" | "lastSeenAt" | "pairingAttempts">,
  ): ChannelUser {
    const now = Date.now();
    const newUser: ChannelUser = {
      ...user,
      id: uuidv4(),
      pairingAttempts: 0,
      createdAt: now,
      lastSeenAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO channel_users (id, channel_id, channel_user_id, display_name, username, allowed, pairing_code, pairing_attempts, pairing_expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newUser.id,
      newUser.channelId,
      newUser.channelUserId,
      newUser.displayName,
      newUser.username || null,
      newUser.allowed ? 1 : 0,
      newUser.pairingCode || null,
      newUser.pairingAttempts,
      newUser.pairingExpiresAt || null,
      newUser.createdAt,
      newUser.lastSeenAt,
    );

    return newUser;
  }

  update(id: string, updates: Partial<ChannelUser>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.displayName !== undefined) {
      fields.push("display_name = ?");
      values.push(updates.displayName);
    }
    if (updates.username !== undefined) {
      fields.push("username = ?");
      values.push(updates.username);
    }
    if (updates.allowed !== undefined) {
      fields.push("allowed = ?");
      values.push(updates.allowed ? 1 : 0);
    }
    if (updates.pairingCode !== undefined) {
      fields.push("pairing_code = ?");
      values.push(updates.pairingCode);
    }
    if (updates.pairingAttempts !== undefined) {
      fields.push("pairing_attempts = ?");
      values.push(updates.pairingAttempts);
    }
    if (updates.pairingExpiresAt !== undefined) {
      fields.push("pairing_expires_at = ?");
      values.push(updates.pairingExpiresAt);
    }
    if (updates.lockoutUntil !== undefined) {
      fields.push("lockout_until = ?");
      values.push(updates.lockoutUntil);
    }
    if (updates.lastSeenAt !== undefined) {
      fields.push("last_seen_at = ?");
      values.push(updates.lastSeenAt);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE channel_users SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): ChannelUser | undefined {
    const stmt = this.db.prepare("SELECT * FROM channel_users WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToUser(row) : undefined;
  }

  findByChannelUserId(channelId: string, channelUserId: string): ChannelUser | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_users WHERE channel_id = ? AND channel_user_id = ?",
    );
    const row = stmt.get(channelId, channelUserId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToUser(row) : undefined;
  }

  findByChannelId(channelId: string): ChannelUser[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_users WHERE channel_id = ? ORDER BY last_seen_at DESC",
    );
    const rows = stmt.all(channelId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToUser(row));
  }

  findAllowedByChannelId(channelId: string): ChannelUser[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_users WHERE channel_id = ? AND allowed = 1 ORDER BY last_seen_at DESC",
    );
    const rows = stmt.all(channelId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToUser(row));
  }

  deleteByChannelId(channelId: string): void {
    const stmt = this.db.prepare("DELETE FROM channel_users WHERE channel_id = ?");
    stmt.run(channelId);
  }

  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM channel_users WHERE id = ?");
    stmt.run(id);
  }

  /**
   * Delete expired pending pairing entries
   * These are placeholder entries created when generating pairing codes that have expired
   * Returns the number of deleted entries
   */
  deleteExpiredPending(channelId: string): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      DELETE FROM channel_users
      WHERE channel_id = ?
        AND allowed = 0
        AND channel_user_id LIKE 'pending_%'
        AND (
          pairing_expires_at IS NULL
          OR pairing_code IS NULL
          OR pairing_expires_at < ?
        )
    `);
    const result = stmt.run(channelId, now);
    return result.changes;
  }

  /**
   * Delete all pending pairing entries for a channel (valid or expired).
   */
  deletePendingByChannel(channelId: string): number {
    const stmt = this.db.prepare(`
      DELETE FROM channel_users
      WHERE channel_id = ?
        AND allowed = 0
        AND channel_user_id LIKE 'pending_%'
    `);
    const result = stmt.run(channelId);
    return result.changes;
  }

  /**
   * Delete expired or empty pending pairing entries across all channels.
   */
  deleteExpiredPendingAll(): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      DELETE FROM channel_users
      WHERE allowed = 0
        AND channel_user_id LIKE 'pending_%'
        AND (
          pairing_expires_at IS NULL
          OR pairing_code IS NULL
          OR pairing_expires_at < ?
        )
    `);
    const result = stmt.run(now);
    return result.changes;
  }

  findByPairingCode(channelId: string, pairingCode: string): ChannelUser | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_users WHERE channel_id = ? AND UPPER(pairing_code) = UPPER(?)",
    );
    const row = stmt.get(channelId, pairingCode) as Record<string, unknown> | undefined;
    return row ? this.mapRowToUser(row) : undefined;
  }

  private mapRowToUser(row: Record<string, unknown>): ChannelUser {
    return {
      id: row.id as string,
      channelId: row.channel_id as string,
      channelUserId: row.channel_user_id as string,
      displayName: row.display_name as string,
      username: (row.username as string) || undefined,
      allowed: row.allowed === 1,
      pairingCode: (row.pairing_code as string) || undefined,
      pairingAttempts: row.pairing_attempts as number,
      pairingExpiresAt: (row.pairing_expires_at as number) || undefined,
      lockoutUntil: (row.lockout_until as number) || undefined,
      createdAt: row.created_at as number,
      lastSeenAt: row.last_seen_at as number,
    };
  }
}

export class ChannelSessionRepository {
  constructor(private db: Database.Database) {}

  create(session: Omit<ChannelSession, "id" | "createdAt" | "lastActivityAt">): ChannelSession {
    const now = Date.now();
    const newSession: ChannelSession = {
      ...session,
      id: uuidv4(),
      createdAt: now,
      lastActivityAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO channel_sessions (id, channel_id, chat_id, user_id, task_id, workspace_id, state, context, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newSession.id,
      newSession.channelId,
      newSession.chatId,
      newSession.userId || null,
      newSession.taskId || null,
      newSession.workspaceId || null,
      newSession.state,
      newSession.context ? JSON.stringify(newSession.context) : null,
      newSession.createdAt,
      newSession.lastActivityAt,
    );

    return newSession;
  }

  update(id: string, updates: Partial<ChannelSession>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    // Use 'in' check to allow setting fields to null/undefined (clearing them)
    if ("taskId" in updates) {
      fields.push("task_id = ?");
      values.push(updates.taskId ?? null); // Convert undefined to null for SQLite
    }
    if ("workspaceId" in updates) {
      fields.push("workspace_id = ?");
      values.push(updates.workspaceId ?? null);
    }
    if ("state" in updates) {
      fields.push("state = ?");
      values.push(updates.state);
    }
    if ("lastActivityAt" in updates) {
      fields.push("last_activity_at = ?");
      values.push(updates.lastActivityAt);
    }

    // Handle shellEnabled and debugMode by merging into context
    const hasContextUpdate =
      "context" in updates || "shellEnabled" in updates || "debugMode" in updates;
    if (hasContextUpdate) {
      // Load existing session to merge context
      const existing = this.findById(id);
      const existingContext = existing?.context || {};
      const newContext = {
        ...existingContext,
        ...("context" in updates ? updates.context : {}),
        ...("shellEnabled" in updates ? { shellEnabled: updates.shellEnabled } : {}),
        ...("debugMode" in updates ? { debugMode: updates.debugMode } : {}),
      };
      fields.push("context = ?");
      values.push(JSON.stringify(newContext));
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE channel_sessions SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): ChannelSession | undefined {
    const stmt = this.db.prepare("SELECT * FROM channel_sessions WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSession(row) : undefined;
  }

  findByChatId(channelId: string, chatId: string): ChannelSession | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_sessions WHERE channel_id = ? AND chat_id = ? ORDER BY last_activity_at DESC LIMIT 1",
    );
    const row = stmt.get(channelId, chatId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSession(row) : undefined;
  }

  findByTaskId(taskId: string): ChannelSession | undefined {
    const stmt = this.db.prepare("SELECT * FROM channel_sessions WHERE task_id = ?");
    const row = stmt.get(taskId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSession(row) : undefined;
  }

  findActiveByChannelId(channelId: string): ChannelSession[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_sessions WHERE channel_id = ? AND state != 'idle' ORDER BY last_activity_at DESC",
    );
    const rows = stmt.all(channelId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToSession(row));
  }

  deleteIdleOlderThan(cutoffMs: number): number {
    const stmt = this.db.prepare(
      "DELETE FROM channel_sessions WHERE state = 'idle' AND COALESCE(last_activity_at, created_at) < ?",
    );
    const result = stmt.run(cutoffMs);
    return Number(result.changes || 0);
  }

  deleteByChannelId(channelId: string): void {
    const stmt = this.db.prepare("DELETE FROM channel_sessions WHERE channel_id = ?");
    stmt.run(channelId);
  }

  private mapRowToSession(row: Record<string, unknown>): ChannelSession {
    const context = row.context
      ? safeJsonParse(row.context as string, {} as Record<string, unknown>, "session.context")
      : undefined;
    // Extract shellEnabled and debugMode from context
    const shellEnabled = context?.shellEnabled as boolean | undefined;
    const debugMode = context?.debugMode as boolean | undefined;
    return {
      id: row.id as string,
      channelId: row.channel_id as string,
      chatId: row.chat_id as string,
      userId: (row.user_id as string) || undefined,
      taskId: (row.task_id as string) || undefined,
      workspaceId: (row.workspace_id as string) || undefined,
      state: row.state as "idle" | "active" | "waiting_approval",
      context,
      shellEnabled,
      debugMode,
      createdAt: row.created_at as number,
      lastActivityAt: row.last_activity_at as number,
    };
  }
}

export class ChannelMessageRepository {
  constructor(private db: Database.Database) {}

  create(message: Omit<ChannelMessage, "id">): ChannelMessage {
    const newMessage: ChannelMessage = {
      ...message,
      id: uuidv4(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO channel_messages (id, channel_id, session_id, channel_message_id, chat_id, user_id, direction, content, attachments, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newMessage.id,
      newMessage.channelId,
      newMessage.sessionId || null,
      newMessage.channelMessageId,
      newMessage.chatId,
      newMessage.userId || null,
      newMessage.direction,
      newMessage.content,
      newMessage.attachments ? JSON.stringify(newMessage.attachments) : null,
      newMessage.timestamp,
    );

    return newMessage;
  }

  findBySessionId(sessionId: string, limit = 50): ChannelMessage[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?",
    );
    const rows = stmt.all(sessionId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMessage(row)).reverse();
  }

  findByChatId(channelId: string, chatId: string, limit = 50): ChannelMessage[] {
    const stmt = this.db.prepare(
      "SELECT * FROM channel_messages WHERE channel_id = ? AND chat_id = ? ORDER BY timestamp DESC LIMIT ?",
    );
    const rows = stmt.all(channelId, chatId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMessage(row)).reverse();
  }

  deleteByChannelId(channelId: string): void {
    const stmt = this.db.prepare("DELETE FROM channel_messages WHERE channel_id = ?");
    stmt.run(channelId);
  }

  /**
   * Get distinct chat IDs for a channel, ordered by most recent message.
   */
  getDistinctChatIds(
    channelId: string,
    limit = 50,
  ): Array<{ chatId: string; lastTimestamp: number }> {
    const stmt = this.db.prepare(`
      SELECT chat_id, MAX(timestamp) as last_ts
      FROM channel_messages
      WHERE channel_id = ?
      GROUP BY chat_id
      ORDER BY last_ts DESC
      LIMIT ?
    `);
    const rows = stmt.all(channelId, limit) as Array<{ chat_id: string; last_ts: number }>;
    return rows.map((row) => ({ chatId: row.chat_id, lastTimestamp: row.last_ts }));
  }

  private mapRowToMessage(row: Record<string, unknown>): ChannelMessage {
    const directionRaw = String(row.direction ?? "").trim();
    const direction: ChannelMessage["direction"] =
      directionRaw === "outgoing" || directionRaw === "outgoing_user" ? directionRaw : "incoming";

    return {
      id: row.id as string,
      channelId: row.channel_id as string,
      sessionId: (row.session_id as string) || undefined,
      channelMessageId: row.channel_message_id as string,
      chatId: row.chat_id as string,
      userId: (row.user_id as string) || undefined,
      direction,
      content: row.content as string,
      attachments: row.attachments
        ? safeJsonParse(row.attachments as string, undefined, "message.attachments")
        : undefined,
      timestamp: row.timestamp as number,
    };
  }
}

// ============================================================
// Gateway Infrastructure Repositories
// ============================================================

export interface QueuedMessage {
  id: string;
  channelType: string;
  chatId: string;
  message: Record<string, unknown>;
  priority: number;
  status: "pending" | "processing" | "sent" | "failed";
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: number;
  error?: string;
  createdAt: number;
  scheduledAt?: number;
}

export interface ScheduledMessage {
  id: string;
  channelType: string;
  chatId: string;
  message: Record<string, unknown>;
  scheduledAt: number;
  status: "pending" | "sent" | "failed" | "cancelled";
  sentMessageId?: string;
  error?: string;
  createdAt: number;
}

export interface DeliveryRecord {
  id: string;
  channelType: string;
  chatId: string;
  messageId: string;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  sentAt?: number;
  deliveredAt?: number;
  readAt?: number;
  error?: string;
  createdAt: number;
}

export interface RateLimitRecord {
  id: string;
  channelType: string;
  userId: string;
  messageCount: number;
  windowStart: number;
  isLimited: boolean;
  limitExpiresAt?: number;
}

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  action: string;
  channelType?: string;
  userId?: string;
  chatId?: string;
  details?: Record<string, unknown>;
  severity: "debug" | "info" | "warn" | "error";
}

export class MessageQueueRepository {
  constructor(private db: Database.Database) {}

  enqueue(item: Omit<QueuedMessage, "id" | "createdAt" | "attempts" | "status">): QueuedMessage {
    const newItem: QueuedMessage = {
      ...item,
      id: uuidv4(),
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO message_queue (id, channel_type, chat_id, message, priority, status, attempts, max_attempts, last_attempt_at, error, created_at, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newItem.id,
      newItem.channelType,
      newItem.chatId,
      JSON.stringify(newItem.message),
      newItem.priority,
      newItem.status,
      newItem.attempts,
      newItem.maxAttempts,
      newItem.lastAttemptAt || null,
      newItem.error || null,
      newItem.createdAt,
      newItem.scheduledAt || null,
    );

    return newItem;
  }

  update(id: string, updates: Partial<QueuedMessage>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.attempts !== undefined) {
      fields.push("attempts = ?");
      values.push(updates.attempts);
    }
    if (updates.lastAttemptAt !== undefined) {
      fields.push("last_attempt_at = ?");
      values.push(updates.lastAttemptAt);
    }
    if (updates.error !== undefined) {
      fields.push("error = ?");
      values.push(updates.error);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE message_queue SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findPending(limit = 50): QueuedMessage[] {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT * FROM message_queue
      WHERE status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?)
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(now, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  findById(id: string): QueuedMessage | undefined {
    const stmt = this.db.prepare("SELECT * FROM message_queue WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToItem(row) : undefined;
  }

  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM message_queue WHERE id = ?");
    stmt.run(id);
  }

  deleteOld(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const stmt = this.db.prepare(
      "DELETE FROM message_queue WHERE status IN ('sent', 'failed') AND created_at < ?",
    );
    const result = stmt.run(cutoff);
    return result.changes;
  }

  private mapRowToItem(row: Record<string, unknown>): QueuedMessage {
    return {
      id: row.id as string,
      channelType: row.channel_type as string,
      chatId: row.chat_id as string,
      message: safeJsonParse(row.message as string, {}, "queue.message"),
      priority: row.priority as number,
      status: row.status as QueuedMessage["status"],
      attempts: row.attempts as number,
      maxAttempts: row.max_attempts as number,
      lastAttemptAt: (row.last_attempt_at as number) || undefined,
      error: (row.error as string) || undefined,
      createdAt: row.created_at as number,
      scheduledAt: (row.scheduled_at as number) || undefined,
    };
  }
}

export class ScheduledMessageRepository {
  constructor(private db: Database.Database) {}

  create(item: Omit<ScheduledMessage, "id" | "createdAt" | "status">): ScheduledMessage {
    const newItem: ScheduledMessage = {
      ...item,
      id: uuidv4(),
      status: "pending",
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO scheduled_messages (id, channel_type, chat_id, message, scheduled_at, status, sent_message_id, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newItem.id,
      newItem.channelType,
      newItem.chatId,
      JSON.stringify(newItem.message),
      newItem.scheduledAt,
      newItem.status,
      newItem.sentMessageId || null,
      newItem.error || null,
      newItem.createdAt,
    );

    return newItem;
  }

  update(id: string, updates: Partial<ScheduledMessage>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.sentMessageId !== undefined) {
      fields.push("sent_message_id = ?");
      values.push(updates.sentMessageId);
    }
    if (updates.error !== undefined) {
      fields.push("error = ?");
      values.push(updates.error);
    }
    if (updates.scheduledAt !== undefined) {
      fields.push("scheduled_at = ?");
      values.push(updates.scheduledAt);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE scheduled_messages SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findDue(limit = 50): ScheduledMessage[] {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_messages
      WHERE status = 'pending' AND scheduled_at <= ?
      ORDER BY scheduled_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(now, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  findById(id: string): ScheduledMessage | undefined {
    const stmt = this.db.prepare("SELECT * FROM scheduled_messages WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToItem(row) : undefined;
  }

  findByChatId(channelType: string, chatId: string): ScheduledMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_messages
      WHERE channel_type = ? AND chat_id = ? AND status = 'pending'
      ORDER BY scheduled_at ASC
    `);
    const rows = stmt.all(channelType, chatId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  cancel(id: string): void {
    const stmt = this.db.prepare(
      "UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
    );
    stmt.run(id);
  }

  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM scheduled_messages WHERE id = ?");
    stmt.run(id);
  }

  private mapRowToItem(row: Record<string, unknown>): ScheduledMessage {
    return {
      id: row.id as string,
      channelType: row.channel_type as string,
      chatId: row.chat_id as string,
      message: safeJsonParse(row.message as string, {}, "scheduled.message"),
      scheduledAt: row.scheduled_at as number,
      status: row.status as ScheduledMessage["status"],
      sentMessageId: (row.sent_message_id as string) || undefined,
      error: (row.error as string) || undefined,
      createdAt: row.created_at as number,
    };
  }
}

export class DeliveryTrackingRepository {
  constructor(private db: Database.Database) {}

  create(item: Omit<DeliveryRecord, "id" | "createdAt">): DeliveryRecord {
    const newItem: DeliveryRecord = {
      ...item,
      id: uuidv4(),
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO delivery_tracking (id, channel_type, chat_id, message_id, status, sent_at, delivered_at, read_at, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newItem.id,
      newItem.channelType,
      newItem.chatId,
      newItem.messageId,
      newItem.status,
      newItem.sentAt || null,
      newItem.deliveredAt || null,
      newItem.readAt || null,
      newItem.error || null,
      newItem.createdAt,
    );

    return newItem;
  }

  update(id: string, updates: Partial<DeliveryRecord>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.sentAt !== undefined) {
      fields.push("sent_at = ?");
      values.push(updates.sentAt);
    }
    if (updates.deliveredAt !== undefined) {
      fields.push("delivered_at = ?");
      values.push(updates.deliveredAt);
    }
    if (updates.readAt !== undefined) {
      fields.push("read_at = ?");
      values.push(updates.readAt);
    }
    if (updates.error !== undefined) {
      fields.push("error = ?");
      values.push(updates.error);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE delivery_tracking SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findByMessageId(messageId: string): DeliveryRecord | undefined {
    const stmt = this.db.prepare("SELECT * FROM delivery_tracking WHERE message_id = ?");
    const row = stmt.get(messageId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToItem(row) : undefined;
  }

  findByChatId(channelType: string, chatId: string, limit = 50): DeliveryRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM delivery_tracking
      WHERE channel_type = ? AND chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(channelType, chatId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  deleteOld(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const stmt = this.db.prepare("DELETE FROM delivery_tracking WHERE created_at < ?");
    const result = stmt.run(cutoff);
    return result.changes;
  }

  private mapRowToItem(row: Record<string, unknown>): DeliveryRecord {
    return {
      id: row.id as string,
      channelType: row.channel_type as string,
      chatId: row.chat_id as string,
      messageId: row.message_id as string,
      status: row.status as DeliveryRecord["status"],
      sentAt: (row.sent_at as number) || undefined,
      deliveredAt: (row.delivered_at as number) || undefined,
      readAt: (row.read_at as number) || undefined,
      error: (row.error as string) || undefined,
      createdAt: row.created_at as number,
    };
  }
}

export class RateLimitRepository {
  constructor(private db: Database.Database) {}

  getOrCreate(channelType: string, userId: string): RateLimitRecord {
    const stmt = this.db.prepare(
      "SELECT * FROM rate_limits WHERE channel_type = ? AND user_id = ?",
    );
    const row = stmt.get(channelType, userId) as Record<string, unknown> | undefined;

    if (row) {
      return this.mapRowToItem(row);
    }

    // Create new record
    const newItem: RateLimitRecord = {
      id: uuidv4(),
      channelType,
      userId,
      messageCount: 0,
      windowStart: Date.now(),
      isLimited: false,
    };

    const insertStmt = this.db.prepare(`
      INSERT INTO rate_limits (id, channel_type, user_id, message_count, window_start, is_limited, limit_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      newItem.id,
      newItem.channelType,
      newItem.userId,
      newItem.messageCount,
      newItem.windowStart,
      newItem.isLimited ? 1 : 0,
      newItem.limitExpiresAt || null,
    );

    return newItem;
  }

  update(channelType: string, userId: string, updates: Partial<RateLimitRecord>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.messageCount !== undefined) {
      fields.push("message_count = ?");
      values.push(updates.messageCount);
    }
    if (updates.windowStart !== undefined) {
      fields.push("window_start = ?");
      values.push(updates.windowStart);
    }
    if (updates.isLimited !== undefined) {
      fields.push("is_limited = ?");
      values.push(updates.isLimited ? 1 : 0);
    }
    if (updates.limitExpiresAt !== undefined) {
      fields.push("limit_expires_at = ?");
      values.push(updates.limitExpiresAt);
    }

    if (fields.length === 0) return;

    values.push(channelType, userId);
    const stmt = this.db.prepare(
      `UPDATE rate_limits SET ${fields.join(", ")} WHERE channel_type = ? AND user_id = ?`,
    );
    stmt.run(...values);
  }

  resetWindow(channelType: string, userId: string): void {
    const stmt = this.db.prepare(`
      UPDATE rate_limits
      SET message_count = 0, window_start = ?, is_limited = 0, limit_expires_at = NULL
      WHERE channel_type = ? AND user_id = ?
    `);
    stmt.run(Date.now(), channelType, userId);
  }

  private mapRowToItem(row: Record<string, unknown>): RateLimitRecord {
    return {
      id: row.id as string,
      channelType: row.channel_type as string,
      userId: row.user_id as string,
      messageCount: row.message_count as number,
      windowStart: row.window_start as number,
      isLimited: row.is_limited === 1,
      limitExpiresAt: (row.limit_expires_at as number) || undefined,
    };
  }
}

export class AuditLogRepository {
  constructor(private db: Database.Database) {}

  log(entry: Omit<AuditLogEntry, "id" | "timestamp">): AuditLogEntry {
    const newEntry: AuditLogEntry = {
      ...entry,
      id: uuidv4(),
      timestamp: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO audit_log (id, timestamp, action, channel_type, user_id, chat_id, details, severity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newEntry.id,
      newEntry.timestamp,
      newEntry.action,
      newEntry.channelType || null,
      newEntry.userId || null,
      newEntry.chatId || null,
      newEntry.details ? JSON.stringify(newEntry.details) : null,
      newEntry.severity,
    );

    return newEntry;
  }

  find(options: {
    action?: string;
    channelType?: string;
    userId?: string;
    chatId?: string;
    fromTimestamp?: number;
    toTimestamp?: number;
    severity?: AuditLogEntry["severity"];
    limit?: number;
    offset?: number;
  }): AuditLogEntry[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (options.action) {
      conditions.push("action = ?");
      values.push(options.action);
    }
    if (options.channelType) {
      conditions.push("channel_type = ?");
      values.push(options.channelType);
    }
    if (options.userId) {
      conditions.push("user_id = ?");
      values.push(options.userId);
    }
    if (options.chatId) {
      conditions.push("chat_id = ?");
      values.push(options.chatId);
    }
    if (options.fromTimestamp) {
      conditions.push("timestamp >= ?");
      values.push(options.fromTimestamp);
    }
    if (options.toTimestamp) {
      conditions.push("timestamp <= ?");
      values.push(options.toTimestamp);
    }
    if (options.severity) {
      conditions.push("severity = ?");
      values.push(options.severity);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const stmt = this.db.prepare(`
      SELECT * FROM audit_log
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);

    values.push(limit, offset);
    const rows = stmt.all(...values) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToEntry(row));
  }

  deleteOld(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const stmt = this.db.prepare("DELETE FROM audit_log WHERE timestamp < ?");
    const result = stmt.run(cutoff);
    return result.changes;
  }

  private mapRowToEntry(row: Record<string, unknown>): AuditLogEntry {
    return {
      id: row.id as string,
      timestamp: row.timestamp as number,
      action: row.action as string,
      channelType: (row.channel_type as string) || undefined,
      userId: (row.user_id as string) || undefined,
      chatId: (row.chat_id as string) || undefined,
      details: row.details
        ? safeJsonParse(row.details as string, undefined, "audit.details")
        : undefined,
      severity: row.severity as AuditLogEntry["severity"],
    };
  }
}

// ============================================================
// Memory System Repositories
// ============================================================

export type MemoryType = "observation" | "decision" | "error" | "insight" | "summary";
export type PrivacyMode = "normal" | "strict" | "disabled";
export type TimePeriod = "hourly" | "daily" | "weekly";

export interface Memory {
  id: string;
  workspaceId: string;
  taskId?: string;
  type: MemoryType;
  content: string;
  summary?: string;
  tokens: number;
  isCompressed: boolean;
  isPrivate: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySummary {
  id: string;
  workspaceId: string;
  timePeriod: TimePeriod;
  periodStart: number;
  periodEnd: number;
  summary: string;
  memoryIds: string[];
  tokens: number;
  createdAt: number;
}

export interface MemorySettings {
  workspaceId: string;
  enabled: boolean;
  autoCapture: boolean;
  compressionEnabled: boolean;
  retentionDays: number;
  maxStorageMb: number;
  privacyMode: PrivacyMode;
  excludedPatterns?: string[];
}

export type MemorySearchResult =
  | {
      id: string;
      snippet: string;
      type: MemoryType;
      relevanceScore: number;
      createdAt: number;
      taskId?: string;
      /** Origin of this search result (database memory vs markdown kit index). */
      source: "db";
    }
  | {
      id: string;
      snippet: string;
      type: MemoryType;
      relevanceScore: number;
      createdAt: number;
      taskId?: string;
      /** Origin of this search result (database memory vs markdown kit index). */
      source: "markdown";
      /** File path for markdown-backed results (workspace-relative). */
      path: string;
      /** Start line (1-based) for markdown-backed results. */
      startLine: number;
      /** End line (1-based) for markdown-backed results. */
      endLine: number;
    };

export interface MemoryEmbedding {
  memoryId: string;
  workspaceId: string;
  embedding: number[];
  updatedAt: number;
}

export interface MemoryTimelineEntry {
  id: string;
  content: string;
  type: MemoryType;
  createdAt: number;
  taskId?: string;
}

export interface MemoryStats {
  count: number;
  totalTokens: number;
  compressedCount: number;
  compressionRatio: number;
}

export class MemoryRepository {
  constructor(private db: Database.Database) {}

  // Keep this small and local: we want memory search to be robust against
  // natural-language queries (punctuation, filler words) without pulling in
  // other modules and risking circular deps.
  private static readonly MEMORY_SEARCH_STOP_WORDS = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "but",
    "if",
    "then",
    "else",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "by",
    "as",
    "at",
    "from",
    "into",
    "about",
    "that",
    "this",
    "it",
    "its",
    "we",
    "you",
    "they",
    "i",
    "he",
    "she",
    "them",
    "our",
    "your",
    "my",
    "me",
    "us",
    "do",
    "does",
    "did",
    "done",
    "can",
    "could",
    "should",
    "would",
    "will",
    "shall",
    "may",
    "might",
    "not",
    "no",
    "yes",
    "please",
    "help",
  ]);

  create(memory: Omit<Memory, "id" | "createdAt" | "updatedAt">): Memory {
    const now = Date.now();
    const newMemory: Memory = {
      ...memory,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO memories (id, workspace_id, task_id, type, content, summary, tokens, is_compressed, is_private, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newMemory.id,
      newMemory.workspaceId,
      newMemory.taskId || null,
      newMemory.type,
      newMemory.content,
      newMemory.summary || null,
      newMemory.tokens,
      newMemory.isCompressed ? 1 : 0,
      newMemory.isPrivate ? 1 : 0,
      newMemory.createdAt,
      newMemory.updatedAt,
    );

    return newMemory;
  }

  update(id: string, updates: Partial<Pick<Memory, "summary" | "tokens" | "isCompressed">>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.summary !== undefined) {
      fields.push("summary = ?");
      values.push(updates.summary);
    }
    if (updates.tokens !== undefined) {
      fields.push("tokens = ?");
      values.push(updates.tokens);
    }
    if (updates.isCompressed !== undefined) {
      fields.push("is_compressed = ?");
      values.push(updates.isCompressed ? 1 : 0);
    }

    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    const stmt = this.db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): Memory | undefined {
    const stmt = this.db.prepare("SELECT * FROM memories WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToMemory(row) : undefined;
  }

  findByIds(ids: string[]): Memory[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`);
    const rows = stmt.all(...ids) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * Layer 1: Search returns IDs + brief snippets (~50 tokens each)
   * Uses FTS5 for full-text search with relevance ranking
   */
  search(
    workspaceId: string,
    query: string,
    limit = 20,
    includePrivate = false,
  ): MemorySearchResult[] {
    const privacyFilter = includePrivate ? "" : "AND m.is_private = 0";
    try {
      // Try FTS5 search first.
      //
      // FTS5 uses a query language where whitespace implies AND. That is often
      // too strict for natural language prompts (lots of filler words), and
      // punctuation can also produce syntax errors. We therefore:
      // 1) try raw query
      // 2) if empty or error, retry with a relaxed OR query over key tokens
      const stmt = this.db.prepare(`
        SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id,
               bm25(memories_fts) as score
        FROM memories_fts f
        JOIN memories m ON f.rowid = m.rowid
        WHERE memories_fts MATCH ? AND m.workspace_id = ? ${privacyFilter}
        ORDER BY score
        LIMIT ?
      `);

      const raw = (query || "").trim();
      if (!raw) return [];
      const tokenized = this.buildRelaxedFtsQuery(raw);

      const mapRows = (rows: Record<string, unknown>[]) =>
        rows.map((row) => ({
          id: row.id as string,
          snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
          type: row.type as MemoryType,
          relevanceScore: Math.abs(row.score as number),
          createdAt: row.created_at as number,
          taskId: (row.task_id as string) || undefined,
          source: "db" as const,
        }));

      let rows: Record<string, unknown>[] = [];
      try {
        rows = stmt.all(raw, workspaceId, limit) as Record<string, unknown>[];
      } catch  {
        // Raw query may be invalid FTS syntax; retry below with tokenized query.
        rows = [];
      }

      // If raw query was too strict (common) or failed, retry with relaxed query.
      if (rows.length === 0 && tokenized) {
        try {
          rows = stmt.all(tokenized, workspaceId, limit) as Record<string, unknown>[];
        } catch {
          // Ignore; we'll fall back to LIKE below.
          rows = [];
        }
      }

      if (rows.length > 0) {
        return mapRows(rows);
      }
    } catch {
      // Fall back to LIKE search if FTS5 is not available
      const fallbackPrivacyFilter = includePrivate ? "" : "AND is_private = 0";
      const raw = (query || "").trim();
      const tokens = this.tokenizeSearchQuery(raw);
      const likeTokens = (tokens.length > 0 ? tokens : [raw]).slice(0, 8).filter(Boolean);

      // Build an OR LIKE query over a small token set for recall.
      const clauses: string[] = [];
      const params: unknown[] = [workspaceId];
      for (const token of likeTokens) {
        clauses.push("(content LIKE ? OR summary LIKE ?)");
        const like = `%${token}%`;
        params.push(like, like);
      }

      const where = clauses.length > 0 ? `AND (${clauses.join(" OR ")})` : "";
      const stmt = this.db.prepare(`
        SELECT id, summary, content, type, created_at, task_id
        FROM memories
        WHERE workspace_id = ? ${fallbackPrivacyFilter}
          ${where}
        ORDER BY created_at DESC
        LIMIT ?
      `);

      params.push(limit);
      const rows = stmt.all(...params) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: row.id as string,
        snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
        type: row.type as MemoryType,
        relevanceScore: 1,
        createdAt: row.created_at as number,
        taskId: (row.task_id as string) || undefined,
        source: "db" as const,
      }));
    }

    return [];
  }

  /**
   * Search imported ChatGPT memories across ALL workspaces.
   * This is intentionally global so sessions from any workspace can retrieve imported history.
   */
  searchImportedGlobal(query: string, limit = 20, includePrivate = false): MemorySearchResult[] {
    const privacyFilter = includePrivate ? "" : "AND m.is_private = 0";
    try {
      const stmt = this.db.prepare(`
        SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id,
               bm25(memories_fts) as score
        FROM memories_fts f
        JOIN memories m ON f.rowid = m.rowid
        WHERE memories_fts MATCH ?
          AND m.content LIKE '[Imported from ChatGPT %'
          ${privacyFilter}
        ORDER BY score
        LIMIT ?
      `);

      const raw = (query || "").trim();
      if (!raw) return [];
      const tokenized = this.buildRelaxedFtsQuery(raw);

      let rows: Record<string, unknown>[] = [];
      try {
        rows = stmt.all(raw, limit) as Record<string, unknown>[];
      } catch {
        rows = [];
      }

      if (rows.length === 0 && tokenized) {
        try {
          rows = stmt.all(tokenized, limit) as Record<string, unknown>[];
        } catch {
          rows = [];
        }
      }

      if (rows.length > 0) {
        return rows.map((row) => ({
          id: row.id as string,
          snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
          type: row.type as MemoryType,
          relevanceScore: Math.abs(row.score as number),
          createdAt: row.created_at as number,
          taskId: (row.task_id as string) || undefined,
          source: "db" as const,
        }));
      }
    } catch {
      // ignore and fall back below
    }

    // LIKE fallback (global)
    const raw = (query || "").trim();
    if (!raw) return [];
    const tokens = this.tokenizeSearchQuery(raw);
    const likeTokens = (tokens.length > 0 ? tokens : [raw]).slice(0, 8).filter(Boolean);

    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const token of likeTokens) {
      clauses.push("(m.content LIKE ? OR m.summary LIKE ?)");
      const like = `%${token}%`;
      params.push(like, like);
    }

    const where = clauses.length > 0 ? `AND (${clauses.join(" OR ")})` : "";
    const stmt = this.db.prepare(`
      SELECT m.id, m.summary, m.content, m.type, m.created_at, m.task_id
      FROM memories m
      WHERE m.content LIKE '[Imported from ChatGPT %'
        ${includePrivate ? "" : "AND m.is_private = 0"}
        ${where}
      ORDER BY m.created_at DESC
      LIMIT ?
    `);

    params.push(limit);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      snippet: (row.summary as string) || this.truncateToSnippet(row.content as string, 200),
      type: row.type as MemoryType,
      relevanceScore: 1,
      createdAt: row.created_at as number,
      taskId: (row.task_id as string) || undefined,
      source: "db" as const,
    }));
  }

  /**
   * Layer 2: Get timeline context around a specific memory
   * Returns surrounding memories within a time window
   */
  getTimelineContext(memoryId: string, windowSize = 5): MemoryTimelineEntry[] {
    const memory = this.findById(memoryId);
    if (!memory) return [];

    const stmt = this.db.prepare(`
      SELECT id, content, type, created_at, task_id
      FROM memories
      WHERE workspace_id = ?
        AND created_at BETWEEN ? AND ?
      ORDER BY created_at ASC
      LIMIT ?
    `);

    const timeWindow = 30 * 60 * 1000; // 30 minutes
    const rows = stmt.all(
      memory.workspaceId,
      memory.createdAt - timeWindow,
      memory.createdAt + timeWindow,
      windowSize * 2 + 1,
    ) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      type: row.type as MemoryType,
      createdAt: row.created_at as number,
      taskId: (row.task_id as string) || undefined,
    }));
  }

  /**
   * Layer 3: Get full details for selected IDs
   * Only called for specific memories when full content is needed
   */
  getFullDetails(ids: string[]): Memory[] {
    return this.findByIds(ids);
  }

  /**
   * Get recent memories for context injection
   */
  getRecentForWorkspace(workspaceId: string, limit = 10, includePrivate = false): Memory[] {
    const privacyFilter = includePrivate ? "" : "AND is_private = 0";
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE workspace_id = ? ${privacyFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(workspaceId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  getRecentImportedGlobal(limit = 20, includePrivate = false): Memory[] {
    const privacyFilter = includePrivate ? "" : "AND is_private = 0";
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE content LIKE '[Imported from ChatGPT %' ${privacyFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * Get uncompressed memories for batch compression
   */
  getUncompressed(limit = 50): Memory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE is_compressed = 0 AND summary IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * List workspace IDs that currently have at least one memory.
   */
  listWorkspaceIds(limit = 5000): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT workspace_id
      FROM memories
      ORDER BY workspace_id ASC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<{ workspace_id: string }>;
    return rows
      .map((row) => row.workspace_id)
      .filter((id) => typeof id === "string" && id.length > 0);
  }

  /**
   * Approximate storage in bytes (UTF-8 length proxy via SQLite length()).
   */
  getApproxStorageBytes(workspaceId: string): number {
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(length(content) + COALESCE(length(summary), 0)), 0) as total_bytes
      FROM memories
      WHERE workspace_id = ?
    `);
    const row = stmt.get(workspaceId) as { total_bytes?: number } | undefined;
    const total = Number(row?.total_bytes || 0);
    return Number.isFinite(total) ? total : 0;
  }

  /**
   * Get oldest memories first, including approximate row bytes for cleanup decisions.
   */
  getOldestForWorkspace(
    workspaceId: string,
    limit = 200,
  ): Array<{ id: string; createdAt: number; approxBytes: number }> {
    const stmt = this.db.prepare(`
      SELECT id, created_at, (length(content) + COALESCE(length(summary), 0)) as approx_bytes
      FROM memories
      WHERE workspace_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(workspaceId, limit) as Array<{
      id: string;
      created_at: number;
      approx_bytes: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      approxBytes: Number.isFinite(row.approx_bytes) ? row.approx_bytes : 0,
    }));
  }

  /**
   * Delete a specific set of memory IDs from a workspace.
   */
  deleteByIds(workspaceId: string, ids: string[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      DELETE FROM memories
      WHERE workspace_id = ? AND id IN (${placeholders})
    `);
    const result = stmt.run(workspaceId, ...ids);
    return result.changes;
  }

  /**
   * Find memories by workspace
   */
  findByWorkspace(workspaceId: string, limit = 100, offset = 0): Memory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(workspaceId, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * Find memories by task
   */
  findByTask(taskId: string): Memory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE task_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(taskId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * Cleanup old memories based on retention policy
   */
  deleteOlderThan(workspaceId: string, cutoffTimestamp: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM memories
      WHERE workspace_id = ? AND created_at < ?
    `);
    const result = stmt.run(workspaceId, cutoffTimestamp);
    return result.changes;
  }

  /**
   * Delete all memories for a workspace
   */
  deleteByWorkspace(workspaceId: string): number {
    const stmt = this.db.prepare("DELETE FROM memories WHERE workspace_id = ?");
    const result = stmt.run(workspaceId);
    return result.changes;
  }

  /**
   * Get storage statistics for a workspace
   */
  getStats(workspaceId: string): MemoryStats {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count,
             COALESCE(SUM(tokens), 0) as total_tokens,
             SUM(CASE WHEN is_compressed = 1 THEN 1 ELSE 0 END) as compressed_count
      FROM memories
      WHERE workspace_id = ?
    `);
    const row = stmt.get(workspaceId) as Record<string, unknown>;
    const count = row.count as number;
    const compressedCount = row.compressed_count as number;
    return {
      count,
      totalTokens: row.total_tokens as number,
      compressedCount,
      compressionRatio: count > 0 ? compressedCount / count : 0,
    };
  }

  /**
   * Get statistics for imported ChatGPT memories
   */
  getImportedStats(workspaceId: string): { count: number; totalTokens: number } {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(tokens), 0) as total_tokens
      FROM memories
      WHERE workspace_id = ? AND content LIKE '[Imported from ChatGPT %'
    `);
    const row = stmt.get(workspaceId) as Record<string, unknown>;
    return {
      count: row.count as number,
      totalTokens: row.total_tokens as number,
    };
  }

  /**
   * Find imported ChatGPT memories with pagination
   */
  findImported(workspaceId: string, limit = 50, offset = 0): Memory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE workspace_id = ? AND content LIKE '[Imported from ChatGPT %'
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(workspaceId, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToMemory(row));
  }

  /**
   * Delete all imported ChatGPT memories for a workspace
   */
  deleteImported(workspaceId: string): number {
    const stmt = this.db.prepare(
      `DELETE FROM memories WHERE workspace_id = ? AND content LIKE '[Imported from ChatGPT %'`,
    );
    const result = stmt.run(workspaceId);
    return result.changes;
  }

  private truncateToSnippet(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars - 3) + "...";
  }

  private tokenizeSearchQuery(raw: string): string[] {
    return (raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1 && !MemoryRepository.MEMORY_SEARCH_STOP_WORDS.has(t));
  }

  private buildRelaxedFtsQuery(raw: string): string | null {
    const tokens = this.tokenizeSearchQuery(raw).slice(0, 8);
    if (tokens.length === 0) return null;

    // Quote tokens to avoid them being interpreted as query operators.
    // Use OR to improve recall for long natural-language prompts.
    const parts = tokens.map((t) => `"${t.replace(/"/g, "")}"`);
    return parts.join(" OR ");
  }

  private mapRowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      taskId: (row.task_id as string) || undefined,
      type: row.type as MemoryType,
      content: row.content as string,
      summary: (row.summary as string) || undefined,
      tokens: row.tokens as number,
      isCompressed: row.is_compressed === 1,
      isPrivate: row.is_private === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

export class MemoryEmbeddingRepository {
  constructor(private db: Database.Database) {}

  upsert(workspaceId: string, memoryId: string, embedding: number[], updatedAt = Date.now()): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
    `);
    stmt.run(memoryId, workspaceId, JSON.stringify(embedding), updatedAt);
  }

  getByWorkspace(workspaceId: string): MemoryEmbedding[] {
    const stmt = this.db.prepare(`
      SELECT memory_id, workspace_id, embedding, updated_at
      FROM memory_embeddings
      WHERE workspace_id = ?
    `);
    const rows = stmt.all(workspaceId) as Array<{
      memory_id: string;
      workspace_id: string;
      embedding: string;
      updated_at: number;
    }>;

    const results: MemoryEmbedding[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.embedding) as number[];
        if (!Array.isArray(parsed)) continue;
        results.push({
          memoryId: row.memory_id,
          workspaceId: row.workspace_id,
          embedding: parsed,
          updatedAt: row.updated_at,
        });
      } catch {
        // ignore malformed row
      }
    }
    return results;
  }

  getStats(workspaceId: string): { count: number } {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM memory_embeddings
      WHERE workspace_id = ?
    `);
    const row = stmt.get(workspaceId) as Record<string, unknown>;
    return { count: row.count as number };
  }

  /**
   * Find memories that are missing embeddings or have stale embeddings.
   * Ordered by most-recently-updated first so results improve quickly.
   */
  findMissingOrStale(
    workspaceId: string,
    limit = 500,
  ): Array<{ memoryId: string; updatedAt: number; content: string; summary?: string }> {
    const stmt = this.db.prepare(`
      SELECT m.id as memory_id, m.updated_at, m.content, m.summary, e.updated_at as emb_updated_at
      FROM memories m
      LEFT JOIN memory_embeddings e ON e.memory_id = m.id
      WHERE m.workspace_id = ?
        AND (e.memory_id IS NULL OR e.updated_at < m.updated_at)
      ORDER BY m.updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(workspaceId, limit) as Array<{
      memory_id: string;
      updated_at: number;
      content: string;
      summary: string | null;
      emb_updated_at: number | null;
    }>;
    return rows.map((r) => ({
      memoryId: r.memory_id,
      updatedAt: r.updated_at,
      content: r.content,
      summary: r.summary || undefined,
    }));
  }

  getImportedGlobal(limit = 5000, offset = 0): Array<MemoryEmbedding & { workspaceId: string }> {
    const stmt = this.db.prepare(`
      SELECT e.memory_id, e.workspace_id, e.embedding, e.updated_at
      FROM memory_embeddings e
      JOIN memories m ON m.id = e.memory_id
      WHERE m.content LIKE '[Imported from ChatGPT %'
      ORDER BY e.updated_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(limit, offset) as Array<{
      memory_id: string;
      workspace_id: string;
      embedding: string;
      updated_at: number;
    }>;

    const results: Array<MemoryEmbedding & { workspaceId: string }> = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.embedding) as number[];
        if (!Array.isArray(parsed)) continue;
        results.push({
          memoryId: row.memory_id,
          workspaceId: row.workspace_id,
          embedding: parsed,
          updatedAt: row.updated_at,
        });
      } catch {
        // ignore
      }
    }
    return results;
  }

  findMissingOrStaleImportedGlobal(limit = 500): Array<{
    memoryId: string;
    workspaceId: string;
    updatedAt: number;
    content: string;
    summary?: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT m.id as memory_id, m.workspace_id, m.updated_at, m.content, m.summary, e.updated_at as emb_updated_at
      FROM memories m
      LEFT JOIN memory_embeddings e ON e.memory_id = m.id
      WHERE m.content LIKE '[Imported from ChatGPT %'
        AND (e.memory_id IS NULL OR e.updated_at < m.updated_at)
      ORDER BY m.updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<{
      memory_id: string;
      workspace_id: string;
      updated_at: number;
      content: string;
      summary: string | null;
      emb_updated_at: number | null;
    }>;
    return rows.map((r) => ({
      memoryId: r.memory_id,
      workspaceId: r.workspace_id,
      updatedAt: r.updated_at,
      content: r.content,
      summary: r.summary || undefined,
    }));
  }

  deleteByWorkspace(workspaceId: string): number {
    const stmt = this.db.prepare("DELETE FROM memory_embeddings WHERE workspace_id = ?");
    const result = stmt.run(workspaceId);
    return result.changes;
  }

  deleteByMemoryIds(ids: string[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      DELETE FROM memory_embeddings
      WHERE memory_id IN (${placeholders})
    `);
    const result = stmt.run(...ids);
    return result.changes;
  }

  deleteImported(workspaceId: string): number {
    // Must be called before deleting imported memories from the memories table.
    const stmt = this.db.prepare(`
      DELETE FROM memory_embeddings
      WHERE workspace_id = ?
        AND memory_id IN (
          SELECT id FROM memories
          WHERE workspace_id = ? AND content LIKE '[Imported from ChatGPT %'
        )
    `);
    const result = stmt.run(workspaceId, workspaceId);
    return result.changes;
  }
}

export class MemorySummaryRepository {
  constructor(private db: Database.Database) {}

  create(summary: Omit<MemorySummary, "id" | "createdAt">): MemorySummary {
    const newSummary: MemorySummary = {
      ...summary,
      id: uuidv4(),
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO memory_summaries (id, workspace_id, time_period, period_start, period_end, summary, memory_ids, tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newSummary.id,
      newSummary.workspaceId,
      newSummary.timePeriod,
      newSummary.periodStart,
      newSummary.periodEnd,
      newSummary.summary,
      JSON.stringify(newSummary.memoryIds),
      newSummary.tokens,
      newSummary.createdAt,
    );

    return newSummary;
  }

  findByWorkspaceAndPeriod(
    workspaceId: string,
    timePeriod: TimePeriod,
    limit = 10,
  ): MemorySummary[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_summaries
      WHERE workspace_id = ? AND time_period = ?
      ORDER BY period_start DESC
      LIMIT ?
    `);
    const rows = stmt.all(workspaceId, timePeriod, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToSummary(row));
  }

  findByWorkspace(workspaceId: string, limit = 50): MemorySummary[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_summaries
      WHERE workspace_id = ?
      ORDER BY period_start DESC
      LIMIT ?
    `);
    const rows = stmt.all(workspaceId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToSummary(row));
  }

  deleteByWorkspace(workspaceId: string): number {
    const stmt = this.db.prepare("DELETE FROM memory_summaries WHERE workspace_id = ?");
    const result = stmt.run(workspaceId);
    return result.changes;
  }

  private mapRowToSummary(row: Record<string, unknown>): MemorySummary {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      timePeriod: row.time_period as TimePeriod,
      periodStart: row.period_start as number,
      periodEnd: row.period_end as number,
      summary: row.summary as string,
      memoryIds: safeJsonParse(row.memory_ids as string, [] as string[], "memorySummary.memoryIds"),
      tokens: row.tokens as number,
      createdAt: row.created_at as number,
    };
  }
}

export class MemorySettingsRepository {
  constructor(private db: Database.Database) {}

  getOrCreate(workspaceId: string): MemorySettings {
    const stmt = this.db.prepare("SELECT * FROM memory_settings WHERE workspace_id = ?");
    const row = stmt.get(workspaceId) as Record<string, unknown> | undefined;

    if (row) {
      return this.mapRowToSettings(row);
    }

    // Create default settings
    const defaults: MemorySettings = {
      workspaceId,
      enabled: true,
      autoCapture: true,
      compressionEnabled: true,
      retentionDays: 90,
      maxStorageMb: 100,
      privacyMode: "normal",
      excludedPatterns: [],
    };

    const insertStmt = this.db.prepare(`
      INSERT INTO memory_settings (workspace_id, enabled, auto_capture, compression_enabled, retention_days, max_storage_mb, privacy_mode, excluded_patterns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      defaults.workspaceId,
      defaults.enabled ? 1 : 0,
      defaults.autoCapture ? 1 : 0,
      defaults.compressionEnabled ? 1 : 0,
      defaults.retentionDays,
      defaults.maxStorageMb,
      defaults.privacyMode,
      JSON.stringify(defaults.excludedPatterns),
    );

    return defaults;
  }

  update(workspaceId: string, updates: Partial<Omit<MemorySettings, "workspaceId">>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.autoCapture !== undefined) {
      fields.push("auto_capture = ?");
      values.push(updates.autoCapture ? 1 : 0);
    }
    if (updates.compressionEnabled !== undefined) {
      fields.push("compression_enabled = ?");
      values.push(updates.compressionEnabled ? 1 : 0);
    }
    if (updates.retentionDays !== undefined) {
      fields.push("retention_days = ?");
      values.push(updates.retentionDays);
    }
    if (updates.maxStorageMb !== undefined) {
      fields.push("max_storage_mb = ?");
      values.push(updates.maxStorageMb);
    }
    if (updates.privacyMode !== undefined) {
      fields.push("privacy_mode = ?");
      values.push(updates.privacyMode);
    }
    if (updates.excludedPatterns !== undefined) {
      fields.push("excluded_patterns = ?");
      values.push(JSON.stringify(updates.excludedPatterns));
    }

    if (fields.length === 0) return;

    values.push(workspaceId);
    const stmt = this.db.prepare(
      `UPDATE memory_settings SET ${fields.join(", ")} WHERE workspace_id = ?`,
    );
    stmt.run(...values);
  }

  delete(workspaceId: string): void {
    const stmt = this.db.prepare("DELETE FROM memory_settings WHERE workspace_id = ?");
    stmt.run(workspaceId);
  }

  private mapRowToSettings(row: Record<string, unknown>): MemorySettings {
    return {
      workspaceId: row.workspace_id as string,
      enabled: row.enabled === 1,
      autoCapture: row.auto_capture === 1,
      compressionEnabled: row.compression_enabled === 1,
      retentionDays: row.retention_days as number,
      maxStorageMb: row.max_storage_mb as number,
      privacyMode: row.privacy_mode as PrivacyMode,
      excludedPatterns: safeJsonParse(
        row.excluded_patterns as string,
        [] as string[],
        "memorySettings.excludedPatterns",
      ),
    };
  }
}

// ============ Git Worktree Repository ============

export class WorktreeInfoRepository {
  constructor(private db: Database.Database) {}

  create(info: WorktreeInfo): WorktreeInfo {
    const stmt = this.db.prepare(`
      INSERT INTO worktree_info (task_id, workspace_id, repo_path, worktree_path, branch_name, base_branch, base_commit, status, created_at, last_commit_sha, last_commit_message, merge_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      info.taskId,
      info.workspaceId,
      info.repoPath ?? null,
      info.worktreePath,
      info.branchName,
      info.baseBranch,
      info.baseCommit,
      info.status,
      info.createdAt,
      info.lastCommitSha ?? null,
      info.lastCommitMessage ?? null,
      info.mergeResult ? JSON.stringify(info.mergeResult) : null,
    );
    return info;
  }

  findByTaskId(taskId: string): WorktreeInfo | undefined {
    const stmt = this.db.prepare("SELECT * FROM worktree_info WHERE task_id = ?");
    const row = stmt.get(taskId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  findByWorkspaceId(workspaceId: string): WorktreeInfo[] {
    const stmt = this.db.prepare(
      "SELECT * FROM worktree_info WHERE workspace_id = ? ORDER BY created_at DESC",
    );
    const rows = stmt.all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  update(taskId: string, updates: Partial<WorktreeInfo>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.repoPath !== undefined) {
      fields.push("repo_path = ?");
      values.push(updates.repoPath);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.lastCommitSha !== undefined) {
      fields.push("last_commit_sha = ?");
      values.push(updates.lastCommitSha);
    }
    if (updates.lastCommitMessage !== undefined) {
      fields.push("last_commit_message = ?");
      values.push(updates.lastCommitMessage);
    }
    if (updates.mergeResult !== undefined) {
      fields.push("merge_result = ?");
      values.push(JSON.stringify(updates.mergeResult));
    }

    if (fields.length === 0) return;

    values.push(taskId);
    const stmt = this.db.prepare(`UPDATE worktree_info SET ${fields.join(", ")} WHERE task_id = ?`);
    stmt.run(...values);
  }

  delete(taskId: string): void {
    const stmt = this.db.prepare("DELETE FROM worktree_info WHERE task_id = ?");
    stmt.run(taskId);
  }

  private mapRow(row: Record<string, unknown>): WorktreeInfo {
    return {
      taskId: row.task_id as string,
      workspaceId: row.workspace_id as string,
      repoPath: (row.repo_path as string) || undefined,
      worktreePath: row.worktree_path as string,
      branchName: row.branch_name as string,
      baseBranch: row.base_branch as string,
      baseCommit: row.base_commit as string,
      status: row.status as WorktreeStatus,
      createdAt: row.created_at as number,
      lastCommitSha: (row.last_commit_sha as string) || undefined,
      lastCommitMessage: (row.last_commit_message as string) || undefined,
      mergeResult: row.merge_result
        ? safeJsonParse<MergeResult>(
            row.merge_result as string,
            { success: false },
            "worktreeInfo.mergeResult",
          )
        : undefined,
    };
  }
}

// ============ Comparison Session Repository ============

export class ComparisonSessionRepository {
  constructor(private db: Database.Database) {}

  create(params: Omit<ComparisonSession, "id" | "createdAt">): ComparisonSession {
    const session: ComparisonSession = {
      id: uuidv4(),
      ...params,
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO comparison_sessions (id, title, prompt, workspace_id, status, task_ids, created_at, completed_at, comparison_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.title,
      session.prompt,
      session.workspaceId,
      session.status,
      JSON.stringify(session.taskIds),
      session.createdAt,
      session.completedAt ?? null,
      session.comparisonResult ? JSON.stringify(session.comparisonResult) : null,
    );
    return session;
  }

  findById(id: string): ComparisonSession | undefined {
    const stmt = this.db.prepare("SELECT * FROM comparison_sessions WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.reconcileTaskIds(this.mapRow(row));
  }

  findByWorkspaceId(workspaceId: string): ComparisonSession[] {
    const stmt = this.db.prepare(
      "SELECT * FROM comparison_sessions WHERE workspace_id = ? ORDER BY created_at DESC",
    );
    const rows = stmt.all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => this.reconcileTaskIds(this.mapRow(row)));
  }

  update(id: string, updates: Partial<ComparisonSession>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.taskIds !== undefined) {
      // Keep materialized task_ids aligned with the canonical task linkage source.
      const canonicalTaskIds = this.getTaskIdsForSession(id);
      fields.push("task_ids = ?");
      values.push(JSON.stringify(canonicalTaskIds));
    }
    if (updates.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completedAt);
    }
    if (updates.comparisonResult !== undefined) {
      fields.push("comparison_result = ?");
      values.push(JSON.stringify(updates.comparisonResult));
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(
      `UPDATE comparison_sessions SET ${fields.join(", ")} WHERE id = ?`,
    );
    stmt.run(...values);
  }

  delete(id: string): void {
    const stmt = this.db.prepare("DELETE FROM comparison_sessions WHERE id = ?");
    stmt.run(id);
  }

  syncTaskIdsFromTasks(sessionId: string): string[] {
    const taskIds = this.getTaskIdsForSession(sessionId);
    const stmt = this.db.prepare("UPDATE comparison_sessions SET task_ids = ? WHERE id = ?");
    stmt.run(JSON.stringify(taskIds), sessionId);
    return taskIds;
  }

  private mapRow(row: Record<string, unknown>): ComparisonSession {
    return {
      id: row.id as string,
      title: row.title as string,
      prompt: row.prompt as string,
      workspaceId: row.workspace_id as string,
      status: row.status as ComparisonSessionStatus,
      taskIds: safeJsonParse<string[]>(row.task_ids as string, [], "comparisonSession.taskIds"),
      createdAt: row.created_at as number,
      completedAt: (row.completed_at as number) || undefined,
      comparisonResult: row.comparison_result
        ? safeJsonParse<ComparisonResult>(
            row.comparison_result as string,
            { taskResults: [] },
            "comparisonSession.comparisonResult",
          )
        : undefined,
    };
  }

  private reconcileTaskIds(session: ComparisonSession): ComparisonSession {
    const canonicalTaskIds = this.getTaskIdsForSession(session.id);
    if (this.arraysEqual(session.taskIds, canonicalTaskIds)) {
      return session;
    }
    const stmt = this.db.prepare("UPDATE comparison_sessions SET task_ids = ? WHERE id = ?");
    stmt.run(JSON.stringify(canonicalTaskIds), session.id);
    return { ...session, taskIds: canonicalTaskIds };
  }

  private getTaskIdsForSession(sessionId: string): string[] {
    const stmt = this.db.prepare(
      "SELECT id FROM tasks WHERE comparison_session_id = ? ORDER BY created_at ASC",
    );
    const rows = stmt.all(sessionId) as Array<{ id: string }>;
    return rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
