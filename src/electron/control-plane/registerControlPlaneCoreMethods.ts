import type Database from "better-sqlite3";
import type { ControlPlaneServer } from "./server";
import { ControlPlaneCoreService } from "./ControlPlaneCoreService";
import { ErrorCodes, Methods } from "./protocol";

function requireString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw { code: ErrorCodes.INVALID_PARAMS, message: `${field} is required` };
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function registerControlPlaneCoreMethods(options: {
  server: ControlPlaneServer;
  db: Database.Database;
  requireScope: (client: Any, scope: "admin" | "read" | "write" | "operator") => void;
}): void {
  const { server, db, requireScope } = options;
  const core = new ControlPlaneCoreService(db);

  server.registerMethod(Methods.COMPANY_LIST, async (client) => {
    requireScope(client, "read");
    return { companies: core.listCompanies() };
  });

  server.registerMethod(Methods.COMPANY_GET, async (client, params) => {
    requireScope(client, "read");
    const companyId = requireString((params as Any)?.companyId, "companyId");
    const company = core.getCompany(companyId);
    if (!company) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Company not found: ${companyId}` };
    }
    return { company };
  });

  server.registerMethod(Methods.COMPANY_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    const companyId = requireString(p.companyId, "companyId");
    const company = core.updateCompany(companyId, {
      name: optionalString(p.name),
      slug: optionalString(p.slug),
      description: p.description === null ? "" : optionalString(p.description),
      status: optionalString(p.status) as Any,
      isDefault: typeof p.isDefault === "boolean" ? p.isDefault : undefined,
      monthlyBudgetCost: p.monthlyBudgetCost === null ? null : optionalNumber(p.monthlyBudgetCost),
      budgetPausedAt: p.budgetPausedAt === null ? null : optionalNumber(p.budgetPausedAt),
    });
    return { company };
  });

  server.registerMethod(Methods.GOAL_LIST, async (client, params) => {
    requireScope(client, "read");
    const companyId = optionalString((params as Any)?.companyId);
    return { goals: core.listGoals(companyId) };
  });

  server.registerMethod(Methods.GOAL_GET, async (client, params) => {
    requireScope(client, "read");
    const goalId = requireString((params as Any)?.goalId, "goalId");
    const goal = core.getGoal(goalId);
    if (!goal) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Goal not found: ${goalId}` };
    }
    return { goal };
  });

  server.registerMethod(Methods.GOAL_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    return {
      goal: core.createGoal({
        companyId: optionalString(p.companyId),
        title: requireString(p.title, "title"),
        description: optionalString(p.description),
        status: optionalString(p.status) as Any,
        targetDate: optionalNumber(p.targetDate),
      }),
    };
  });

  server.registerMethod(Methods.GOAL_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    const goalId = requireString(p.goalId, "goalId");
    return {
      goal: core.updateGoal(goalId, {
        companyId: optionalString(p.companyId),
        title: optionalString(p.title),
        description: p.description === null ? "" : optionalString(p.description),
        status: optionalString(p.status) as Any,
        targetDate: p.targetDate === null ? null : optionalNumber(p.targetDate),
      }),
    };
  });

  server.registerMethod(Methods.PROJECT_LIST, async (client, params) => {
    requireScope(client, "read");
    const p = (params || {}) as Any;
    return {
      projects: core.listProjects({
        companyId: optionalString(p.companyId),
        goalId: optionalString(p.goalId),
        includeArchived: p.includeArchived === true,
      }),
    };
  });

  server.registerMethod(Methods.PROJECT_GET, async (client, params) => {
    requireScope(client, "read");
    const projectId = requireString((params as Any)?.projectId, "projectId");
    const project = core.getProject(projectId);
    if (!project) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Project not found: ${projectId}` };
    }
    return { project };
  });

  server.registerMethod(Methods.PROJECT_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    return {
      project: core.createProject({
        companyId: optionalString(p.companyId),
        goalId: optionalString(p.goalId),
        name: requireString(p.name, "name"),
        description: optionalString(p.description),
        status: optionalString(p.status) as Any,
        monthlyBudgetCost:
          p.monthlyBudgetCost === null ? null : optionalNumber(p.monthlyBudgetCost),
      }),
    };
  });

  server.registerMethod(Methods.PROJECT_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    const projectId = requireString(p.projectId, "projectId");
    return {
      project: core.updateProject(projectId, {
        companyId: optionalString(p.companyId),
        goalId: p.goalId === null ? "" : optionalString(p.goalId),
        name: optionalString(p.name),
        description: p.description === null ? "" : optionalString(p.description),
        status: optionalString(p.status) as Any,
        monthlyBudgetCost:
          p.monthlyBudgetCost === null ? null : optionalNumber(p.monthlyBudgetCost),
        archivedAt: p.archivedAt === null ? null : optionalNumber(p.archivedAt),
      }),
    };
  });

  server.registerMethod(Methods.PROJECT_WORKSPACE_LIST, async (client, params) => {
    requireScope(client, "read");
    const projectId = requireString((params as Any)?.projectId, "projectId");
    return { links: core.listProjectWorkspaces(projectId) };
  });

  server.registerMethod(Methods.PROJECT_WORKSPACE_LINK, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    return {
      link: core.linkProjectWorkspace({
        projectId: requireString(p.projectId, "projectId"),
        workspaceId: requireString(p.workspaceId, "workspaceId"),
        isPrimary: p.isPrimary === true,
      }),
    };
  });

  server.registerMethod(Methods.PROJECT_WORKSPACE_UNLINK, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    return {
      ok: core.unlinkProjectWorkspace(
        requireString(p.projectId, "projectId"),
        requireString(p.workspaceId, "workspaceId"),
      ),
    };
  });

  server.registerMethod(Methods.PROJECT_WORKSPACE_SET_PRIMARY, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    return {
      link: core.setPrimaryProjectWorkspace(
        requireString(p.projectId, "projectId"),
        requireString(p.workspaceId, "workspaceId"),
      ),
    };
  });

  server.registerMethod(Methods.ISSUE_LIST, async (client, params) => {
    requireScope(client, "read");
    const p = (params || {}) as Any;
    return {
      issues: core.listIssues({
        companyId: optionalString(p.companyId),
        goalId: optionalString(p.goalId),
        projectId: optionalString(p.projectId),
        workspaceId: optionalString(p.workspaceId),
        assigneeAgentRoleId: optionalString(p.assigneeAgentRoleId),
        status: Array.isArray(p.status)
          ? p.status.filter((value: unknown) => typeof value === "string")
          : optionalString(p.status),
        limit: optionalNumber(p.limit),
        offset: optionalNumber(p.offset),
      }),
    };
  });

  server.registerMethod(Methods.ISSUE_GET, async (client, params) => {
    requireScope(client, "read");
    const issueId = requireString((params as Any)?.issueId, "issueId");
    const issue = core.getIssue(issueId);
    if (!issue) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Issue not found: ${issueId}` };
    }
    return { issue };
  });

  server.registerMethod(Methods.ISSUE_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    return {
      issue: core.createIssue({
        companyId: optionalString(p.companyId),
        goalId: optionalString(p.goalId),
        projectId: optionalString(p.projectId),
        parentIssueId: optionalString(p.parentIssueId),
        workspaceId: optionalString(p.workspaceId),
        title: requireString(p.title, "title"),
        description: optionalString(p.description),
        status: optionalString(p.status) as Any,
        priority: optionalNumber(p.priority) as Any,
        assigneeAgentRoleId: optionalString(p.assigneeAgentRoleId),
        reporterAgentRoleId: optionalString(p.reporterAgentRoleId),
        requestDepth: optionalNumber(p.requestDepth),
        billingCode: optionalString(p.billingCode),
        metadata: typeof p.metadata === "object" && p.metadata ? p.metadata : undefined,
      }),
    };
  });

  server.registerMethod(Methods.ISSUE_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    const issueId = requireString(p.issueId, "issueId");
    return {
      issue: core.updateIssue(issueId, {
        goalId: p.goalId === null ? "" : optionalString(p.goalId),
        projectId: p.projectId === null ? "" : optionalString(p.projectId),
        parentIssueId: p.parentIssueId === null ? "" : optionalString(p.parentIssueId),
        workspaceId: p.workspaceId === null ? "" : optionalString(p.workspaceId),
        taskId: p.taskId === null ? "" : optionalString(p.taskId),
        activeRunId: p.activeRunId === null ? "" : optionalString(p.activeRunId),
        title: optionalString(p.title),
        description: p.description === null ? "" : optionalString(p.description),
        status: optionalString(p.status) as Any,
        priority: optionalNumber(p.priority) as Any,
        assigneeAgentRoleId:
          p.assigneeAgentRoleId === null ? "" : optionalString(p.assigneeAgentRoleId),
        reporterAgentRoleId:
          p.reporterAgentRoleId === null ? "" : optionalString(p.reporterAgentRoleId),
        requestDepth: p.requestDepth === null ? null : optionalNumber(p.requestDepth),
        billingCode: p.billingCode === null ? "" : optionalString(p.billingCode),
        metadata:
          p.metadata === null ? null : typeof p.metadata === "object" ? p.metadata : undefined,
        completedAt: p.completedAt === null ? null : optionalNumber(p.completedAt),
      }),
    };
  });

  server.registerMethod(Methods.ISSUE_COMMENT_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    return {
      comment: core.createIssueComment({
        issueId: requireString(p.issueId, "issueId"),
        authorType: requireString(p.authorType, "authorType") as Any,
        authorAgentRoleId: optionalString(p.authorAgentRoleId),
        body: requireString(p.body, "body"),
      }),
    };
  });

  server.registerMethod(Methods.ISSUE_COMMENT_LIST, async (client, params) => {
    requireScope(client, "read");
    const issueId = requireString((params as Any)?.issueId, "issueId");
    return { comments: core.listIssueComments(issueId) };
  });

  server.registerMethod(Methods.ISSUE_CHECKOUT, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    return core.checkoutIssue({
      issueId: requireString(p.issueId, "issueId"),
      agentRoleId: optionalString(p.agentRoleId),
      workspaceId: optionalString(p.workspaceId),
    });
  });

  server.registerMethod(Methods.ISSUE_RELEASE, async (client, params) => {
    requireScope(client, "admin");
    const p = (params || {}) as Any;
    return core.releaseIssue({
      issueId: requireString(p.issueId, "issueId"),
      runId: optionalString(p.runId),
      status: requireString(p.status, "status") as Any,
      summary: optionalString(p.summary),
      error: optionalString(p.error),
    });
  });

  server.registerMethod(Methods.RUN_LIST, async (client, params) => {
    requireScope(client, "read");
    const p = (params || {}) as Any;
    return {
      runs: core.listRuns({
        companyId: optionalString(p.companyId),
        projectId: optionalString(p.projectId),
        issueId: optionalString(p.issueId),
        agentRoleId: optionalString(p.agentRoleId),
        status: Array.isArray(p.status)
          ? p.status.filter((value: unknown) => typeof value === "string")
          : optionalString(p.status),
        limit: optionalNumber(p.limit),
        offset: optionalNumber(p.offset),
      }),
    };
  });

  server.registerMethod(Methods.RUN_GET, async (client, params) => {
    requireScope(client, "read");
    const runId = requireString((params as Any)?.runId, "runId");
    return { run: core.getRun(runId) };
  });

  server.registerMethod(Methods.RUN_EVENTS, async (client, params) => {
    requireScope(client, "read");
    const runId = requireString((params as Any)?.runId, "runId");
    return { events: core.getRunEvents(runId) };
  });

  server.registerMethod(Methods.COST_SUMMARY, async (client, params) => {
    requireScope(client, "read");
    const p = (params || {}) as Any;
    return {
      summary: core.summarizeCosts({
        scopeType: requireString(p.scopeType, "scopeType") as Any,
        scopeId: requireString(p.scopeId, "scopeId"),
        windowStart: optionalNumber(p.windowStart),
        windowEnd: optionalNumber(p.windowEnd),
      }),
    };
  });

  server.registerMethod(Methods.COST_BY_AGENT, async (client, params) => {
    requireScope(client, "read");
    const p = (params || {}) as Any;
    return {
      summary: core.summarizeCostsByAgent(
        requireString(p.agentRoleId, "agentRoleId"),
        optionalNumber(p.windowStart),
        optionalNumber(p.windowEnd),
      ),
    };
  });

  server.registerMethod(Methods.COST_BY_PROJECT, async (client, params) => {
    requireScope(client, "read");
    const p = (params || {}) as Any;
    return {
      summary: core.summarizeCostsByProject(
        requireString(p.projectId, "projectId"),
        optionalNumber(p.windowStart),
        optionalNumber(p.windowEnd),
      ),
    };
  });

  server.registerMethod(Methods.COMPANY_TEMPLATE_EXPORT, async (client, params) => {
    requireScope(client, "read");
    const companyId = requireString((params as Any)?.companyId, "companyId");
    return { template: core.exportCompanyTemplate(companyId) };
  });

  server.registerMethod(Methods.COMPANY_TEMPLATE_IMPORT, async (client, params) => {
    requireScope(client, "admin");
    const template = (params as Any)?.template;
    if (!template || typeof template !== "object") {
      throw { code: ErrorCodes.INVALID_PARAMS, message: "template is required" };
    }
    return { result: core.importCompanyTemplate(template as Any) };
  });
}
