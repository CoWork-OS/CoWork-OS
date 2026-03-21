import { EventEmitter } from "events";
import {
  AgentRole,
  HeartbeatResult,
  HeartbeatEvent,
  HeartbeatStatus,
  HeartbeatConfig,
  HeartbeatDecisionMode,
  MemoryFeaturesSettings,
  AgentMention,
  Task,
  Activity,
  ProactiveTaskDefinition,
  CompanyOutputContract,
  CompanyOutputType,
  CompanyLoopType,
  CompanyPriority,
  CompanyReviewReason,
  AwarenessSummary,
  AutonomyDecision,
  ChiefOfStaffWorldModel,
  HeartbeatSignalFamily,
  HeartbeatWorkspaceScope,
  ProactiveSuggestion,
} from "../../shared/types";
import { AgentRoleRepository } from "./AgentRoleRepository";
import { MentionRepository } from "./MentionRepository";
import { ActivityRepository } from "../activity/ActivityRepository";
import { WorkingStateRepository } from "./WorkingStateRepository";
import { buildRolePersonaPrompt } from "./role-persona";
import {
  buildHeartbeatWorkspaceContext,
  HeartbeatMaintenanceStateStore,
  type HeartbeatChecklistItem,
  readHeartbeatChecklist,
} from "./heartbeat-maintenance";
import {
  buildAgentConfigFromAutonomyPolicy,
  resolveOperationalAutonomyPolicy,
} from "./autonomy-policy";
import type { MemoryCaptureOptions } from "../memory/MemoryService";

type HeartbeatWakeMode = "now" | "next-heartbeat";

type HeartbeatWakeSource = "hook" | "cron" | "api" | "manual";

interface HeartbeatWakeRequest {
  mode: HeartbeatWakeMode;
  source: HeartbeatWakeSource;
  text: string;
  requestedAt: number;
}

interface HeartbeatWakeDedupe {
  signature: string;
  requestedAt: number;
}

/**
 * Work items found during heartbeat check
 */
interface WorkItems {
  pendingMentions: AgentMention[];
  assignedTasks: Task[];
  relevantActivities: Activity[];
  awarenessSummary: AwarenessSummary | null;
  autonomyWorldModel: ChiefOfStaffWorldModel | null;
  autonomyDecisions: AutonomyDecision[];
}

interface MaintenanceWorkspaceContext {
  workspaceId: string;
  workspacePath: string;
}

interface DueChecklistItem {
  item: HeartbeatChecklistItem;
  stateKey: string;
}

interface DueProactiveTask {
  task: ProactiveTaskDefinition;
  stateKey: string;
}

interface HeartbeatDecision {
  mode: HeartbeatDecisionMode;
  signalFamily: HeartbeatSignalFamily;
  confidence: number;
  interruptionRisk: number;
  workspaceScope: HeartbeatWorkspaceScope;
  workspaceId?: string;
  memoryType?:
    | "observation"
    | "preference"
    | "constraint"
    | "timing_preference"
    | "workflow_pattern"
    | "correction_rule";
  memoryContent?: string;
  suggestion?: {
    title: string;
    description: string;
    actionPrompt?: string;
    suggestionClass?: ProactiveSuggestion["suggestionClass"];
    urgency?: ProactiveSuggestion["urgency"];
    learningSignalIds?: string[];
    sourceSignals?: string[];
    recommendedDelivery?: ProactiveSuggestion["recommendedDelivery"];
    companionStyle?: ProactiveSuggestion["companionStyle"];
  };
}

/**
 * Dependencies for HeartbeatService
 */
export interface HeartbeatServiceDeps {
  agentRoleRepo: AgentRoleRepository;
  mentionRepo: MentionRepository;
  activityRepo: ActivityRepository;
  workingStateRepo: WorkingStateRepository;
  createTask: (
    workspaceId: string,
    prompt: string,
    title: string,
    agentRoleId?: string,
    options?: {
      source?: Task["source"];
      agentConfig?: Task["agentConfig"];
    },
  ) => Promise<Task>;
  updateTask?: (taskId: string, updates: Partial<Task>) => void;
  getTasksForAgent: (agentRoleId: string, workspaceId?: string) => Task[];
  getDefaultWorkspaceId: () => string | undefined;
  getDefaultWorkspacePath: () => string | undefined;
  getWorkspacePath: (workspaceId: string) => string | undefined;
  hasActiveForegroundTask?: (workspaceId?: string) => boolean;
  recordActivity?: (params: {
    workspaceId: string;
    agentRoleId: string;
    title: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }) => void;
  listWorkspaceContexts?: () => MaintenanceWorkspaceContext[];
  getMemoryFeaturesSettings?: () => MemoryFeaturesSettings;
  getAwarenessSummary?: (workspaceId?: string) => AwarenessSummary | null;
  getAutonomyState?: (workspaceId?: string) => ChiefOfStaffWorldModel | null;
  getAutonomyDecisions?: (workspaceId?: string) => AutonomyDecision[];
  listActiveSuggestions?: (workspaceId: string) => ProactiveSuggestion[];
  createCompanionSuggestion?: (
    workspaceId: string,
    suggestion: {
      type?: ProactiveSuggestion["type"];
      title: string;
      description: string;
      actionPrompt?: string;
      confidence: number;
      suggestionClass?: ProactiveSuggestion["suggestionClass"];
      urgency?: ProactiveSuggestion["urgency"];
      learningSignalIds?: string[];
      workspaceScope?: HeartbeatWorkspaceScope;
      sourceSignals?: string[];
      recommendedDelivery?: ProactiveSuggestion["recommendedDelivery"];
      companionStyle?: ProactiveSuggestion["companionStyle"];
      sourceEntity?: string;
      sourceTaskId?: string;
    },
  ) => Promise<ProactiveSuggestion | null>;
  addNotification?: (params: {
    type: "companion_suggestion" | "info" | "warning";
    title: string;
    message: string;
    workspaceId?: string;
    suggestionId?: string;
    recommendedDelivery?: "briefing" | "inbox" | "nudge";
    companionStyle?: "email" | "note";
  }) => Promise<void>;
  captureMemory?: (
    workspaceId: string,
    taskId: string | undefined,
    type:
      | "observation"
      | "preference"
      | "constraint"
      | "timing_preference"
    | "workflow_pattern"
    | "correction_rule",
    content: string,
    isPrivate?: boolean,
    options?: MemoryCaptureOptions,
  ) => Promise<unknown>;
}

/**
 * HeartbeatService manages periodic agent wake-ups
 *
 * Each agent with heartbeat enabled wakes up at configured intervals
 * to check for:
 * - Pending @mentions directed at them
 * - Tasks assigned to them
 * - Relevant activity feed discussions
 *
 * If work is found, a task is created. Otherwise, HEARTBEAT_OK is logged.
 */
export class HeartbeatService extends EventEmitter {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running: Map<string, boolean> = new Map();
  private wakeQueues: Map<string, HeartbeatWakeRequest[]> = new Map();
  private wakeDedupe: Map<string, HeartbeatWakeDedupe> = new Map();
  private proactiveTaskLastRunAt: Map<string, number> = new Map();
  private wakeNowThrottleUntil: Map<string, number> = new Map();
  private wakeImmediateTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly maintenanceState = new HeartbeatMaintenanceStateStore();
  private started = false;

  private static readonly WAKE_COALESCE_MS = 30_000;
  private static readonly MAX_WAKE_QUEUE_SIZE = 25;
  private static readonly MIN_IMMEDIATE_WAKE_GAP_MS = 10_000;
  private static readonly INTERRUPTION_THRESHOLD = 0.82;
  private static readonly PROMOTION_THRESHOLD = 0.78;

  constructor(private deps: HeartbeatServiceDeps) {
    super();
  }

  /**
   * Start the heartbeat service
   * Schedules heartbeats for all enabled agents
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    const agents = this.deps.agentRoleRepo.findHeartbeatEnabled();

    for (const agent of agents) {
      this.scheduleHeartbeat(agent);
    }

    console.log(`[HeartbeatService] Started with ${agents.length} agents enabled`);
  }

  /**
   * Stop the heartbeat service
   * Clears all scheduled heartbeats
   */
  async stop(): Promise<void> {
    this.started = false;

    for (const [_agentId, timer] of this.timers) {
      clearTimeout(timer);
    }

    this.timers.clear();
    this.running.clear();
    this.wakeQueues.clear();
    this.wakeDedupe.clear();
    this.proactiveTaskLastRunAt.clear();
    this.wakeNowThrottleUntil.clear();

    for (const [, timer] of this.wakeImmediateTimers) {
      clearTimeout(timer);
    }
    this.wakeImmediateTimers.clear();

    console.log("[HeartbeatService] Stopped");
  }

  /**
   * Manually trigger a heartbeat for a specific agent
   */
  async triggerHeartbeat(agentRoleId: string): Promise<HeartbeatResult> {
    const agent = this.deps.agentRoleRepo.findById(agentRoleId);
    if (!agent) {
      return {
        agentRoleId,
        status: "error",
        pendingMentions: 0,
        assignedTasks: 0,
        relevantActivities: 0,
        error: "Agent role not found",
      };
    }

    return this.executeHeartbeat(agent);
  }

  /**
   * Submit a wake request for an agent.
   */
  submitWakeRequest(
    agentRoleId: string,
    request: { text?: string; mode?: HeartbeatWakeMode; source?: HeartbeatWakeSource },
  ): void {
    const agent = this.deps.agentRoleRepo.findById(agentRoleId);
    if (!agent || !agent.heartbeatEnabled) {
      return;
    }

    const wakeRequest: HeartbeatWakeRequest = {
      mode: request.mode === "now" ? "now" : "next-heartbeat",
      source: request.source || "manual",
      text: this.normalizeWakeText(request.text),
      requestedAt: Date.now(),
    };

    this.enqueueWakeRequest(agent, wakeRequest);
  }

  /**
   * Submit a wake request to all enabled agents.
   */
  submitWakeForAll(request: {
    text?: string;
    mode?: HeartbeatWakeMode;
    source?: HeartbeatWakeSource;
  }): void {
    const enabledAgents = this.deps.agentRoleRepo.findHeartbeatEnabled();
    for (const agent of enabledAgents) {
      this.submitWakeRequest(agent.id, request);
    }
  }

  /**
   * Update heartbeat configuration for an agent
   */
  updateAgentConfig(agentRoleId: string, config: HeartbeatConfig): void {
    // Cancel existing timer
    this.cancelHeartbeat(agentRoleId);

    // Get updated agent
    const agent = this.deps.agentRoleRepo.findById(agentRoleId);
    if (!agent) {
      return;
    }

    // Schedule new heartbeat if enabled
    if (config.heartbeatEnabled && agent.heartbeatEnabled) {
      this.scheduleHeartbeat(agent);
    }
  }

  /**
   * Cancel heartbeat for an agent
   */
  cancelHeartbeat(agentRoleId: string): void {
    const timer = this.timers.get(agentRoleId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(agentRoleId);
    }
    this.wakeQueues.delete(agentRoleId);
    this.wakeDedupe.delete(agentRoleId);
    this.clearProactiveTaskRunState(agentRoleId);
    this.wakeNowThrottleUntil.delete(agentRoleId);
    this.clearImmediateWake(agentRoleId);
    this.running.delete(agentRoleId);
  }

  /**
   * Get status of all heartbeat-enabled agents
   */
  getAllStatus(): Array<{
    agentRoleId: string;
    agentName: string;
    heartbeatEnabled: boolean;
    heartbeatStatus: HeartbeatStatus;
    lastHeartbeatAt?: number;
    nextHeartbeatAt?: number;
  }> {
    const agents = this.deps.agentRoleRepo.findAll(true);

    return agents.map((agent) => ({
      agentRoleId: agent.id,
      agentName: agent.displayName,
      heartbeatEnabled: agent.heartbeatEnabled || false,
      heartbeatStatus: agent.heartbeatStatus || "idle",
      lastHeartbeatAt: agent.lastHeartbeatAt,
      nextHeartbeatAt: this.getNextHeartbeatTime(agent),
    }));
  }

  /**
   * Get status of a specific agent
   */
  getStatus(agentRoleId: string):
    | {
        heartbeatEnabled: boolean;
        heartbeatStatus: HeartbeatStatus;
        lastHeartbeatAt?: number;
        nextHeartbeatAt?: number;
        isRunning: boolean;
      }
    | undefined {
    const agent = this.deps.agentRoleRepo.findById(agentRoleId);
    if (!agent) {
      return undefined;
    }

    return {
      heartbeatEnabled: agent.heartbeatEnabled || false,
      heartbeatStatus: agent.heartbeatStatus || "idle",
      lastHeartbeatAt: agent.lastHeartbeatAt,
      nextHeartbeatAt: this.getNextHeartbeatTime(agent),
      isRunning: this.running.get(agentRoleId) || false,
    };
  }

  /**
   * Schedule a heartbeat for an agent
   */
  private scheduleHeartbeat(agent: AgentRole): void {
    if (!this.started || !agent.heartbeatEnabled) {
      return;
    }

    // Cancel any existing timer
    const existingTimer = this.timers.get(agent.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Calculate delay with stagger offset
    const intervalMs = (agent.heartbeatIntervalMinutes || 15) * 60 * 1000;
    const staggerMs = (agent.heartbeatStaggerOffset || 0) * 60 * 1000;

    // Calculate time until next heartbeat
    const now = Date.now();
    const lastHeartbeat = agent.lastHeartbeatAt || 0;
    const nextHeartbeat = lastHeartbeat + intervalMs + staggerMs;
    const delayMs = Math.max(0, nextHeartbeat - now);

    // Schedule the heartbeat
    const timer = setTimeout(async () => {
      const currentAgent = this.deps.agentRoleRepo.findById(agent.id);
      if (currentAgent && currentAgent.heartbeatEnabled) {
        await this.executeHeartbeat(currentAgent);
        // Reschedule from fresh state so lastHeartbeatAt reflects the completed run.
        const refreshedAgent = this.deps.agentRoleRepo.findById(agent.id);
        if (refreshedAgent && refreshedAgent.heartbeatEnabled) {
          this.scheduleHeartbeat(refreshedAgent);
        }
      }
    }, delayMs);

    this.timers.set(agent.id, timer);

    console.log(
      `[HeartbeatService] Scheduled ${agent.displayName} in ${Math.round(delayMs / 1000)}s`,
    );
  }

  /**
   * Execute a heartbeat for an agent
   */
  private async executeHeartbeat(agent: AgentRole): Promise<HeartbeatResult> {
    // Prevent concurrent execution
    if (this.running.get(agent.id)) {
      return {
        agentRoleId: agent.id,
        status: "error",
        pendingMentions: 0,
        assignedTasks: 0,
        relevantActivities: 0,
        error: "Heartbeat already running",
      };
    }

    const wakeRequests = this.consumeWakeRequests(agent.id);
    const hasManualWakeRequest = wakeRequests.some((request) => request.source === "manual");
    if (this.deps.hasActiveForegroundTask?.() && !hasManualWakeRequest) {
      const result: HeartbeatResult = {
        agentRoleId: agent.id,
        status: "ok",
        pendingMentions: 0,
        assignedTasks: 0,
        relevantActivities: 0,
        silent: true,
      };

      console.log(
        `[HeartbeatService] Suppressed ${agent.displayName} while a foreground task is active`,
      );
      this.updateHeartbeatStatus(agent.id, "sleeping", Date.now());
      this.emitHeartbeatEvent({
        type: "no_work",
        agentRoleId: agent.id,
        agentName: agent.displayName,
        timestamp: Date.now(),
        result,
      });
      this.emitHeartbeatEvent({
        type: "completed",
        agentRoleId: agent.id,
        agentName: agent.displayName,
        timestamp: Date.now(),
        result,
      });
      return result;
    }

    this.running.set(agent.id, true);
    this.updateHeartbeatStatus(agent.id, "running");

    // Emit started event
    this.emitHeartbeatEvent({
      type: "started",
      agentRoleId: agent.id,
      agentName: agent.displayName,
      timestamp: Date.now(),
    });

    try {
      // Check for pending work
      const workItems = await this.checkForWork(agent);
      const result: HeartbeatResult = {
        agentRoleId: agent.id,
        status: "ok",
        pendingMentions: workItems.pendingMentions.length,
        assignedTasks: workItems.assignedTasks.length,
        relevantActivities: workItems.relevantActivities.length,
      };
      const maintenanceWorkspace = this.selectMaintenanceWorkspace(workItems);
      const checklistItems = this.extractDueChecklistItems(agent, maintenanceWorkspace);
      const proactiveTasks = this.extractProactiveTasks(agent);
      const immediateWakeRequests = wakeRequests.filter((request) => request.mode === "now");
      const selectedWorkspace =
        this.selectWorkspaceForWork(workItems) ?? maintenanceWorkspace;
      const workspaceId = selectedWorkspace?.workspaceId || this.deps.getDefaultWorkspaceId();
      if (maintenanceWorkspace) {
        result.maintenanceWorkspaceId = maintenanceWorkspace.workspaceId;
      }
      result.maintenanceChecks = checklistItems.length;
      const decision = this.decideHeartbeatOutcome(
        agent,
        workItems,
        wakeRequests,
        proactiveTasks,
        checklistItems,
        workspaceId,
      );
      result.decisionMode = decision.mode;
      result.signalFamily = decision.signalFamily;
      result.confidence = decision.confidence;
      result.interruptionRisk = decision.interruptionRisk;
      result.workspaceScope = decision.workspaceScope;

      if (decision.mode === "task_creation") {
        result.status = "work_done";
        const workspacePath = selectedWorkspace
          ? selectedWorkspace.workspacePath
          : this.deps.getDefaultWorkspacePath();

        // Build prompt for agent to handle the work
        const prompt = this.buildHeartbeatPrompt(
          agent,
          workItems,
          wakeRequests,
          proactiveTasks,
          checklistItems,
          workspacePath,
        );
        const outputContract = this.buildOutputContract(
          agent,
          workItems,
          immediateWakeRequests,
          proactiveTasks,
          checklistItems,
        );
        result.triggerReason = outputContract.triggerReason;
        result.loopType = outputContract.loopType;
        result.outputType = outputContract.outputType;
        result.expectedOutputType = outputContract.expectedOutputType;
        result.valueReason = outputContract.valueReason;
        result.reviewRequired = outputContract.reviewRequired;
        result.reviewReason = outputContract.reviewReason;
        result.evidenceRefs = outputContract.evidenceRefs;
        result.companyPriority = outputContract.companyPriority;

        if (workspaceId) {
          const task = await this.deps.createTask(
            workspaceId,
            prompt,
            `Heartbeat: ${agent.displayName}`,
            agent.id,
            {
              source: "api",
              agentConfig: {
                ...buildAgentConfigFromAutonomyPolicy(resolveOperationalAutonomyPolicy(agent)),
                allowUserInput: false,
                gatewayContext: "private",
                // Heartbeat tasks are planning/review work, not code execution.
                // Lock the domain so the IntentRouter cannot infer "code" from workspace
                // keywords (e.g. TypeScript mentions, backtick-formatted paths) and
                // incorrectly require run_command evidence before marking steps complete.
                taskDomain: "general",
              },
            },
          );
          result.taskCreated = task.id;
          this.deps.updateTask?.(task.id, {
            assignedAgentRoleId: agent.id,
            companyId: agent.companyId,
          });
          const updatableRepo = this.deps.agentRoleRepo as typeof this.deps.agentRoleRepo & {
            update?: (request: { id: string; lastUsefulOutputAt?: number }) => unknown;
          };
          updatableRepo.update?.({
            id: agent.id,
            lastUsefulOutputAt: Date.now(),
          });
          this.deps.recordActivity?.({
            workspaceId,
            agentRoleId: agent.id,
            title: `Heartbeat surfaced work for ${agent.displayName}`,
            description: outputContract.valueReason,
            metadata: {
              taskId: task.id,
              maintenanceChecks: checklistItems.length,
              wakeRequests: immediateWakeRequests.length,
              proactiveTasks: proactiveTasks.length,
              companyId: agent.companyId,
              outputContract,
            },
          });
          this.commitChecklistRunState(checklistItems, Date.now());
          this.commitProactiveTaskRunState(proactiveTasks, Date.now());
        } else {
          console.warn(
            "[HeartbeatService] Heartbeat skipped task creation: no workspace available",
          );
        }

        await this.captureCompanionMemory(workspaceId, decision);

        this.emitHeartbeatEvent({
          type: "work_found",
          agentRoleId: agent.id,
          agentName: agent.displayName,
          timestamp: Date.now(),
          result,
        });
      } else if (decision.mode === "inbox_suggestion" || decision.mode === "nudge") {
        const suggestionCreated = workspaceId
          ? await this.deliverCompanionSuggestion(agent, workspaceId, decision)
          : false;
        await this.captureCompanionMemory(workspaceId, decision);
        if (suggestionCreated) {
          result.status = "work_done";
          result.silent = false;
          this.emitHeartbeatEvent({
            type: "work_found",
            agentRoleId: agent.id,
            agentName: agent.displayName,
            timestamp: Date.now(),
            result,
          });
        } else {
          result.silent = true;
          this.emitHeartbeatEvent({
            type: "no_work",
            agentRoleId: agent.id,
            agentName: agent.displayName,
            timestamp: Date.now(),
            result,
          });
        }
      } else {
        await this.captureCompanionMemory(workspaceId, decision);
        result.silent = true;
        this.emitHeartbeatEvent({
          type: "no_work",
          agentRoleId: agent.id,
          agentName: agent.displayName,
          timestamp: Date.now(),
          result,
        });
      }

      // Update status
      this.updateHeartbeatStatus(agent.id, "sleeping", Date.now());

      // Emit completed event
      this.emitHeartbeatEvent({
        type: "completed",
        agentRoleId: agent.id,
        agentName: agent.displayName,
        timestamp: Date.now(),
        result,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.updateHeartbeatStatus(agent.id, "error");

      const result: HeartbeatResult = {
        agentRoleId: agent.id,
        status: "error",
        pendingMentions: 0,
        assignedTasks: 0,
        relevantActivities: 0,
        error: errorMessage,
      };

      this.emitHeartbeatEvent({
        type: "error",
        agentRoleId: agent.id,
        agentName: agent.displayName,
        timestamp: Date.now(),
        result,
        error: errorMessage,
      });

      return result;
    } finally {
      this.running.set(agent.id, false);
      this.wakeNowThrottleUntil.set(agent.id, Date.now());

      const hasNowWakeRequest = this.hasImmediateWakeRequest(agent.id);
      if (hasNowWakeRequest) {
        const currentAgent = this.deps.agentRoleRepo.findById(agent.id);
        if (currentAgent && currentAgent.heartbeatEnabled) {
          this.scheduleImmediateWake(currentAgent, "drain");
        }
      }
    }
  }

  private enqueueWakeRequest(agent: AgentRole, request: HeartbeatWakeRequest): boolean {
    const agentRoleId = agent.id;
    const signature = this.getWakeSignature(request);
    const now = Date.now();
    const existing = this.wakeDedupe.get(agentRoleId);

    if (
      existing &&
      existing.signature === signature &&
      now - existing.requestedAt < HeartbeatService.WAKE_COALESCE_MS
    ) {
      this.emitHeartbeatEvent({
        type: "wake_coalesced",
        agentRoleId,
        agentName: agent.displayName,
        timestamp: now,
        wake: {
          source: request.source,
          mode: request.mode,
          text: request.text,
        },
      });
      return false;
    }

    const queue = this.getWakeQueue(agentRoleId);
    queue.push(request);
    if (queue.length > HeartbeatService.MAX_WAKE_QUEUE_SIZE) {
      let dropIndex = queue.findIndex((queuedRequest) => queuedRequest.mode !== "now");
      if (dropIndex === -1) {
        dropIndex = 0;
      }
      const droppedRequest = queue[dropIndex];
      queue.splice(dropIndex, 1);
      this.emitHeartbeatEvent({
        type: "wake_queue_saturated",
        agentRoleId,
        agentName: agent.displayName,
        timestamp: now,
        wake: {
          source: droppedRequest ? droppedRequest.source : request.source,
          mode: droppedRequest ? droppedRequest.mode : request.mode,
          text: droppedRequest ? droppedRequest.text : request.text,
        },
      });
    } else {
      this.emitHeartbeatEvent({
        type: "wake_queued",
        agentRoleId,
        agentName: agent.displayName,
        timestamp: now,
        wake: {
          source: request.source,
          mode: request.mode,
          text: request.text,
        },
      });
    }

    this.wakeDedupe.set(agentRoleId, {
      signature,
      requestedAt: now,
    });

    if (request.mode === "now") {
      this.scheduleImmediateWake(agent, "ready", request);
    }

    return true;
  }

  private scheduleImmediateWake(
    agent: AgentRole,
    reason: "ready" | "drain",
    wakeRequest?: HeartbeatWakeRequest,
  ): void {
    const agentRoleId = agent.id;
    if (this.wakeImmediateTimers.has(agentRoleId) || this.running.get(agentRoleId)) {
      return;
    }

    const now = Date.now();
    const lastExecution = this.wakeNowThrottleUntil.get(agentRoleId) || 0;
    const delayMs = Math.max(0, HeartbeatService.MIN_IMMEDIATE_WAKE_GAP_MS - (now - lastExecution));

    if (delayMs === 0) {
      this.wakeNowThrottleUntil.set(agentRoleId, now);
      void this.executeHeartbeat(agent).catch((error) => {
        console.error("[HeartbeatService] Failed to process immediate wake heartbeat:", error);
      });
      return;
    }

    const timer = setTimeout(() => {
      this.wakeImmediateTimers.delete(agentRoleId);
      if (this.running.get(agentRoleId)) {
        return;
      }
      this.wakeNowThrottleUntil.set(agentRoleId, Date.now());
      void this.executeHeartbeat(agent).catch((error) => {
        console.error(
          "[HeartbeatService] Failed to process delayed immediate wake heartbeat:",
          error,
        );
      });
    }, delayMs);

    this.wakeImmediateTimers.set(agentRoleId, timer);

    const deferredWake = wakeRequest ?? {
      source: "api",
      mode: "now",
      text: `${reason}: ${delayMs}ms`,
      requestedAt: now,
    };

    this.emitHeartbeatEvent({
      type: "wake_immediate_deferred",
      agentRoleId,
      agentName: agent.displayName,
      timestamp: now,
      wake: {
        source: deferredWake.source,
        mode: deferredWake.mode,
        text: `${deferredWake.text} (${reason}: ${delayMs}ms)`,
        deferredMs: delayMs,
        reason,
      },
    });
  }

  private clearImmediateWake(agentRoleId: string): void {
    const existingTimer = this.wakeImmediateTimers.get(agentRoleId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.wakeImmediateTimers.delete(agentRoleId);
    }
  }

  private hasImmediateWakeRequest(agentRoleId: string): boolean {
    const requests = this.wakeQueues.get(agentRoleId);
    if (!requests) {
      return false;
    }

    return requests.some((request) => request.mode === "now");
  }

  private consumeWakeRequests(agentRoleId: string): HeartbeatWakeRequest[] {
    const queue = this.wakeQueues.get(agentRoleId);
    if (!queue || queue.length === 0) {
      return [];
    }

    const requests = [...queue];
    this.wakeQueues.delete(agentRoleId);
    this.clearImmediateWake(agentRoleId);
    return this.coalesceWakeRequests(requests);
  }

  private coalesceWakeRequests(requests: HeartbeatWakeRequest[]): HeartbeatWakeRequest[] {
    const seen = new Set<string>();
    const dedupedRequests: HeartbeatWakeRequest[] = [];

    for (const request of requests) {
      const signature = this.getWakeSignature(request);
      if (seen.has(signature)) {
        continue;
      }

      seen.add(signature);
      dedupedRequests.push(request);
    }

    return dedupedRequests;
  }

  private getWakeQueue(agentRoleId: string): HeartbeatWakeRequest[] {
    let queue = this.wakeQueues.get(agentRoleId);
    if (!queue) {
      queue = [];
      this.wakeQueues.set(agentRoleId, queue);
    }

    return queue;
  }

  private getWakeSignature(request: HeartbeatWakeRequest): string {
    return `${request.source}|${request.mode}|${request.text.length}|${request.text}`;
  }

  private normalizeWakeText(text?: string): string {
    return (text || "").trim();
  }

  /**
   * Check for pending work for an agent
   */
  private async checkForWork(agent: AgentRole): Promise<WorkItems> {
    // Get pending mentions
    const pendingMentions = this.deps.mentionRepo.getPendingForAgent(agent.id);

    // Get assigned tasks (in progress or pending)
    const assignedTasks = this.deps.getTasksForAgent(agent.id);

    const workspaceIds = new Set<string>();
    for (const mention of pendingMentions) {
      if (mention.workspaceId?.trim()) workspaceIds.add(mention.workspaceId.trim());
    }
    for (const task of assignedTasks) {
      if (task.workspaceId?.trim()) workspaceIds.add(task.workspaceId.trim());
    }
    const fallbackWorkspaceId = this.deps.getDefaultWorkspaceId();
    if (workspaceIds.size === 0 && fallbackWorkspaceId?.trim()) {
      workspaceIds.add(fallbackWorkspaceId.trim());
    }
    const awarenessWorkspaceId = Array.from(workspaceIds)[0] || fallbackWorkspaceId;
    const awarenessSummary = this.deps.getAwarenessSummary?.(awarenessWorkspaceId) || null;
    const autonomyWorldModel = this.deps.getAutonomyState?.(awarenessWorkspaceId) || null;
    const autonomyDecisions = this.deps.getAutonomyDecisions?.(awarenessWorkspaceId) || [];

    const relevantActivities: Activity[] = [];
    const seenActivityIds = new Set<string>();
    for (const workspaceId of Array.from(workspaceIds).slice(0, 3)) {
      const entries =
        this.deps.activityRepo.list?.({
          workspaceId,
          limit: 10,
        }) || [];
      for (const entry of entries) {
        if (!entry?.id || seenActivityIds.has(entry.id)) continue;
        if (Date.now() - entry.createdAt > 60 * 60 * 1000) continue;
        seenActivityIds.add(entry.id);
        relevantActivities.push(entry);
      }
    }
    relevantActivities.sort((a, b) => b.createdAt - a.createdAt);

    return {
      pendingMentions,
      assignedTasks,
      relevantActivities: relevantActivities.slice(0, 12),
      awarenessSummary,
      autonomyWorldModel,
      autonomyDecisions,
    };
  }

  private selectWorkspaceForWork(
    work: WorkItems,
  ): { workspaceId: string; workspacePath: string } | undefined {
    const candidates = new Map<string, { score: number; priority: number }>();
    const addCandidate = (
      workspaceIdRaw: string | undefined,
      score: number,
      priority: number,
    ): void => {
      const workspaceId = typeof workspaceIdRaw === "string" ? workspaceIdRaw.trim() : "";
      if (!workspaceId) return;

      const existing = candidates.get(workspaceId);
      if (
        !existing ||
        score > existing.score ||
        (score === existing.score && priority > existing.priority)
      ) {
        candidates.set(workspaceId, { score, priority });
      }
    };

    for (const mention of work.pendingMentions) {
      addCandidate(mention.workspaceId, mention.createdAt, 2);
    }

    for (const task of work.assignedTasks) {
      addCandidate(task.workspaceId, task.updatedAt ?? 0, 1);
    }

    const sortedCandidates = Array.from(candidates.entries())
      .map(([workspaceId, info]) => ({ workspaceId, ...info }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.workspaceId.localeCompare(b.workspaceId);
      });

    for (const candidate of sortedCandidates) {
      const workspacePath = this.deps.getWorkspacePath(candidate.workspaceId);
      if (typeof workspacePath === "string" && workspacePath.trim().length === 0) {
        continue;
      }

      if (!workspacePath) {
        continue;
      }

      return {
        workspaceId: candidate.workspaceId,
        workspacePath,
      };
    }

    return undefined;
  }

  /**
   * Build a prompt for the agent to handle pending work
   */
  private buildHeartbeatPrompt(
    agent: AgentRole,
    work: WorkItems,
    wakeRequests: HeartbeatWakeRequest[],
    proactiveTasks: DueProactiveTask[],
    checklistItems: DueChecklistItem[],
    workspacePath?: string,
  ): string {
    const lines: string[] = [
      `You are ${agent.displayName}, waking up for a scheduled heartbeat check.`,
      "",
    ];

    if (wakeRequests.length > 0) {
      lines.push("## Wake Requests");
      for (const request of wakeRequests) {
        const detail = request.text || "[no detail provided]";
        lines.push(`- ${request.mode} / ${request.source}: ${detail}`);
      }
      lines.push("");
    }

    const rolePersona = buildRolePersonaPrompt(agent, workspacePath);
    if (rolePersona) {
      lines.push(rolePersona);
      lines.push("");
    }

    const workspaceContext = buildHeartbeatWorkspaceContext(workspacePath);
    if (workspaceContext) {
      lines.push("## Focused Workspace Context");
      lines.push(workspaceContext);
      lines.push("");
    }

    // Add pending mentions
    if (work.pendingMentions.length > 0) {
      lines.push("## Pending @Mentions");
      for (const mention of work.pendingMentions) {
        lines.push(`- Type: ${mention.mentionType}`);
        if (mention.context) {
          lines.push(`  Context: ${mention.context}`);
        }
      }
      lines.push("");
    }

    // Add assigned tasks
    if (work.assignedTasks.length > 0) {
      lines.push("## Assigned Tasks");
      for (const task of work.assignedTasks) {
        lines.push(`- [${task.status}] ${task.title}`);
      }
      lines.push("");
    }

    if (work.relevantActivities.length > 0) {
      lines.push("## Recent Workspace Activity");
      for (const activity of work.relevantActivities.slice(0, 8)) {
        const detail = activity.description ? ` — ${activity.description}` : "";
        lines.push(`- [${activity.activityType}] ${activity.title}${detail}`);
      }
      lines.push("");
    }

    if (work.awarenessSummary?.currentFocus) {
      lines.push("## Current Focus");
      lines.push(`- ${work.awarenessSummary.currentFocus}`);
      lines.push("");
    }

    if ((work.awarenessSummary?.whatMattersNow.length || 0) > 0) {
      lines.push("## Awareness Signals");
      for (const item of work.awarenessSummary?.whatMattersNow.slice(0, 6) || []) {
        const detail = item.detail ? ` — ${item.detail}` : "";
        lines.push(`- [${item.source}] ${item.title}${detail}`);
      }
      lines.push("");
    }

    if ((work.awarenessSummary?.dueSoon.length || 0) > 0) {
      lines.push("## Due Soon");
      for (const item of work.awarenessSummary?.dueSoon.slice(0, 5) || []) {
        const detail = item.detail ? ` — ${item.detail}` : "";
        lines.push(`- ${item.title}${detail}`);
      }
      lines.push("");
    }

    if ((work.autonomyWorldModel?.goals.length || 0) > 0) {
      lines.push("## Active Goals");
      for (const goal of work.autonomyWorldModel?.goals.slice(0, 4) || []) {
        lines.push(`- [${goal.status}] ${goal.title}`);
      }
      lines.push("");
    }

    if ((work.autonomyWorldModel?.openLoops.length || 0) > 0) {
      lines.push("## Open Loops");
      for (const loop of work.autonomyWorldModel?.openLoops.slice(0, 4) || []) {
        const detail = loop.dueAt ? ` — due ${new Date(loop.dueAt).toLocaleString()}` : "";
        lines.push(`- ${loop.title}${detail}`);
      }
      lines.push("");
    }

    if (work.autonomyDecisions.length > 0) {
      lines.push("## Pending Chief-of-Staff Interventions");
      for (const decision of work.autonomyDecisions.slice(0, 6)) {
        const detail = decision.description ? ` — ${decision.description}` : "";
        lines.push(`- [${decision.actionType}/${decision.status}] ${decision.title}${detail}`);
      }
      lines.push("");
    }

    if (checklistItems.length > 0) {
      lines.push("## HEARTBEAT.md Recurring Checks");
      lines.push("Run these user-defined checks proactively during this heartbeat:");
      lines.push("");
      for (const entry of checklistItems) {
        lines.push(`### ${entry.item.sectionTitle}`);
        lines.push(`- ${entry.item.title}`);
        lines.push("");
      }
    }

    // Add proactive tasks from digital twin cognitive offload config
    if (proactiveTasks.length > 0) {
      lines.push("## Proactive Tasks");
      lines.push(
        "As part of this heartbeat, perform these proactive checks for your human counterpart:",
      );
      lines.push("");
      for (const entry of proactiveTasks) {
        const task = entry.task;
        lines.push(`### ${task.name}`);
        lines.push(task.promptTemplate);
        lines.push("");
      }
    }

    // Add instructions
    lines.push("## Instructions");
    const hasWorkOrSignal =
      work.pendingMentions.length > 0 ||
      work.assignedTasks.length > 0 ||
      (work.awarenessSummary?.whatMattersNow.length || 0) > 0 ||
      (work.awarenessSummary?.dueSoon.length || 0) > 0 ||
      work.autonomyDecisions.length > 0 ||
      wakeRequests.length > 0 ||
      proactiveTasks.length > 0 ||
      checklistItems.length > 0;

    if (hasWorkOrSignal) {
      lines.push("Please review the above items and take appropriate action.");
      lines.push("For mentions, acknowledge them and respond as needed.");
      lines.push("For assigned tasks, continue working on them or report any blockers.");
      if (checklistItems.length > 0) {
        lines.push(
          "For HEARTBEAT.md checks, use the normal toolset proactively. If nothing requires the user's attention after investigating, your final response should be exactly HEARTBEAT_OK.",
        );
      }
      if (wakeRequests.length > 0) {
        lines.push("For wake requests, treat them as explicit check-in prompts.");
      }
    } else {
      lines.push("No pending work found. HEARTBEAT_OK.");
    }

    return lines.join("\n");
  }

  /**
   * Extract enabled proactive tasks from an agent's soul JSON (digital twin config)
   */
  private extractProactiveTasks(agent: AgentRole): DueProactiveTask[] {
    if (!agent.soul || !agent.soul.trim()) return [];
    try {
      const soulData = JSON.parse(agent.soul);
      const tasks = soulData?.cognitiveOffload?.proactiveTasks;
      if (!Array.isArray(tasks)) return [];
      const sortedTasks = tasks
        .filter((t: ProactiveTaskDefinition) => t.enabled && t.promptTemplate)
        .sort(
          (a: ProactiveTaskDefinition, b: ProactiveTaskDefinition) =>
            (a.priority ?? 99) - (b.priority ?? 99),
        );
      const now = Date.now();
      const dueTasks: DueProactiveTask[] = [];
      for (const task of sortedTasks) {
        const frequencyMinutes =
          typeof task.frequencyMinutes === "number" && Number.isFinite(task.frequencyMinutes)
            ? Math.max(1, Math.round(task.frequencyMinutes))
            : 15;
        const frequencyMs = frequencyMinutes * 60 * 1000;
        const key = this.getProactiveTaskKey(agent.id, task.id);
        const lastRunAt =
          this.proactiveTaskLastRunAt.get(key) || this.maintenanceState.getProactiveLastRunAt(key) || 0;
        if (!lastRunAt || now - lastRunAt >= frequencyMs) {
          dueTasks.push({ task, stateKey: key });
        }
      }
      return dueTasks;
    } catch {
      return [];
    }
  }

  private getProactiveTaskKey(agentRoleId: string, taskId: string): string {
    return `${agentRoleId}:${taskId}`;
  }

  private getChecklistRunStateKey(
    agentRoleId: string,
    workspaceId: string,
    checklistItemId: string,
  ): string {
    return `${agentRoleId}:${workspaceId}:${checklistItemId}`;
  }

  private selectMaintenanceWorkspace(work: WorkItems): MaintenanceWorkspaceContext | undefined {
    const defaultWorkspaceId = this.deps.getDefaultWorkspaceId();
    const defaultWorkspacePath = defaultWorkspaceId
      ? this.deps.getWorkspacePath(defaultWorkspaceId)
      : this.deps.getDefaultWorkspacePath();
    const preferred: MaintenanceWorkspaceContext[] = [];
    if (defaultWorkspaceId && defaultWorkspacePath?.trim()) {
      preferred.push({
        workspaceId: defaultWorkspaceId,
        workspacePath: defaultWorkspacePath,
      });
    }

    const others = (this.deps.listWorkspaceContexts?.() || []).filter(
      (workspace) =>
        workspace.workspaceId !== defaultWorkspaceId && typeof workspace.workspacePath === "string",
    );

    for (const workspace of [...preferred, ...others]) {
      if (readHeartbeatChecklist(workspace.workspacePath).length > 0) {
        return workspace;
      }
    }

    return preferred[0];
  }

  private extractDueChecklistItems(
    agent: AgentRole,
    workspace: MaintenanceWorkspaceContext | undefined,
  ): DueChecklistItem[] {
    if (!workspace || !this.isMaintenanceHeartbeatEnabled(agent)) {
      return [];
    }
    const items = readHeartbeatChecklist(workspace.workspacePath);
    if (items.length === 0) return [];
    const now = Date.now();
    return items.filter((item) => {
      const key = this.getChecklistRunStateKey(agent.id, workspace.workspaceId, item.id);
      const lastRunAt = this.maintenanceState.getChecklistLastRunAt(key) || 0;
      return item.cadenceMs === 0 || !lastRunAt || now - lastRunAt >= item.cadenceMs;
    }).map((item) => ({
      item,
      stateKey: this.getChecklistRunStateKey(agent.id, workspace.workspaceId, item.id),
    }));
  }

  private isMaintenanceHeartbeatEnabled(agent: AgentRole): boolean {
    const features =
      this.deps.getMemoryFeaturesSettings?.() || {
        contextPackInjectionEnabled: true,
        heartbeatMaintenanceEnabled: true,
      };
    return features.heartbeatMaintenanceEnabled && agent.autonomyLevel === "lead";
  }

  private commitChecklistRunState(items: DueChecklistItem[], runAt: number): void {
    for (const entry of items) {
      this.maintenanceState.setChecklistLastRunAt(entry.stateKey, runAt);
    }
  }

  private commitProactiveTaskRunState(tasks: DueProactiveTask[], runAt: number): void {
    for (const entry of tasks) {
      this.proactiveTaskLastRunAt.set(entry.stateKey, runAt);
      this.maintenanceState.setProactiveLastRunAt(entry.stateKey, runAt);
    }
  }

  private decideHeartbeatOutcome(
    agent: AgentRole,
    workItems: WorkItems,
    wakeRequests: HeartbeatWakeRequest[],
    proactiveTasks: DueProactiveTask[],
    checklistItems: DueChecklistItem[],
    workspaceId?: string,
  ): HeartbeatDecision {
    const immediateWakeRequests = wakeRequests.filter((request) => request.mode === "now");
    if (immediateWakeRequests.length > 0) {
      return {
        mode: "task_creation",
        signalFamily: "urgent_interrupt",
        confidence: 0.98,
        interruptionRisk: 0.2,
        workspaceScope: "single",
        workspaceId,
      };
    }

    if (workItems.pendingMentions.length > 0) {
      return {
        mode: "task_creation",
        signalFamily: "mentions",
        confidence: 0.95,
        interruptionRisk: 0.18,
        workspaceScope: "single",
        workspaceId,
      };
    }

    if (workItems.assignedTasks.length > 0) {
      return {
        mode: "task_creation",
        signalFamily: "assigned_tasks",
        confidence: 0.92,
        interruptionRisk: 0.24,
        workspaceScope: "single",
        workspaceId,
      };
    }

    if (proactiveTasks.length > 0 || checklistItems.length > 0) {
      return {
        mode: "task_creation",
        signalFamily: "maintenance",
        confidence: 0.88,
        interruptionRisk: 0.22,
        workspaceScope: "single",
        workspaceId,
      };
    }

    const requiresHeartbeatAwareness =
      (workItems.awarenessSummary?.whatMattersNow || []).some((item) => item.requiresHeartbeat) ||
      (workItems.awarenessSummary?.dueSoon || []).some((item) => item.requiresHeartbeat);
    if (requiresHeartbeatAwareness) {
      return {
        mode: "task_creation",
        signalFamily: "awareness_signal",
        confidence: 0.84,
        interruptionRisk: 0.32,
        workspaceScope: "single",
        workspaceId,
      };
    }

    const urgentDueSoon = (workItems.awarenessSummary?.dueSoon || []).find(
      (item) => (item.score || 0) >= 0.9,
    );
    if (urgentDueSoon) {
      return {
        mode: "nudge",
        signalFamily: "urgent_interrupt",
        confidence: Math.max(0.86, urgentDueSoon.score || 0.86),
        interruptionRisk: 0.35,
        workspaceScope: "single",
        workspaceId,
        memoryType: "observation",
        memoryContent: `Urgent deadline signal: ${urgentDueSoon.title}${urgentDueSoon.detail ? ` — ${urgentDueSoon.detail}` : ""}`,
        suggestion: {
          title: `Immediate attention recommended: ${urgentDueSoon.title}`.slice(0, 90),
          description:
            urgentDueSoon.detail ||
            "A due-soon signal crossed the urgency threshold during heartbeat review.",
          actionPrompt: `Review the urgent item and decide the next action now: ${urgentDueSoon.title}`,
          suggestionClass: "urgent",
          urgency: "high",
          sourceSignals: [urgentDueSoon.id],
          learningSignalIds: [urgentDueSoon.id],
          recommendedDelivery: "nudge",
          companionStyle: "email",
        },
      };
    }

    const focusDecision = this.analyzeFocusState(workItems, workspaceId);
    if (focusDecision) {
      return focusDecision;
    }

    const openLoopDecision = this.analyzeOpenLoopPressure(agent, workItems, workspaceId);
    if (openLoopDecision) {
      return openLoopDecision;
    }

    const correctionDecision = this.analyzeCorrectionLearning(workItems, workspaceId);
    if (correctionDecision) {
      return correctionDecision;
    }

    const driftDecision = this.analyzeMemoryDrift(workItems, workspaceId);
    if (driftDecision) {
      return driftDecision;
    }

    const crossWorkspaceDecision = this.analyzeCrossWorkspacePatterns(workItems, workspaceId);
    if (crossWorkspaceDecision) {
      return crossWorkspaceDecision;
    }

    const agingDecision = this.analyzeSuggestionAging(workspaceId);
    if (agingDecision) {
      return agingDecision;
    }

    return {
      mode: "silent",
      signalFamily: "focus_state",
      confidence: 0.2,
      interruptionRisk: 0.9,
      workspaceScope: "single",
      workspaceId,
    };
  }

  private analyzeFocusState(
    workItems: WorkItems,
    workspaceId?: string,
  ): HeartbeatDecision | null {
    const currentFocus = workItems.awarenessSummary?.currentFocus?.trim();
    const relevantFocusSignals = (workItems.awarenessSummary?.whatMattersNow || []).filter(
      (item) => item.tags.includes("focus") || item.tags.includes("context"),
    );
    const interruptionRisk = currentFocus ? 0.78 : 0.54;
    const confidence = currentFocus && relevantFocusSignals.length > 0 ? 0.76 : 0;
    if (!currentFocus || confidence < 0.68) {
      return null;
    }

    return {
      mode: "inbox_suggestion",
      signalFamily: "focus_state",
      confidence,
      interruptionRisk,
      workspaceScope: "single",
      workspaceId,
      memoryType:
        confidence >= HeartbeatService.PROMOTION_THRESHOLD ? "timing_preference" : "observation",
      memoryContent: `Focus state observed: ${currentFocus}. Interruption risk ${Math.round(
        interruptionRisk * 100,
      )}%.`,
      suggestion: {
        title: `Protect current focus: ${currentFocus}`.slice(0, 90),
        description:
          "You appear to be in focused work. I should keep proactive output lightweight and oriented around preserving that flow.",
        actionPrompt:
          "Summarize the single highest-leverage next step that preserves the current focus instead of introducing a new context.",
        suggestionClass: "focus_support",
        urgency: "medium",
        sourceSignals: relevantFocusSignals.map((item) => item.id),
        learningSignalIds: relevantFocusSignals.map((item) => item.id),
        recommendedDelivery: "inbox",
        companionStyle: "email",
      },
    };
  }

  private analyzeOpenLoopPressure(
    agent: AgentRole,
    workItems: WorkItems,
    workspaceId?: string,
  ): HeartbeatDecision | null {
    const openLoops = workItems.autonomyWorldModel?.openLoops || [];
    const pendingDecisions = workItems.autonomyDecisions.filter((decision) => decision.status !== "done");
    const pressureScore = openLoops.length + pendingDecisions.length;
    if (pressureScore < 2) {
      return null;
    }

    const confidence = Math.min(0.9, 0.6 + pressureScore * 0.08);
    if (pressureScore >= 4 && (agent.autonomyLevel === "lead" || pendingDecisions.length > 0)) {
      return {
        mode: "task_creation",
        signalFamily: "open_loop_pressure",
        confidence,
        interruptionRisk: 0.28,
        workspaceScope: "single",
        workspaceId,
        memoryType: "workflow_pattern",
        memoryContent: `Open-loop pressure detected: ${pressureScore} unresolved loops/decisions require structured follow-up.`,
      };
    }

    return {
      mode: "inbox_suggestion",
      signalFamily: "open_loop_pressure",
      confidence,
      interruptionRisk: 0.42,
      workspaceScope: "single",
      workspaceId,
      memoryType: "observation",
      memoryContent: `Open loops accumulating: ${pressureScore} unresolved loops/decisions detected.`,
      suggestion: {
        title: `Reduce open-loop pressure in ${openLoops[0]?.title || "current workspace"}`.slice(
          0,
          90,
        ),
        description:
          "Several unresolved commitments are accumulating. A short consolidation pass would likely reduce context-switching friction.",
        actionPrompt:
          "Review the current open loops and suggest the smallest set of actions that closes or defers them cleanly.",
        suggestionClass: "open_loop",
        urgency: pressureScore >= 3 ? "high" : "medium",
        sourceSignals: [
          ...openLoops.slice(0, 3).map((loop) => loop.id),
          ...pendingDecisions.slice(0, 3).map((decision) => decision.id),
        ],
        learningSignalIds: [
          ...openLoops.slice(0, 3).map((loop) => loop.id),
          ...pendingDecisions.slice(0, 3).map((decision) => decision.id),
        ],
        recommendedDelivery: "inbox",
        companionStyle: "email",
      },
    };
  }

  private analyzeCorrectionLearning(
    workItems: WorkItems,
    workspaceId?: string,
  ): HeartbeatDecision | null {
    const correctionActivities = workItems.relevantActivities.filter((activity) =>
      /(fix|rename|correct|instead|should|prefer|not this|wrong)/i.test(
        `${activity.title} ${activity.description || ""}`,
      ),
    );
    if (correctionActivities.length < 2) {
      return null;
    }

    const titles = correctionActivities.slice(0, 3).map((activity) => activity.title);
    return {
      mode: "silent",
      signalFamily: "correction_learning",
      confidence: 0.82,
      interruptionRisk: 0.84,
      workspaceScope: "single",
      workspaceId,
      memoryType: "correction_rule",
      memoryContent: `Correction pattern learned from recent activity: ${titles.join("; ")}`,
    };
  }

  private analyzeMemoryDrift(
    workItems: WorkItems,
    workspaceId?: string,
  ): HeartbeatDecision | null {
    const currentFocus = workItems.awarenessSummary?.currentFocus?.toLowerCase() || "";
    const activeGoals = workItems.autonomyWorldModel?.goals || [];
    if (!currentFocus || activeGoals.length === 0) {
      return null;
    }
    const mismatchedGoal = activeGoals.find((goal) => {
      const goalTitle = goal.title.toLowerCase();
      return !goalTitle.includes(currentFocus.split(/\s+/)[0] || "") && goal.status === "active";
    });
    if (!mismatchedGoal) {
      return null;
    }

    return {
      mode: "silent",
      signalFamily: "memory_drift",
      confidence: 0.74,
      interruptionRisk: 0.88,
      workspaceScope: "single",
      workspaceId,
      memoryType: "observation",
      memoryContent: `Possible drift observed: current focus "${workItems.awarenessSummary?.currentFocus}" may be diverging from active goal "${mismatchedGoal.title}".`,
    };
  }

  private analyzeCrossWorkspacePatterns(
    workItems: WorkItems,
    workspaceId?: string,
  ): HeartbeatDecision | null {
    const contexts = this.deps.listWorkspaceContexts?.() || [];
    if (contexts.length < 2 || !this.deps.getAwarenessSummary) {
      return null;
    }

    const summaries = contexts
      .slice(0, 5)
      .map((context) => ({
        workspaceId: context.workspaceId,
        summary: this.deps.getAwarenessSummary?.(context.workspaceId) || null,
      }))
      .filter((entry) => entry.summary);

    const busyWorkspaces = summaries.filter(
      (entry) =>
        (entry.summary?.whatMattersNow.length || 0) > 0 || (entry.summary?.dueSoon.length || 0) > 0,
    );
    if (busyWorkspaces.length < 2) {
      return null;
    }

    const signalIds = busyWorkspaces.flatMap((entry) => [
      ...(entry.summary?.whatMattersNow.slice(0, 1).map((item) => item.id) || []),
      ...(entry.summary?.dueSoon.slice(0, 1).map((item) => item.id) || []),
    ]);

    return {
      mode: "inbox_suggestion",
      signalFamily: "cross_workspace_patterns",
      confidence: 0.8,
      interruptionRisk: 0.48,
      workspaceScope: "all",
      workspaceId,
      memoryType:
        busyWorkspaces.length >= 3 ? "workflow_pattern" : "observation",
      memoryContent: `Cross-workspace pattern: ${busyWorkspaces.length} workspaces currently show competing focus or due-soon pressure.`,
      suggestion: {
        title: `Cross-workspace friction detected across ${busyWorkspaces.length} workspaces`,
        description:
          "Similar pressure is appearing in multiple workspaces. A single coordinated summary would likely reduce repeated re-orientation.",
        actionPrompt:
          "Create one executive summary that consolidates the top priorities and next actions across the affected workspaces.",
        suggestionClass: "cross_workspace",
        urgency: "medium",
        sourceSignals: signalIds,
        learningSignalIds: signalIds,
        recommendedDelivery: "inbox",
        companionStyle: "email",
      },
    };
  }

  private analyzeSuggestionAging(workspaceId?: string): HeartbeatDecision | null {
    if (!workspaceId || !this.deps.listActiveSuggestions) {
      return null;
    }
    const agingThreshold = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const agingSuggestions = this.deps
      .listActiveSuggestions(workspaceId)
      .filter((suggestion) => suggestion.createdAt < agingThreshold);
    if (agingSuggestions.length < 3) {
      return null;
    }

    return {
      mode: "inbox_suggestion",
      signalFamily: "suggestion_aging",
      confidence: 0.72,
      interruptionRisk: 0.62,
      workspaceScope: "single",
      workspaceId,
      memoryType: "workflow_pattern",
      memoryContent: `Suggestion backlog aging detected: ${agingSuggestions.length} active suggestions are older than 3 days.`,
      suggestion: {
        title: "Prune or refresh aging companion suggestions",
        description:
          "Several older suggestions are still active. Reviewing them now would help the companion learn what should be suppressed, revived, or acted on.",
        actionPrompt:
          "Review the aging suggestions, dismiss what is stale, and keep only the items that still deserve attention.",
        suggestionClass: "aging",
        urgency: "low",
        sourceSignals: agingSuggestions.slice(0, 5).map((suggestion) => suggestion.id),
        learningSignalIds: agingSuggestions.slice(0, 5).map((suggestion) => suggestion.id),
        recommendedDelivery: "briefing",
        companionStyle: "email",
      },
    };
  }

  private async deliverCompanionSuggestion(
    agent: AgentRole,
    workspaceId: string | undefined,
    decision: HeartbeatDecision,
  ): Promise<boolean> {
    if (!workspaceId || !decision.suggestion || !this.deps.createCompanionSuggestion) {
      return false;
    }
    const created = await this.deps.createCompanionSuggestion(workspaceId, {
      type: "insight",
      title: decision.suggestion.title,
      description: decision.suggestion.description,
      actionPrompt: decision.suggestion.actionPrompt,
      confidence: decision.confidence,
      suggestionClass: decision.suggestion.suggestionClass,
      urgency: decision.suggestion.urgency,
      learningSignalIds: decision.suggestion.learningSignalIds,
      workspaceScope: decision.workspaceScope,
      sourceSignals: decision.suggestion.sourceSignals,
      recommendedDelivery: decision.suggestion.recommendedDelivery,
      companionStyle: decision.suggestion.companionStyle,
    });
    if (!created) {
      return false;
    }

    const delivery = decision.suggestion.recommendedDelivery || "inbox";
    if (delivery === "inbox" || delivery === "nudge") {
      await this.deps.addNotification?.({
        type: "companion_suggestion",
        title: delivery === "nudge" ? `Companion nudge: ${created.title}` : `Companion suggestion: ${created.title}`,
        message: created.description,
        workspaceId,
        suggestionId: created.id,
        recommendedDelivery: delivery,
        companionStyle: created.companionStyle || "email",
      });
    }

    this.deps.recordActivity?.({
      workspaceId,
      agentRoleId: agent.id,
      title: `Heartbeat surfaced a companion ${delivery}`,
      description: created.title,
      metadata: {
        signalFamily: decision.signalFamily,
        confidence: decision.confidence,
        interruptionRisk: decision.interruptionRisk,
        workspaceScope: decision.workspaceScope,
        suggestionId: created.id,
      },
    });

    return true;
  }

  private async captureCompanionMemory(
    workspaceId: string | undefined,
    decision: HeartbeatDecision,
  ): Promise<void> {
    if (!workspaceId || !decision.memoryType || !decision.memoryContent || !this.deps.captureMemory) {
      return;
    }
    const isPrivate = decision.confidence < HeartbeatService.PROMOTION_THRESHOLD;
    await this.deps.captureMemory(
      workspaceId,
      undefined,
      decision.memoryType,
      decision.memoryContent,
      isPrivate,
      {
        origin: "heartbeat",
        batchKey: `heartbeat:${workspaceId}:${decision.signalFamily}:${Math.floor(Date.now() / 300000)}`,
        signalFamily: decision.signalFamily,
        priority: decision.confidence >= HeartbeatService.PROMOTION_THRESHOLD ? "high" : "low",
      },
    );
  }

  private describeHeartbeatWork(
    work: WorkItems,
    wakeRequests: HeartbeatWakeRequest[],
    proactiveTasks: DueProactiveTask[],
    checklistItems: DueChecklistItem[],
  ): string {
    const parts: string[] = [];
    const immediateWakeRequests = wakeRequests.filter((request) => request.mode === "now");
    if (work.pendingMentions.length > 0) parts.push(`${work.pendingMentions.length} mention(s)`);
    if (work.assignedTasks.length > 0) parts.push(`${work.assignedTasks.length} assigned task(s)`);
    if ((work.awarenessSummary?.whatMattersNow.length || 0) > 0) {
      parts.push(`${work.awarenessSummary?.whatMattersNow.length || 0} awareness signal(s)`);
    }
    if ((work.awarenessSummary?.dueSoon.length || 0) > 0) {
      parts.push(`${work.awarenessSummary?.dueSoon.length || 0} due-soon item(s)`);
    }
    if (work.autonomyDecisions.length > 0) {
      parts.push(`${work.autonomyDecisions.length} chief-of-staff intervention(s)`);
    }
    if (immediateWakeRequests.length > 0) parts.push(`${immediateWakeRequests.length} immediate wake request(s)`);
    if (proactiveTasks.length > 0) parts.push(`${proactiveTasks.length} proactive task(s)`);
    if (checklistItems.length > 0) parts.push(`${checklistItems.length} HEARTBEAT.md check(s)`);
    return parts.length > 0 ? parts.join(", ") : "Scheduled maintenance heartbeat found follow-up work.";
  }

  private buildOutputContract(
    agent: AgentRole,
    workItems: WorkItems,
    immediateWakeRequests: HeartbeatWakeRequest[],
    proactiveTasks: DueProactiveTask[],
    checklistItems: DueChecklistItem[],
  ): CompanyOutputContract {
    const loopType: CompanyLoopType =
      proactiveTasks.length > 0 || checklistItems.length > 0
        ? "review"
        : workItems.pendingMentions.length > 0 || workItems.assignedTasks.length > 0
          ? "execution"
          : "monitor";

    let outputType: CompanyOutputType = "status_digest";
    let reviewRequired = false;
    let reviewReason: CompanyReviewReason | undefined;
    if (workItems.pendingMentions.length > 0 || workItems.assignedTasks.length > 0) {
      outputType = "work_order";
    } else if (workItems.autonomyDecisions.length > 0) {
      outputType = "review_request";
      reviewRequired = true;
      reviewReason = "operator_attention";
    } else if ((workItems.awarenessSummary?.dueSoon.length || 0) > 0) {
      outputType = "status_digest";
    } else if (proactiveTasks.length > 0 || checklistItems.length > 0) {
      outputType = "review_request";
      reviewRequired = true;
      reviewReason = "operator_attention";
    }

    const evidenceRefs = [
      ...workItems.pendingMentions.map((mention) => ({
        type: "mention",
        id: mention.id,
        label: mention.mentionType,
      })),
      ...workItems.assignedTasks.map((task) => ({
        type: "task",
        id: task.id,
        label: task.title,
      })),
      ...proactiveTasks.map((task) => ({
        type: "proactive_task",
        id: task.task.id,
        label: task.task.name,
      })),
      ...checklistItems.map((item) => ({
        type: "heartbeat_check",
        id: item.stateKey,
        label: item.item.title,
      })),
      ...this.getAwarenessEvidenceRefs(workItems.awarenessSummary),
      ...workItems.autonomyDecisions.slice(0, 4).map((decision) => ({
        type: "autonomy_decision",
        id: decision.id,
        label: decision.title,
      })),
      ...immediateWakeRequests.slice(0, 3).map((wake, index) => ({
        type: "wake_request",
        id: `${wake.requestedAt}:${index}`,
        label: wake.source,
      })),
    ];

    const valueReason = this.describeHeartbeatWork(
      workItems,
      immediateWakeRequests,
      proactiveTasks,
      checklistItems,
    );

    return {
      companyId: agent.companyId || "personal",
      operatorRoleId: agent.id,
      loopType,
      outputType,
      sourceIssueId: undefined,
      sourceGoalId: undefined,
      valueReason,
      reviewRequired,
      reviewReason,
      evidenceRefs,
      companyPriority: this.resolveCompanyPriority(workItems, proactiveTasks, checklistItems),
      triggerReason: valueReason,
      expectedOutputType: outputType,
    };
  }

  private resolveCompanyPriority(
    workItems: WorkItems,
    proactiveTasks: DueProactiveTask[],
    checklistItems: DueChecklistItem[],
  ): CompanyPriority {
    if (workItems.pendingMentions.length > 0 || workItems.assignedTasks.length > 1) {
      return "high";
    }
    if ((workItems.awarenessSummary?.dueSoon.length || 0) > 0) {
      return "high";
    }
    if (workItems.autonomyDecisions.some((decision) => decision.priority === "high")) {
      return "high";
    }
    if (proactiveTasks.length > 0 || checklistItems.length > 0) {
      return "normal";
    }
    if ((workItems.awarenessSummary?.whatMattersNow.length || 0) > 0) {
      return "normal";
    }
    return "low";
  }

  private getAwarenessEvidenceRefs(summary: AwarenessSummary | null | undefined): Array<{
    type: string;
    id: string;
    label: string;
  }> {
    if (!summary) return [];
    return [...summary.whatMattersNow, ...summary.dueSoon].slice(0, 6).map((item) => ({
      type: "awareness_signal",
      id: item.id,
      label: item.title,
    }));
  }

  private clearProactiveTaskRunState(agentRoleId: string): void {
    const prefix = `${agentRoleId}:`;
    for (const key of this.proactiveTaskLastRunAt.keys()) {
      if (key.startsWith(prefix)) {
        this.proactiveTaskLastRunAt.delete(key);
      }
    }
    this.maintenanceState.clearAgent(agentRoleId);
  }

  /**
   * Update heartbeat status in the database
   */
  private updateHeartbeatStatus(
    agentRoleId: string,
    status: HeartbeatStatus,
    lastHeartbeatAt?: number,
  ): void {
    this.deps.agentRoleRepo.updateHeartbeatStatus(agentRoleId, status, lastHeartbeatAt);
  }

  /**
   * Calculate next heartbeat time for an agent
   */
  private getNextHeartbeatTime(agent: AgentRole): number | undefined {
    if (!agent.heartbeatEnabled) {
      return undefined;
    }

    const intervalMs = (agent.heartbeatIntervalMinutes || 15) * 60 * 1000;
    const staggerMs = (agent.heartbeatStaggerOffset || 0) * 60 * 1000;
    const lastHeartbeat = agent.lastHeartbeatAt || Date.now();

    return lastHeartbeat + intervalMs + staggerMs;
  }

  /**
   * Emit a heartbeat event
   */
  private emitHeartbeatEvent(event: HeartbeatEvent): void {
    this.emit("heartbeat", event);
    console.log(
      `[HeartbeatService] ${event.agentName}: ${event.type}`,
      event.result
        ? `(mentions: ${event.result.pendingMentions}, tasks: ${event.result.assignedTasks})`
        : "",
    );
  }
}

// Singleton instance
let heartbeatServiceInstance: HeartbeatService | null = null;

export function getHeartbeatService(): HeartbeatService | null {
  return heartbeatServiceInstance;
}

export function setHeartbeatService(service: HeartbeatService | null): void {
  heartbeatServiceInstance = service;
}
