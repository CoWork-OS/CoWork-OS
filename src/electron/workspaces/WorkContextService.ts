import type {
  ManagedSession,
  Task,
  WorkContext,
  WorkContextCreateInput,
  WorkContextMemberInput,
  WorkContextState,
  WorkContextUpdateInput,
} from "../../shared/types";
import { WorkspaceRepository } from "../database/repositories";
import { WorkContextRepository, workContextMemberRole } from "./WorkContextRepository";
import Database from "better-sqlite3";

function normalizeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new Error("WorkContext name is required.");
  return name.slice(0, 200);
}

function normalizeId(value: unknown, label: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new Error(`${label} is required.`);
  return id;
}

export class WorkContextService {
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly repo: WorkContextRepository;

  constructor(private readonly db: Database.Database) {
    this.workspaceRepo = new WorkspaceRepository(db);
    this.repo = new WorkContextRepository(db);
  }

  list(
    options: { workspaceId?: string; includeArchived?: boolean; limit?: number } = {},
  ): WorkContext[] {
    if (options.workspaceId) this.assertWorkspace(options.workspaceId);
    return this.repo.list(options);
  }

  get(contextId: string): WorkContext | undefined {
    return this.repo.findById(normalizeId(contextId, "contextId"));
  }

  create(input: WorkContextCreateInput): WorkContext {
    const workspaceId = normalizeId(input.workspaceId, "workspaceId");
    this.assertWorkspace(workspaceId);
    if (input.taskId || input.managedSessionId) {
      this.assertMemberExists(input.taskId, input.managedSessionId);
    }
    const context = this.repo.create({
      workspaceId,
      name: normalizeName(input.name),
      status: input.status,
    });
    if (input.taskId || input.managedSessionId) {
      return (
        this.repo.addMember({
          contextId: context.id,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.managedSessionId ? { managedSessionId: input.managedSessionId } : {}),
        }) || context
      );
    }
    return context;
  }

  update(input: WorkContextUpdateInput): WorkContext | undefined {
    const contextId = normalizeId(input.contextId, "contextId");
    const existing = this.repo.findById(contextId);
    if (!existing) return undefined;
    if (input.activeTaskId) this.assertTaskWorkspace(existing.workspaceId, input.activeTaskId);
    if (input.activeManagedSessionId) {
      this.assertManagedSessionWorkspace(existing.workspaceId, input.activeManagedSessionId);
    }
    const state: Partial<Omit<WorkContextState, "schemaVersion">> | undefined = input.state
      ? { ...input.state }
      : undefined;
    return this.repo.update(contextId, {
      ...(input.name !== undefined ? { name: normalizeName(input.name) } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.activeTaskId !== undefined ? { activeTaskId: input.activeTaskId } : {}),
      ...(input.activeManagedSessionId !== undefined
        ? { activeManagedSessionId: input.activeManagedSessionId }
        : {}),
      ...(state ? { state } : {}),
    });
  }

  addMember(input: WorkContextMemberInput): WorkContext | undefined {
    const contextId = normalizeId(input.contextId, "contextId");
    const context = this.repo.findById(contextId);
    if (!context) return undefined;
    this.assertMemberExists(input.taskId, input.managedSessionId);
    if (input.taskId) this.assertTaskWorkspace(context.workspaceId, input.taskId);
    if (input.managedSessionId)
      this.assertManagedSessionWorkspace(context.workspaceId, input.managedSessionId);
    return this.repo.addMember({
      ...input,
      contextId,
      role: workContextMemberRole(input.role),
    });
  }

  ensureForTask(task: Pick<Task, "id" | "title" | "workspaceId">): WorkContext {
    const existing = this.repo.findByTaskId(task.id);
    if (existing) return existing;
    const context = this.repo.create({
      workspaceId: task.workspaceId,
      name: normalizeName(task.title || "Untitled work"),
    });
    return (
      this.repo.addMember({ contextId: context.id, taskId: task.id, role: "primary" }) || context
    );
  }

  ensureForManagedSession(
    session: Pick<ManagedSession, "id" | "title" | "workspaceId">,
  ): WorkContext {
    const existing = this.repo.findByManagedSessionId(session.id);
    if (existing) return existing;
    const context = this.repo.create({
      workspaceId: session.workspaceId,
      name: normalizeName(session.title || "Untitled work"),
    });
    return (
      this.repo.addMember({
        contextId: context.id,
        managedSessionId: session.id,
        role: "primary",
      }) || context
    );
  }

  attachForkedTask(
    task: Pick<Task, "id" | "title" | "workspaceId">,
    sourceTaskId?: string,
  ): WorkContext {
    const source = sourceTaskId ? this.repo.findByTaskId(sourceTaskId) : undefined;
    if (source) {
      return (
        this.repo.addMember({ contextId: source.id, taskId: task.id, role: "child" }) || source
      );
    }
    return this.ensureForTask(task);
  }

  private assertWorkspace(workspaceId: string): void {
    if (!this.workspaceRepo.findById(workspaceId))
      throw new Error(`Workspace not found: ${workspaceId}`);
  }

  private assertMemberExists(taskId?: string, managedSessionId?: string): void {
    if (taskId) {
      const row = this.db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
      if (!row) throw new Error(`Task not found: ${taskId}`);
    }
    if (managedSessionId) {
      const row = this.db
        .prepare("SELECT id FROM managed_sessions WHERE id = ?")
        .get(managedSessionId);
      if (!row) throw new Error(`Managed session not found: ${managedSessionId}`);
    }
  }

  private assertTaskWorkspace(workspaceId: string, taskId: string): void {
    const row = this.db.prepare("SELECT workspace_id FROM tasks WHERE id = ?").get(taskId) as
      | { workspace_id?: string }
      | undefined;
    if (row?.workspace_id !== workspaceId)
      throw new Error("Task does not belong to this WorkContext workspace.");
  }

  private assertManagedSessionWorkspace(workspaceId: string, managedSessionId: string): void {
    const row = this.db
      .prepare("SELECT workspace_id FROM managed_sessions WHERE id = ?")
      .get(managedSessionId) as { workspace_id?: string } | undefined;
    if (row?.workspace_id !== workspaceId) {
      throw new Error("Managed session does not belong to this WorkContext workspace.");
    }
  }
}
