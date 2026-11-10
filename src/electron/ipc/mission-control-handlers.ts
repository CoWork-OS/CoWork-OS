import {
  CoreFailureClusterRepository,
  CoreFailureRecordRepository,
} from "../core/core-repository-facades";
import {
  AgentRoleRepository,
  AutomationProfileRepository,
  TaskSubscriptionRepository,
} from "../agents/agent-repository-facades";
import { TaskRepository } from "../database/repository-facades";
import type Database from "better-sqlite3";
import { ipcMain, BrowserWindow } from "electron";
import {
  IPC_CHANNELS,
  CoreEvalCase,
  CoreFailureCluster,
  CoreFailureRecord,
  CoreHarnessExperiment,
  CoreLearningsEntry,
  CompanyCommandCenterSummary,
  CompanyEvidenceRef,
  CompanyExecutionMapItem,
  CompanyOperatorStatus,
  CompanyOutputContract,
  CompanyOutputFeedItem,
  CompanyReviewQueueItem,
  MissionControlBrief,
  MissionControlItem,
  MissionControlItemEvidence,
  MissionControlListRequest,
  MissionControlScopeRequest,
} from "../../shared/types";

import { ActivityRepository } from "../activity/activity-repository-facades";

import { HeartbeatService } from "../agents/HeartbeatService";
import { rateLimiter } from "../utils/rate-limiter";
import { validateInput, UUIDSchema } from "../utils/validation";
import { createLogger } from "../utils/logger";
import { ControlPlaneCoreService } from "../control-plane/ControlPlaneCoreService";
import { StrategicPlannerService } from "../control-plane/StrategicPlannerService";

import { CoreTraceService } from "../core/CoreTraceService";
import { CoreMemoryDistiller } from "../core/CoreMemoryDistiller";

import { CoreFailureMiningService } from "../core/CoreFailureMiningService";
import { CoreFailureClusterService } from "../core/CoreFailureClusterService";
import { CoreEvalCaseService } from "../core/CoreEvalCaseService";
import { CoreHarnessExperimentService } from "../core/CoreHarnessExperimentService";
import { CoreHarnessExperimentRunner } from "../core/CoreHarnessExperimentRunner";
import { CoreLearningsService } from "../core/CoreLearningsService";
import { MissionControlIntelligenceService } from "../mission-control/mission-control-repository-facades";
import { AutomationRunOutcomeRepository } from "../automation/automation-outcome-repository-facades";
import { AutomationOutcomeService } from "../automation/AutomationOutcomeService";
import {
  CoreEvalCaseListRequestSchema,
  CoreExperimentListRequestSchema,
  CoreFailureClusterListRequestSchema,
  CoreFailureRecordListRequestSchema,
  CoreLearningsListRequestSchema,
} from "../utils/validation";

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
      typeof candidate.reviewReason === "string" ? (candidate.reviewReason as Any) : undefined,
    evidenceRefs: Array.isArray(candidate.evidenceRefs)
      ? (candidate.evidenceRefs as CompanyEvidenceRef[])
      : [],
    companyPriority:
      typeof candidate.companyPriority === "string"
        ? (candidate.companyPriority as Any)
        : undefined,
    triggerReason:
      typeof candidate.triggerReason === "string" ? candidate.triggerReason : undefined,
    expectedOutputType:
      typeof candidate.expectedOutputType === "string"
        ? (candidate.expectedOutputType as Any)
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

function getIssueOrigin(metadata: unknown): {
  origin: "planner" | "inbox" | "manual";
  label?: string;
} {
  if (!metadata || typeof metadata !== "object") {
    return { origin: "manual" };
  }
  const raw = metadata as Record<string, unknown>;
  const source = typeof raw.source === "string" ? raw.source : "";
  if (source === "mailbox_handoff") {
    return { origin: "inbox", label: "Inbox" };
  }
  if (source === "strategic_planner") {
    return { origin: "planner", label: "Planner" };
  }
  return { origin: "manual" };
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
  heartbeatService: HeartbeatService;
  getPlannerService: () => StrategicPlannerService | null;
  getMainWindow: () => BrowserWindow | null;
  coreTraceService: CoreTraceService;
  coreMemoryDistiller: CoreMemoryDistiller;
  coreFailureMiningService: CoreFailureMiningService;
  coreFailureClusterService: CoreFailureClusterService;
  coreEvalCaseService: CoreEvalCaseService;
  coreHarnessExperimentService: CoreHarnessExperimentService;
  coreHarnessExperimentRunner: CoreHarnessExperimentRunner;
  coreLearningsService: CoreLearningsService;
  automationOutcomeService?: AutomationOutcomeService | null;
}

/**
 * Set up Mission Control IPC handlers
 */
export function setupMissionControlHandlers(deps: MissionControlDeps): void {
  mainWindowGetter = deps.getMainWindow;

  const { db, agentRoleRepo, heartbeatService } = deps;
  const core = new ControlPlaneCoreService(db);
  const automationProfileRepo = new AutomationProfileRepository(db);
  const coreFailureRecordRepo = new CoreFailureRecordRepository(db);
  const coreFailureClusterRepo = new CoreFailureClusterRepository(db);
  const missionControlIntelligence = new MissionControlIntelligenceService(db);
  const automationOutcomeRepo = new AutomationRunOutcomeRepository(db);
  const taskRepo = new TaskRepository(db);
  const activityRepo = new ActivityRepository(db);
  const requirePlannerService = (): StrategicPlannerService => {
    const service = deps.getPlannerService();
    if (!service) {
      throw new Error("Strategic planner is unavailable");
    }
    return service;
  };

  ipcMain.handle(IPC_CHANNELS.MC_AUTOMATION_OUTCOME_RETRY, async (_, outcomeId: string) => {
    const id = requireString(outcomeId, "outcomeId").slice(0, 160);
    if (!deps.automationOutcomeService) {
      throw new Error("Automation outcome service is unavailable.");
    }
    return deps.automationOutcomeService.retryNotification(id);
  });

  // ============ Mission Control Intelligence Handlers ============

  ipcMain.handle(
    IPC_CHANNELS.MISSION_CONTROL_LIST_ITEMS,
    async (_, request?: MissionControlListRequest): Promise<MissionControlItem[]> => {
      return missionControlIntelligence.listItems(request || {});
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MISSION_CONTROL_GET_ITEM_EVIDENCE,
    async (_, itemId: string): Promise<MissionControlItemEvidence[]> => {
      return missionControlIntelligence.getEvidence(
        requireString(itemId, "Mission Control item ID"),
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MISSION_CONTROL_REFRESH,
    async (_, request?: MissionControlScopeRequest): Promise<MissionControlBrief> => {
      checkRateLimit(IPC_CHANNELS.MISSION_CONTROL_REFRESH);
      return missionControlIntelligence.refresh(request || {});
    },
  );

  // ============ Heartbeat Handlers ============

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

  ipcMain.handle(IPC_CHANNELS.HEARTBEAT_GET_ALL_STATUS, async () => {
    return heartbeatService.getAllStatus();
  });

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_PROFILE_LIST, async () => {
    return automationProfileRepo.listAll();
  });

  ipcMain.handle(
    IPC_CHANNELS.CORE_FAILURE_LIST,
    async (_, request?: unknown): Promise<CoreFailureRecord[]> => {
      const validated = request
        ? validateInput(
            CoreFailureRecordListRequestSchema,
            request,
            "core failure record list request",
          )
        : {};
      if (validated.traceId) {
        await deps.coreFailureMiningService.mineTrace(validated.traceId);
      }
      return coreFailureRecordRepo.list(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_FAILURE_CLUSTER_LIST,
    async (_, request?: unknown): Promise<CoreFailureCluster[]> => {
      const validated = request
        ? validateInput(
            CoreFailureClusterListRequestSchema,
            request,
            "core failure cluster list request",
          )
        : {};
      await deps.coreFailureClusterService.clusterFailures(
        validated.profileId,
        validated.workspaceId,
      );
      return coreFailureClusterRepo.list(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_EVAL_CASE_LIST,
    async (_, request?: unknown): Promise<CoreEvalCase[]> => {
      const validated = request
        ? validateInput(CoreEvalCaseListRequestSchema, request, "core eval case list request")
        : {};
      return deps.coreEvalCaseService.listEvalCases(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_EXPERIMENT_LIST,
    async (_, request?: unknown): Promise<CoreHarnessExperiment[]> => {
      const validated = request
        ? validateInput(CoreExperimentListRequestSchema, request, "core experiment list request")
        : {};
      return deps.coreHarnessExperimentService.listExperiments(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_LEARNINGS_LIST,
    async (_, request?: unknown): Promise<CoreLearningsEntry[]> => {
      const validated = request
        ? validateInput(CoreLearningsListRequestSchema, request, "core learnings list request")
        : {};
      return deps.coreLearningsService.list(validated);
    },
  );

  // Forward heartbeat events to renderer
  heartbeatService.on("heartbeat", (event) => {
    // Projection runs in its own unit; the event is forwarded without waiting for it.
    void missionControlIntelligence.recordHeartbeatEvent(event).catch((error: unknown) => {
      logger.warn("Failed to project heartbeat event into Mission Control:", error);
    });
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

  // ============ Company Ops / Planner ============

  ipcMain.handle(IPC_CHANNELS.MC_COMPANY_LIST, async () => {
    return core.listCompanies();
  });

  ipcMain.handle(IPC_CHANNELS.MC_COMMAND_CENTER_SUMMARY, async (_, companyId: string) => {
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    const company = await core.getCompany(validated);
    if (!company) {
      throw new Error("Company not found");
    }

    const goals = await core.listGoals(validated);
    const projects = await core.listProjects({ companyId: validated, includeArchived: false });
    const issues = await core.listIssues({ companyId: validated, limit: 5000 });
    const runs = await core.listRuns({ companyId: validated, limit: 100 });
    const plannerRuns = await requirePlannerService().listRuns({ companyId: validated, limit: 8 });
    const automationOutcomes = await automationOutcomeRepo.list({
      companyId: validated,
      limit: 12,
    });
    const automationOutcomeSummary = await automationOutcomeRepo.summarize({
      companyId: validated,
    });
    const operators = await agentRoleRepo.findByCompanyId(validated, false);
    const activityWorkspaceId = company.defaultWorkspaceId;
    const activities = activityWorkspaceId
      ? await activityRepo.list({ workspaceId: activityWorkspaceId, limit: 100 })
      : [];
    const taskIds = await taskRepo.findIdsByCompany(validated, 200);
    const tasks = (await Promise.all(taskIds.map((id) => taskRepo.findById(id)))).filter(Boolean);

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
          origin: item.origin,
          originLabel: item.originLabel,
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
        origin: "planner",
        originLabel: "Planner",
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
        nextStep: contract.expectedOutputType
          ? `Expected next output: ${contract.expectedOutputType}`
          : undefined,
      });
    }

    for (const issue of issues) {
      const contract = getOutputContract(issue.metadata);
      if (!contract) continue;
      const origin = getIssueOrigin(issue.metadata);
      pushOutput({
        id: `issue:${issue.id}`,
        sourceType: "issue",
        origin: origin.origin,
        originLabel: origin.label,
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
        reviewRequired:
          contract.reviewRequired || issue.status === "review" || issue.status === "blocked",
        reviewReason:
          contract.reviewReason ||
          (issue.status === "blocked"
            ? "operator_attention"
            : issue.status === "review"
              ? "strategy"
              : undefined),
        evidenceRefs: contract.evidenceRefs,
        companyPriority: contract.companyPriority,
        whatChanged:
          issue.status === "blocked" ? "Issue is blocked" : `Issue moved to ${issue.status}`,
        nextStep: getCompletionNextStep(issue.metadata),
      });
    }

    for (const activity of activities) {
      const contract = getOutputContract(activity.metadata);
      if (!contract) continue;
      pushOutput({
        id: `activity:${activity.id}`,
        sourceType: "activity",
        origin: "activity",
        title: activity.title,
        summary: activity.description,
        createdAt: activity.createdAt,
        operatorRoleId: contract.operatorRoleId || activity.agentRoleId,
        taskId:
          typeof activity.metadata?.taskId === "string" ? activity.metadata.taskId : undefined,
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

    const executionMap: CompanyExecutionMapItem[] = issues.slice(0, 50).map((issue) => {
      const run = issue.activeRunId
        ? runs.find((entry) => entry.id === issue.activeRunId)
        : undefined;
      const task = issue.taskId ? tasks.find((entry) => entry?.id === issue.taskId) : undefined;
      const contract = getOutputContract(issue.metadata);
      const origin = getIssueOrigin(issue.metadata);
      return {
        issueId: issue.id,
        issueTitle: issue.title,
        issueStatus: issue.status,
        origin: origin.origin,
        originLabel: origin.label,
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
        openIssueCount: issues.filter((issue) => !["done", "cancelled"].includes(issue.status))
          .length,
        blockedIssueCount: issues.filter((issue) => issue.status === "blocked").length,
        pendingReviewCount: reviewQueue.length,
        valuableOutputCount: outputs.length,
        operatorCount: operators.length,
        healthyOperatorCount: operatorStatuses.filter(
          (operator) => (operator.operatorHealthScore ?? 0.7) >= 0.6,
        ).length,
      },
      operators: operatorStatuses,
      outputs: outputs.slice(0, 30),
      reviewQueue: reviewQueue.slice(0, 20),
      executionMap,
      plannerRuns,
      automationOutcomes,
      automationOutcomeSummary,
    };

    return summary;
  });

  ipcMain.handle(IPC_CHANNELS.MC_GOAL_LIST, async (_, companyId: string) => {
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    return core.listGoals(validated);
  });

  ipcMain.handle(IPC_CHANNELS.MC_PROJECT_LIST, async (_, companyId: string) => {
    const validated = validateInput(UUIDSchema, companyId, "company ID");
    return core.listProjects({ companyId: validated });
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
        description: request.description === null ? undefined : optionalString(request.description),
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
