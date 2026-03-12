import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { AgentTeamRepository } from "../agents/AgentTeamRepository";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";
import { getUserDataDir } from "../utils/user-data-dir";
import type {
  AgentRole,
  Company,
  CompanyCreateInput,
  CompanyImportResult,
  CompanyUpdate,
  CompanyTemplateExport,
  CostSummary,
  Goal,
  GoalUpdate,
  HeartbeatRun,
  HeartbeatRunEvent,
  Issue,
  IssueComment,
  IssueFilters,
  IssueUpdate,
  Project,
  ProjectCreateInput,
  ProjectWorkspaceLink,
  ProjectUpdate,
  RunFilters,
  Task,
} from "../../shared/types";

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeArrayFilter<T extends string>(value?: T | T[]): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function currentMonthWindow(now = Date.now()): { start: number; end: number } {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime() - 1;
  return { start, end };
}

export class ControlPlaneCoreService {
  private static readonly provisionedDatabases = new WeakSet<Database.Database>();
  private taskRepo: TaskRepository;
  private workspaceRepo: WorkspaceRepository;
  private agentRoleRepo: AgentRoleRepository;
  private agentTeamRepo: AgentTeamRepository;

  constructor(private db: Database.Database) {
    this.taskRepo = new TaskRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.agentRoleRepo = new AgentRoleRepository(db);
    this.agentTeamRepo = new AgentTeamRepository(db);
    this.ensureDefaultCompanySeeded();
    this.ensureDefaultWorkspacesProvisioned();
  }

  listCompanies(): Company[] {
    const rows = this.db
      .prepare("SELECT * FROM companies ORDER BY is_default DESC, created_at ASC")
      .all() as Any[];
    return rows.map((row) => this.mapCompany(row));
  }

  getCompany(id: string): Company | undefined {
    const row = this.db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as Any;
    return row ? this.mapCompany(row) : undefined;
  }

  getDefaultCompany(): Company {
    const row = this.db
      .prepare("SELECT * FROM companies ORDER BY is_default DESC, created_at ASC LIMIT 1")
      .get() as Any;
    if (!row) {
      throw new Error("No company configured");
    }
    return this.mapCompany(row);
  }

  createCompany(input: CompanyCreateInput): Company {
    const now = Date.now();
    const normalizedName = input.name.trim();
    const resolvedName = this.resolveAvailableCompanyName(normalizedName || "Company");
    const resolvedSlug = this.resolveAvailableCompanySlug(
      this.normalizeCompanySlug(input.slug) || this.normalizeCompanySlug(resolvedName),
    );
    const shouldBeDefault =
      typeof input.isDefault === "boolean"
        ? input.isDefault
        : !this.db.prepare("SELECT 1 FROM companies LIMIT 1").get();
    const company: Company = {
      id: randomUUID(),
      name: resolvedName,
      slug: resolvedSlug,
      description: input.description,
      status: input.status || "active",
      isDefault: shouldBeDefault,
      defaultWorkspaceId:
        typeof input.defaultWorkspaceId === "string" ? input.defaultWorkspaceId.trim() || undefined : undefined,
      monthlyBudgetCost: input.monthlyBudgetCost ?? undefined,
      budgetPausedAt: input.budgetPausedAt ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    const tx = this.db.transaction(() => {
      if (company.isDefault) {
        this.db.prepare("UPDATE companies SET is_default = 0").run();
      }
      this.db
        .prepare(
          `
            INSERT INTO companies (
              id, name, slug, description, status, is_default, default_workspace_id,
              monthly_budget_cost, budget_paused_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          company.id,
          company.name,
          company.slug,
          company.description || null,
          company.status,
          company.isDefault ? 1 : 0,
          company.defaultWorkspaceId || null,
          company.monthlyBudgetCost ?? null,
          company.budgetPausedAt ?? null,
          company.createdAt,
          company.updatedAt,
        );
      return this.ensureCompanyDefaultWorkspace(company);
    });
    return tx();
  }

  updateCompany(id: string, updates: CompanyUpdate): Company | undefined {
    const fields: string[] = [];
    const values: Any[] = [];
    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.slug !== undefined) {
      fields.push("slug = ?");
      values.push(updates.slug);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description || null);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.isDefault !== undefined) {
      fields.push("is_default = ?");
      values.push(updates.isDefault ? 1 : 0);
    }
    if (updates.defaultWorkspaceId !== undefined) {
      fields.push("default_workspace_id = ?");
      values.push(updates.defaultWorkspaceId || null);
    }
    if (updates.monthlyBudgetCost !== undefined) {
      fields.push("monthly_budget_cost = ?");
      values.push(updates.monthlyBudgetCost ?? null);
    }
    if (updates.budgetPausedAt !== undefined) {
      fields.push("budget_paused_at = ?");
      values.push(updates.budgetPausedAt ?? null);
    }
    if (fields.length === 0) return this.getCompany(id);
    fields.push("updated_at = ?");
    values.push(Date.now(), id);
    const tx = this.db.transaction(() => {
      if (updates.isDefault) {
        this.db.prepare("UPDATE companies SET is_default = 0 WHERE id != ?").run(id);
      }
      this.db.prepare(`UPDATE companies SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      const updated = this.getCompany(id);
      return updated ? this.ensureCompanyDefaultWorkspace(updated) : updated;
    });
    return tx();
  }

  listGoals(companyId?: string): Goal[] {
    const rows = companyId
      ? ((this.db
          .prepare("SELECT * FROM goals WHERE company_id = ? ORDER BY created_at DESC")
          .all(companyId) as Any[]) ?? [])
      : ((this.db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all() as Any[]) ?? []);
    return rows.map((row) => this.mapGoal(row));
  }

  getGoal(id: string): Goal | undefined {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Any;
    return row ? this.mapGoal(row) : undefined;
  }

  createGoal(input: Partial<Goal> & Pick<Goal, "title">): Goal {
    const now = Date.now();
    const companyId = input.companyId || this.getDefaultCompany().id;
    const goal: Goal = {
      id: randomUUID(),
      companyId,
      title: input.title,
      description: input.description,
      status: input.status || "active",
      targetDate: input.targetDate,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `
          INSERT INTO goals (id, company_id, title, description, status, target_date, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        goal.id,
        goal.companyId,
        goal.title,
        goal.description || null,
        goal.status,
        goal.targetDate ?? null,
        goal.createdAt,
        goal.updatedAt,
      );
    return goal;
  }

  updateGoal(id: string, updates: GoalUpdate): Goal | undefined {
    const fields: string[] = [];
    const values: Any[] = [];
    if (updates.title !== undefined) {
      fields.push("title = ?");
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description || null);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.targetDate !== undefined) {
      fields.push("target_date = ?");
      values.push(updates.targetDate ?? null);
    }
    if (updates.companyId !== undefined) {
      fields.push("company_id = ?");
      values.push(updates.companyId);
    }
    if (fields.length === 0) return this.getGoal(id);
    fields.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE goals SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getGoal(id);
  }

  listProjects(input?: { companyId?: string; goalId?: string; includeArchived?: boolean }): Project[] {
    const clauses: string[] = ["1 = 1"];
    const args: Any[] = [];
    if (input?.companyId) {
      clauses.push("company_id = ?");
      args.push(input.companyId);
    }
    if (input?.goalId) {
      clauses.push("goal_id = ?");
      args.push(input.goalId);
    }
    if (!input?.includeArchived) {
      clauses.push("status != 'archived'");
    }
    const rows = this.db
      .prepare(`SELECT * FROM projects WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`)
      .all(...args) as Any[];
    return rows.map((row) => this.mapProject(row));
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Any;
    return row ? this.mapProject(row) : undefined;
  }

  createProject(input: ProjectCreateInput): Project {
    const now = Date.now();
    const companyId =
      input.companyId || (input.goalId ? this.getGoal(input.goalId)?.companyId : undefined) || this.getDefaultCompany().id;
    const project: Project = {
      id: randomUUID(),
      companyId,
      goalId: input.goalId,
      name: input.name,
      description: input.description,
      status: input.status || "active",
      monthlyBudgetCost: input.monthlyBudgetCost ?? undefined,
      archivedAt: input.archivedAt ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `
          INSERT INTO projects (
            id, company_id, goal_id, name, description, status, monthly_budget_cost, archived_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        project.id,
        project.companyId,
        project.goalId || null,
        project.name,
        project.description || null,
        project.status,
        project.monthlyBudgetCost ?? null,
        project.archivedAt ?? null,
        project.createdAt,
        project.updatedAt,
      );
    const company = this.getCompany(project.companyId);
    if (company?.defaultWorkspaceId && this.listProjectWorkspaces(project.id).length === 0) {
      this.linkProjectWorkspace({
        projectId: project.id,
        workspaceId: company.defaultWorkspaceId,
        isPrimary: true,
      });
    }
    return project;
  }

  updateProject(id: string, updates: ProjectUpdate): Project | undefined {
    const fields: string[] = [];
    const values: Any[] = [];
    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description || null);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.goalId !== undefined) {
      fields.push("goal_id = ?");
      values.push(updates.goalId || null);
    }
    if (updates.companyId !== undefined) {
      fields.push("company_id = ?");
      values.push(updates.companyId);
    }
    if (updates.monthlyBudgetCost !== undefined) {
      fields.push("monthly_budget_cost = ?");
      values.push(updates.monthlyBudgetCost ?? null);
    }
    if (updates.archivedAt !== undefined) {
      fields.push("archived_at = ?");
      values.push(updates.archivedAt ?? null);
    }
    if (fields.length === 0) return this.getProject(id);
    fields.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getProject(id);
  }

  listProjectWorkspaces(projectId: string): ProjectWorkspaceLink[] {
    const rows = this.db
      .prepare(
        `
          SELECT * FROM project_workspace_links
          WHERE project_id = ?
          ORDER BY is_primary DESC, created_at ASC
        `,
      )
      .all(projectId) as Any[];
    return rows.map((row) => this.mapProjectWorkspaceLink(row));
  }

  linkProjectWorkspace(input: {
    projectId: string;
    workspaceId: string;
    isPrimary?: boolean;
  }): ProjectWorkspaceLink {
    const now = Date.now();
    const existing = this.db
      .prepare(
        "SELECT * FROM project_workspace_links WHERE project_id = ? AND workspace_id = ? LIMIT 1",
      )
      .get(input.projectId, input.workspaceId) as Any;
    if (existing) {
      if (input.isPrimary) {
        this.setPrimaryProjectWorkspace(input.projectId, input.workspaceId);
        const refreshed = this.db
          .prepare(
            "SELECT * FROM project_workspace_links WHERE project_id = ? AND workspace_id = ? LIMIT 1",
          )
          .get(input.projectId, input.workspaceId) as Any;
        return this.mapProjectWorkspaceLink(refreshed);
      }
      return this.mapProjectWorkspaceLink(existing);
    }

    if (input.isPrimary) {
      this.db
        .prepare("UPDATE project_workspace_links SET is_primary = 0, updated_at = ? WHERE project_id = ?")
        .run(now, input.projectId);
    }

    const link: ProjectWorkspaceLink = {
      id: randomUUID(),
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      isPrimary: input.isPrimary ?? this.listProjectWorkspaces(input.projectId).length === 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `
          INSERT INTO project_workspace_links (id, project_id, workspace_id, is_primary, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        link.id,
        link.projectId,
        link.workspaceId,
        link.isPrimary ? 1 : 0,
        link.createdAt,
        link.updatedAt,
      );
    return link;
  }

  unlinkProjectWorkspace(projectId: string, workspaceId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM project_workspace_links WHERE project_id = ? AND workspace_id = ?")
      .run(projectId, workspaceId);
    return result.changes > 0;
  }

  setPrimaryProjectWorkspace(projectId: string, workspaceId: string): ProjectWorkspaceLink | undefined {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE project_workspace_links SET is_primary = 0, updated_at = ? WHERE project_id = ?")
        .run(now, projectId);
      this.db
        .prepare(
          "UPDATE project_workspace_links SET is_primary = 1, updated_at = ? WHERE project_id = ? AND workspace_id = ?",
        )
        .run(now, projectId, workspaceId);
    });
    tx();
    const row = this.db
      .prepare("SELECT * FROM project_workspace_links WHERE project_id = ? AND workspace_id = ?")
      .get(projectId, workspaceId) as Any;
    return row ? this.mapProjectWorkspaceLink(row) : undefined;
  }

  listIssues(filters?: IssueFilters): Issue[] {
    const clauses: string[] = ["1 = 1"];
    const args: Any[] = [];
    if (filters?.companyId) {
      clauses.push("company_id = ?");
      args.push(filters.companyId);
    }
    if (filters?.goalId) {
      clauses.push("goal_id = ?");
      args.push(filters.goalId);
    }
    if (filters?.projectId) {
      clauses.push("project_id = ?");
      args.push(filters.projectId);
    }
    if (filters?.workspaceId) {
      clauses.push("workspace_id = ?");
      args.push(filters.workspaceId);
    }
    if (filters?.assigneeAgentRoleId) {
      clauses.push("assignee_agent_role_id = ?");
      args.push(filters.assigneeAgentRoleId);
    }
    const statuses = normalizeArrayFilter(filters?.status);
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      args.push(...statuses);
    }
    const limit = Math.min(Math.max(filters?.limit || 200, 1), 1000);
    const offset = Math.max(filters?.offset || 0, 0);
    args.push(limit, offset);
    const rows = this.db
      .prepare(
        `SELECT * FROM issues WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args) as Any[];
    return rows.map((row) => this.mapIssue(row));
  }

  getIssue(id: string): Issue | undefined {
    const row = this.db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as Any;
    return row ? this.mapIssue(row) : undefined;
  }

  createIssue(input: Partial<Issue> & Pick<Issue, "title">): Issue {
    const now = Date.now();
    const project = input.projectId ? this.getProject(input.projectId) : undefined;
    const goal = input.goalId ? this.getGoal(input.goalId) : undefined;
    const companyId =
      input.companyId || project?.companyId || goal?.companyId || this.getDefaultCompany().id;
    const issue: Issue = {
      id: randomUUID(),
      companyId,
      goalId: input.goalId || project?.goalId,
      projectId: input.projectId,
      parentIssueId: input.parentIssueId,
      workspaceId: input.workspaceId || this.getPrimaryWorkspaceIdForProject(input.projectId),
      taskId: input.taskId,
      activeRunId: input.activeRunId,
      title: input.title,
      description: input.description,
      status: input.status || "backlog",
      priority: input.priority ?? 1,
      assigneeAgentRoleId: input.assigneeAgentRoleId,
      reporterAgentRoleId: input.reporterAgentRoleId,
      requestDepth: input.requestDepth,
      billingCode: input.billingCode,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
      completedAt: input.completedAt,
    };
    this.db
      .prepare(
        `
          INSERT INTO issues (
            id, company_id, goal_id, project_id, parent_issue_id, workspace_id, task_id, active_run_id,
            title, description, status, priority, assignee_agent_role_id, reporter_agent_role_id,
            request_depth, billing_code, metadata, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        issue.id,
        issue.companyId,
        issue.goalId || null,
        issue.projectId || null,
        issue.parentIssueId || null,
        issue.workspaceId || null,
        issue.taskId || null,
        issue.activeRunId || null,
        issue.title,
        issue.description || null,
        issue.status,
        issue.priority,
        issue.assigneeAgentRoleId || null,
        issue.reporterAgentRoleId || null,
        issue.requestDepth ?? null,
        issue.billingCode || null,
        issue.metadata ? JSON.stringify(issue.metadata) : null,
        issue.createdAt,
        issue.updatedAt,
        issue.completedAt ?? null,
      );
    return issue;
  }

  updateIssue(id: string, updates: IssueUpdate): Issue | undefined {
    const fields: string[] = [];
    const values: Any[] = [];
    if (updates.title !== undefined) {
      fields.push("title = ?");
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description || null);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.priority !== undefined) {
      fields.push("priority = ?");
      values.push(updates.priority);
    }
    if (updates.assigneeAgentRoleId !== undefined) {
      fields.push("assignee_agent_role_id = ?");
      values.push(updates.assigneeAgentRoleId || null);
    }
    if (updates.reporterAgentRoleId !== undefined) {
      fields.push("reporter_agent_role_id = ?");
      values.push(updates.reporterAgentRoleId || null);
    }
    if (updates.goalId !== undefined) {
      fields.push("goal_id = ?");
      values.push(updates.goalId || null);
    }
    if (updates.projectId !== undefined) {
      fields.push("project_id = ?");
      values.push(updates.projectId || null);
    }
    if (updates.parentIssueId !== undefined) {
      fields.push("parent_issue_id = ?");
      values.push(updates.parentIssueId || null);
    }
    if (updates.workspaceId !== undefined) {
      fields.push("workspace_id = ?");
      values.push(updates.workspaceId || null);
    }
    if (updates.taskId !== undefined) {
      fields.push("task_id = ?");
      values.push(updates.taskId || null);
    }
    if (updates.activeRunId !== undefined) {
      fields.push("active_run_id = ?");
      values.push(updates.activeRunId || null);
    }
    if (updates.requestDepth !== undefined) {
      fields.push("request_depth = ?");
      values.push(updates.requestDepth ?? null);
    }
    if (updates.billingCode !== undefined) {
      fields.push("billing_code = ?");
      values.push(updates.billingCode || null);
    }
    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }
    if (updates.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completedAt ?? null);
    }
    if (fields.length === 0) return this.getIssue(id);
    fields.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE issues SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getIssue(id);
  }

  listIssueComments(issueId: string): IssueComment[] {
    const rows = this.db
      .prepare("SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC")
      .all(issueId) as Any[];
    return rows.map((row) => this.mapIssueComment(row));
  }

  createIssueComment(input: Omit<IssueComment, "id" | "createdAt" | "updatedAt">): IssueComment {
    const now = Date.now();
    const comment: IssueComment = {
      id: randomUUID(),
      issueId: input.issueId,
      authorType: input.authorType,
      authorAgentRoleId: input.authorAgentRoleId,
      body: input.body,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `
          INSERT INTO issue_comments (id, issue_id, author_type, author_agent_role_id, body, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        comment.id,
        comment.issueId,
        comment.authorType,
        comment.authorAgentRoleId || null,
        comment.body,
        comment.createdAt,
        comment.updatedAt,
      );
    this.db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, comment.issueId);
    return comment;
  }

  listAssignedIssues(agentRoleId: string, workspaceId?: string): Issue[] {
    const clauses = [
      "assignee_agent_role_id = ?",
      "status IN ('backlog', 'todo', 'in_progress', 'review', 'blocked')",
      "active_run_id IS NULL",
    ];
    const args: Any[] = [agentRoleId];
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      args.push(workspaceId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM issues WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`)
      .all(...args) as Any[];
    return rows.map((row) => this.mapIssue(row));
  }

  checkoutIssue(input: {
    issueId: string;
    agentRoleId?: string;
    workspaceId?: string;
    taskId?: string;
    resumedFromRunId?: string;
  }): { issue: Issue; run: HeartbeatRun } {
    const now = Date.now();
    const runId = randomUUID();
    const tx = this.db.transaction(() => {
      const issue = this.db.prepare("SELECT * FROM issues WHERE id = ?").get(input.issueId) as Any;
      if (!issue) {
        throw new Error(`Issue not found: ${input.issueId}`);
      }
      const active = this.db
        .prepare(
          "SELECT id FROM heartbeat_runs WHERE issue_id = ? AND status IN ('queued', 'running') LIMIT 1",
        )
        .get(input.issueId) as Any;
      if (active?.id) {
        throw new Error(`Issue already checked out: ${input.issueId}`);
      }
      this.db
        .prepare(
          `
            INSERT INTO heartbeat_runs (
              id, issue_id, task_id, agent_role_id, workspace_id, status, summary, error,
              resumed_from_run_id, created_at, updated_at, started_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?, ?, NULL, NULL)
          `,
        )
        .run(
          runId,
          input.issueId,
          input.taskId || null,
          input.agentRoleId || null,
          input.workspaceId || issue.workspace_id || null,
          input.resumedFromRunId || null,
          now,
          now,
        );
      this.db
        .prepare(
          `
            UPDATE issues
            SET status = 'in_progress',
                assignee_agent_role_id = COALESCE(?, assignee_agent_role_id),
                workspace_id = COALESCE(?, workspace_id),
                task_id = COALESCE(?, task_id),
                active_run_id = ?,
                updated_at = ?
            WHERE id = ?
          `,
        )
        .run(input.agentRoleId || null, input.workspaceId || null, input.taskId || null, runId, now, input.issueId);
      this.insertRunEvent(runId, "issue.checked_out", {
        issueId: input.issueId,
        agentRoleId: input.agentRoleId,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
      });
    });

    try {
      tx();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already checked out") || message.includes("UNIQUE constraint")) {
        throw new Error(`Issue already checked out: ${input.issueId}`);
      }
      throw error;
    }

    if (input.taskId) {
      this.attachTaskToRun(runId, input.taskId);
    }

    const issue = this.getIssue(input.issueId);
    const run = this.getRun(runId);
    if (!issue || !run) {
      throw new Error("Failed to checkout issue");
    }
    return { issue, run };
  }

  attachTaskToRun(runId: string, taskId: string): { issue: Issue; run: HeartbeatRun; task: Task } {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const issue = this.getIssue(run.issueId);
    if (!issue) throw new Error(`Issue not found for run: ${runId}`);
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE heartbeat_runs
            SET task_id = ?, workspace_id = COALESCE(?, workspace_id), status = 'running',
                updated_at = ?, started_at = COALESCE(started_at, ?)
            WHERE id = ?
          `,
        )
        .run(taskId, task.workspaceId || issue.workspaceId || null, now, now, runId);
      this.db
        .prepare(
          `
            UPDATE issues
            SET task_id = ?, active_run_id = ?, workspace_id = COALESCE(?, workspace_id),
                status = 'in_progress', updated_at = ?
            WHERE id = ?
          `,
        )
        .run(taskId, runId, task.workspaceId || issue.workspaceId || null, now, issue.id);
    });
    tx();

    this.taskRepo.update(taskId, {
      companyId: issue.companyId,
      goalId: issue.goalId,
      projectId: issue.projectId,
      issueId: issue.id,
      heartbeatRunId: runId,
      requestDepth: issue.requestDepth,
      billingCode: issue.billingCode,
      workspaceId: issue.workspaceId || task.workspaceId,
    });

    this.insertRunEvent(runId, "run.task_attached", {
      taskId,
      issueId: issue.id,
      workspaceId: task.workspaceId,
    });

    const updatedIssue = this.getIssue(issue.id);
    const updatedRun = this.getRun(runId);
    const updatedTask = this.taskRepo.findById(taskId);
    if (!updatedIssue || !updatedRun || !updatedTask) {
      throw new Error("Failed to attach task to run");
    }
    return { issue: updatedIssue, run: updatedRun, task: updatedTask };
  }

  releaseIssue(input: {
    issueId: string;
    runId?: string;
    status: HeartbeatRun["status"];
    summary?: string;
    error?: string;
  }): { issue?: Issue; run?: HeartbeatRun } {
    const issue = this.getIssue(input.issueId);
    if (!issue) return {};
    const runId = input.runId || issue.activeRunId;
    if (!runId) return { issue };

    const run = this.getRun(runId);
    if (!run) return { issue };

    const now = Date.now();
    const nextIssueStatus = this.mapRunStatusToIssueStatus(input.status);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE heartbeat_runs
            SET status = ?, summary = ?, error = ?, updated_at = ?, completed_at = ?
            WHERE id = ?
          `,
        )
        .run(input.status, input.summary || null, input.error || null, now, now, runId);
      this.db
        .prepare(
          `
            UPDATE issues
            SET status = ?, active_run_id = NULL, updated_at = ?, completed_at = ?
            WHERE id = ?
          `,
        )
        .run(
          nextIssueStatus,
          now,
          input.status === "completed" ? now : null,
          input.issueId,
        );
      this.insertRunEvent(runId, `issue.released.${input.status}`, {
        issueId: input.issueId,
        summary: input.summary,
        error: input.error,
      });
    });
    tx();
    return { issue: this.getIssue(input.issueId), run: this.getRun(runId) };
  }

  listRuns(filters?: RunFilters): HeartbeatRun[] {
    const clauses: string[] = ["1 = 1"];
    const args: Any[] = [];
    let joinIssues = false;
    if (filters?.companyId) {
      joinIssues = true;
      clauses.push("i.company_id = ?");
      args.push(filters.companyId);
    }
    if (filters?.projectId) {
      joinIssues = true;
      clauses.push("i.project_id = ?");
      args.push(filters.projectId);
    }
    if (filters?.issueId) {
      clauses.push("r.issue_id = ?");
      args.push(filters.issueId);
    }
    if (filters?.agentRoleId) {
      clauses.push("r.agent_role_id = ?");
      args.push(filters.agentRoleId);
    }
    const statuses = normalizeArrayFilter(filters?.status);
    if (statuses.length > 0) {
      clauses.push(`r.status IN (${statuses.map(() => "?").join(", ")})`);
      args.push(...statuses);
    }
    const limit = Math.min(Math.max(filters?.limit || 200, 1), 1000);
    const offset = Math.max(filters?.offset || 0, 0);
    args.push(limit, offset);
    const sql = `
      SELECT r.*
      FROM heartbeat_runs r
      ${joinIssues ? "JOIN issues i ON i.id = r.issue_id" : ""}
      WHERE ${clauses.join(" AND ")}
      ORDER BY r.updated_at DESC
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(sql).all(...args) as Any[];
    return rows.map((row) => this.mapRun(row));
  }

  getRun(id: string): HeartbeatRun | undefined {
    const row = this.db.prepare("SELECT * FROM heartbeat_runs WHERE id = ?").get(id) as Any;
    return row ? this.mapRun(row) : undefined;
  }

  getRunEvents(runId: string): HeartbeatRunEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM heartbeat_run_events WHERE run_id = ? ORDER BY timestamp ASC")
      .all(runId) as Any[];
    return rows.map((row) => this.mapRunEvent(row));
  }

  syncTaskLifecycle(
    taskId: string,
    overrides?: { status?: Task["status"]; resultSummary?: string; error?: string },
  ): void {
    const task = this.taskRepo.findById(taskId);
    if (!task?.issueId || !task.heartbeatRunId) {
      return;
    }
    const run = this.getRun(task.heartbeatRunId);
    const issue = this.getIssue(task.issueId);
    if (!run || !issue) {
      return;
    }

    const now = Date.now();
    const taskStatus = overrides?.status || task.status;
    if (taskStatus === "queued" || taskStatus === "pending") {
      this.db
        .prepare(
          `
            UPDATE heartbeat_runs
            SET status = 'queued', updated_at = ?
            WHERE id = ?
          `,
        )
        .run(now, run.id);
      this.db
        .prepare(
          `
            UPDATE issues
            SET status = CASE WHEN status = 'backlog' THEN 'todo' ELSE status END,
                task_id = ?, active_run_id = ?, updated_at = ?
            WHERE id = ?
          `,
        )
        .run(task.id, run.id, now, issue.id);
      this.insertRunEvent(run.id, `task.${taskStatus}`, { taskId, issueId: issue.id });
      return;
    }

    if (taskStatus === "planning" || taskStatus === "executing") {
      this.db
        .prepare(
          `
            UPDATE heartbeat_runs
            SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
                updated_at = ?, started_at = COALESCE(started_at, ?)
            WHERE id = ?
          `,
        )
        .run(now, now, run.id);
      this.db
        .prepare(
          `
            UPDATE issues
            SET status = 'in_progress', task_id = ?, active_run_id = ?, updated_at = ?
            WHERE id = ?
          `,
        )
        .run(task.id, run.id, now, issue.id);
      this.insertRunEvent(run.id, `task.${taskStatus}`, { taskId, issueId: issue.id });
      return;
    }

    const runStatus =
      taskStatus === "completed"
        ? "completed"
        : taskStatus === "cancelled"
          ? "cancelled"
          : taskStatus === "interrupted"
            ? "interrupted"
            : "failed";
    const issueStatus =
      runStatus === "completed"
        ? task.terminalStatus === "needs_user_action" ||
          task.terminalStatus === "awaiting_approval" ||
          task.terminalStatus === "resume_available" ||
          task.terminalStatus === "partial_success"
          ? "review"
          : "done"
        : runStatus === "cancelled" || runStatus === "interrupted"
          ? "todo"
          : "blocked";

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE heartbeat_runs
            SET status = ?, summary = ?, error = ?, updated_at = ?, completed_at = ?
            WHERE id = ?
          `,
        )
        .run(
          runStatus,
          overrides?.resultSummary || task.resultSummary || null,
          overrides?.error || task.error || null,
          now,
          now,
          run.id,
        );
      this.db
        .prepare(
          `
            UPDATE issues
            SET status = ?, task_id = ?, active_run_id = NULL, updated_at = ?, completed_at = ?
            WHERE id = ?
          `,
        )
        .run(issueStatus, task.id, now, runStatus === "completed" ? now : null, issue.id);
      this.insertRunEvent(run.id, `task.${taskStatus}`, {
        taskId,
        issueId: issue.id,
        resultSummary: overrides?.resultSummary || task.resultSummary,
        error: overrides?.error || task.error,
      });
    });
    tx();
  }

  summarizeCosts(
    input: {
      scopeType: CostSummary["scopeType"];
      scopeId: string;
      windowStart?: number;
      windowEnd?: number;
    },
  ): CostSummary {
    const { start, end } = currentMonthWindow();
    const windowStart = input.windowStart ?? start;
    const windowEnd = input.windowEnd ?? end;
    let where = "te.type = 'llm_usage' AND te.timestamp >= ? AND te.timestamp <= ?";
    const args: Any[] = [windowStart, windowEnd];

    if (input.scopeType === "company") {
      where += " AND t.company_id = ?";
      args.push(input.scopeId);
    } else if (input.scopeType === "project") {
      where += " AND t.project_id = ?";
      args.push(input.scopeId);
    } else if (input.scopeType === "issue") {
      where += " AND t.issue_id = ?";
      args.push(input.scopeId);
    } else {
      where += " AND COALESCE(r.agent_role_id, t.assigned_agent_role_id) = ?";
      args.push(input.scopeId);
    }

    const rows = this.db
      .prepare(
        `
          SELECT te.task_id, te.payload, COALESCE(t.completed_at, t.updated_at, t.created_at) AS task_ts
          FROM task_events te
          JOIN tasks t ON t.id = te.task_id
          LEFT JOIN heartbeat_runs r ON r.id = t.heartbeat_run_id
          WHERE ${where}
        `,
      )
      .all(...args) as Array<{ task_id: string; payload: string; task_ts: number }>;

    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastTaskAt = 0;
    const taskIds = new Set<string>();

    for (const row of rows) {
      const payload = safeJsonParse<Any>(row.payload, {});
      const delta = payload?.delta ?? payload ?? {};
      totalCost += Number(delta.cost || 0);
      totalInputTokens += Number(delta.inputTokens || 0);
      totalOutputTokens += Number(delta.outputTokens || 0);
      taskIds.add(row.task_id);
      if (typeof row.task_ts === "number" && row.task_ts > lastTaskAt) {
        lastTaskAt = row.task_ts;
      }
    }

    return {
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      windowStart,
      windowEnd,
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      taskCount: taskIds.size,
      lastTaskAt: lastTaskAt || undefined,
    };
  }

  summarizeCostsByAgent(agentRoleId: string, windowStart?: number, windowEnd?: number): CostSummary {
    return this.summarizeCosts({
      scopeType: "agent",
      scopeId: agentRoleId,
      windowStart,
      windowEnd,
    });
  }

  summarizeCostsByProject(projectId: string, windowStart?: number, windowEnd?: number): CostSummary {
    return this.summarizeCosts({
      scopeType: "project",
      scopeId: projectId,
      windowStart,
      windowEnd,
    });
  }

  enforceAgentBudgets(agentRoleIds?: string[]): AgentRole[] {
    const roles = agentRoleIds?.length
      ? agentRoleIds
          .map((id) => this.agentRoleRepo.findById(id))
          .filter((role): role is AgentRole => Boolean(role))
      : this.agentRoleRepo.findAll(true);
    const { start, end } = currentMonthWindow();
    const paused: AgentRole[] = [];

    for (const role of roles) {
      if (!role.monthlyBudgetCost || role.monthlyBudgetCost <= 0) continue;
      const summary = this.summarizeCostsByAgent(role.id, start, end);
      if (summary.totalCost <= role.monthlyBudgetCost) continue;
      const updated = this.agentRoleRepo.update({
        id: role.id,
        heartbeatEnabled: false,
        autoPausedAt: role.autoPausedAt || Date.now(),
      });
      if (updated) {
        paused.push(updated);
      }
    }
    return paused;
  }

  exportCompanyTemplate(companyId: string): CompanyTemplateExport {
    const company = this.getCompany(companyId);
    if (!company) throw new Error(`Company not found: ${companyId}`);
    const goals = this.listGoals(companyId);
    const projects = this.listProjects({ companyId, includeArchived: true });
    const projectWorkspaceLinks = projects.flatMap((project) => this.listProjectWorkspaces(project.id));
    const issues = this.listIssues({ companyId, limit: 5000 });
    const issueComments = issues.flatMap((issue) => this.listIssueComments(issue.id));
    const agentRoles = this.agentRoleRepo.findAll(true);
    const teams = (this.db
      .prepare("SELECT * FROM agent_teams ORDER BY created_at ASC")
      .all() as Any[]).map((row) => ({
      ...row,
      workspaceId: row.workspace_id,
      leadAgentRoleId: row.lead_agent_role_id,
      maxParallelAgents: row.max_parallel_agents,
      defaultModelPreference: row.default_model_preference,
      defaultPersonality: row.default_personality,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return {
      schemaVersion: 1,
      exportedAt: Date.now(),
      company,
      goals,
      projects,
      projectWorkspaceLinks,
      issues,
      issueComments,
      agentRoles: agentRoles.map((role) => ({
        ...role,
        systemPrompt: role.systemPrompt,
      })),
      teams,
      policies: undefined,
    };
  }

  importCompanyTemplate(template: CompanyTemplateExport): CompanyImportResult {
    const tx = this.db.transaction(() => {
      const companyIdMap = new Map<string, string>();
      const goalIdMap = new Map<string, string>();
      const projectIdMap = new Map<string, string>();
      const issueIdMap = new Map<string, string>();
      const agentRoleIdMap = new Map<string, string>();

      const importedCompany = this.createImportedCompany(template.company);
      companyIdMap.set(template.company.id, importedCompany.id);

      for (const role of template.agentRoles || []) {
        const existing = this.agentRoleRepo.findByName(role.name);
        if (existing) {
          agentRoleIdMap.set(role.id, existing.id);
          continue;
        }

        if (role.isSystem) {
          continue;
        }

        const created = this.agentRoleRepo.create({
          name: this.resolveImportedAgentRoleName(role.name),
          displayName: role.displayName || role.name,
          description: role.description,
          icon: role.icon,
          color: role.color,
          personalityId: role.personalityId,
          modelKey: role.modelKey,
          providerType: role.providerType,
          systemPrompt: role.systemPrompt,
          capabilities: role.capabilities,
          toolRestrictions: role.toolRestrictions,
          autonomyLevel: role.autonomyLevel,
          soul: role.soul,
          heartbeatEnabled: role.heartbeatEnabled,
          heartbeatIntervalMinutes: role.heartbeatIntervalMinutes,
          heartbeatStaggerOffset: role.heartbeatStaggerOffset,
          monthlyBudgetCost: role.monthlyBudgetCost,
        });
        agentRoleIdMap.set(role.id, created.id);
        this.agentRoleRepo.update({
          id: created.id,
          isActive: role.isActive,
          sortOrder: role.sortOrder,
          autoPausedAt: role.autoPausedAt ?? null,
        });
      }

      for (const goal of template.goals || []) {
        const created = this.createGoal({
          companyId: importedCompany.id,
          title: goal.title,
          description: goal.description,
          status: goal.status,
          targetDate: goal.targetDate,
        });
        goalIdMap.set(goal.id, created.id);
      }

      for (const project of template.projects || []) {
        const created = this.createProject({
          companyId: importedCompany.id,
          goalId: project.goalId ? goalIdMap.get(project.goalId) : undefined,
          name: this.resolveImportedProjectName(importedCompany.id, project.name),
          description: project.description,
          status: project.status,
          monthlyBudgetCost: project.monthlyBudgetCost,
          archivedAt: project.archivedAt,
        });
        projectIdMap.set(project.id, created.id);
      }

      for (const link of template.projectWorkspaceLinks || []) {
        const newProjectId = projectIdMap.get(link.projectId);
        if (!newProjectId) continue;
        const workspaceExists = this.db
          .prepare("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1")
          .get(link.workspaceId);
        if (!workspaceExists) continue;
        this.linkProjectWorkspace({
          projectId: newProjectId,
          workspaceId: link.workspaceId,
          isPrimary: link.isPrimary,
        });
      }

      for (const issue of template.issues || []) {
        const created = this.createIssue({
          companyId: importedCompany.id,
          goalId: issue.goalId ? goalIdMap.get(issue.goalId) : undefined,
          projectId: issue.projectId ? projectIdMap.get(issue.projectId) : undefined,
          parentIssueId: issue.parentIssueId ? issueIdMap.get(issue.parentIssueId) : undefined,
          workspaceId: issue.workspaceId,
          title: issue.title,
          description: issue.description,
          status: issue.status,
          priority: issue.priority,
          assigneeAgentRoleId: issue.assigneeAgentRoleId
            ? agentRoleIdMap.get(issue.assigneeAgentRoleId)
            : undefined,
          reporterAgentRoleId: issue.reporterAgentRoleId
            ? agentRoleIdMap.get(issue.reporterAgentRoleId)
            : undefined,
          requestDepth: issue.requestDepth,
          billingCode: issue.billingCode,
          metadata: issue.metadata,
        });
        issueIdMap.set(issue.id, created.id);
      }

      for (const comment of template.issueComments || []) {
        const newIssueId = issueIdMap.get(comment.issueId);
        if (!newIssueId) continue;
        this.createIssueComment({
          issueId: newIssueId,
          authorType: comment.authorType,
          authorAgentRoleId: comment.authorAgentRoleId
            ? agentRoleIdMap.get(comment.authorAgentRoleId)
            : undefined,
          body: comment.body,
        });
      }

      for (const rawTeam of template.teams || []) {
        const team = rawTeam as Record<string, unknown>;
        const workspaceId =
          typeof team.workspaceId === "string" && team.workspaceId.trim()
            ? team.workspaceId
            : undefined;
        const leadAgentRoleId =
          typeof team.leadAgentRoleId === "string" && team.leadAgentRoleId.trim()
            ? agentRoleIdMap.get(team.leadAgentRoleId)
            : undefined;
        if (!workspaceId || !leadAgentRoleId) continue;

        const workspaceExists = this.db
          .prepare("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1")
          .get(workspaceId);
        if (!workspaceExists) continue;

        const defaultWorkspaceId =
          typeof team.defaultWorkspaceId === "string" && team.defaultWorkspaceId.trim()
            ? team.defaultWorkspaceId
            : undefined;
        const defaultWorkspaceExists =
          !defaultWorkspaceId ||
          this.db.prepare("SELECT 1 FROM workspaces WHERE id = ? LIMIT 1").get(defaultWorkspaceId);

        this.agentTeamRepo.create({
          workspaceId,
          name: this.resolveImportedTeamName(
            workspaceId,
            typeof team.name === "string" && team.name.trim() ? team.name : "Imported Team",
          ),
          description: typeof team.description === "string" ? team.description : undefined,
          leadAgentRoleId,
          maxParallelAgents:
            typeof team.maxParallelAgents === "number" ? team.maxParallelAgents : undefined,
          defaultModelPreference:
            typeof team.defaultModelPreference === "string"
              ? team.defaultModelPreference
              : undefined,
          defaultPersonality:
            typeof team.defaultPersonality === "string" ? team.defaultPersonality : undefined,
          isActive: team.isActive !== false,
          persistent: team.persistent === true,
          defaultWorkspaceId:
            defaultWorkspaceId && defaultWorkspaceExists ? defaultWorkspaceId : undefined,
        });
      }

      return {
        company: importedCompany,
        goalCount: goalIdMap.size,
        projectCount: projectIdMap.size,
        issueCount: issueIdMap.size,
      };
    });

    return tx();
  }

  private createImportedCompany(source: Company): Company {
    const now = Date.now();
    const name = this.resolveImportedCompanyName(source.name);
    const slug = this.resolveImportedCompanySlug(source.slug);
    const company: Company = {
      id: randomUUID(),
      name,
      slug,
      description: source.description,
      status: source.status || "active",
      isDefault: false,
      defaultWorkspaceId: undefined,
      monthlyBudgetCost: source.monthlyBudgetCost,
      budgetPausedAt: undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `
          INSERT INTO companies (
            id, name, slug, description, status, is_default, default_workspace_id,
            monthly_budget_cost, budget_paused_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?)
        `,
      )
      .run(
        company.id,
        company.name,
        company.slug,
        company.description || null,
        company.status,
        company.monthlyBudgetCost ?? null,
        company.createdAt,
        company.updatedAt,
      );
    return this.ensureCompanyDefaultWorkspace(company);
  }

  private resolveImportedCompanyName(baseName: string): string {
    return this.resolveAvailableCompanyName(baseName || "Imported Company");
  }

  private resolveImportedCompanySlug(baseSlug: string): string {
    return this.resolveAvailableCompanySlug(this.normalizeCompanySlug(baseSlug) || "imported-company");
  }

  private resolveAvailableCompanyName(baseName: string): string {
    let candidate = baseName.trim() || "Company";
    const base = candidate;
    let index = 2;
    while (this.db.prepare("SELECT 1 FROM companies WHERE name = ? LIMIT 1").get(candidate)) {
      candidate = `${base} (${index})`;
      index += 1;
    }
    return candidate;
  }

  private resolveAvailableCompanySlug(baseSlug: string): string {
    let candidate = baseSlug.trim() || "company";
    const base = candidate;
    let index = 2;
    while (this.db.prepare("SELECT 1 FROM companies WHERE slug = ? LIMIT 1").get(candidate)) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    return candidate;
  }

  private normalizeCompanySlug(value?: string): string {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    const slug = normalized
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "");
    return slug.length > 0 ? slug.slice(0, 60) : "";
  }

  private resolveImportedProjectName(companyId: string, baseName: string): string {
    let candidate = baseName;
    let index = 2;
    while (
      this.db
        .prepare("SELECT 1 FROM projects WHERE company_id = ? AND name = ? LIMIT 1")
        .get(companyId, candidate)
    ) {
      candidate = `${baseName} (${index})`;
      index += 1;
    }
    return candidate;
  }

  private resolveImportedAgentRoleName(baseName: string): string {
    let candidate = baseName || "imported-agent";
    let index = 2;
    while (this.agentRoleRepo.findByName(candidate)) {
      candidate = `${baseName}-${index}`;
      index += 1;
    }
    return candidate;
  }

  private resolveImportedTeamName(workspaceId: string, baseName: string): string {
    let candidate = baseName || "Imported Team";
    let index = 2;
    while (this.agentTeamRepo.findByName(workspaceId, candidate)) {
      candidate = `${baseName} (${index})`;
      index += 1;
    }
    return candidate;
  }

  private getPrimaryWorkspaceIdForProject(projectId?: string): string | undefined {
    if (!projectId) return undefined;
    const row = this.db
      .prepare(
        `
          SELECT workspace_id
          FROM project_workspace_links
          WHERE project_id = ?
          ORDER BY is_primary DESC, created_at ASC
          LIMIT 1
        `,
      )
      .get(projectId) as Any;
    return row?.workspace_id ? String(row.workspace_id) : undefined;
  }

  private mapRunStatusToIssueStatus(status: HeartbeatRun["status"]): Issue["status"] {
    if (status === "completed") return "done";
    if (status === "cancelled" || status === "interrupted") return "todo";
    if (status === "failed") return "blocked";
    return "in_progress";
  }

  private insertRunEvent(runId: string, type: string, payload: Any): void {
    this.db
      .prepare(
        `
          INSERT INTO heartbeat_run_events (id, run_id, timestamp, type, payload)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(randomUUID(), runId, Date.now(), type, JSON.stringify(payload ?? {}));
  }

  private mapCompany(row: Any): Company {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description || undefined,
      status: row.status,
      isDefault: Number(row.is_default) === 1,
      defaultWorkspaceId: row.default_workspace_id || undefined,
      monthlyBudgetCost:
        typeof row.monthly_budget_cost === "number" ? row.monthly_budget_cost : undefined,
      budgetPausedAt: row.budget_paused_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private ensureCompanyDefaultWorkspace(company: Company): Company {
    const existingWorkspace = company.defaultWorkspaceId
      ? this.workspaceRepo.findById(company.defaultWorkspaceId)
      : undefined;
    if (existingWorkspace?.id) {
      this.ensureCompanyWorkspaceStructure(existingWorkspace.path);
      this.backfillCompanyProjectWorkspaces(company.id, existingWorkspace.id);
      return {
        ...company,
        defaultWorkspaceId: existingWorkspace.id,
      };
    }

    const workspacePath = this.buildCompanyWorkspacePath(company.slug || company.name);
    this.ensureCompanyWorkspaceStructure(workspacePath);
    const byPath = this.workspaceRepo.findByPath(workspacePath);
    const workspace =
      byPath ||
      this.workspaceRepo.create(`Company: ${company.name}`, workspacePath, {
        read: true,
        write: true,
        delete: false,
        network: true,
        shell: false,
      });

    const now = Date.now();
    this.db
      .prepare("UPDATE companies SET default_workspace_id = ?, updated_at = ? WHERE id = ?")
      .run(workspace.id, now, company.id);

    this.backfillCompanyProjectWorkspaces(company.id, workspace.id);

    return {
      ...company,
      defaultWorkspaceId: workspace.id,
      updatedAt: now,
    };
  }

  private backfillCompanyProjectWorkspaces(companyId: string, workspaceId: string): void {
    const projects = this.listProjects({ companyId, includeArchived: true });
    for (const project of projects) {
      if (this.listProjectWorkspaces(project.id).length > 0) continue;
      this.linkProjectWorkspace({
        projectId: project.id,
        workspaceId,
        isPrimary: true,
      });
    }
  }

  private buildCompanyWorkspacePath(slugOrName: string): string {
    return path.join(getUserDataDir(), "company-workspaces", this.normalizeCompanySlug(slugOrName) || "company");
  }

  private ensureDefaultCompanySeeded(): void {
    const hasCompany = this.db.prepare("SELECT 1 FROM companies LIMIT 1").get();
    if (hasCompany) {
      return;
    }
    this.createCompany({
      name: "Local Company",
      slug: "local",
      isDefault: true,
      status: "active",
    });
  }

  private ensureCompanyWorkspaceStructure(workspacePath: string): void {
    fs.mkdirSync(workspacePath, { recursive: true });
    for (const entry of [".cowork", "projects", "ops", "research", "artifacts"]) {
      fs.mkdirSync(path.join(workspacePath, entry), { recursive: true });
    }
  }

  private ensureDefaultWorkspacesProvisioned(): void {
    if (ControlPlaneCoreService.provisionedDatabases.has(this.db)) {
      return;
    }
    this.provisionCompanyDefaultWorkspaces();
    ControlPlaneCoreService.provisionedDatabases.add(this.db);
  }

  private provisionCompanyDefaultWorkspaces(): void {
    const companyIds = (this.db.prepare("SELECT id FROM companies ORDER BY created_at ASC").all() as Any[]).map(
      (row) => String(row.id),
    );
    for (const companyId of companyIds) {
      const company = this.getCompany(companyId);
      if (!company) continue;
      this.ensureCompanyDefaultWorkspace(company);
    }
  }

  private mapGoal(row: Any): Goal {
    return {
      id: row.id,
      companyId: row.company_id,
      title: row.title,
      description: row.description || undefined,
      status: row.status,
      targetDate: row.target_date || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapProject(row: Any): Project {
    return {
      id: row.id,
      companyId: row.company_id,
      goalId: row.goal_id || undefined,
      name: row.name,
      description: row.description || undefined,
      status: row.status,
      monthlyBudgetCost:
        typeof row.monthly_budget_cost === "number" ? row.monthly_budget_cost : undefined,
      archivedAt: row.archived_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapProjectWorkspaceLink(row: Any): ProjectWorkspaceLink {
    return {
      id: row.id,
      projectId: row.project_id,
      workspaceId: row.workspace_id,
      isPrimary: Number(row.is_primary) === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapIssue(row: Any): Issue {
    return {
      id: row.id,
      companyId: row.company_id,
      goalId: row.goal_id || undefined,
      projectId: row.project_id || undefined,
      parentIssueId: row.parent_issue_id || undefined,
      workspaceId: row.workspace_id || undefined,
      taskId: row.task_id || undefined,
      activeRunId: row.active_run_id || undefined,
      title: row.title,
      description: row.description || undefined,
      status: row.status,
      priority: row.priority,
      assigneeAgentRoleId: row.assignee_agent_role_id || undefined,
      reporterAgentRoleId: row.reporter_agent_role_id || undefined,
      requestDepth: typeof row.request_depth === "number" ? row.request_depth : undefined,
      billingCode: row.billing_code || undefined,
      metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || undefined,
    };
  }

  private mapIssueComment(row: Any): IssueComment {
    return {
      id: row.id,
      issueId: row.issue_id,
      authorType: row.author_type,
      authorAgentRoleId: row.author_agent_role_id || undefined,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRun(row: Any): HeartbeatRun {
    return {
      id: row.id,
      issueId: row.issue_id,
      taskId: row.task_id || undefined,
      agentRoleId: row.agent_role_id || undefined,
      workspaceId: row.workspace_id || undefined,
      status: row.status,
      summary: row.summary || undefined,
      error: row.error || undefined,
      resumedFromRunId: row.resumed_from_run_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
    };
  }

  private mapRunEvent(row: Any): HeartbeatRunEvent {
    return {
      id: row.id,
      runId: row.run_id,
      timestamp: row.timestamp,
      type: row.type,
      payload: safeJsonParse(row.payload, {}),
    };
  }
}
