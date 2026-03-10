import type Database from "better-sqlite3";
import { ipcMain, BrowserWindow } from "electron";
import { IPC_CHANNELS, HeartbeatConfig } from "../../shared/types";
import type { Issue } from "../../shared/types";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import {
  TaskSubscriptionRepository,
  SubscriptionReason,
} from "../agents/TaskSubscriptionRepository";
import { StandupReportService } from "../reports/StandupReportService";
import { HeartbeatService } from "../agents/HeartbeatService";
import { rateLimiter } from "../utils/rate-limiter";
import { validateInput, UUIDSchema } from "../utils/validation";
import { createLogger } from "../utils/logger";
import { ControlPlaneCoreService } from "../control-plane/ControlPlaneCoreService";
import { StrategicPlannerService } from "../control-plane/StrategicPlannerService";

const logger = createLogger("MissionControl");

// Get main window for event broadcasting
let mainWindowGetter: (() => BrowserWindow | null) | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindowGetter?.() ?? null;
}

/**
 * Rate limit check helper
 */
function checkRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    throw new Error(`Rate limit exceeded for ${channel}`);
  }
}

function requireString(value: unknown, fieldName: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
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

function optionalUuid(value: unknown, fieldName: string): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return validateInput(UUIDSchema, value, fieldName);
}

/**
 * Dependencies for Mission Control handlers
 */
export interface MissionControlDeps {
  db: Database.Database;
  agentRoleRepo: AgentRoleRepository;
  taskSubscriptionRepo: TaskSubscriptionRepository;
  standupService: StandupReportService;
  heartbeatService: HeartbeatService;
  getPlannerService: () => StrategicPlannerService | null;
  getMainWindow: () => BrowserWindow | null;
}

/**
 * Set up Mission Control IPC handlers
 */
export function setupMissionControlHandlers(deps: MissionControlDeps): void {
  mainWindowGetter = deps.getMainWindow;

  const { db, agentRoleRepo, taskSubscriptionRepo, standupService, heartbeatService } = deps;
  const core = new ControlPlaneCoreService(db);
  const requirePlannerService = (): StrategicPlannerService => {
    const service = deps.getPlannerService();
    if (!service) {
      throw new Error("Strategic planner is unavailable");
    }
    return service;
  };

  // ============ Heartbeat Handlers ============

  ipcMain.handle(IPC_CHANNELS.HEARTBEAT_GET_CONFIG, async (_, agentRoleId: string) => {
    const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
    const role = agentRoleRepo.findById(validated);
    if (!role) {
      throw new Error("Agent role not found");
    }
    return {
      heartbeatEnabled: role.heartbeatEnabled,
      heartbeatIntervalMinutes: role.heartbeatIntervalMinutes,
      heartbeatStaggerOffset: role.heartbeatStaggerOffset,
      lastHeartbeatAt: role.lastHeartbeatAt,
      heartbeatStatus: role.heartbeatStatus,
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.HEARTBEAT_UPDATE_CONFIG,
    async (_, agentRoleId: string, config: HeartbeatConfig) => {
      checkRateLimit(IPC_CHANNELS.HEARTBEAT_UPDATE_CONFIG);
      const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
      const result = agentRoleRepo.updateHeartbeatConfig(validated, config);
      if (result) {
        heartbeatService.updateAgentConfig(validated, config);
        getMainWindow()?.webContents.send(IPC_CHANNELS.HEARTBEAT_EVENT, {
          type: "config_updated",
          agentRoleId: validated,
          config,
        });
      }
      return result;
    },
  );

  ipcMain.handle(IPC_CHANNELS.HEARTBEAT_TRIGGER, async (_, agentRoleId: string) => {
    checkRateLimit(IPC_CHANNELS.HEARTBEAT_TRIGGER);
    const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
    const result = await heartbeatService.triggerHeartbeat(validated);
    getMainWindow()?.webContents.send(IPC_CHANNELS.HEARTBEAT_EVENT, {
      type: "triggered",
      agentRoleId: validated,
      result,
    });
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.HEARTBEAT_GET_STATUS, async (_, agentRoleId: string) => {
    const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
    return heartbeatService.getStatus(validated);
  });

  ipcMain.handle(IPC_CHANNELS.HEARTBEAT_GET_ALL_STATUS, async () => {
    return heartbeatService.getAllStatus();
  });

  // Forward heartbeat events to renderer
  heartbeatService.on("heartbeat", (event) => {
    if (event.type === "no_work" && event.result?.silent) {
      return;
    }
    getMainWindow()?.webContents.send(IPC_CHANNELS.HEARTBEAT_EVENT, event);
  });

  // ============ Task Subscription Handlers ============

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_LIST, async (_, taskId: string) => {
    const validated = validateInput(UUIDSchema, taskId, "task ID");
    return taskSubscriptionRepo.getSubscribers(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_ADD,
    async (_, taskId: string, agentRoleId: string, reason: SubscriptionReason) => {
      checkRateLimit(IPC_CHANNELS.SUBSCRIPTION_ADD);
      const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
      const validatedAgentRoleId = validateInput(UUIDSchema, agentRoleId, "agent role ID");
      const subscription = taskSubscriptionRepo.subscribe(
        validatedTaskId,
        validatedAgentRoleId,
        reason,
      );
      getMainWindow()?.webContents.send(IPC_CHANNELS.SUBSCRIPTION_EVENT, {
        type: "added",
        subscription,
      });
      return subscription;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_REMOVE,
    async (_, taskId: string, agentRoleId: string) => {
      checkRateLimit(IPC_CHANNELS.SUBSCRIPTION_REMOVE);
      const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
      const validatedAgentRoleId = validateInput(UUIDSchema, agentRoleId, "agent role ID");
      const success = taskSubscriptionRepo.unsubscribe(validatedTaskId, validatedAgentRoleId);
      if (success) {
        getMainWindow()?.webContents.send(IPC_CHANNELS.SUBSCRIPTION_EVENT, {
          type: "removed",
          taskId: validatedTaskId,
          agentRoleId: validatedAgentRoleId,
        });
      }
      return { success };
    },
  );

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_GET_SUBSCRIBERS, async (_, taskId: string) => {
    const validated = validateInput(UUIDSchema, taskId, "task ID");
    return taskSubscriptionRepo.getSubscribers(validated);
  });

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_GET_FOR_AGENT, async (_, agentRoleId: string) => {
    const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
    return taskSubscriptionRepo.getSubscriptionsForAgent(validated);
  });

  // ============ Standup Report Handlers ============

  ipcMain.handle(IPC_CHANNELS.STANDUP_GENERATE, async (_, workspaceId: string) => {
    checkRateLimit(IPC_CHANNELS.STANDUP_GENERATE);
    const validated = validateInput(UUIDSchema, workspaceId, "workspace ID");
    return standupService.generateReport(validated);
  });

  ipcMain.handle(IPC_CHANNELS.STANDUP_GET_LATEST, async (_, workspaceId: string) => {
    const validated = validateInput(UUIDSchema, workspaceId, "workspace ID");
    return standupService.getLatest(validated);
  });

  ipcMain.handle(IPC_CHANNELS.STANDUP_LIST, async (_, workspaceId: string, limit?: number) => {
    const validated = validateInput(UUIDSchema, workspaceId, "workspace ID");
    return standupService.list({ workspaceId: validated, limit });
  });

  ipcMain.handle(
    IPC_CHANNELS.STANDUP_DELIVER,
    async (_, reportId: string, channelType: string, channelId: string) => {
      checkRateLimit(IPC_CHANNELS.STANDUP_DELIVER);
      const validatedReportId = validateInput(UUIDSchema, reportId, "report ID");
      const report = standupService.findById(validatedReportId);
      if (!report) {
        throw new Error("Standup report not found");
      }
      await standupService.deliverReport(report, { channelType, channelId });
      return { success: true };
    },
  );

  // ============ Company Ops / Planner ============

  ipcMain.handle(IPC_CHANNELS.MC_COMPANY_LIST, async () => {
    return core.listCompanies();
  });

  ipcMain.handle(IPC_CHANNELS.MC_COMPANY_GET, async (_, companyId: string) => {
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    return core.getCompany(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.MC_COMPANY_CREATE,
    async (
      _,
      request: {
        name: string;
        slug?: string;
        description?: string;
        status?: "active" | "inactive" | "suspended";
        isDefault?: boolean;
        monthlyBudgetCost?: number | null;
        budgetPausedAt?: number | null;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.MC_COMPANY_CREATE);
      return core.createCompany({
        name: requireString(request.name, "company name"),
        slug: optionalString(request.slug),
        description:
          request.description === null ? undefined : optionalString(request.description),
        status: optionalString(request.status) as "active" | "inactive" | "suspended" | undefined,
        isDefault: typeof request.isDefault === "boolean" ? request.isDefault : undefined,
        monthlyBudgetCost:
          request.monthlyBudgetCost === null ? null : optionalNumber(request.monthlyBudgetCost),
        budgetPausedAt: request.budgetPausedAt === null ? null : optionalNumber(request.budgetPausedAt),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MC_COMPANY_UPDATE,
    async (
      _,
      request: {
        companyId: string;
        name?: string;
        slug?: string;
        description?: string;
        status?: "active" | "inactive" | "suspended";
        isDefault?: boolean;
        monthlyBudgetCost?: number | null;
        budgetPausedAt?: number | null;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.MC_COMPANY_UPDATE);
      const validated = validateInput(UUIDSchema, request.companyId, "company ID");
      return core.updateCompany(validated, {
        name: optionalString(request.name),
        slug: optionalString(request.slug),
        description:
          request.description === null ? "" : optionalString(request.description),
        status: optionalString(request.status) as "active" | "inactive" | "suspended" | undefined,
        isDefault: typeof request.isDefault === "boolean" ? request.isDefault : undefined,
        monthlyBudgetCost:
          request.monthlyBudgetCost === null ? null : optionalNumber(request.monthlyBudgetCost),
        budgetPausedAt: request.budgetPausedAt === null ? null : optionalNumber(request.budgetPausedAt),
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.MC_GOAL_LIST, async (_, companyId: string) => {
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    return core.listGoals(validated);
  });

  ipcMain.handle(IPC_CHANNELS.MC_GOAL_GET, async (_, goalId: string) => {
    const validated = validateInput(UUIDSchema, goalId, "goal ID");
    return core.getGoal(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.MC_GOAL_CREATE,
    async (
      _,
      request: {
        companyId?: string;
        title: string;
        description?: string;
        status?: "active" | "completed" | "cancelled" | "archived";
        targetDate?: number | null;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.MC_GOAL_CREATE);
      return core.createGoal({
        companyId: optionalUuid(request.companyId, "company ID"),
        title: requireString(request.title, "goal title"),
        description:
          request.description === null ? undefined : optionalString(request.description),
        status: optionalString(request.status) as
          | "active"
          | "completed"
          | "cancelled"
          | "archived"
          | undefined,
        targetDate: request.targetDate === null ? undefined : optionalNumber(request.targetDate),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MC_GOAL_UPDATE,
    async (
      _,
      request: {
        goalId: string;
        companyId?: string;
        title?: string;
        description?: string;
        status?: "active" | "completed" | "cancelled" | "archived";
        targetDate?: number | null;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.MC_GOAL_UPDATE);
      const validated = validateInput(UUIDSchema, request.goalId, "goal ID");
      return core.updateGoal(validated, {
        companyId: optionalUuid(request.companyId, "company ID"),
        title: optionalString(request.title),
        description: request.description === null ? "" : optionalString(request.description),
        status: optionalString(request.status) as
          | "active"
          | "completed"
          | "cancelled"
          | "archived"
          | undefined,
        targetDate: request.targetDate === null ? null : optionalNumber(request.targetDate),
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.MC_PROJECT_LIST, async (_, companyId: string) => {
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    return core.listProjects({ companyId: validated });
  });

  ipcMain.handle(IPC_CHANNELS.MC_PROJECT_GET, async (_, projectId: string) => {
    const validated = validateInput(UUIDSchema, projectId, "project ID");
    return core.getProject(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.MC_PROJECT_CREATE,
    async (
      _,
      request: {
        companyId?: string;
        goalId?: string;
        name: string;
        description?: string;
        status?: "active" | "paused" | "completed" | "archived";
        monthlyBudgetCost?: number | null;
        archivedAt?: number | null;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.MC_PROJECT_CREATE);
      return core.createProject({
        companyId: optionalUuid(request.companyId, "company ID"),
        goalId: optionalUuid(request.goalId, "goal ID"),
        name: requireString(request.name, "project name"),
        description:
          request.description === null ? undefined : optionalString(request.description),
        status: optionalString(request.status) as
          | "active"
          | "paused"
          | "completed"
          | "archived"
          | undefined,
        monthlyBudgetCost:
          request.monthlyBudgetCost === null ? null : optionalNumber(request.monthlyBudgetCost),
        archivedAt: request.archivedAt === null ? null : optionalNumber(request.archivedAt),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MC_PROJECT_UPDATE,
    async (
      _,
      request: {
        projectId: string;
        companyId?: string;
        goalId?: string | null;
        name?: string;
        description?: string;
        status?: "active" | "paused" | "completed" | "archived";
        monthlyBudgetCost?: number | null;
        archivedAt?: number | null;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.MC_PROJECT_UPDATE);
      const validated = validateInput(UUIDSchema, request.projectId, "project ID");
      return core.updateProject(validated, {
        companyId: optionalUuid(request.companyId, "company ID"),
        goalId:
          request.goalId === null ? null : optionalUuid(request.goalId, "goal ID"),
        name: optionalString(request.name),
        description: request.description === null ? "" : optionalString(request.description),
        status: optionalString(request.status) as
          | "active"
          | "paused"
          | "completed"
          | "archived"
          | undefined,
        monthlyBudgetCost:
          request.monthlyBudgetCost === null ? null : optionalNumber(request.monthlyBudgetCost),
        archivedAt: request.archivedAt === null ? null : optionalNumber(request.archivedAt),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MC_ISSUE_LIST,
    async (_, params: { companyId: string; limit?: number }) => {
      const validated = validateInput(UUIDSchema, params.companyId, "company ID");
      return core.listIssues({ companyId: validated, limit: params.limit });
    },
  );

  ipcMain.handle(IPC_CHANNELS.MC_ISSUE_GET, async (_, issueId: string) => {
    const validated = validateInput(UUIDSchema, issueId, "issue ID");
    return core.getIssue(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.MC_ISSUE_CREATE,
    async (
      _,
      request: {
        companyId?: string;
        goalId?: string;
        projectId?: string;
        parentIssueId?: string;
        workspaceId?: string;
        taskId?: string;
        activeRunId?: string;
        title: string;
        description?: string;
        status?:
          | "backlog"
          | "todo"
          | "in_progress"
          | "review"
          | "blocked"
          | "done"
          | "cancelled";
        priority?: number;
        assigneeAgentRoleId?: string;
        reporterAgentRoleId?: string;
        requestDepth?: number | null;
        billingCode?: string;
        metadata?: Record<string, unknown> | null;
        completedAt?: number | null;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.MC_ISSUE_CREATE);
      return core.createIssue({
        companyId: optionalUuid(request.companyId, "company ID"),
        goalId: optionalUuid(request.goalId, "goal ID"),
        projectId: optionalUuid(request.projectId, "project ID"),
        parentIssueId: optionalUuid(request.parentIssueId, "parent issue ID"),
        workspaceId: optionalUuid(request.workspaceId, "workspace ID"),
        taskId: optionalUuid(request.taskId, "task ID"),
        activeRunId: optionalUuid(request.activeRunId, "run ID"),
        title: requireString(request.title, "issue title"),
        description:
          request.description === null ? undefined : optionalString(request.description),
        status: optionalString(request.status) as Issue["status"] | undefined,
        priority: optionalNumber(request.priority),
        assigneeAgentRoleId: optionalUuid(request.assigneeAgentRoleId, "assignee agent role ID"),
        reporterAgentRoleId: optionalUuid(request.reporterAgentRoleId, "reporter agent role ID"),
        requestDepth: request.requestDepth === null ? undefined : optionalNumber(request.requestDepth),
        billingCode: optionalString(request.billingCode),
        metadata:
          request.metadata && typeof request.metadata === "object" ? request.metadata : undefined,
        completedAt: request.completedAt === null ? undefined : optionalNumber(request.completedAt),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MC_ISSUE_UPDATE,
    async (
      _,
      request: {
        issueId: string;
        goalId?: string | null;
        projectId?: string | null;
        parentIssueId?: string | null;
        workspaceId?: string | null;
        taskId?: string | null;
        activeRunId?: string | null;
        title?: string;
        description?: string;
        status?:
          | "backlog"
          | "todo"
          | "in_progress"
          | "review"
          | "blocked"
          | "done"
          | "cancelled";
        priority?: number;
        assigneeAgentRoleId?: string | null;
        reporterAgentRoleId?: string | null;
        requestDepth?: number | null;
        billingCode?: string;
        metadata?: Record<string, unknown> | null;
        completedAt?: number | null;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.MC_ISSUE_UPDATE);
      const validated = validateInput(UUIDSchema, request.issueId, "issue ID");
      return core.updateIssue(validated, {
        goalId: request.goalId === null ? null : optionalUuid(request.goalId, "goal ID"),
        projectId: request.projectId === null ? null : optionalUuid(request.projectId, "project ID"),
        parentIssueId:
          request.parentIssueId === null
            ? null
            : optionalUuid(request.parentIssueId, "parent issue ID"),
        workspaceId:
          request.workspaceId === null ? null : optionalUuid(request.workspaceId, "workspace ID"),
        taskId: request.taskId === null ? null : optionalUuid(request.taskId, "task ID"),
        activeRunId: request.activeRunId === null ? null : optionalUuid(request.activeRunId, "run ID"),
        title: optionalString(request.title),
        description: request.description === null ? "" : optionalString(request.description),
        status: optionalString(request.status) as Issue["status"] | undefined,
        priority: optionalNumber(request.priority),
        assigneeAgentRoleId:
          request.assigneeAgentRoleId === null
            ? null
            : optionalUuid(request.assigneeAgentRoleId, "assignee agent role ID"),
        reporterAgentRoleId:
          request.reporterAgentRoleId === null
            ? null
            : optionalUuid(request.reporterAgentRoleId, "reporter agent role ID"),
        requestDepth: request.requestDepth === null ? null : optionalNumber(request.requestDepth),
        billingCode: optionalString(request.billingCode),
        metadata:
          request.metadata === null
            ? null
            : request.metadata && typeof request.metadata === "object"
              ? request.metadata
              : undefined,
        completedAt: request.completedAt === null ? null : optionalNumber(request.completedAt),
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.MC_ISSUE_COMMENT_LIST, async (_, issueId: string) => {
    const validated = validateInput(UUIDSchema, issueId, "issue ID");
    return core.listIssueComments(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.MC_RUN_LIST,
    async (_, params: { companyId: string; issueId?: string; limit?: number }) => {
      const validatedCompanyId = validateInput(UUIDSchema, params.companyId, "company ID");
      const validatedIssueId =
        typeof params.issueId === "string" && params.issueId.trim().length > 0
          ? validateInput(UUIDSchema, params.issueId, "issue ID")
          : undefined;
      return core.listRuns({
        companyId: validatedCompanyId,
        issueId: validatedIssueId,
        limit: params.limit,
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.MC_RUN_EVENT_LIST, async (_, runId: string) => {
    const validated = validateInput(UUIDSchema, runId, "run ID");
    return core.getRunEvents(validated);
  });

  ipcMain.handle(IPC_CHANNELS.MC_PLANNER_GET_CONFIG, async (_, companyId: string) => {
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    return requirePlannerService().getConfig(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.MC_PLANNER_UPDATE_CONFIG,
    async (
      _,
      request: {
        companyId: string;
        enabled?: boolean;
        intervalMinutes?: number;
        planningWorkspaceId?: string | null;
        plannerAgentRoleId?: string | null;
        autoDispatch?: boolean;
        approvalPreset?: "manual" | "safe_autonomy" | "founder_edge";
        maxIssuesPerRun?: number;
        staleIssueDays?: number;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.MC_PLANNER_UPDATE_CONFIG);
      const validated = validateInput(UUIDSchema, request.companyId, "company ID");
      return requirePlannerService().updateConfig(validated, request);
    },
  );

  ipcMain.handle(IPC_CHANNELS.MC_PLANNER_RUN, async (_, companyId: string) => {
    checkRateLimit(IPC_CHANNELS.MC_PLANNER_RUN);
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    return requirePlannerService().runNow({ companyId: validated, trigger: "manual" });
  });

  ipcMain.handle(
    IPC_CHANNELS.MC_PLANNER_LIST_RUNS,
    async (_, params: { companyId: string; limit?: number }) => {
      const validated = validateInput(UUIDSchema, params.companyId, "company ID");
      return requirePlannerService().listRuns({ companyId: validated, limit: params.limit });
    },
  );

  logger.debug("Handlers initialized");
}
