import type Database from "better-sqlite3";
import { ipcMain, BrowserWindow } from "electron";
import {
  IPC_CHANNELS,
  CoreEvalCase,
  CoreFailureCluster,
  CoreFailureRecord,
  CoreHarnessExperiment,
  CoreLearningsEntry,
  CoreTrace,
  CoreMemoryCandidate,
  CoreMemoryDistillRun,
  HeartbeatConfig,
  CompanyCommandCenterSummary,
  CompanyEvidenceRef,
  CompanyExecutionMapItem,
  CompanyOperatorStatus,
  CompanyOutputContract,
  CompanyOutputFeedItem,
  CompanyReviewQueueItem,
  SymphonyConfigUpdate,
  MissionControlBrief,
  MissionControlItem,
  MissionControlItemEvidence,
  MissionControlListRequest,
  MissionControlScopeRequest,
} from "../../shared/types";
import type { Issue } from "../../shared/types";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { AutomationProfileRepository } from "../agents/AutomationProfileRepository";
import { HeartbeatRunRepository } from "../agents/HeartbeatRunRepository";
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
import { SymphonyService } from "../control-plane/SymphonyService";
import { AgentCompaniesService } from "../control-plane/AgentCompaniesService";
import { SubconsciousRunRepository } from "../subconscious/SubconsciousRepositories";
import { CoreMemoryCandidateRepository } from "../core/CoreMemoryCandidateRepository";
import { CoreMemoryDistillRunRepository } from "../core/CoreMemoryDistillRunRepository";
import { CoreTraceRepository } from "../core/CoreTraceRepository";
import { CoreTraceService } from "../core/CoreTraceService";
import { CoreMemoryDistiller } from "../core/CoreMemoryDistiller";
import { CoreFailureRecordRepository } from "../core/CoreFailureRecordRepository";
import { CoreFailureClusterRepository } from "../core/CoreFailureClusterRepository";
import { CoreFailureMiningService } from "../core/CoreFailureMiningService";
import { CoreFailureClusterService } from "../core/CoreFailureClusterService";
import { CoreEvalCaseService } from "../core/CoreEvalCaseService";
import { CoreHarnessExperimentService } from "../core/CoreHarnessExperimentService";
import { CoreHarnessExperimentRunner } from "../core/CoreHarnessExperimentRunner";
import { CoreLearningsService } from "../core/CoreLearningsService";
import { MissionControlIntelligenceService } from "../mission-control/MissionControlIntelligenceService";
import {
  AutomationProfileAttachRequestSchema,
  AutomationProfileCreateRequestSchema,
  AutomationProfileUpdateRequestSchema,
  CoreEvalCaseListRequestSchema,
  CoreEvalCaseReviewSchema,
  CoreExperimentListRequestSchema,
  CoreExperimentReviewSchema,
  CoreExperimentRunSchema,
  CoreFailureClusterListRequestSchema,
  CoreFailureClusterReviewSchema,
  CoreFailureRecordListRequestSchema,
  HeartbeatConfigSchema,
  CoreLearningsListRequestSchema,
  CoreMemoryCandidateListRequestSchema,
  CoreMemoryCandidateReviewSchema,
  CoreMemoryDistillRunNowSchema,
  CoreTraceListRequestSchema,
  StandupDeliveryRequestSchema,
  StringIdSchema,
} from "../utils/validation";

const logger = createLogger("MissionControl");
type Any = any;

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
  standupService: StandupReportService;
  heartbeatService: HeartbeatService;
  getPlannerService: () => StrategicPlannerService | null;
  getSymphonyService: () => SymphonyService | null;
  getMainWindow: () => BrowserWindow | null;
  coreTraceService: CoreTraceService;
  coreMemoryDistiller: CoreMemoryDistiller;
  coreFailureMiningService: CoreFailureMiningService;
  coreFailureClusterService: CoreFailureClusterService;
  coreEvalCaseService: CoreEvalCaseService;
  coreHarnessExperimentService: CoreHarnessExperimentService;
  coreHarnessExperimentRunner: CoreHarnessExperimentRunner;
  coreLearningsService: CoreLearningsService;
}

/**
 * Set up Mission Control IPC handlers
 */
export function setupMissionControlHandlers(deps: MissionControlDeps): void {
  mainWindowGetter = deps.getMainWindow;

  const { db, agentRoleRepo, taskSubscriptionRepo, standupService, heartbeatService } = deps;
  const core = new ControlPlaneCoreService(db);
  const automationProfileRepo = new AutomationProfileRepository(db);
  const heartbeatRunRepo = new HeartbeatRunRepository(db);
  const subconsciousRunRepo = new SubconsciousRunRepository(db);
  const coreTraceRepo = new CoreTraceRepository(db);
  const coreFailureRecordRepo = new CoreFailureRecordRepository(db);
  const coreFailureClusterRepo = new CoreFailureClusterRepository(db);
  const coreMemoryCandidateRepo = new CoreMemoryCandidateRepository(db);
  const coreMemoryDistillRunRepo = new CoreMemoryDistillRunRepository(db);
  const missionControlIntelligence = new MissionControlIntelligenceService(db);
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
  const requireSymphonyService = (): SymphonyService => {
    const service = deps.getSymphonyService();
    if (!service) {
      throw new Error("Symphony service is unavailable");
    }
    return service;
  };

  // ============ Mission Control Intelligence Handlers ============

  ipcMain.handle(
    IPC_CHANNELS.MISSION_CONTROL_GET_BRIEF,
    async (_, request?: MissionControlScopeRequest): Promise<MissionControlBrief> => {
      return missionControlIntelligence.getBrief(request || {});
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MISSION_CONTROL_LIST_ITEMS,
    async (_, request?: MissionControlListRequest): Promise<MissionControlItem[]> => {
      return missionControlIntelligence.listItems(request || {});
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MISSION_CONTROL_GET_ITEM_EVIDENCE,
    async (_, itemId: string): Promise<MissionControlItemEvidence[]> => {
      return missionControlIntelligence.getEvidence(requireString(itemId, "Mission Control item ID"));
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
    async (_, agentRoleId: string, config: unknown) => {
      checkRateLimit(IPC_CHANNELS.HEARTBEAT_UPDATE_CONFIG);
      const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
      const validatedConfig = validateInput(
        HeartbeatConfigSchema,
        config,
        "heartbeat configuration",
      );
      const result = agentRoleRepo.updateHeartbeatConfig(validated, validatedConfig);
      if (result) {
        heartbeatService.updateAgentConfig(validated, validatedConfig);
        getMainWindow()?.webContents.send(IPC_CHANNELS.HEARTBEAT_EVENT, {
          type: "config_updated",
          agentRoleId: validated,
          config: validatedConfig,
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

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_PROFILE_LIST, async () => {
    return automationProfileRepo.listAll();
  });

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_PROFILE_GET, async (_, id: string) => {
    const validated = validateInput(UUIDSchema, id, "automation profile ID");
    return automationProfileRepo.findById(validated);
  });

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_PROFILE_CREATE, async (_, request) => {
    checkRateLimit(IPC_CHANNELS.AUTOMATION_PROFILE_CREATE);
    const validatedRequest = validateInput(
      AutomationProfileCreateRequestSchema,
      request,
      "automation profile create request",
    );
    const agentRoleId = validatedRequest.agentRoleId;
    const role = agentRoleRepo.findById(agentRoleId);
    if (!role) {
      throw new Error("Agent role not found");
    }
    if (role.roleKind === "persona_template") {
      throw new Error("Digital Twin roles cannot own core automation profiles");
    }
    return automationProfileRepo.createOrReplace({
      agentRoleId,
      enabled: validatedRequest.enabled,
      cadenceMinutes: validatedRequest.cadenceMinutes,
      staggerOffsetMinutes: validatedRequest.staggerOffsetMinutes,
      dispatchCooldownMinutes: validatedRequest.dispatchCooldownMinutes,
      maxDispatchesPerDay: validatedRequest.maxDispatchesPerDay,
      profile: validatedRequest.profile,
      activeHours: validatedRequest.activeHours,
    });
  });

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_PROFILE_UPDATE, async (_, request) => {
    checkRateLimit(IPC_CHANNELS.AUTOMATION_PROFILE_UPDATE);
    const validatedRequest = validateInput(
      AutomationProfileUpdateRequestSchema,
      request,
      "automation profile update request",
    );
    const id = validatedRequest.id;
    return automationProfileRepo.update({
      id,
      enabled: validatedRequest.enabled,
      cadenceMinutes: validatedRequest.cadenceMinutes,
      staggerOffsetMinutes: validatedRequest.staggerOffsetMinutes,
      dispatchCooldownMinutes: validatedRequest.dispatchCooldownMinutes,
      maxDispatchesPerDay: validatedRequest.maxDispatchesPerDay,
      profile: validatedRequest.profile,
      activeHours: validatedRequest.activeHours,
    });
  });

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_PROFILE_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.AUTOMATION_PROFILE_DELETE);
    const validated = validateInput(UUIDSchema, id, "automation profile ID");
    automationProfileRepo.deleteById(validated);
  });

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_PROFILE_ATTACH, async (_, agentRoleId: string, request?: Record<string, unknown>) => {
    checkRateLimit(IPC_CHANNELS.AUTOMATION_PROFILE_ATTACH);
    const validatedRoleId = validateInput(UUIDSchema, agentRoleId, "agent role ID");
    const validatedRequest = validateInput(
      AutomationProfileAttachRequestSchema,
      request ?? {},
      "automation profile attach request",
    );
    const role = agentRoleRepo.findById(validatedRoleId);
    if (!role) {
      throw new Error("Agent role not found");
    }
    if (role.roleKind === "persona_template") {
      throw new Error("Digital Twin roles cannot own core automation profiles");
    }
    return automationProfileRepo.createOrReplace({
      agentRoleId: validatedRoleId,
      enabled: validatedRequest.enabled ?? true,
      cadenceMinutes: validatedRequest.cadenceMinutes,
      staggerOffsetMinutes: validatedRequest.staggerOffsetMinutes,
      dispatchCooldownMinutes: validatedRequest.dispatchCooldownMinutes,
      maxDispatchesPerDay: validatedRequest.maxDispatchesPerDay,
      profile: validatedRequest.profile,
      activeHours: validatedRequest.activeHours,
    });
  });

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_PROFILE_DETACH, async (_, agentRoleId: string) => {
    checkRateLimit(IPC_CHANNELS.AUTOMATION_PROFILE_DETACH);
    const validatedRoleId = validateInput(UUIDSchema, agentRoleId, "agent role ID");
    automationProfileRepo.deleteByAgentRoleId(validatedRoleId);
  });

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_PROFILE_LIST_HEARTBEAT_RUNS, async (_, payload: { profileId: string; limit?: number }) => {
    const profileId = validateInput(UUIDSchema, payload?.profileId, "automation profile ID");
    const profile = automationProfileRepo.findById(profileId);
    if (!profile) {
      throw new Error("Automation profile not found");
    }
    const all = heartbeatRunRepo.listRecentDispatches(profile.agentRoleId, 0);
    return typeof payload?.limit === "number" ? all.slice(0, payload.limit) : all;
  });

  ipcMain.handle(IPC_CHANNELS.AUTOMATION_PROFILE_LIST_SUBCONSCIOUS_RUNS, async (_, payload: { profileId: string; limit?: number }) => {
    const profileId = validateInput(UUIDSchema, payload?.profileId, "automation profile ID");
    const profile = automationProfileRepo.findById(profileId);
    if (!profile) {
      throw new Error("Automation profile not found");
    }
    return subconsciousRunRepo.list({
      targetKey: `agent_role:${profile.agentRoleId}`,
      limit: typeof payload?.limit === "number" ? payload.limit : 20,
    });
  });

  ipcMain.handle(IPC_CHANNELS.CORE_TRACE_LIST, async (_, request?: unknown): Promise<CoreTrace[]> => {
    const validated = request
      ? validateInput(CoreTraceListRequestSchema, request, "core trace list request")
      : {};
    return coreTraceRepo.list(validated);
  });

  ipcMain.handle(IPC_CHANNELS.CORE_TRACE_GET, async (_, id: string) => {
    const validated = validateInput(StringIdSchema, id, "core trace ID");
    return deps.coreTraceService.getTrace(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.CORE_TRACE_LIST_BY_PROFILE,
    async (_, payload: { profileId: string; limit?: number }): Promise<CoreTrace[]> => {
      const profileId = validateInput(UUIDSchema, payload?.profileId, "automation profile ID");
      const limit = typeof payload?.limit === "number" ? payload.limit : 50;
      return deps.coreTraceService.listByProfile(profileId, limit);
    },
  );

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
        deps.coreFailureMiningService.mineTrace(validated.traceId);
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
      deps.coreFailureClusterService.clusterFailures(validated.profileId, validated.workspaceId);
      return coreFailureClusterRepo.list(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_FAILURE_CLUSTER_REVIEW,
    async (_, request: unknown): Promise<CoreFailureCluster | undefined> => {
      const validated = validateInput(
        CoreFailureClusterReviewSchema,
        request,
        "core failure cluster review request",
      );
      return coreFailureClusterRepo.update(validated.id, {
        status: validated.status,
        rootCauseSummary: validated.rootCauseSummary,
        updatedAt: Date.now(),
      });
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
    IPC_CHANNELS.CORE_EVAL_CASE_REVIEW,
    async (_, request: unknown): Promise<CoreEvalCase | undefined> => {
      const validated = validateInput(
        CoreEvalCaseReviewSchema,
        request,
        "core eval case review request",
      );
      return deps.coreEvalCaseService.reviewEvalCase(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_EXPERIMENT_LIST,
    async (_, request?: unknown): Promise<CoreHarnessExperiment[]> => {
      const validated = request
        ? validateInput(
            CoreExperimentListRequestSchema,
            request,
            "core experiment list request",
          )
        : {};
      return deps.coreHarnessExperimentService.listExperiments(validated);
    },
  );

  ipcMain.handle(IPC_CHANNELS.CORE_EXPERIMENT_RUN, async (_, request: unknown) => {
    checkRateLimit(IPC_CHANNELS.CORE_EXPERIMENT_RUN);
    const validated = validateInput(
      CoreExperimentRunSchema,
      request,
      "core experiment run request",
    );
    return deps.coreHarnessExperimentRunner.run(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.CORE_EXPERIMENT_REVIEW,
    async (_, request: unknown): Promise<CoreHarnessExperiment | undefined> => {
      checkRateLimit(IPC_CHANNELS.CORE_EXPERIMENT_REVIEW);
      const validated = validateInput(
        CoreExperimentReviewSchema,
        request,
        "core experiment review request",
      );
      return deps.coreHarnessExperimentRunner.review(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_LEARNINGS_LIST,
    async (_, request?: unknown): Promise<CoreLearningsEntry[]> => {
      const validated = request
        ? validateInput(
            CoreLearningsListRequestSchema,
            request,
            "core learnings list request",
          )
        : {};
      return deps.coreLearningsService.list(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_MEMORY_LIST_CANDIDATES,
    async (_, request?: unknown): Promise<CoreMemoryCandidate[]> => {
      const validated = request
        ? validateInput(
            CoreMemoryCandidateListRequestSchema,
            request,
            "core memory candidate list request",
          )
        : {};
      return coreMemoryCandidateRepo.list(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_MEMORY_REVIEW_CANDIDATE,
    async (_, request: unknown): Promise<CoreMemoryCandidate | undefined> => {
      const validated = validateInput(
        CoreMemoryCandidateReviewSchema,
        request,
        "core memory candidate review request",
      );
      return coreMemoryCandidateRepo.review(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_MEMORY_LIST_DISTILL_RUNS,
    async (_, payload: { profileId: string; workspaceId?: string; limit?: number }): Promise<CoreMemoryDistillRun[]> => {
      const profileId = validateInput(UUIDSchema, payload?.profileId, "automation profile ID");
      const workspaceId =
        typeof payload?.workspaceId === "string" && payload.workspaceId.trim().length > 0
          ? validateInput(UUIDSchema, payload.workspaceId, "workspace ID")
          : undefined;
      const limit = typeof payload?.limit === "number" ? payload.limit : undefined;
      return coreMemoryDistillRunRepo.list({ profileId, workspaceId, limit });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CORE_MEMORY_RUN_DISTILL_NOW,
    async (_, request: unknown): Promise<CoreMemoryDistillRun> => {
      const validated = validateInput(
        CoreMemoryDistillRunNowSchema,
        request,
        "core memory distill run request",
      );
      return deps.coreMemoryDistiller.runOffline(validated);
    },
  );

  // Forward heartbeat events to renderer
  heartbeatService.on("heartbeat", (event) => {
    try {
      missionControlIntelligence.recordHeartbeatEvent(event);
    } catch (error) {
      logger.warn("Failed to project heartbeat event into Mission Control:", error);
    }
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
      const delivery = validateInput(
        StandupDeliveryRequestSchema,
        { reportId, channelType, channelId },
        "standup delivery request",
      );
      const report = standupService.findById(delivery.reportId);
      if (!report) {
        throw new Error("Standup report not found");
      }
      await standupService.deliverReport(report, {
        channelType: delivery.channelType,
        channelId: delivery.channelId,
      });
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
        nextStep: contract.expectedOutputType ? `Expected next output: ${contract.expectedOutputType}` : undefined,
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
        origin: "activity",
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

  ipcMain.handle(IPC_CHANNELS.MC_SYMPHONY_GET_CONFIG, async () => {
    return requireSymphonyService().getConfig();
  });

  ipcMain.handle(IPC_CHANNELS.MC_SYMPHONY_STATUS, async () => {
    return requireSymphonyService().getStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.MC_SYMPHONY_UPDATE_CONFIG,
    async (_, updates: SymphonyConfigUpdate) => {
      checkRateLimit(IPC_CHANNELS.MC_SYMPHONY_UPDATE_CONFIG);
      return requireSymphonyService().updateConfig(updates || {});
    },
  );

  ipcMain.handle(IPC_CHANNELS.MC_SYMPHONY_RUN, async () => {
    checkRateLimit(IPC_CHANNELS.MC_SYMPHONY_RUN);
    return requireSymphonyService().runOnce("manual");
  });

  ipcMain.handle(IPC_CHANNELS.MC_SYMPHONY_PAUSE, async () => {
    checkRateLimit(IPC_CHANNELS.MC_SYMPHONY_PAUSE);
    return requireSymphonyService().updateConfig({ enabled: false });
  });

  logger.debug("Handlers initialized");
}
