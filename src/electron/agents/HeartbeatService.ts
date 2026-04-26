import Database from "better-sqlite3";
import { EventEmitter } from "events";
import {
  AgentMention,
  AgentRole,
  HeartbeatConfig,
  HeartbeatEvent,
  HeartbeatPulseResultKind,
  HeartbeatResult,
  HeartbeatSignal,
  HeartbeatSignalFamily,
  HeartbeatSignalSource,
  HeartbeatStatus,
  ProactiveSuggestion,
  ProactiveTaskDefinition,
  Task,
  type AwarenessSummary,
  type AutonomyDecision,
  type ChiefOfStaffWorldModel,
  type MemoryFeaturesSettings,
} from "../../shared/types";
import { AgentRoleRepository } from "./AgentRoleRepository";
import { MentionRepository } from "./MentionRepository";
import { ActivityRepository } from "../activity/ActivityRepository";
import { WorkingStateRepository } from "./WorkingStateRepository";
import {
  HeartbeatMaintenanceStateStore,
  type HeartbeatChecklistItem,
  readHeartbeatChecklist,
} from "./heartbeat-maintenance";
import { HeartbeatSignalStore, type SubmitHeartbeatSignalInput } from "./HeartbeatSignalStore";
import { HeartbeatRunRepository } from "./HeartbeatRunRepository";
import { HeartbeatPulseEngine, getSignalStrength, type HeartbeatPulseDecision } from "./HeartbeatPulseEngine";
import { HeartbeatDispatchEngine } from "./HeartbeatDispatchEngine";
import type { MemoryCaptureOptions } from "../memory/MemoryService";
import { AutomationProfileRepository } from "./AutomationProfileRepository";
import { CoreTraceService } from "../core/CoreTraceService";
import { CoreMemoryCandidateService } from "../core/CoreMemoryCandidateService";
import { CoreMemoryDistiller } from "../core/CoreMemoryDistiller";
import { CoreLearningPipelineService } from "../core/CoreLearningPipelineService";

type HeartbeatWakeMode = "now" | "next-heartbeat";
type HeartbeatWakeSource = "hook" | "cron" | "api" | "manual";

interface MaintenanceWorkspaceContext {
  workspaceId: string;
  workspacePath: string;
}

type HeartbeatStatusSnapshot = {
  agentRoleId: string;
  agentName: string;
  heartbeatEnabled: boolean;
  heartbeatStatus: HeartbeatStatus;
  lastHeartbeatAt?: number;
  nextHeartbeatAt?: number;
  lastPulseResult?: HeartbeatPulseResultKind;
  lastDispatchKind?: string;
  deferred?: ReturnType<HeartbeatService["getDeferredStateForAgent"]>;
  compressedSignalCount: number;
  dueProactiveCount: number;
  checklistDueCount: number;
  dispatchCooldownUntil?: number;
  dispatchesToday: number;
  maxDispatchesPerDay: number;
};

export interface HeartbeatServiceDeps {
  db?: Database.Database;
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
      taskOverrides?: Partial<Task>;
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
      workspaceScope?: "single" | "all";
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
  runWorkflowReflection?: (params: {
    workspaceId?: string;
    reason: string;
    signalCount: number;
    heartbeatRunId: string;
  }) => Promise<{ id?: string; outcome?: string } | null>;
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
  automationProfileRepo?: AutomationProfileRepository;
  coreTraceService?: CoreTraceService;
  coreMemoryCandidateService?: CoreMemoryCandidateService;
  coreMemoryDistiller?: CoreMemoryDistiller;
  coreLearningPipelineService?: CoreLearningPipelineService;
}

function normalizeWakeText(text?: string): string {
  const normalized = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  return normalized || "Heartbeat wake requested";
}

function deriveSignalFamily(mode: HeartbeatWakeMode, source: HeartbeatWakeSource): HeartbeatSignalFamily {
  if (mode === "now") return "urgent_interrupt";
  if (source === "cron") return "maintenance";
  return "awareness_signal";
}

function getStartOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function buildSignalSummary(signal: HeartbeatSignal): string {
  const reason = signal.reason ? `: ${signal.reason}` : "";
  return `${signal.signalFamily} via ${signal.source}${reason}`;
}

function isUsableWorkspaceId(value?: string): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function getProactiveTasks(agent: AgentRole): ProactiveTaskDefinition[] {
  return agent.heartbeatPolicy?.proactiveTasks || [];
}

function getHeartbeatPolicy(agent: AgentRole) {
  return agent.heartbeatPolicy;
}


function getTimeParts(timeZone?: string): { hour: number; weekday: number } {
  if (!timeZone) {
    const now = new Date();
    return { hour: now.getHours(), weekday: now.getDay() };
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = formatter.formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value || "0");
  const weekdayText = parts.find((part) => part.type === "weekday")?.value || "Sun";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { hour, weekday: weekdays.indexOf(weekdayText) };
}

function isWithinActiveHours(agent: AgentRole): boolean {
  const activeHours = getHeartbeatPolicy(agent)?.activeHours || agent.activeHours;
  if (!activeHours) return true;
  const { hour, weekday } = getTimeParts(activeHours.timezone);
  if (Array.isArray(activeHours.weekdays) && activeHours.weekdays.length > 0) {
    if (!activeHours.weekdays.includes(weekday)) return false;
  }
  const { startHour, endHour } = activeHours;
  if (startHour === endHour) return true;
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
}

export class HeartbeatService extends EventEmitter {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private runningPromises = new Map<string, Promise<HeartbeatResult>>();
  private pendingManualOverrides = new Set<string>();
  private readonly maintenanceState = new HeartbeatMaintenanceStateStore();
  private readonly signalStore = new HeartbeatSignalStore();
  private readonly runRepo: HeartbeatRunRepository;
  private readonly pulseEngine = new HeartbeatPulseEngine();
  private readonly dispatchEngine: HeartbeatDispatchEngine;
  private started = false;

  constructor(private deps: HeartbeatServiceDeps) {
    super();
    this.runRepo = new HeartbeatRunRepository(deps.db);
    this.dispatchEngine = new HeartbeatDispatchEngine({
      createTask: deps.createTask,
      updateTask: deps.updateTask,
      createCompanionSuggestion: deps.createCompanionSuggestion,
      addNotification: deps.addNotification,
      recordActivity: deps.recordActivity,
    });
  }

  private async finalizeCoreLearning(traceId?: string): Promise<void> {
    if (!traceId) return;
    this.deps.coreMemoryCandidateService?.extractFromTrace(traceId);
    this.deps.coreMemoryCandidateService?.autoAcceptHighSignalCandidates(traceId);
    await this.deps.coreMemoryDistiller?.runHotPath(traceId);
    this.deps.coreLearningPipelineService?.processTrace(traceId);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.runRepo.reconcileInterruptedAgentRuns();
    this.reconcileLegacyMigratedRuns();
    for (const agent of this.deps.agentRoleRepo.findHeartbeatEnabled()) {
      this.scheduleHeartbeat(agent);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.running.clear();
    this.runningPromises.clear();
    this.pendingManualOverrides.clear();
  }

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
    this.submitHeartbeatSignal({
      agentRoleId,
      signalFamily: "urgent_interrupt",
      source: "manual",
      urgency: "critical",
      confidence: 1,
      fingerprint: `manual:${agentRoleId}:${Date.now()}`,
      reason: "Manual immediate wake",
    });
    if (this.running.has(agentRoleId)) {
      this.pendingManualOverrides.add(agentRoleId);
      const current = this.runningPromises.get(agentRoleId);
      if (current) {
        await current;
      }
      await Promise.resolve();
      const replay = this.runningPromises.get(agentRoleId);
      if (replay) return replay;
      const refreshedAgent = this.deps.agentRoleRepo.findById(agentRoleId);
      if (!refreshedAgent) {
        return {
          agentRoleId,
          status: "error",
          pendingMentions: 0,
          assignedTasks: 0,
          relevantActivities: 0,
          error: "Agent role not found after active pulse completed",
        };
      }
      return this.executePulse(refreshedAgent, true);
    }
    return this.executePulse(agent, true);
  }

  submitHeartbeatSignal(input: SubmitHeartbeatSignalInput): HeartbeatSignal {
    const result = this.signalStore.submit(input);
    const agent = this.deps.agentRoleRepo.findById(input.agentRoleId);
    this.emitHeartbeatEvent({
      type: result.merged ? "signal_merged" : "signal_received",
      agentRoleId: input.agentRoleId,
      agentName: agent?.displayName || input.agentRoleId,
      timestamp: Date.now(),
      signal: result.signal,
    });
    return result.signal;
  }

  submitSignalForAll(input: Omit<SubmitHeartbeatSignalInput, "agentRoleId">): HeartbeatSignal[] {
    const signals: HeartbeatSignal[] = [];
    for (const agent of this.deps.agentRoleRepo.findHeartbeatEnabled()) {
      signals.push(
        this.submitHeartbeatSignal({
          ...input,
          agentRoleId: agent.id,
        }),
      );
    }
    return signals;
  }

  submitWakeRequest(
    agentRoleId: string,
    request: { text?: string; mode?: HeartbeatWakeMode; source?: HeartbeatWakeSource },
  ): void {
    const mode = request.mode === "now" ? "now" : "next-heartbeat";
    const source = request.source || "manual";
    const reason = normalizeWakeText(request.text);
    const fingerprint =
      mode === "now" && source === "manual"
        ? `manual:${agentRoleId}:${Date.now()}`
        : `${source}:${mode}:${agentRoleId}:${reason.toLowerCase()}`;
    this.submitHeartbeatSignal({
      agentRoleId,
      signalFamily: deriveSignalFamily(mode, source),
      source,
      urgency: mode === "now" ? "critical" : source === "hook" ? "medium" : "low",
      confidence: mode === "now" ? 1 : source === "hook" ? 0.7 : 0.5,
      fingerprint,
      reason,
    });
  }

  submitWakeForAll(request: {
    text?: string;
    mode?: HeartbeatWakeMode;
    source?: HeartbeatWakeSource;
  }): void {
    for (const agent of this.deps.agentRoleRepo.findHeartbeatEnabled()) {
      this.submitWakeRequest(agent.id, request);
    }
  }

  updateAgentConfig(agentRoleId: string, _config: HeartbeatConfig): void {
    this.cancelHeartbeat(agentRoleId);
    const agent = this.deps.agentRoleRepo.findById(agentRoleId);
    if (agent?.heartbeatPolicy?.enabled || agent?.heartbeatEnabled) this.scheduleHeartbeat(agent);
  }

  cancelHeartbeat(agentRoleId: string): void {
    const timer = this.timers.get(agentRoleId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentRoleId);
    this.running.delete(agentRoleId);
    this.runningPromises.delete(agentRoleId);
    this.pendingManualOverrides.delete(agentRoleId);
    this.signalStore.clearDeferredState(agentRoleId);
  }

  getAllStatus(): HeartbeatStatusSnapshot[] {
    return this.deps.agentRoleRepo.findAll(true).map((agent) => this.buildStatus(agent));
  }

  getStatus(agentRoleId: string):
    | (HeartbeatStatusSnapshot & {
        isRunning: boolean;
      })
    | undefined {
    const agent = this.deps.agentRoleRepo.findById(agentRoleId);
    if (!agent) return undefined;
    return {
      ...this.buildStatus(agent),
      isRunning: this.running.has(agentRoleId),
    };
  }

  private buildStatus(agent: AgentRole): HeartbeatStatusSnapshot {
    const signals = this.signalStore.listAgentSignals(agent.id);
    const deferred = this.getDeferredStateForAgent(agent.id);
    const dueChecklistItems = this.getDueChecklistItems(agent);
    const dueProactiveTasks = this.getDueProactiveTasks(agent, signals);
    const dispatchesToday = this.getDispatchesToday(agent.id);
    const maxDispatchesPerDay =
      agent.heartbeatPolicy?.maxDispatchesPerDay || agent.maxDispatchesPerDay || 6;
    return {
      agentRoleId: agent.id,
      agentName: agent.displayName,
      heartbeatEnabled: agent.heartbeatPolicy?.enabled || agent.heartbeatEnabled || false,
      heartbeatStatus: agent.heartbeatStatus || "idle",
      lastHeartbeatAt: agent.lastHeartbeatAt,
      nextHeartbeatAt: this.getNextHeartbeatTime(agent),
      lastPulseResult: agent.lastPulseResult,
      lastDispatchKind: agent.lastDispatchKind,
      deferred,
      compressedSignalCount: signals.reduce((sum, signal) => sum + signal.mergedCount, 0),
      dueProactiveCount: dueProactiveTasks.length,
      checklistDueCount: dueChecklistItems.length,
      dispatchCooldownUntil: this.getDispatchCooldownUntil(agent),
      dispatchesToday,
      maxDispatchesPerDay,
    };
  }

  private scheduleHeartbeat(agent: AgentRole): void {
    if (!this.started || !(agent.heartbeatPolicy?.enabled || agent.heartbeatEnabled)) return;
    const existing = this.timers.get(agent.id);
    if (existing) clearTimeout(existing);
    const nextHeartbeatAt = this.getNextHeartbeatTime(agent) || Date.now() + 30_000;
    const delay = Math.max(1_000, nextHeartbeatAt - Date.now());
    const timer = setTimeout(async () => {
      const liveAgent = this.deps.agentRoleRepo.findById(agent.id);
      if (liveAgent?.heartbeatPolicy?.enabled || liveAgent?.heartbeatEnabled) {
        await this.executePulse(liveAgent, false);
        const refreshed = this.deps.agentRoleRepo.findById(agent.id);
        if (refreshed?.heartbeatPolicy?.enabled || refreshed?.heartbeatEnabled) this.scheduleHeartbeat(refreshed);
      }
    }, delay);
    this.timers.set(agent.id, timer);
  }

  private async executePulse(agent: AgentRole, manualOverride: boolean): Promise<HeartbeatResult> {
    if (this.running.has(agent.id)) {
      return (
        this.runningPromises.get(agent.id) || {
          agentRoleId: agent.id,
          status: "ok",
          pendingMentions: 0,
          assignedTasks: 0,
          relevantActivities: 0,
          triggerReason: "Pulse already running",
        }
      );
    }

    const dueChecklistItems = this.getDueChecklistItems(agent);
    const pulseSignals = this.signalStore.listAgentSignals(agent.id);
    const pulseMentions = this.deps.mentionRepo.getPendingForAgent(agent.id);
    const pulseTasks = this.deps.getTasksForAgent(agent.id);
    const workspaceId = this.resolveWorkspaceId(
      agent,
      pulseSignals,
      pulseMentions,
      pulseTasks,
      dueChecklistItems,
    );
    const scopedChecklistItems = workspaceId
      ? dueChecklistItems.filter((item) => !item.workspaceId || item.workspaceId === workspaceId)
      : [];
    const pulseRun = this.runRepo.create({
      agentRoleId: agent.id,
      workspaceId,
      runType: "pulse",
      reason: manualOverride ? "manual_pulse" : "scheduled_pulse",
      status: "running",
    });
    const profile = this.deps.automationProfileRepo?.findByAgentRoleId(agent.id);
    const coreTrace = profile
      ? this.deps.coreTraceService?.startTrace({
          profileId: profile.id,
          workspaceId,
          targetKey: `agent_role:${agent.id}`,
          sourceSurface: "heartbeat",
          traceKind: "pulse_cycle",
          status: "running",
          heartbeatRunId: pulseRun.id,
          startedAt: Date.now(),
        })
      : undefined;
    if (coreTrace) {
      this.deps.coreTraceService?.appendPhaseEvent(
        coreTrace.id,
        "start",
        "heartbeat.pulse_started",
        manualOverride ? "Manual heartbeat pulse started." : "Scheduled heartbeat pulse started.",
        {
          agentRoleId: agent.id,
          workspaceId,
          runId: pulseRun.id,
        },
      );
    }
    this.emitHeartbeatEvent({
      type: "pulse_started",
      agentRoleId: agent.id,
      agentName: agent.displayName,
      timestamp: Date.now(),
      runId: pulseRun.id,
      runType: "pulse",
    });

    const promise = (async (): Promise<HeartbeatResult> => {
      this.running.add(agent.id);
      this.deps.agentRoleRepo.updateHeartbeatStatus(agent.id, "running");
      try {
        const pendingMentions = pulseMentions.length;
        const assignedTasks = pulseTasks.length;
        const relevantActivities = workspaceId
          ? this.deps.activityRepo.list({ workspaceId, agentRoleId: agent.id, limit: 10 }).length
          : 0;

        if (!manualOverride && !isWithinActiveHours(agent)) {
          if (coreTrace) {
            this.deps.coreTraceService?.appendPhaseEvent(
              coreTrace.id,
              "gating",
              "heartbeat.gated",
              "Heartbeat pulse deferred because the operator is outside active hours.",
            );
            this.deps.coreTraceService?.completeTrace(
              coreTrace.id,
              "completed",
              "Outside active hours.",
            );
          }
          const result: HeartbeatResult = {
            agentRoleId: agent.id,
            status: "ok",
            runId: pulseRun.id,
            runType: "pulse",
            pendingMentions,
            assignedTasks,
            relevantActivities,
            pulseOutcome: "idle",
            triggerReason: "Outside active hours",
          };
          this.runRepo.finish(pulseRun.id, { status: "completed", summary: "Outside active hours" });
          this.finishPulse(agent, result);
          return result;
        }

        const dueProactiveTasks = this.getDueProactiveTasks(agent, pulseSignals);
        const dispatchesToday = this.getDispatchesToday(agent.id);
        const decision = this.pulseEngine.evaluate({
          agent,
          signals: pulseSignals,
          pendingMentions,
          assignedTasks,
          hasActiveForegroundTask: workspaceId
            ? (this.deps.hasActiveForegroundTask?.(workspaceId) ?? false)
            : (this.deps.hasActiveForegroundTask?.() ?? false),
          manualOverride,
          dueChecklistItems: scopedChecklistItems,
          dueProactiveTasks,
          cooldownUntil: this.getDispatchCooldownUntil(agent),
          dispatchesToday,
          maxDispatchesPerDay:
            agent.heartbeatPolicy?.maxDispatchesPerDay || agent.maxDispatchesPerDay || 6,
          hasInFlightDispatch: this.runRepo.hasInFlightDispatch(agent.id, workspaceId),
        });

        let result: HeartbeatResult = {
          agentRoleId: agent.id,
          status: "ok",
          runId: pulseRun.id,
          runType: "pulse",
          pendingMentions,
          assignedTasks,
          relevantActivities,
          pulseOutcome: decision.kind,
          triggerReason: decision.reason,
          compressedSignalCount: decision.compressedSignalCount,
          signalCount: decision.signalCount,
          dueProactiveCount: decision.dueProactiveCount,
          checklistDueCount: decision.dueChecklistCount,
          dispatchesToday,
          maxDispatchesPerDay:
            agent.heartbeatPolicy?.maxDispatchesPerDay || agent.maxDispatchesPerDay || 6,
        };

        const reflectionRun = await this.maybeRunWorkflowReflection({
          agent,
          workspaceId,
          decision,
          pendingMentions,
          assignedTasks,
          relevantActivities,
          heartbeatRunId: pulseRun.id,
        });
        if (reflectionRun) {
          result = {
            ...result,
            reflectionRunId: reflectionRun.id,
            reflectionOutcome: reflectionRun.outcome,
          };
          if (coreTrace) {
            this.deps.coreTraceService?.appendPhaseEvent(
              coreTrace.id,
              "decision",
              "heartbeat.reflection_triggered",
              "Heartbeat triggered workflow reflection from accumulated signals.",
              {
                reflectionRunId: reflectionRun.id,
                reflectionOutcome: reflectionRun.outcome,
              },
            );
          }
        }

        if (decision.kind === "deferred") {
          if (coreTrace) {
            this.deps.coreTraceService?.appendPhaseEvent(
              coreTrace.id,
              "gating",
              "heartbeat.deferred",
              decision.reason,
              {
                compressedSignalCount: decision.compressedSignalCount,
                signalCount: decision.signalCount,
              },
            );
            this.deps.coreTraceService?.completeTrace(coreTrace.id, "completed", decision.reason);
            await this.finalizeCoreLearning(coreTrace.id);
          }
          this.signalStore.setDeferredState(agent.id, decision.deferred || {
            active: true,
            compressedSignalCount: 0,
          });
          this.runRepo.finish(pulseRun.id, { status: "completed", summary: decision.reason });
          result.deferred = true;
          result.deferredReason = decision.reason;
          this.emitHeartbeatEvent({
            type: "pulse_deferred",
            agentRoleId: agent.id,
            agentName: agent.displayName,
            timestamp: Date.now(),
            result,
            runId: pulseRun.id,
            runType: "pulse",
            deferred: decision.deferred,
          });
          this.finishPulse(agent, result);
          return result;
        }

        this.signalStore.clearDeferredState(agent.id);

        if (decision.kind === "idle" || !decision.dispatchKind) {
          if (coreTrace) {
            this.deps.coreTraceService?.appendPhaseEvent(
              coreTrace.id,
              "decision",
              "heartbeat.idle",
              decision.reason,
            );
            this.deps.coreTraceService?.completeTrace(coreTrace.id, "completed", decision.reason);
            await this.finalizeCoreLearning(coreTrace.id);
          }
          this.runRepo.finish(pulseRun.id, { status: "completed", summary: decision.reason });
          this.emitHeartbeatEvent({
            type: "pulse_completed",
            agentRoleId: agent.id,
            agentName: agent.displayName,
            timestamp: Date.now(),
            result,
            runId: pulseRun.id,
            runType: "pulse",
          });
          this.finishPulse(agent, result);
          return result;
        }

        if (!workspaceId) {
          if (coreTrace) {
            this.deps.coreTraceService?.appendPhaseEvent(
              coreTrace.id,
              "decision",
              "heartbeat.no_workspace",
              "Heartbeat could not dispatch because no workspace was available.",
            );
            this.deps.coreTraceService?.completeTrace(
              coreTrace.id,
              "completed",
              "No workspace available for heartbeat dispatch.",
            );
            await this.finalizeCoreLearning(coreTrace.id);
          }
          result = {
            ...result,
            pulseOutcome: "idle",
            dispatchKind: undefined,
            triggerReason: "No workspace available for heartbeat dispatch",
          };
          this.runRepo.finish(pulseRun.id, {
            status: "completed",
            summary: "No workspace available for heartbeat dispatch",
          });
          this.emitHeartbeatEvent({
            type: "dispatch_skipped",
            agentRoleId: agent.id,
            agentName: agent.displayName,
            timestamp: Date.now(),
            result,
            runId: pulseRun.id,
            runType: "pulse",
            dispatchKind: decision.dispatchKind,
          });
          this.emitHeartbeatEvent({
            type: "pulse_completed",
            agentRoleId: agent.id,
            agentName: agent.displayName,
            timestamp: Date.now(),
            result,
            runId: pulseRun.id,
            runType: "pulse",
          });
          this.finishPulse(agent, result);
          return result;
        }

        const dispatchRun = this.runRepo.create({
          agentRoleId: agent.id,
          workspaceId,
          runType: "dispatch",
          dispatchKind: decision.dispatchKind,
          reason: decision.reason,
          evidenceRefs: decision.evidenceRefs,
          status: "running",
        });
        this.emitHeartbeatEvent({
          type: "dispatch_started",
          agentRoleId: agent.id,
          agentName: agent.displayName,
          timestamp: Date.now(),
          runId: dispatchRun.id,
          runType: "dispatch",
          dispatchKind: decision.dispatchKind,
        });
        if (coreTrace) {
          this.deps.coreTraceService?.appendPhaseEvent(
            coreTrace.id,
            "dispatch",
            "heartbeat.dispatch_started",
            `Heartbeat started ${decision.dispatchKind} dispatch.`,
            {
              dispatchRunId: dispatchRun.id,
              dispatchKind: decision.dispatchKind,
              reason: decision.reason,
            },
          );
        }

        let dispatchResult: HeartbeatResult;
        try {
          dispatchResult = await this.dispatchEngine.execute({
            agent,
            heartbeatRunId: dispatchRun.id,
            workspaceId,
            reason: decision.reason,
            signalSummaries: pulseSignals.map(buildSignalSummary).slice(0, 8),
            evidenceRefs: decision.evidenceRefs,
            dueChecklistItems: scopedChecklistItems,
            dueProactiveTasks,
            dispatchKind: decision.dispatchKind,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.runRepo.recordEvent(dispatchRun.id, "dispatch.failed", {
            dispatchKind: decision.dispatchKind,
            triggerReason: decision.reason,
            error: message,
          });
          this.runRepo.finish(dispatchRun.id, {
            status: "failed",
            summary: decision.reason,
            error: message,
            evidenceRefs: decision.evidenceRefs,
          });
          throw error;
        }

        this.runRepo.recordEvent(dispatchRun.id, "dispatch.completed", {
          dispatchKind: decision.dispatchKind,
          triggerReason: decision.reason,
        });
        this.runRepo.finish(dispatchRun.id, {
          status: dispatchResult.status === "error" ? "failed" : "completed",
          summary: decision.reason,
          error: dispatchResult.error,
          taskId: dispatchResult.taskCreated,
          evidenceRefs: decision.evidenceRefs,
        });
        if (dispatchResult.taskCreated) {
          this.runRepo.attachTask(dispatchRun.id, dispatchResult.taskCreated);
          if (coreTrace) {
            this.deps.coreTraceService?.attachTask(coreTrace.id, dispatchResult.taskCreated);
          }
        }
        if (dispatchResult.status !== "error") {
          this.markMaintenanceCompleted(agent, scopedChecklistItems, dueProactiveTasks, decision.kind);
          this.signalStore.removeSignals(
            agent.id,
            pulseSignals
              .filter((signal) => decision.signalIds.includes(signal.id))
              .map((signal) => ({
                id: signal.id,
                lastSeenAt: signal.lastSeenAt,
                mergedCount: signal.mergedCount,
              })),
          );
        }
        this.deps.agentRoleRepo.updateHeartbeatRunTimestamps?.(agent.id, {
          lastDispatchAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          lastDispatchKind: decision.dispatchKind,
        });
        result = {
          ...result,
          status: dispatchResult.status,
          dispatchKind: decision.dispatchKind,
          taskCreated: dispatchResult.taskCreated,
          runId: pulseRun.id,
        };

        this.runRepo.finish(pulseRun.id, {
          status: "completed",
          summary: `${decision.kind}: ${decision.reason}`,
        });
        if (coreTrace) {
          this.deps.coreTraceService?.appendPhaseEvent(
            coreTrace.id,
            "dispatch",
            "heartbeat.dispatch_completed",
            `${decision.dispatchKind} dispatch ${dispatchResult.status === "error" ? "failed" : "completed"}.`,
            {
              dispatchRunId: dispatchRun.id,
              taskId: dispatchResult.taskCreated,
              status: dispatchResult.status,
            },
          );
          this.deps.coreTraceService?.completeTrace(
            coreTrace.id,
            dispatchResult.status === "error" ? "failed" : "completed",
            `${decision.kind}: ${decision.reason}`,
          );
          await this.finalizeCoreLearning(coreTrace.id);
        }
        this.emitHeartbeatEvent({
          type: "dispatch_completed",
          agentRoleId: agent.id,
          agentName: agent.displayName,
          timestamp: Date.now(),
          result,
          runId: dispatchRun.id,
          runType: "dispatch",
          dispatchKind: decision.dispatchKind,
        });
        this.emitHeartbeatEvent({
          type: "pulse_completed",
          agentRoleId: agent.id,
          agentName: agent.displayName,
          timestamp: Date.now(),
          result,
          runId: pulseRun.id,
          runType: "pulse",
        });
        this.finishPulse(agent, result);
        return result;
      } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (coreTrace) {
        this.deps.coreTraceService?.appendPhaseEvent(
          coreTrace.id,
          "error",
          "heartbeat.error",
          message,
        );
        this.deps.coreTraceService?.failTrace(coreTrace.id, message);
        await this.finalizeCoreLearning(coreTrace.id);
      }
      this.runRepo.finish(pulseRun.id, { status: "failed", error: message });
      const result: HeartbeatResult = {
        agentRoleId: agent.id,
        status: "error",
        runId: pulseRun.id,
        runType: "pulse",
        pendingMentions: 0,
        assignedTasks: 0,
        relevantActivities: 0,
        error: message,
      };
      this.deps.agentRoleRepo.updateHeartbeatStatus(agent.id, "error");
      this.emitHeartbeatEvent({
        type: "error",
        agentRoleId: agent.id,
        agentName: agent.displayName,
        timestamp: Date.now(),
        result,
        error: message,
        runId: pulseRun.id,
        runType: "pulse",
      });
      return result;
      } finally {
      this.running.delete(agent.id);
      this.runningPromises.delete(agent.id);
      const refreshed = this.deps.agentRoleRepo.findById(agent.id);
      if (this.pendingManualOverrides.has(agent.id) && (refreshed?.heartbeatPolicy?.enabled || refreshed?.heartbeatEnabled)) {
        this.pendingManualOverrides.delete(agent.id);
        queueMicrotask(() => {
          const replayAgent = this.deps.agentRoleRepo.findById(agent.id);
          if (replayAgent?.heartbeatPolicy?.enabled || replayAgent?.heartbeatEnabled) {
            void this.executePulse(replayAgent, true);
          }
        });
      } else if (this.started && (refreshed?.heartbeatPolicy?.enabled || refreshed?.heartbeatEnabled) && !this.timers.has(agent.id)) {
        this.scheduleHeartbeat(refreshed);
      }
      }
    })();
    this.runningPromises.set(agent.id, promise);
    return promise;
  }

  private finishPulse(agent: AgentRole, result: HeartbeatResult): void {
    const now = Date.now();
    this.deps.agentRoleRepo.updateHeartbeatStatus(agent.id, "idle", now);
    this.deps.agentRoleRepo.updateHeartbeatRunTimestamps?.(agent.id, {
      lastPulseAt: now,
      lastHeartbeatAt: now,
      lastPulseResult: result.pulseOutcome,
    });
    this.timers.delete(agent.id);
  }

  private async maybeRunWorkflowReflection(params: {
    agent: AgentRole;
    workspaceId?: string;
    decision: HeartbeatPulseDecision;
    pendingMentions: number;
    assignedTasks: number;
    relevantActivities: number;
    heartbeatRunId: string;
  }): Promise<{ id?: string; outcome?: string } | null> {
    if (!this.deps.runWorkflowReflection) return null;
    const actionableSignalCount =
      params.decision.signalCount +
      params.pendingMentions +
      params.decision.dueChecklistCount +
      params.decision.dueProactiveCount;
    const shouldReflect =
      params.decision.kind !== "idle" ||
      actionableSignalCount >= 2 ||
      params.relevantActivities >= 3 ||
      params.assignedTasks >= 2;
    if (!shouldReflect) return null;
    try {
      return await this.deps.runWorkflowReflection({
        workspaceId: params.workspaceId,
        reason: params.decision.reason,
        signalCount: actionableSignalCount,
        heartbeatRunId: params.heartbeatRunId,
      });
    } catch (error) {
      console.warn("[HeartbeatService] Workflow reflection failed:", error);
      return null;
    }
  }

  private getDeferredStateForAgent(agentRoleId: string) {
    return this.signalStore.getDeferredState(agentRoleId);
  }

  private getDispatchesToday(agentRoleId: string): number {
    return this.runRepo
      .listRecentDispatches(agentRoleId, getStartOfDay(Date.now()))
      .filter((run) => run.status !== "cancelled")
      .length;
  }

  private getDispatchCooldownUntil(agent: AgentRole): number | undefined {
    const latestDispatch = this.runRepo.getLatestRun(agent.id, "dispatch");
    if (!latestDispatch?.completedAt) return undefined;
    const cooldownMs =
      (agent.heartbeatPolicy?.dispatchCooldownMinutes || agent.dispatchCooldownMinutes || 120) *
      60 *
      1000;
    if (latestDispatch.status === "failed") {
      return latestDispatch.completedAt + Math.min(cooldownMs / 4, 15 * 60 * 1000);
    }
    return latestDispatch.completedAt + cooldownMs;
  }

  private getNextHeartbeatTime(agent: AgentRole): number | undefined {
    if (!(agent.heartbeatPolicy?.enabled || agent.heartbeatEnabled)) return undefined;
    const intervalMs =
      (agent.heartbeatPolicy?.cadenceMinutes ||
        agent.pulseEveryMinutes ||
        agent.heartbeatIntervalMinutes ||
        15) *
      60 *
      1000;
    const staggerMs =
      (agent.heartbeatPolicy?.staggerOffsetMinutes || agent.heartbeatStaggerOffset || 0) *
      60 *
      1000;
    if (agent.lastPulseAt) {
      return agent.lastPulseAt + intervalMs;
    }
    return Date.now() + Math.max(5_000, staggerMs || 5_000);
  }

  private reconcileLegacyMigratedRuns(): void {
    const db = this.deps.db;
    if (!db) return;

    const staleRows = db
      .prepare(
        `SELECT r.id
         FROM heartbeat_runs r
         LEFT JOIN agent_roles a ON a.id = r.agent_role_id
         LEFT JOIN issues i ON i.id = r.issue_id
         LEFT JOIN tasks t ON t.id = r.task_id
         WHERE r.status = 'running'
           AND r.reason = 'migrated_v2_run'
           AND r.issue_id IS NOT NULL
           AND (
             a.id IS NULL OR
             i.active_run_id = r.id OR
             t.status IN ('failed', 'completed', 'cancelled')
           )`,
      )
      .all() as Array<{ id: string }>;

    if (staleRows.length === 0) return;

    const staleRunIds = staleRows.map((row) => row.id);
    const placeholders = staleRunIds.map(() => "?").join(", ");
    const now = Date.now();
    const message = "Legacy v2 heartbeat run reconciled during v3 startup";

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE heartbeat_runs
         SET status = 'failed',
             error = COALESCE(error, ?),
             updated_at = ?,
             completed_at = COALESCE(completed_at, ?)
         WHERE id IN (${placeholders})`,
      ).run(message, now, now, ...staleRunIds);

      db.prepare(
        `UPDATE issues
         SET active_run_id = NULL,
             updated_at = ?
         WHERE active_run_id IN (${placeholders})`,
      ).run(now, ...staleRunIds);
    });

    tx();
    console.info(`[HeartbeatService] Reconciled ${staleRunIds.length} legacy migrated heartbeat run(s)`);
  }

  private getDueChecklistItems(agent: AgentRole): HeartbeatChecklistItem[] {
    if ((agent.heartbeatPolicy?.profile || agent.heartbeatProfile) === "observer") return [];
    const workspaces =
      this.deps.listWorkspaceContexts?.() ||
      (this.deps.getDefaultWorkspaceId() && this.deps.getDefaultWorkspacePath()
        ? [
            {
              workspaceId: this.deps.getDefaultWorkspaceId() as string,
              workspacePath: this.deps.getDefaultWorkspacePath() as string,
            },
          ]
        : []);
    const now = Date.now();
    const items: HeartbeatChecklistItem[] = [];
    for (const workspace of workspaces) {
      for (const item of readHeartbeatChecklist(workspace.workspacePath, workspace.workspaceId)) {
        const key = `${agent.id}:${workspace.workspaceId}:${item.id}`;
        const lastRunAt = this.maintenanceState.getChecklistLastRunAt(key);
        const due = item.cadenceMs === 0 || lastRunAt === 0 || now - lastRunAt >= item.cadenceMs;
        if (due) items.push(item);
      }
    }
    return items;
  }

  private getDueProactiveTasks(agent: AgentRole, signals: HeartbeatSignal[]): ProactiveTaskDefinition[] {
    if ((agent.heartbeatPolicy?.profile || agent.heartbeatProfile) === "observer") return [];
    const now = Date.now();
    const signalStrength = getSignalStrength(signals);
    return getProactiveTasks(agent).filter((task) => {
      if (!task.enabled) return false;
      if ((task.minSignalStrength || 0) > signalStrength) return false;
      const key = `${agent.id}:${task.id}`;
      const lastRunAt = this.maintenanceState.getProactiveLastRunAt(key);
      return lastRunAt === 0 || now - lastRunAt >= task.frequencyMinutes * 60 * 1000;
    });
  }

  private markMaintenanceCompleted(
    agent: AgentRole,
    dueChecklistItems: HeartbeatChecklistItem[],
    dueProactiveTasks: ProactiveTaskDefinition[],
    outcome: HeartbeatPulseResultKind,
  ): void {
    if (outcome === "deferred" || outcome === "idle") return;
    const now = Date.now();
    for (const item of dueChecklistItems) {
      if (!item.workspaceId) continue;
      this.maintenanceState.setChecklistLastRunAt(`${agent.id}:${item.workspaceId}:${item.id}`, now);
    }
    for (const task of dueProactiveTasks) {
      this.maintenanceState.setProactiveLastRunAt(`${agent.id}:${task.id}`, now);
    }
  }

  private emitHeartbeatEvent(event: HeartbeatEvent): void {
    this.emit("heartbeat", event);
  }

  private resolveWorkspaceId(
    agent: AgentRole,
    signals: HeartbeatSignal[],
    mentions: AgentMention[],
    tasks: Task[],
    dueChecklistItems: HeartbeatChecklistItem[] = [],
  ): string | undefined {
    const candidates: string[] = [];
    for (const signal of signals) {
      if (isUsableWorkspaceId(signal.workspaceId)) candidates.push(signal.workspaceId);
    }
    for (const mention of mentions) {
      if (isUsableWorkspaceId(mention.workspaceId)) candidates.push(mention.workspaceId);
    }
    for (const task of tasks) {
      if (isUsableWorkspaceId(task.workspaceId)) candidates.push(task.workspaceId);
    }
    for (const item of dueChecklistItems) {
      if (isUsableWorkspaceId(item.workspaceId)) candidates.push(item.workspaceId);
    }
    const fallback = this.deps.getDefaultWorkspaceId();
    if (isUsableWorkspaceId(fallback)) candidates.push(fallback);

    for (const candidate of candidates) {
      const workspacePath = this.deps.getWorkspacePath(candidate);
      if (typeof workspacePath === "string" && workspacePath.trim().length > 0) {
        return candidate;
      }
      if (candidate === fallback) {
        return candidate;
      }
    }

    if (fallback) {
      this.deps.recordActivity?.({
        workspaceId: fallback,
        agentRoleId: agent.id,
        title: "Heartbeat workspace resolution fallback",
        description: "No valid source workspace found for heartbeat pulse",
        metadata: {
          signalCount: signals.length,
          mentionCount: mentions.length,
          taskCount: tasks.length,
        },
      });
    }
    return fallback;
  }
}

let heartbeatServiceInstance: HeartbeatService | null = null;

export function getHeartbeatService(): HeartbeatService | null {
  return heartbeatServiceInstance;
}

export function setHeartbeatService(service: HeartbeatService | null): void {
  heartbeatServiceInstance = service;
}
