import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  WorkContext,
  WorkContextMemberInput,
  WorkContextMemberRole,
  WorkContextState,
  WorkContextStatus,
} from "../../shared/types";

type Any = any;

const DEFAULT_STATE: WorkContextState = { schemaVersion: 1 };

function parseState(value: unknown): WorkContextState {
  if (typeof value !== "string" || value.trim().length === 0) return { ...DEFAULT_STATE };
  try {
    const parsed = JSON.parse(value) as Partial<WorkContextState>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_STATE };
    }
    return { ...DEFAULT_STATE, ...parsed, schemaVersion: 1 };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export class WorkContextRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    id?: string;
    workspaceId: string;
    name: string;
    status?: WorkContextStatus;
    taskId?: string;
    managedSessionId?: string;
  }): WorkContext {
    const now = Date.now();
    const id = input.id || randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO work_contexts (
          id, workspace_id, name, status, active_task_id,
          active_managed_session_id, state_json, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.workspaceId,
        input.name,
        input.status || "active",
        input.taskId || null,
        input.managedSessionId || null,
        JSON.stringify(DEFAULT_STATE),
        now,
        now,
        input.status === "archived" ? now : null,
      );

    if (input.taskId || input.managedSessionId) {
      this.addMember({
        contextId: id,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.managedSessionId ? { managedSessionId: input.managedSessionId } : {}),
        role: "primary",
      });
    }
    const context = this.findById(id);
    if (!context) throw new Error(`Failed to create WorkContext: ${id}`);
    return context;
  }

  findById(id: string): WorkContext | undefined {
    const row = this.db.prepare("SELECT * FROM work_contexts WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findByTaskId(taskId: string): WorkContext | undefined {
    const row = this.db
      .prepare(
        `
        SELECT c.*
        FROM work_contexts c
        INNER JOIN work_context_members m ON m.context_id = c.id
        WHERE m.task_id = ?
        LIMIT 1
      `,
      )
      .get(taskId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findByManagedSessionId(managedSessionId: string): WorkContext | undefined {
    const row = this.db
      .prepare(
        `
        SELECT c.*
        FROM work_contexts c
        INNER JOIN work_context_members m ON m.context_id = c.id
        WHERE m.managed_session_id = ?
        LIMIT 1
      `,
      )
      .get(managedSessionId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(
    options: { workspaceId?: string; includeArchived?: boolean; limit?: number } = {},
  ): WorkContext[] {
    const limit = Math.min(
      500,
      Math.max(1, Math.floor(Number.isFinite(options.limit) ? Number(options.limit) : 100)),
    );
    const where: string[] = [];
    const args: Any[] = [];
    if (options.workspaceId) {
      where.push("workspace_id = ?");
      args.push(options.workspaceId);
    }
    if (options.includeArchived !== true) where.push("status != 'archived'");
    const rows = this.db
      .prepare(
        `
        SELECT * FROM work_contexts
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
      `,
      )
      .all(...args, limit) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  update(
    id: string,
    updates: {
      name?: string;
      status?: WorkContextStatus;
      activeTaskId?: string | null;
      activeManagedSessionId?: string | null;
      state?: Partial<Omit<WorkContextState, "schemaVersion">>;
    },
  ): WorkContext | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: Any[] = [];
    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
      fields.push("archived_at = ?");
      values.push(updates.status === "archived" ? Date.now() : null);
    }
    if (updates.activeTaskId !== undefined) {
      fields.push("active_task_id = ?");
      values.push(updates.activeTaskId || null);
    }
    if (updates.activeManagedSessionId !== undefined) {
      fields.push("active_managed_session_id = ?");
      values.push(updates.activeManagedSessionId || null);
    }
    if (updates.state !== undefined) {
      fields.push("state_json = ?");
      values.push(JSON.stringify({ ...existing.state, ...updates.state, schemaVersion: 1 }));
    }
    if (fields.length === 0) return existing;
    fields.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE work_contexts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  addMember(input: WorkContextMemberInput): WorkContext | undefined {
    if (!input.taskId && !input.managedSessionId) {
      throw new Error("A WorkContext member requires a taskId or managedSessionId.");
    }
    const context = this.findById(input.contextId);
    if (!context) throw new Error(`WorkContext not found: ${input.contextId}`);
    const existing = input.taskId
      ? this.findByTaskId(input.taskId)
      : input.managedSessionId
        ? this.findByManagedSessionId(input.managedSessionId)
        : undefined;
    if (existing) {
      if (existing.id !== input.contextId) {
        throw new Error("Work item already belongs to another WorkContext.");
      }
      return existing;
    }
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO work_context_members (
          id, context_id, task_id, managed_session_id, role, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        randomUUID(),
        input.contextId,
        input.taskId || null,
        input.managedSessionId || null,
        input.role || "primary",
        now,
      );

    const activeTaskId = input.taskId && input.role !== "child" ? input.taskId : undefined;
    const activeManagedSessionId =
      input.managedSessionId && input.role !== "child" ? input.managedSessionId : undefined;
    return this.update(input.contextId, {
      ...(activeTaskId ? { activeTaskId } : {}),
      ...(activeManagedSessionId ? { activeManagedSessionId } : {}),
    });
  }

  private mapRow(row: Any): WorkContext {
    const members = this.db
      .prepare(
        `
        SELECT task_id, managed_session_id
        FROM work_context_members
        WHERE context_id = ?
        ORDER BY created_at ASC
      `,
      )
      .all(String(row.id || "")) as Any[];
    return {
      id: String(row.id || ""),
      workspaceId: String(row.workspace_id || ""),
      name: String(row.name || "Untitled work"),
      status: String(row.status || "active") as WorkContextStatus,
      activeTaskId: row.active_task_id ? String(row.active_task_id) : undefined,
      activeManagedSessionId: row.active_managed_session_id
        ? String(row.active_managed_session_id)
        : undefined,
      taskIds: members
        .map((member) => (member.task_id ? String(member.task_id) : undefined))
        .filter((id): id is string => Boolean(id)),
      managedSessionIds: members
        .map((member) =>
          member.managed_session_id ? String(member.managed_session_id) : undefined,
        )
        .filter((id): id is string => Boolean(id)),
      state: parseState(row.state_json),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      archivedAt: row.archived_at ? Number(row.archived_at) : undefined,
    };
  }
}

export function workContextMemberRole(value: unknown): WorkContextMemberRole {
  return value === "child" || value === "reviewer" || value === "scheduled" ? value : "primary";
}
