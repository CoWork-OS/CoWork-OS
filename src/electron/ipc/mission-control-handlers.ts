import type Database from "better-sqlite3";
import { ipcMain, BrowserWindow } from "electron";
import {
  IPC_CHANNELS,
  HeartbeatConfig,
  CompanyCommandCenterSummary,
  CompanyEvidenceRef,
  CompanyExecutionMapItem,
  CompanyOperatorStatus,
  CompanyOutputContract,
  CompanyOutputFeedItem,
  CompanyReviewQueueItem,
} from "../../shared/types";
import type { Issue } from "../../shared/types";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import {
  TaskSubscriptionRepository,
  SubscriptionReason,
} from "../agents/TaskSubscriptionRepository";
import { ActivityRepository } from "../activity/ActivityRepository";
import { TaskRepository } from "../database/repositories";
import { StandupReportService } from "../reports/StandupReportService";
import { HeartbeatService } from "../agents/HeartbeatService";
import { rateLimiter } from "../utils/rate-limiter";
import { validateInput, UUIDSchema } from "../utils/validation";
import { createLogger } from "../utils/logger";
import { ControlPlaneCoreService } from "../control-plane/ControlPlaneCoreService";
import { StrategicPlannerService } from "../control-plane/StrategicPlannerService";
import { AgentCompaniesService } from "../control-plane/AgentCompaniesService";

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

function getOutputContract(metadata: unknown): CompanyOutputContract | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = metadata as Record<string, unknown>;
  const candidate =
    raw.outputContract && typeof raw.outputContract === "object"
      ? (raw.outputContract as Record<string, unknown>)
      : raw;
  if (
    typeof candidate.companyId !== "string" ||
    typeof candidate.loopType !== "string" ||
    typeof candidate.outputType !== "string" ||
    typeof candidate.valueReason !== "string"
  ) {
    return null;
  }
  return {
    companyId: candidate.companyId,
    operatorRoleId:
      typeof candidate.operatorRoleId === "string" ? candidate.operatorRoleId : undefined,
    loopType: candidate.loopType as CompanyOutputContract["loopType"],
    outputType: candidate.outputType as CompanyOutputContract["outputType"],
    sourceIssueId:
      typeof candidate.sourceIssueId === "string" ? candidate.sourceIssueId : undefined,
    sourceGoalId: typeof candidate.sourceGoalId === "string" ? candidate.sourceGoalId : undefined,
    valueReason: candidate.valueReason,
    reviewRequired: Boolean(candidate.reviewRequired),
    reviewReason:
      typeof candidate.reviewReason === "string" ? candidate.reviewReason as Any : undefined,
    evidenceRefs: Array.isArray(candidate.evidenceRefs)
      ? (candidate.evidenceRefs as CompanyEvidenceRef[])
      : [],
    companyPriority:
      typeof candidate.companyPriority === "string" ? candidate.companyPriority as Any : undefined,
    triggerReason:
      typeof candidate.triggerReason === "string" ? candidate.triggerReason : undefined,
    expectedOutputType:
      typeof candidate.expectedOutputType === "string"
        ? candidate.expectedOutputType as Any
        : undefined,
  };
}

function getCompletionNextStep(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = metadata as Record<string, unknown>;
  const completion = raw.completionContract;
  if (!completion || typeof completion !== "object") return undefined;
  const doneWhen = (completion as Record<string, unknown>).doneWhen;
  if (!Array.isArray(doneWhen) || doneWhen.length === 0) return undefined;
  return `Next: ${doneWhen[0]}`;
}

function getLatestLoopForOperator(
  outputs: CompanyOutputFeedItem[],
  operatorRoleId: string,
): CompanyOperatorStatus["activeLoop"] {
  return outputs.find((item) => item.operatorRoleId === operatorRoleId)?.loopType;
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
  const agentCompanies = new AgentCompaniesService(db, core, agentRoleRepo);
  const taskRepo = new TaskRepository(db);
  const activityRepo = new ActivityRepository(db);
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
      pulseEveryMinutes: role.pulseEveryMinutes,
      dispatchCooldownMinutes: role.dispatchCooldownMinutes,
      maxDispatchesPerDay: role.maxDispatchesPerDay,
      heartbeatProfile: role.heartbeatProfile,
      activeHours: role.activeHours,
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
    if (
      (event.type === "wake_queued" ||
        event.type === "wake_coalesced" ||
        event.type === "wake_queue_saturated" ||
        event.type === "wake_immediate_deferred") &&
      event.wake?.source !== "manual"
    ) {
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

  ipcMain.handle(IPC_CHANNELS.MC_COMPANY_PACKAGE_SOURCE_LIST, async (_, companyId?: string) => {
    return agentCompanies.listSources(companyId);
  });

  ipcMain.handle(
    IPC_CHANNELS.MC_COMPANY_PACKAGE_PREVIEW_IMPORT,
    async (_, request: import("../../shared/types").CompanyPackageImportRequest) => {
      checkRateLimit(IPC_CHANNELS.MC_COMPANY_PACKAGE_PREVIEW_IMPORT);
      return agentCompanies.previewImport(request);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MC_COMPANY_PACKAGE_IMPORT,
    async (_, request: import("../../shared/types").CompanyPackageImportRequest) => {
      checkRateLimit(IPC_CHANNELS.MC_COMPANY_PACKAGE_IMPORT);
      return agentCompanies.importPackage(request);
    },
  );

  ipcMain.handle(IPC_CHANNELS.MC_COMPANY_GRAPH_GET, async (_, companyId: string) => {
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    return agentCompanies.getResolvedGraph(validated);
  });

  ipcMain.handle(IPC_CHANNELS.MC_COMPANY_SYNC_LIST, async (_, companyId: string) => {
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    return agentCompanies.listSyncStates(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.MC_COMPANY_ORG_LINK_ROLE,
    async (
      _,
      request: {
        companyId: string;
        orgNodeId: string;
        agentRoleId: string | null;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.MC_COMPANY_ORG_LINK_ROLE);
      return agentCompanies.linkOrgNodeToAgentRole({
        companyId: validateInput(UUIDSchema, request.companyId, "company ID"),
        orgNodeId: validateInput(UUIDSchema, request.orgNodeId, "org node ID"),
        agentRoleId: request.agentRoleId
          ? validateInput(UUIDSchema, request.agentRoleId, "agent role ID")
          : null,
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.MC_COMMAND_CENTER_SUMMARY, async (_, companyId: string) => {
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    const company = core.getCompany(validated);
    if (!company) {
      throw new Error("Company not found");
    }

    const goals = core.listGoals(validated);
    const projects = core.listProjects({ companyId: validated, includeArchived: false });
    const issues = core.listIssues({ companyId: validated, limit: 5000 });
    const runs = core.listRuns({ companyId: validated, limit: 100 });
    const plannerRuns = requirePlannerService().listRuns({ companyId: validated, limit: 8 });
    const operators = agentRoleRepo.findByCompanyId(validated, false);
    const activityWorkspaceId = company.defaultWorkspaceId;
    const activities = activityWorkspaceId
      ? activityRepo.list({ workspaceId: activityWorkspaceId, limit: 100 })
      : [];
    const taskIds = (
      db
        .prepare("SELECT id FROM tasks WHERE company_id = ? ORDER BY updated_at DESC LIMIT 200")
        .all(validated) as Array<{ id: string }>
    ).map((row) => row.id);
    const tasks = taskIds.map((id) => taskRepo.findById(id)).filter(Boolean);

    const outputs: CompanyOutputFeedItem[] = [];
    const reviewQueue: CompanyReviewQueueItem[] = [];

    const pushOutput = (item: CompanyOutputFeedItem): void => {
      outputs.push(item);
      if (item.reviewRequired && item.reviewReason) {
        reviewQueue.push({
          id: `review:${item.id}`,
          title: item.title,
          createdAt: item.createdAt,
          sourceType: item.sourceType,
          reviewReason: item.reviewReason,
          outputType: item.outputType,
          companyPriority: item.companyPriority,
          summary: item.summary,
          issueId: item.issueId,
          runId: item.runId,
          taskId: item.taskId,
          operatorRoleId: item.operatorRoleId,
        });
      }
    };

    for (const run of plannerRuns) {
      const contract = getOutputContract(run.metadata);
      if (!contract) continue;
      pushOutput({
        id: `planner:${run.id}`,
        sourceType: "planner_run",
        title: run.summary || "Planner cycle",
        summary: Array.isArray((run.metadata as Any)?.suppressedOutputs)
          ? ((run.metadata as Any).suppressedOutputs as Array<{ summary?: string }>)
              .map((entry) => entry.summary)
              .filter(Boolean)
              .join(" | ")
          : undefined,
        status: run.status,
        createdAt: run.createdAt,
        operatorRoleId: contract.operatorRoleId,
        loopType: contract.loopType,
        outputType: contract.outputType,
        valueReason: contract.valueReason,
        triggerReason: contract.triggerReason,
        reviewRequired: contract.reviewRequired,
        reviewReason: contract.reviewReason,
        evidenceRefs: contract.evidenceRefs,
        companyPriority: contract.companyPriority,
        whatChanged: run.summary,
        nextStep: contract.expectedOutputType ? `Expected next output: ${contract.expectedOutputType}` : undefined,
      });
    }

    for (const issue of issues) {
      const contract = getOutputContract(issue.metadata);
      if (!contract) continue;
      pushOutput({
        id: `issue:${issue.id}`,
        sourceType: "issue",
        title: issue.title,
        summary: issue.description,
        status: issue.status,
        createdAt: issue.updatedAt,
        operatorRoleId: contract.operatorRoleId || issue.assigneeAgentRoleId,
        issueId: issue.id,
        taskId: issue.taskId,
        loopType: contract.loopType,
        outputType: contract.outputType,
        valueReason: contract.valueReason,
        triggerReason: contract.triggerReason,
        reviewRequired: contract.reviewRequired || issue.status === "review" || issue.status === "blocked",
        reviewReason:
          contract.reviewReason || (issue.status === "blocked" ? "operator_attention" : issue.status === "review" ? "strategy" : undefined),
        evidenceRefs: contract.evidenceRefs,
        companyPriority: contract.companyPriority,
        whatChanged: issue.status === "blocked" ? "Issue is blocked" : `Issue moved to ${issue.status}`,
        nextStep: getCompletionNextStep(issue.metadata),
      });
    }

    for (const activity of activities) {
      const contract = getOutputContract(activity.metadata);
      if (!contract) continue;
      pushOutput({
        id: `activity:${activity.id}`,
        sourceType: "activity",
        title: activity.title,
        summary: activity.description,
        createdAt: activity.createdAt,
        operatorRoleId: contract.operatorRoleId || activity.agentRoleId,
        taskId: typeof activity.metadata?.taskId === "string" ? activity.metadata.taskId : undefined,
        loopType: contract.loopType,
        outputType: contract.outputType,
        valueReason: contract.valueReason,
        triggerReason: contract.triggerReason,
        reviewRequired: contract.reviewRequired,
        reviewReason: contract.reviewReason,
        evidenceRefs: contract.evidenceRefs,
        companyPriority: contract.companyPriority,
      });
    }

    outputs.sort((a, b) => b.createdAt - a.createdAt);
    reviewQueue.sort((a, b) => b.createdAt - a.createdAt);

    const operatorStatuses: CompanyOperatorStatus[] = operators.map((operator) => {
      const operatorTasks = tasks.filter((task) => task?.assignedAgentRoleId === operator.id);
      const operatorRuns = runs.filter((run) => run.agentRoleId === operator.id);
      const failedRuns = operatorRuns.filter((run) => run.status === "failed").length;
      const currentBottleneck = operatorTasks.find((task) => task?.boardColumn === "review")
        ? "Pending review"
        : operatorRuns.find((run) => run.status === "failed")
          ? "Recent failed run"
          : undefined;
      return {
        agentRoleId: operator.id,
        displayName: operator.displayName,
        icon: operator.icon,
        color: operator.color,
        autonomyLevel: operator.autonomyLevel,
        operatorMandate: operator.operatorMandate,
        allowedLoopTypes: operator.allowedLoopTypes || [],
        outputTypes: operator.outputTypes || [],
        suppressionPolicy: operator.suppressionPolicy,
        maxAutonomousOutputsPerCycle: operator.maxAutonomousOutputsPerCycle,
        activeLoop: getLatestLoopForOperator(outputs, operator.id),
        lastHeartbeatAt: operator.lastHeartbeatAt,
        lastUsefulOutputAt: operator.lastUsefulOutputAt,
        heartbeatStatus: operator.heartbeatStatus,
        operatorHealthScore: operator.operatorHealthScore,
        tokenSpendUsd: operatorTasks.reduce((sum, task) => sum + Number(task?.budgetCost || 0), 0),
        failureRate: operatorRuns.length > 0 ? failedRuns / operatorRuns.length : 0,
        currentBottleneck,
      };
    });

    const executionMap: CompanyExecutionMapItem[] = issues
      .slice(0, 50)
      .map((issue) => {
        const run = issue.activeRunId ? runs.find((entry) => entry.id === issue.activeRunId) : undefined;
        const task = issue.taskId ? tasks.find((entry) => entry?.id === issue.taskId) : undefined;
        const contract = getOutputContract(issue.metadata);
        return {
          issueId: issue.id,
          issueTitle: issue.title,
          issueStatus: issue.status,
          goalId: issue.goalId,
          goalTitle: goals.find((goal) => goal.id === issue.goalId)?.title,
          projectId: issue.projectId,
          projectName: projects.find((project) => project.id === issue.projectId)?.name,
          runId: run?.id,
          runStatus: run?.status,
          taskId: task?.id,
          taskStatus: task?.status,
          outputType: contract?.outputType,
          ownerAgentRoleId: issue.assigneeAgentRoleId,
          stale: Date.now() - issue.updatedAt > 3 * 24 * 60 * 60 * 1000,
        };
      });

    const summary: CompanyCommandCenterSummary = {
      company,
      overview: {
        activeGoalCount: goals.filter((goal) => goal.status === "active").length,
        activeProjectCount: projects.filter((project) => project.status === "active").length,
        openIssueCount: issues.filter((issue) => !["done", "cancelled"].includes(issue.status)).length,
        blockedIssueCount: issues.filter((issue) => issue.status === "blocked").length,
        pendingReviewCount: reviewQueue.length,
        valuableOutputCount: outputs.length,
        operatorCount: operators.length,
        healthyOperatorCount: operatorStatuses.filter((operator) => (operator.operatorHealthScore ?? 0.7) >= 0.6).length,
      },
      operators: operatorStatuses,
      outputs: outputs.slice(0, 30),
      reviewQueue: reviewQueue.slice(0, 20),
      executionMap,
      plannerRuns,
    };

    return summary;
  });

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
