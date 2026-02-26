import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  TaskLabel,
  CreateTaskLabelRequest,
  UpdateTaskLabelRequest,
  TaskLabelListQuery,
} from "../../shared/types";

const DEFAULT_LABEL_COLOR = "#6366f1";

/**
 * Repository for managing task labels in the database
 */
export class TaskLabelRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new task label
   */
  create(request: CreateTaskLabelRequest): TaskLabel {
    const now = Date.now();
    const label: TaskLabel = {
      id: uuidv4(),
      workspaceId: request.workspaceId,
      name: request.name,
      color: request.color || DEFAULT_LABEL_COLOR,
      createdAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO task_labels (id, workspace_id, name, color, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(label.id, label.workspaceId, label.name, label.color, label.createdAt);

    return label;
  }

  /**
   * Find a task label by ID
   */
  findById(id: string): TaskLabel | undefined {
    const stmt = this.db.prepare("SELECT * FROM task_labels WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToLabel(row) : undefined;
  }

  /**
   * Find a task label by name within a workspace
   */
  findByName(workspaceId: string, name: string): TaskLabel | undefined {
    const stmt = this.db.prepare("SELECT * FROM task_labels WHERE workspace_id = ? AND name = ?");
    const row = stmt.get(workspaceId, name) as Any;
    return row ? this.mapRowToLabel(row) : undefined;
  }

  /**
   * List all labels for a workspace
   */
  list(query: TaskLabelListQuery): TaskLabel[] {
    const stmt = this.db.prepare(
      "SELECT * FROM task_labels WHERE workspace_id = ? ORDER BY name ASC",
    );
    const rows = stmt.all(query.workspaceId) as Any[];
    return rows.map((row) => this.mapRowToLabel(row));
  }

  /**
   * Update a task label
   */
  update(id: string, request: UpdateTaskLabelRequest): TaskLabel | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;

    const updates: string[] = [];
    const params: Any[] = [];

    if (request.name !== undefined) {
      updates.push("name = ?");
      params.push(request.name);
    }

    if (request.color !== undefined) {
      updates.push("color = ?");
      params.push(request.color);
    }

    if (updates.length === 0) return existing;

    params.push(id);

    const stmt = this.db.prepare(`UPDATE task_labels SET ${updates.join(", ")} WHERE id = ?`);
    stmt.run(...params);

    return this.findById(id);
  }

  /**
   * Delete a task label
   */
  delete(id: string): boolean {
    const stmt = this.db.prepare("DELETE FROM task_labels WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all labels for a workspace
   */
  deleteByWorkspace(workspaceId: string): number {
    const stmt = this.db.prepare("DELETE FROM task_labels WHERE workspace_id = ?");
    const result = stmt.run(workspaceId);
    return result.changes;
  }

  /**
   * Get multiple labels by IDs
   */
  getByIds(ids: string[]): TaskLabel[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.db.prepare(`SELECT * FROM task_labels WHERE id IN (${placeholders})`);
    const rows = stmt.all(...ids) as Any[];
    return rows.map((row) => this.mapRowToLabel(row));
  }

  /**
   * Map database row to TaskLabel object
   */
  private mapRowToLabel(row: Any): TaskLabel {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      color: row.color,
      createdAt: row.created_at,
    };
  }
}
