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

  private mapRowToWorkspace(row: any): Workspace {
    const defaultPermissions: WorkspacePermissions = { read: true, write: false, delete: false, network: false };
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
      INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, budget_tokens, budget_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      newTask.budgetCost || null
    );

    return newTask;
  }

  update(id: string, updates: Partial<Task>): void {
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      fields.push(`${snakeKey} = ?`);
      values.push(value);
    });

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
    // First delete related task events
    const deleteEvents = this.db.prepare('DELETE FROM task_events WHERE task_id = ?');
    deleteEvents.run(id);

    // Then delete the task
    const deleteTask = this.db.prepare('DELETE FROM tasks WHERE id = ?');
    deleteTask.run(id);
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
