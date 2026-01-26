import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  Task,
  TaskEvent,
  Artifact,
  Workspace,
  ApprovalRequest,
  Skill,
  WorkspacePermissions,
} from '../../shared/types';

/**
 * Safely parse JSON with error handling
 * Returns defaultValue if parsing fails
 */
function safeJsonParse<T>(jsonString: string, defaultValue: T, context?: string): T {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error(`Failed to parse JSON${context ? ` in ${context}` : ''}:`, error, 'Input:', jsonString?.slice(0, 100));
    return defaultValue;
  }
}

export class WorkspaceRepository {
  constructor(private db: Database.Database) {}

  create(name: string, path: string, permissions: WorkspacePermissions): Workspace {
    const workspace: Workspace = {
      id: uuidv4(),
      name,
      path,
      createdAt: Date.now(),
      permissions,
    };

    const stmt = this.db.prepare(`
      INSERT INTO workspaces (id, name, path, created_at, permissions)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      workspace.id,
      workspace.name,
      workspace.path,
      workspace.createdAt,
      JSON.stringify(workspace.permissions)
    );

    return workspace;
  }

  findById(id: string): Workspace | undefined {
    const stmt = this.db.prepare('SELECT * FROM workspaces WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.mapRowToWorkspace(row) : undefined;
  }

  findAll(): Workspace[] {
    const stmt = this.db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC');
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapRowToWorkspace(row));
  }

  /**
   * Check if a workspace with the given path already exists
   */
  existsByPath(path: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM workspaces WHERE path = ?');
    const row = stmt.get(path);
    return !!row;
  }

  /**
   * Find a workspace by its path
   */
  findByPath(path: string): Workspace | undefined {
    const stmt = this.db.prepare('SELECT * FROM workspaces WHERE path = ?');
    const row = stmt.get(path) as any;
    return row ? this.mapRowToWorkspace(row) : undefined;
  }

  /**
   * Update workspace permissions
   */
  updatePermissions(id: string, permissions: WorkspacePermissions): void {
    const stmt = this.db.prepare('UPDATE workspaces SET permissions = ? WHERE id = ?');
    stmt.run(JSON.stringify(permissions), id);
  }

  private mapRowToWorkspace(row: any): Workspace {
    const defaultPermissions: WorkspacePermissions = { read: true, write: false, delete: false, network: false, shell: false };
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      createdAt: row.created_at,
      permissions: safeJsonParse(row.permissions, defaultPermissions, 'workspace.permissions'),
    };
  }
}

export class TaskRepository {
  constructor(private db: Database.Database) {}

  create(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Task {
    const newTask: Task = {
      ...task,
      id: uuidv4(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, budget_tokens, budget_cost, success_criteria, max_attempts, current_attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newTask.id,
      newTask.title,
      newTask.prompt,
      newTask.status,
      newTask.workspaceId,
      newTask.createdAt,
      newTask.updatedAt,
      newTask.budgetTokens || null,
      newTask.budgetCost || null,
      newTask.successCriteria ? JSON.stringify(newTask.successCriteria) : null,
      newTask.maxAttempts || null,
      newTask.currentAttempt || 1
    );

    return newTask;
  }

  // Whitelist of allowed update fields to prevent SQL injection
  private static readonly ALLOWED_UPDATE_FIELDS = new Set([
    'title', 'status', 'error', 'result', 'budgetTokens', 'budgetCost',
    'successCriteria', 'maxAttempts', 'currentAttempt'
  ]);

  update(id: string, updates: Partial<Task>): void {
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      // Validate field name against whitelist
      if (!TaskRepository.ALLOWED_UPDATE_FIELDS.has(key)) {
        console.warn(`Ignoring unknown field in task update: ${key}`);
        return;
      }
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      fields.push(`${snakeKey} = ?`);
      // JSON serialize object fields
      if (key === 'successCriteria' && value != null) {
        values.push(JSON.stringify(value));
      } else {
        values.push(value);
      }
    });

    if (fields.length === 0) {
      return; // No valid fields to update
    }

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): Task | undefined {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.mapRowToTask(row) : undefined;
  }

  findAll(limit = 100, offset = 0): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(limit, offset) as any[];
    return rows.map(row => this.mapRowToTask(row));
  }

  delete(id: string): void {
    // Use transaction to ensure atomic deletion
    const deleteTransaction = this.db.transaction((taskId: string) => {
      // First delete related task events
      const deleteEvents = this.db.prepare('DELETE FROM task_events WHERE task_id = ?');
      deleteEvents.run(taskId);

      // Then delete the task
      const deleteTask = this.db.prepare('DELETE FROM tasks WHERE id = ?');
      deleteTask.run(taskId);
    });

    deleteTransaction(id);
  }

  private mapRowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      status: row.status,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || undefined,
      budgetTokens: row.budget_tokens || undefined,
      budgetCost: row.budget_cost || undefined,
      error: row.error || undefined,
      // Goal Mode fields
      successCriteria: row.success_criteria ? safeJsonParse(row.success_criteria, undefined, 'task.successCriteria') : undefined,
      maxAttempts: row.max_attempts || undefined,
      currentAttempt: row.current_attempt || undefined,
    };
  }
}

export class TaskEventRepository {
  constructor(private db: Database.Database) {}

  create(event: Omit<TaskEvent, 'id'>): TaskEvent {
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
      JSON.stringify(newEvent.payload)
    );

    return newEvent;
  }

  findByTaskId(taskId: string): TaskEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM task_events
      WHERE task_id = ?
      ORDER BY timestamp ASC
    `);
    const rows = stmt.all(taskId) as any[];
    return rows.map(row => this.mapRowToEvent(row));
  }

  private mapRowToEvent(row: any): TaskEvent {
    return {
      id: row.id,
      taskId: row.task_id,
      timestamp: row.timestamp,
      type: row.type,
      payload: safeJsonParse(row.payload, {}, 'taskEvent.payload'),
    };
  }
}

export class ArtifactRepository {
  constructor(private db: Database.Database) {}

  create(artifact: Omit<Artifact, 'id'>): Artifact {
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
      newArtifact.createdAt
    );

    return newArtifact;
  }

  findByTaskId(taskId: string): Artifact[] {
    const stmt = this.db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC');
    const rows = stmt.all(taskId) as any[];
    return rows.map(row => this.mapRowToArtifact(row));
  }

  private mapRowToArtifact(row: any): Artifact {
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

  create(approval: Omit<ApprovalRequest, 'id'>): ApprovalRequest {
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
      newApproval.requestedAt
    );

    return newApproval;
  }

  update(id: string, status: 'approved' | 'denied'): void {
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
    const rows = stmt.all(taskId) as any[];
    return rows.map(row => this.mapRowToApproval(row));
  }

  private mapRowToApproval(row: any): ApprovalRequest {
    return {
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      description: row.description,
      details: safeJsonParse(row.details, {}, 'approval.details'),
      status: row.status,
      requestedAt: row.requested_at,
      resolvedAt: row.resolved_at || undefined,
    };
  }
}

export class SkillRepository {
  constructor(private db: Database.Database) {}

  create(skill: Omit<Skill, 'id'>): Skill {
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
      newSkill.parameters ? JSON.stringify(newSkill.parameters) : null
    );

    return newSkill;
  }

  findAll(): Skill[] {
    const stmt = this.db.prepare('SELECT * FROM skills ORDER BY name ASC');
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapRowToSkill(row));
  }

  findById(id: string): Skill | undefined {
    const stmt = this.db.prepare('SELECT * FROM skills WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.mapRowToSkill(row) : undefined;
  }

  private mapRowToSkill(row: any): Skill {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      prompt: row.prompt,
      scriptPath: row.script_path || undefined,
      parameters: row.parameters ? safeJsonParse(row.parameters, undefined, 'skill.parameters') : undefined,
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
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapRowToModel(row));
  }

  findByKey(key: string): LLMModel | undefined {
    const stmt = this.db.prepare('SELECT * FROM llm_models WHERE key = ?');
    const row = stmt.get(key) as any;
    return row ? this.mapRowToModel(row) : undefined;
  }

  findById(id: string): LLMModel | undefined {
    const stmt = this.db.prepare('SELECT * FROM llm_models WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.mapRowToModel(row) : undefined;
  }

  private mapRowToModel(row: any): LLMModel {
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
    mode: 'open' | 'allowlist' | 'pairing';
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
  state: 'idle' | 'active' | 'waiting_approval';
  context?: Record<string, unknown>;
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
  direction: 'incoming' | 'outgoing';
  content: string;
  attachments?: Array<{ type: string; url?: string; fileName?: string }>;
  timestamp: number;
}

export class ChannelRepository {
  constructor(private db: Database.Database) {}

  create(channel: Omit<Channel, 'id' | 'createdAt' | 'updatedAt'>): Channel {
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
      newChannel.updatedAt
    );

    return newChannel;
  }

  update(id: string, updates: Partial<Channel>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.config !== undefined) {
      fields.push('config = ?');
      values.push(JSON.stringify(updates.config));
    }
    if (updates.securityConfig !== undefined) {
      fields.push('security_config = ?');
      values.push(JSON.stringify(updates.securityConfig));
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.botUsername !== undefined) {
      fields.push('bot_username = ?');
      values.push(updates.botUsername);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    const stmt = this.db.prepare(`UPDATE channels SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): Channel | undefined {
    const stmt = this.db.prepare('SELECT * FROM channels WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToChannel(row) : undefined;
  }

  findByType(type: string): Channel | undefined {
    const stmt = this.db.prepare('SELECT * FROM channels WHERE type = ?');
    const row = stmt.get(type) as Record<string, unknown> | undefined;
    return row ? this.mapRowToChannel(row) : undefined;
  }

  findAll(): Channel[] {
    const stmt = this.db.prepare('SELECT * FROM channels ORDER BY created_at ASC');
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => this.mapRowToChannel(row));
  }

  findEnabled(): Channel[] {
    const stmt = this.db.prepare('SELECT * FROM channels WHERE enabled = 1 ORDER BY created_at ASC');
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => this.mapRowToChannel(row));
  }

  delete(id: string): void {
    const stmt = this.db.prepare('DELETE FROM channels WHERE id = ?');
    stmt.run(id);
  }

  private mapRowToChannel(row: Record<string, unknown>): Channel {
    const defaultSecurityConfig = { mode: 'pairing' as const };
    return {
      id: row.id as string,
      type: row.type as string,
      name: row.name as string,
      enabled: row.enabled === 1,
      config: safeJsonParse(row.config as string, {}, 'channel.config'),
      securityConfig: safeJsonParse(row.security_config as string, defaultSecurityConfig, 'channel.securityConfig'),
      status: row.status as string,
      botUsername: (row.bot_username as string) || undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

export class ChannelUserRepository {
  constructor(private db: Database.Database) {}

  create(user: Omit<ChannelUser, 'id' | 'createdAt' | 'lastSeenAt' | 'pairingAttempts'>): ChannelUser {
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
      newUser.lastSeenAt
    );

    return newUser;
  }

  update(id: string, updates: Partial<ChannelUser>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(updates.displayName);
    }
    if (updates.username !== undefined) {
      fields.push('username = ?');
      values.push(updates.username);
    }
    if (updates.allowed !== undefined) {
      fields.push('allowed = ?');
      values.push(updates.allowed ? 1 : 0);
    }
    if (updates.pairingCode !== undefined) {
      fields.push('pairing_code = ?');
      values.push(updates.pairingCode);
    }
    if (updates.pairingAttempts !== undefined) {
      fields.push('pairing_attempts = ?');
      values.push(updates.pairingAttempts);
    }
    if (updates.pairingExpiresAt !== undefined) {
      fields.push('pairing_expires_at = ?');
      values.push(updates.pairingExpiresAt);
    }
    if (updates.lastSeenAt !== undefined) {
      fields.push('last_seen_at = ?');
      values.push(updates.lastSeenAt);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE channel_users SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): ChannelUser | undefined {
    const stmt = this.db.prepare('SELECT * FROM channel_users WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToUser(row) : undefined;
  }

  findByChannelUserId(channelId: string, channelUserId: string): ChannelUser | undefined {
    const stmt = this.db.prepare('SELECT * FROM channel_users WHERE channel_id = ? AND channel_user_id = ?');
    const row = stmt.get(channelId, channelUserId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToUser(row) : undefined;
  }

  findByChannelId(channelId: string): ChannelUser[] {
    const stmt = this.db.prepare('SELECT * FROM channel_users WHERE channel_id = ? ORDER BY last_seen_at DESC');
    const rows = stmt.all(channelId) as Record<string, unknown>[];
    return rows.map(row => this.mapRowToUser(row));
  }

  findAllowedByChannelId(channelId: string): ChannelUser[] {
    const stmt = this.db.prepare('SELECT * FROM channel_users WHERE channel_id = ? AND allowed = 1 ORDER BY last_seen_at DESC');
    const rows = stmt.all(channelId) as Record<string, unknown>[];
    return rows.map(row => this.mapRowToUser(row));
  }

  deleteByChannelId(channelId: string): void {
    const stmt = this.db.prepare('DELETE FROM channel_users WHERE channel_id = ?');
    stmt.run(channelId);
  }

  findByPairingCode(channelId: string, pairingCode: string): ChannelUser | undefined {
    const stmt = this.db.prepare('SELECT * FROM channel_users WHERE channel_id = ? AND UPPER(pairing_code) = UPPER(?)');
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
      createdAt: row.created_at as number,
      lastSeenAt: row.last_seen_at as number,
    };
  }
}

export class ChannelSessionRepository {
  constructor(private db: Database.Database) {}

  create(session: Omit<ChannelSession, 'id' | 'createdAt' | 'lastActivityAt'>): ChannelSession {
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
      newSession.lastActivityAt
    );

    return newSession;
  }

  update(id: string, updates: Partial<ChannelSession>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    // Use 'in' check to allow setting fields to null/undefined (clearing them)
    if ('taskId' in updates) {
      fields.push('task_id = ?');
      values.push(updates.taskId ?? null); // Convert undefined to null for SQLite
    }
    if ('workspaceId' in updates) {
      fields.push('workspace_id = ?');
      values.push(updates.workspaceId ?? null);
    }
    if ('state' in updates) {
      fields.push('state = ?');
      values.push(updates.state);
    }
    if ('context' in updates) {
      fields.push('context = ?');
      values.push(updates.context ? JSON.stringify(updates.context) : null);
    }
    if ('lastActivityAt' in updates) {
      fields.push('last_activity_at = ?');
      values.push(updates.lastActivityAt);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE channel_sessions SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  findById(id: string): ChannelSession | undefined {
    const stmt = this.db.prepare('SELECT * FROM channel_sessions WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSession(row) : undefined;
  }

  findByChatId(channelId: string, chatId: string): ChannelSession | undefined {
    const stmt = this.db.prepare('SELECT * FROM channel_sessions WHERE channel_id = ? AND chat_id = ? ORDER BY last_activity_at DESC LIMIT 1');
    const row = stmt.get(channelId, chatId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSession(row) : undefined;
  }

  findByTaskId(taskId: string): ChannelSession | undefined {
    const stmt = this.db.prepare('SELECT * FROM channel_sessions WHERE task_id = ?');
    const row = stmt.get(taskId) as Record<string, unknown> | undefined;
    return row ? this.mapRowToSession(row) : undefined;
  }

  findActiveByChannelId(channelId: string): ChannelSession[] {
    const stmt = this.db.prepare("SELECT * FROM channel_sessions WHERE channel_id = ? AND state != 'idle' ORDER BY last_activity_at DESC");
    const rows = stmt.all(channelId) as Record<string, unknown>[];
    return rows.map(row => this.mapRowToSession(row));
  }

  deleteByChannelId(channelId: string): void {
    const stmt = this.db.prepare('DELETE FROM channel_sessions WHERE channel_id = ?');
    stmt.run(channelId);
  }

  private mapRowToSession(row: Record<string, unknown>): ChannelSession {
    return {
      id: row.id as string,
      channelId: row.channel_id as string,
      chatId: row.chat_id as string,
      userId: (row.user_id as string) || undefined,
      taskId: (row.task_id as string) || undefined,
      workspaceId: (row.workspace_id as string) || undefined,
      state: row.state as 'idle' | 'active' | 'waiting_approval',
      context: row.context ? safeJsonParse(row.context as string, undefined, 'session.context') : undefined,
      createdAt: row.created_at as number,
      lastActivityAt: row.last_activity_at as number,
    };
  }
}

export class ChannelMessageRepository {
  constructor(private db: Database.Database) {}

  create(message: Omit<ChannelMessage, 'id'>): ChannelMessage {
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
      newMessage.timestamp
    );

    return newMessage;
  }

  findBySessionId(sessionId: string, limit = 50): ChannelMessage[] {
    const stmt = this.db.prepare('SELECT * FROM channel_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?');
    const rows = stmt.all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(row => this.mapRowToMessage(row)).reverse();
  }

  findByChatId(channelId: string, chatId: string, limit = 50): ChannelMessage[] {
    const stmt = this.db.prepare('SELECT * FROM channel_messages WHERE channel_id = ? AND chat_id = ? ORDER BY timestamp DESC LIMIT ?');
    const rows = stmt.all(channelId, chatId, limit) as Record<string, unknown>[];
    return rows.map(row => this.mapRowToMessage(row)).reverse();
  }

  deleteByChannelId(channelId: string): void {
    const stmt = this.db.prepare('DELETE FROM channel_messages WHERE channel_id = ?');
    stmt.run(channelId);
  }

  private mapRowToMessage(row: Record<string, unknown>): ChannelMessage {
    return {
      id: row.id as string,
      channelId: row.channel_id as string,
      sessionId: (row.session_id as string) || undefined,
      channelMessageId: row.channel_message_id as string,
      chatId: row.chat_id as string,
      userId: (row.user_id as string) || undefined,
      direction: row.direction as 'incoming' | 'outgoing',
      content: row.content as string,
      attachments: row.attachments ? safeJsonParse(row.attachments as string, undefined, 'message.attachments') : undefined,
      timestamp: row.timestamp as number,
    };
  }
}
