import { dispatchOccurrenceKey } from "../automation/dispatch-occurrence";
import { serviceStatements } from "../database/service-statements";
import {
  AgentRoleRepository,
  AutomationProfileRepository,
  HeartbeatRunRepository,
  MentionRepository,
  WorkingStateRepository,
} from "./agent-repository-facades";
import type Database from "better-sqlite3";
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
  HeartbeatStatus,
  ProactiveSuggestion,
  ProactiveTaskDefinition,
  Task,
  type HeartbeatDispatchKind,
  type TaskStatus,
  type AwarenessSummary,
  type CreateAutomationRunOutcomeInput,
  type MemoryFeaturesSettings,
} from "../../shared/types";

import { ActivityRepository } from "../activity/activity-repository-facades";

import {
  HeartbeatMaintenanceStateStore,
  type HeartbeatChecklistItem,
  readHeartbeatChecklist,
} from "./heartbeat-maintenance";
import { HeartbeatSignalStore, type SubmitHeartbeatSignalInput } from "./HeartbeatSignalStore";

import {
  HeartbeatPulseEngine,
  getSignalStrength,
  type HeartbeatPulseDecision,
} from "./HeartbeatPulseEngine";
import { HeartbeatDispatchEngine } from "./HeartbeatDispatchEngine";
import {
  getBackgroundDispatchBudget,
  type BackgroundDispatchBudgetAuthority,
} from "./BackgroundDispatchBudget";
import type { SuggestionSource } from "../agent/SuggestionSink";
import {
  TERMINAL_TASK_STATUSES,
  type PruneHeartbeatRunsInput,
  type PruneHeartbeatRunsResult,
} from "./HeartbeatRunRepository";

import { CoreTraceService } from "../core/CoreTraceService";
import { CoreMemoryCandidateService } from "../core/CoreMemoryCandidateService";
import { CoreMemoryDistiller } from "../core/CoreMemoryDistiller";
import { CoreLearningPipelineService } from "../core/CoreLearningPipelineService";
import {
  classifyHeartbeatDispatchOutcome,
  classifyHeartbeatErrorOutcome,
} from "../automation/automation-outcome-classifier";
import { createLogger } from "../utils/logger";

const logger = createLogger("HeartbeatService");

type HeartbeatWakeMode = "now" | "next-heartbeat";
type HeartbeatWakeSource = "hook" | "cron" | "api" | "manual";
type WorkspaceMemoryReadGuard = (candidatePath: string) => boolean;

export interface HeartbeatWakeRequest {
  text?: string;
  mode?: HeartbeatWakeMode;
  source?: HeartbeatWakeSource;
  /** Workspace the wake is about; scopes and merges the resulting signal. */
  workspaceId?: string;
  /** Coarse wake kind (e.g. "file_change", "git") used instead of the text for merging. */
  category?: string;
}

/** Dispatch runs still in flight after this long are treated as abandoned. */
export const STALE_DISPATCH_MS = 12 * 60 * 60 * 1000;
/** Reported runbook/cron items are not re-reported for at least this long. */
const ADVISORY_ACK_MIN_MS = 60 * 60 * 1000;
const HEARTBEAT_RUN_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Wakes of the same kind within this window merge into one signal. */
const WAKE_FINGERPRINT_BUCKET_MS = 60 * 60 * 1000;
const URGENT_WAKE_MIN_RETENTION_MS = 2 * 60 * 60 * 1000;

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
  getTasksForAgent: (agentRoleId: string, workspaceId?: string) => Task[] | Promise<Task[]>;
  /** Current status of a task (undefined when it no longer exists); settles in-flight dispatches. */
  getTaskStatus?: (taskId: string) => TaskStatus | undefined | Promise<TaskStatus | undefined>;
  getDefaultWorkspaceId: () => string | undefined;
  getDefaultWorkspacePath: () => string | undefined;
  getWorkspacePath: (workspaceId: string) => string | undefined;
  /** Resolve the effective profile boundary for memory-only background work. */
  getWorkspaceMemoryReadGuard: (workspaceId: string) => WorkspaceMemoryReadGuard;
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
  /** Shared background dispatch budget (Heartbeat, WI, Strategic Planner). */
  dispatchBudget?: BackgroundDispatchBudgetAuthority;
  listActiveSuggestions?: (
    workspaceId: string,
  ) => ProactiveSuggestion[] | Promise<ProactiveSuggestion[]>;
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
      entityKey?: string;
      source?: SuggestionSource;
    },
  ) => Promise<ProactiveSuggestion | null>;
  addNotification?: (params: {
    type: "companion_suggestion" | "info" | "warning";
    title: string;
    message: string;
    workspaceId?: string;
    taskId?: string;
    suggestionId?: string;
    recommendedDelivery?: "briefing" | "inbox" | "nudge";
    companionStyle?: "email" | "note";
  }) => Promise<void>;
  recordAutomationOutcome?: (outcome: CreateAutomationRunOutcomeInput) => Promise<unknown>;
  runWorkflowReflection?: (params: {
    workspaceId?: string;
    reason: string;
    signalCount: number;
    heartbeatRunId: string;
  }) => Promise<{ id?: string; outcome?: string } | null>;
  /**
   * Commitment expiry (docs/memory-repo-phase3-design.md §6): closes past-due commitments
   * that later activity says were done. Offered once per idle pulse; the service keeps its
   * own daily cooldown and returns null when it did not run.
   */
  runCommitmentExpiry?: () => Promise<{ expired: number } | null>;
  /**
   * The daily dream over the memory folder (docs/memory-repo-phase2-design.md §6). Offered
   * once per idle pulse; the dreamer enforces its own interval, budget and settings.
   */
  runMemoryRepoDream?: () => Promise<unknown>;
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

function deriveSignalFamily(
  mode: HeartbeatWakeMode,
  source: HeartbeatWakeSource,
): HeartbeatSignalFamily {
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

function isHeartbeatEnabled(agent: AgentRole): boolean {
  return Boolean(agent.heartbeatPolicy?.enabled || agent.heartbeatEnabled);
}

function normalizeWakeCategory(category?: string): string {
  const normalized = typeof category === "string" ? category.trim().toLowerCase() : "";
  return normalized.replace(/[^a-z0-9_-]+/g, "_").slice(0, 40) || "general";
}

/** Dispatch kinds that are reported but not executed yet. */
function isAdvisoryDispatchKind(kind?: HeartbeatDispatchKind): kind is "runbook" | "cron_handoff" {
  return kind === "runbook" || kind === "cron_handoff";
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
  private pendingManualReplays = new Map<
    string,
    {
      promise: Promise<HeartbeatResult>;
      resolve: (result: HeartbeatResult | Promise<HeartbeatResult>) => void;
    }
  >();
  private pendingImmediatePulses = new Set<string>();
  private advisoryAcknowledgedAt = new Map<string, number>();
  private retentionTimer: NodeJS.Timeout | null = null;
  private readonly maintenanceState = new HeartbeatMaintenanceStateStore();
  private readonly signalStore = new HeartbeatSignalStore();
  private readonly runRepo: HeartbeatRunRepository;
  private readonly pulseEngine = new HeartbeatPulseEngine();
  private readonly dispatchEngine: HeartbeatDispatchEngine;
  private started = false;
  private stopping = false;

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
    await this.deps.coreMemoryCandidateService?.extractFromTrace(traceId);
    await this.deps.coreMemoryCandidateService?.autoAcceptHighSignalCandidates(traceId);
    await this.deps.coreMemoryDistiller?.runHotPath(traceId);
    await this.deps.coreLearningPipelineService?.processTrace(traceId);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.stopping = false;
    this.started = true;
    await this.runRepo.reconcileInterruptedAgentRuns();
    await this.reconcileStaleDispatchRuns();
    await this.reconcileLegacyMigratedRuns();
    await this.pruneRunHistorySafely();
    if (!this.started || this.stopping) return;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = setInterval(() => {
      void this.pruneRunHistorySafely();
    }, HEARTBEAT_RUN_RETENTION_INTERVAL_MS);
    this.retentionTimer.unref?.();
    for (const agent of await this.deps.agentRoleRepo.findHeartbeatEnabled()) {
      this.scheduleHeartbeat(agent);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = null;
    this.pendingImmediatePulses.clear();
    // Pulses can still be awaiting dispatch or learning work. Keep storage alive
    // until their completion bookkeeping has finished.
    await Promise.allSettled(this.runningPromises.values());
    for (const [agentRoleId, replay] of this.pendingManualReplays) {
      replay.resolve(this.stoppedResult(agentRoleId));
    }
    this.pendingManualReplays.clear();
    this.running.clear();
    this.runningPromises.clear();
    await this.signalStore.flush();
  }

  /**
   * Delete old pulse/dispatch history (default: older than 30 days, keeping the newest 200 runs
   * per agent). Runs at startup and daily; retention services may call it directly.
   */
  async pruneRunHistory(input: PruneHeartbeatRunsInput = {}): Promise<PruneHeartbeatRunsResult> {
    return this.runRepo.pruneRuns(input);
  }

  private async pruneRunHistorySafely(): Promise<void> {
    if (this.stopping) return;
    try {
      const pruned = await this.pruneRunHistory();
      if (pruned.runsDeleted > 0) {
        console.info(
          `[HeartbeatService] Pruned ${pruned.runsDeleted} heartbeat run(s) and ${pruned.eventsDeleted} event(s)`,
        );
      }
    } catch (error) {
      console.warn("[HeartbeatService] Failed to prune heartbeat run history:", error);
    }
  }

  async triggerHeartbeat(agentRoleId: string): Promise<HeartbeatResult> {
    if (this.stopping) return this.stoppedResult(agentRoleId);
    const agent = await this.deps.agentRoleRepo.findById(agentRoleId);
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
    await this.submitHeartbeatSignal({
      agentRoleId,
      signalFamily: "urgent_interrupt",
      source: "manual",
      urgency: "critical",
      confidence: 1,
      fingerprint: `manual:${agentRoleId}:${Date.now()}`,
      reason: "Manual immediate wake",
    });
    if (this.stopping) return this.stoppedResult(agentRoleId);
    if (this.running.has(agentRoleId)) {
      // A pulse is in flight. Queue exactly one manual replay for when it finishes; every manual
      // trigger that arrives meanwhile shares that replay.
      const queued = this.pendingManualReplays.get(agentRoleId);
      if (queued) return queued.promise;
      let resolve!: (result: HeartbeatResult | Promise<HeartbeatResult>) => void;
      const promise = new Promise<HeartbeatResult>((done) => {
        resolve = done;
      });
      this.pendingManualReplays.set(agentRoleId, { promise, resolve });
      return promise;
    }
    return this.executePulse(agent, true);
  }

  async submitHeartbeatSignal(input: SubmitHeartbeatSignalInput): Promise<HeartbeatSignal> {
    const result = this.signalStore.submit(input);
    const agent = await this.deps.agentRoleRepo.findById(input.agentRoleId);
    this.emitHeartbeatEvent({
      type: result.merged ? "signal_merged" : "signal_received",
      agentRoleId: input.agentRoleId,
      agentName: agent?.displayName || input.agentRoleId,
      timestamp: Date.now(),
      signal: result.signal,
    });
    return result.signal;
  }

  async submitSignalForAll(
    input: Omit<SubmitHeartbeatSignalInput, "agentRoleId">,
  ): Promise<HeartbeatSignal[]> {
    const signals: HeartbeatSignal[] = [];
    for (const agent of await this.deps.agentRoleRepo.findHeartbeatEnabled()) {
      signals.push(
        await this.submitHeartbeatSignal({
          ...input,
          agentRoleId: agent.id,
        }),
      );
    }
    return signals;
  }

  async submitWakeRequest(agentRoleId: string, request: HeartbeatWakeRequest): Promise<void> {
    const mode = request.mode === "now" ? "now" : "next-heartbeat";
    const source = request.source || "manual";
    const reason = normalizeWakeText(request.text);
    const signalFamily = deriveSignalFamily(mode, source);
    const workspaceId = isUsableWorkspaceId(request.workspaceId) ? request.workspaceId : undefined;
    const now = Date.now();
    // Wake texts carry window titles and file paths, so they must not be part of the
    // fingerprint: wakes of the same kind merge per source, family, category, workspace and
    // time bucket.
    const fingerprint =
      mode === "now" && source === "manual"
        ? `manual:${agentRoleId}:${now}`
        : [
            "wake",
            source,
            signalFamily,
            normalizeWakeCategory(request.category),
            workspaceId || "*",
            Math.floor(now / WAKE_FINGERPRINT_BUCKET_MS),
          ].join(":");
    let expiresAt: number | undefined;
    if (mode === "now") {
      // An urgent wake must survive at least two pulse intervals of this agent.
      const agent = await this.deps.agentRoleRepo.findById(agentRoleId);
      expiresAt = now + Math.max(URGENT_WAKE_MIN_RETENTION_MS, 2 * this.getCadenceMs(agent));
    }
    await this.submitHeartbeatSignal({
      agentRoleId,
      workspaceId,
      signalFamily,
      source,
      urgency: mode === "now" ? "critical" : source === "hook" ? "medium" : "low",
      confidence: mode === "now" ? 1 : source === "hook" ? 0.7 : 0.5,
      fingerprint,
      reason,
      expiresAt,
    });
    if (mode === "now") {
      await this.requestImmediatePulse(agentRoleId);
    }
  }

  async submitWakeForAll(request: HeartbeatWakeRequest): Promise<void> {
    for (const agent of await this.deps.agentRoleRepo.findHeartbeatEnabled()) {
      await this.submitWakeRequest(agent.id, request);
    }
  }

  /**
   * Pulse an agent as soon as possible. Never starts a second concurrent pulse: while one is
   * running, the immediate pulse is queued for right after it.
   */
  private async requestImmediatePulse(agentRoleId: string): Promise<void> {
    if (!this.started || this.stopping) return;
    if (this.running.has(agentRoleId)) {
      this.pendingImmediatePulses.add(agentRoleId);
      return;
    }
    const agent = await this.deps.agentRoleRepo.findById(agentRoleId);
    if (!agent || !isHeartbeatEnabled(agent) || !this.started || this.stopping) return;
    if (this.running.has(agentRoleId)) {
      this.pendingImmediatePulses.add(agentRoleId);
      return;
    }
    this.scheduleHeartbeat(agent, { immediate: true });
  }

  async updateAgentConfig(agentRoleId: string, _config: HeartbeatConfig): Promise<void> {
    this.cancelHeartbeat(agentRoleId);
    const agent = await this.deps.agentRoleRepo.findById(agentRoleId);
    if (agent?.heartbeatPolicy?.enabled || agent?.heartbeatEnabled) this.scheduleHeartbeat(agent);
  }

  cancelHeartbeat(agentRoleId: string): void {
    const timer = this.timers.get(agentRoleId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentRoleId);
    this.pendingImmediatePulses.delete(agentRoleId);
    // An in-flight pulse keeps its running slot: releasing it here would let a second pulse
    // start concurrently. The pulse releases the slot (and settles queued manual replays) itself.
    this.signalStore.clearDeferredState(agentRoleId);
  }

  async getAllStatus(): Promise<HeartbeatStatusSnapshot[]> {
    return Promise.all(
      (await this.deps.agentRoleRepo.findAll(true)).map((agent) => this.buildStatus(agent)),
    );
  }

  async getStatus(agentRoleId: string): Promise<
    | (HeartbeatStatusSnapshot & {
        isRunning: boolean;
      })
    | undefined
  > {
    const agent = await this.deps.agentRoleRepo.findById(agentRoleId);
    if (!agent) return undefined;
    return {
      ...(await this.buildStatus(agent)),
      isRunning: this.running.has(agentRoleId),
    };
  }

  private async buildStatus(agent: AgentRole): Promise<HeartbeatStatusSnapshot> {
    const signals = this.signalStore.listAgentSignals(agent.id);
    const deferred = this.getDeferredStateForAgent(agent.id);
    const dueChecklistItems = this.getDueChecklistItems(agent);
    const dueProactiveTasks = this.getDueProactiveTasks(agent, signals);
    const dispatchesToday = await this.getDispatchesToday(agent.id);
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
      dispatchCooldownUntil: await this.getDispatchCooldownUntil(agent),
      dispatchesToday,
      maxDispatchesPerDay,
    };
  }

  /** Arm the agent's single pulse timer, replacing (and clearing) any existing one. */
  private scheduleHeartbeat(agent: AgentRole, options: { immediate?: boolean } = {}): void {
    if (!this.started || this.stopping || !isHeartbeatEnabled(agent)) return;
    const existing = this.timers.get(agent.id);
    if (existing) clearTimeout(existing);
    this.timers.delete(agent.id);
    const nextHeartbeatAt = this.getNextHeartbeatTime(agent) || Date.now() + 30_000;
    const delay = options.immediate ? 0 : Math.max(1_000, nextHeartbeatAt - Date.now());
    const runScheduledPulse = async () => {
      if (!this.started) return;
      try {
        const liveAgent = await this.deps.agentRoleRepo.findById(agent.id);
        // The pulse re-arms the timer when it releases its running slot.
        if (liveAgent && isHeartbeatEnabled(liveAgent)) await this.executePulse(liveAgent, false);
      } catch (error) {
        console.error("[HeartbeatService] Scheduled heartbeat failed:", error);
        if (this.started && !this.timers.has(agent.id) && !this.running.has(agent.id)) {
          this.scheduleHeartbeat(agent);
        }
      }
    };
    const timer = setTimeout(() => {
      // A fired timer is no longer pending; drop it so the pulse can re-arm the agent.
      if (this.timers.get(agent.id) === timer) this.timers.delete(agent.id);
      // The pulse catches its own failures; the timer only starts it.
      void runScheduledPulse();
    }, delay);
    this.timers.set(agent.id, timer);
  }

  private stoppedResult(agentRoleId: string): HeartbeatResult {
    return {
      agentRoleId,
      status: "error",
      pendingMentions: 0,
      assignedTasks: 0,
      relevantActivities: 0,
      error: "Heartbeat service is stopped",
    };
  }

  private executePulse(agent: AgentRole, manualOverride: boolean): Promise<HeartbeatResult> {
    if (this.stopping) return Promise.resolve(this.stoppedResult(agent.id));
    if (this.running.has(agent.id)) {
      return (
        this.runningPromises.get(agent.id) ||
        Promise.resolve({
          agentRoleId: agent.id,
          status: "ok",
          pendingMentions: 0,
          assignedTasks: 0,
          relevantActivities: 0,
          triggerReason: "Pulse already running",
        })
      );
    }
    // Reserve the slot synchronously, before any await: otherwise a scheduled and a manual
    // pulse can both pass the guard and dispatch twice.
    this.running.add(agent.id);
    const promise = Promise.resolve().then(() => this.runPulse(agent, manualOverride));
    this.runningPromises.set(agent.id, promise);
    return promise;
  }

  private async runPulse(agent: AgentRole, manualOverride: boolean): Promise<HeartbeatResult> {
    try {
      return await this.runPulseBody(agent, manualOverride);
    } catch (error) {
      // Failures before the pulse run row exists; later failures are recorded by the body.
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Bot future runs are paused") {
        const result: HeartbeatResult = {
          agentRoleId: agent.id,
          status: "ok",
          runType: "pulse",
          pendingMentions: 0,
          assignedTasks: 0,
          relevantActivities: 0,
          pulseOutcome: "idle",
          triggerReason: message,
        };
        await this.finishPulse(agent, result);
        return result;
      }
      console.error("[HeartbeatService] Heartbeat pulse failed:", error);
      try {
        await this.deps.agentRoleRepo.updateHeartbeatStatus(agent.id, "error");
      } catch {
        // Best effort only.
      }
      return {
        agentRoleId: agent.id,
        status: "error",
        pendingMentions: 0,
        assignedTasks: 0,
        relevantActivities: 0,
        error: message,
      };
    } finally {
      await this.releasePulseSlot(agent.id);
    }
  }

  /**
   * Release the running slot and decide what runs next: a queued manual replay (exactly once),
   * a queued immediate pulse, or the next scheduled pulse. The slot stays held while the agent
   * is re-read so nothing can start in between.
   */
  private async releasePulseSlot(agentRoleId: string): Promise<void> {
    let refreshed: AgentRole | undefined;
    if (!this.stopping) {
      try {
        refreshed = await this.deps.agentRoleRepo.findById(agentRoleId);
      } catch (error) {
        console.error("[HeartbeatService] Failed to reload agent after a pulse:", error);
      }
    }
    const replay = this.pendingManualReplays.get(agentRoleId);
    this.pendingManualReplays.delete(agentRoleId);
    const immediate = this.pendingImmediatePulses.delete(agentRoleId);
    this.running.delete(agentRoleId);
    this.runningPromises.delete(agentRoleId);

    if (replay) {
      if (this.stopping) {
        replay.resolve(this.stoppedResult(agentRoleId));
      } else if (!refreshed) {
        replay.resolve({
          agentRoleId,
          status: "error",
          pendingMentions: 0,
          assignedTasks: 0,
          relevantActivities: 0,
          error: "Agent role not found after active pulse completed",
        });
      } else {
        // The replay pulse re-arms the timer when it finishes.
        replay.resolve(this.executePulse(refreshed, true));
      }
      return;
    }
    if (!this.started || this.stopping || !refreshed || !isHeartbeatEnabled(refreshed)) return;
    if (immediate) {
      this.scheduleHeartbeat(refreshed, { immediate: true });
    } else if (!this.timers.has(agentRoleId)) {
      this.scheduleHeartbeat(refreshed);
    }
  }

  private async runPulseBody(agent: AgentRole, manualOverride: boolean): Promise<HeartbeatResult> {
    const dueChecklistItems = this.getDueChecklistItems(agent);
    const pulseSignals = this.signalStore.listAgentSignals(agent.id);
    const pulseMentions = await this.deps.mentionRepo.getPendingForAgent(agent.id);
    const pulseTasks = await this.deps.getTasksForAgent(agent.id);
    const workspaceId = this.resolveWorkspaceId(
      agent,
      pulseSignals,
      pulseMentions,
      pulseTasks,
      dueChecklistItems,
    );
    if (
      workspaceId &&
      this.deps.db &&
      (await serviceStatements(this.deps.db).unit("botWorkControl_futurePaused", [
        workspaceId,
        agent.id,
      ]))
    ) {
      const result: HeartbeatResult = {
        agentRoleId: agent.id,
        status: "ok",
        runType: "pulse",
        pendingMentions: pulseMentions.length,
        assignedTasks: pulseTasks.length,
        relevantActivities: 0,
        pulseOutcome: "idle",
        triggerReason: "Bot future runs are paused",
      };
      await this.finishPulse(agent, result);
      return result;
    }
    const scopedChecklistItems = workspaceId
      ? dueChecklistItems.filter((item) => !item.workspaceId || item.workspaceId === workspaceId)
      : [];
    const pendingMentions = pulseMentions.length;
    const assignedTasks = pulseTasks.length;

    // Cheap gates first: a quiet pulse creates no run or trace rows and triggers neither
    // reflection nor Dreaming.
    if (!manualOverride && !isWithinActiveHours(agent)) {
      const result: HeartbeatResult = {
        agentRoleId: agent.id,
        status: "ok",
        runType: "pulse",
        pendingMentions,
        assignedTasks,
        relevantActivities: 0,
        pulseOutcome: "idle",
        triggerReason: "Outside active hours",
      };
      await this.finishPulse(agent, result);
      return result;
    }

    await this.settleInFlightDispatches(agent.id);
    const dueProactiveTasks = this.getDueProactiveTasks(agent, pulseSignals);
    const now = Date.now();
    // Runbook and cron hand-off items that were already reported stay due (they did not run)
    // but must not keep winning every pulse over other work.
    const decisionChecklistItems = scopedChecklistItems.filter(
      (item) => !this.isAdvisoryAcknowledged(this.checklistKey(agent, item), item.cadenceMs, now),
    );
    const decisionProactiveTasks = dueProactiveTasks.filter(
      (task) =>
        !this.isAdvisoryAcknowledged(
          this.proactiveKey(agent, task),
          task.frequencyMinutes * 60 * 1000,
          now,
        ),
    );
    const dispatchesToday = await this.getDispatchesToday(agent.id);
    const maxDispatchesPerDay =
      agent.heartbeatPolicy?.maxDispatchesPerDay || agent.maxDispatchesPerDay || 6;
    let decision = this.withDispatchEvidence(
      this.pulseEngine.evaluate({
        agent,
        signals: pulseSignals,
        pendingMentions,
        assignedTasks,
        hasActiveForegroundTask: workspaceId
          ? (this.deps.hasActiveForegroundTask?.(workspaceId) ?? false)
          : (this.deps.hasActiveForegroundTask?.() ?? false),
        manualOverride,
        dueChecklistItems: decisionChecklistItems,
        dueProactiveTasks: decisionProactiveTasks,
        cooldownUntil: await this.getDispatchCooldownUntil(agent),
        dispatchesToday,
        maxDispatchesPerDay,
        hasInFlightDispatch: await this.runRepo.hasInFlightDispatch(agent.id, workspaceId),
      }),
      { agent, mentions: pulseMentions, tasks: pulseTasks, manualOverride },
    );

    if (decision.kind === "deferred") {
      this.signalStore.setDeferredState(
        agent.id,
        decision.deferred || {
          active: true,
          compressedSignalCount: 0,
        },
      );
      const result: HeartbeatResult = {
        agentRoleId: agent.id,
        status: "ok",
        runType: "pulse",
        pendingMentions,
        assignedTasks,
        relevantActivities: 0,
        pulseOutcome: decision.kind,
        triggerReason: decision.reason,
        compressedSignalCount: decision.compressedSignalCount,
        signalCount: decision.signalCount,
        dueProactiveCount: decision.dueProactiveCount,
        checklistDueCount: decision.dueChecklistCount,
        dispatchesToday,
        maxDispatchesPerDay,
        deferred: true,
        deferredReason: decision.reason,
      };
      this.emitHeartbeatEvent({
        type: "pulse_deferred",
        agentRoleId: agent.id,
        agentName: agent.displayName,
        timestamp: Date.now(),
        result,
        runType: "pulse",
        deferred: decision.deferred,
      });
      await this.finishPulse(agent, result);
      return result;
    }

    await this.deps.agentRoleRepo.updateHeartbeatStatus(agent.id, "running");
    const relevantActivities = workspaceId
      ? (await this.deps.activityRepo.list({ workspaceId, agentRoleId: agent.id, limit: 10 }))
          .length
      : 0;
    const pulseRun = await this.runRepo.create({
      agentRoleId: agent.id,
      workspaceId,
      runType: "pulse",
      reason: manualOverride ? "manual_pulse" : "scheduled_pulse",
      status: "running",
    });
    let coreTrace: Awaited<ReturnType<CoreTraceService["startTrace"]>> | undefined;
    try {
      const profile = await this.deps.automationProfileRepo?.findByAgentRoleId(agent.id);
      coreTrace = profile
        ? await this.deps.coreTraceService?.startTrace({
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
        await this.deps.coreTraceService?.appendPhaseEvent(
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
        maxDispatchesPerDay,
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
          await this.deps.coreTraceService?.appendPhaseEvent(
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

      const commitmentSweep = await this.maybeRunCommitmentExpiry();
      this.offerMemoryRepoDream();
      if (commitmentSweep && commitmentSweep.expired > 0) {
        result = { ...result, commitmentsExpired: commitmentSweep.expired };
        if (coreTrace) {
          await this.deps.coreTraceService?.appendPhaseEvent(
            coreTrace.id,
            "decision",
            "heartbeat.commitments_expired",
            "Heartbeat closed past-due commitments that were done.",
            { expired: commitmentSweep.expired },
          );
        }
      }

      this.signalStore.clearDeferredState(agent.id);

      if (decision.kind === "idle" || !decision.dispatchKind) {
        if (coreTrace) {
          await this.deps.coreTraceService?.appendPhaseEvent(
            coreTrace.id,
            "decision",
            "heartbeat.idle",
            decision.reason,
          );
          await this.deps.coreTraceService?.completeTrace(
            coreTrace.id,
            "completed",
            decision.reason,
          );
          await this.finalizeCoreLearning(coreTrace.id);
        }
        await this.runRepo.finish(pulseRun.id, { status: "completed", summary: decision.reason });
        this.emitHeartbeatEvent({
          type: "pulse_completed",
          agentRoleId: agent.id,
          agentName: agent.displayName,
          timestamp: Date.now(),
          result,
          runId: pulseRun.id,
          runType: "pulse",
        });
        await this.finishPulse(agent, result);
        return result;
      }

      if (!workspaceId) {
        if (coreTrace) {
          await this.deps.coreTraceService?.appendPhaseEvent(
            coreTrace.id,
            "decision",
            "heartbeat.no_workspace",
            "Heartbeat could not dispatch because no workspace was available.",
          );
          await this.deps.coreTraceService?.completeTrace(
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
        await this.runRepo.finish(pulseRun.id, {
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
        await this.finishPulse(agent, result);
        return result;
      }

      if (isAdvisoryDispatchKind(decision.dispatchKind)) {
        // Runbooks and cron hand-offs are not executed yet; they only leave an activity entry.
        // Until they are, they must not spend dispatch budget or cooldown (no dispatch run),
        // mark checklist items done, or consume signals other dispatches still need.
        const advisoryChecklistItems =
          decision.dispatchKind === "runbook" ? decisionChecklistItems : [];
        const advisoryProactiveTasks = decisionProactiveTasks.filter((task) =>
          decision.dispatchKind === "cron_handoff"
            ? task.executionMode === "cron_handoff"
            : task.executionMode !== "pulse_only",
        );
        const advisoryResult = await this.dispatchEngine.execute({
          agent,
          heartbeatRunId: pulseRun.id,
          workspaceId,
          reason: decision.reason,
          signalSummaries: pulseSignals.map(buildSignalSummary).slice(0, 8),
          evidenceRefs: decision.evidenceRefs,
          dueChecklistItems: advisoryChecklistItems,
          dueProactiveTasks: advisoryProactiveTasks,
          dispatchKind: decision.dispatchKind,
        });
        await this.runRepo.recordEvent(pulseRun.id, "dispatch.advisory", {
          dispatchKind: decision.dispatchKind,
          triggerReason: decision.reason,
          checklistItems: advisoryChecklistItems.map((item) => item.title),
          proactiveTasks: advisoryProactiveTasks.map((task) => task.name),
        });
        this.acknowledgeAdvisoryItems(agent, advisoryChecklistItems, advisoryProactiveTasks);
        this.removeDecisionSignals(agent.id, pulseSignals, decision.signalIds);
        result = {
          ...result,
          status: advisoryResult.status,
          dispatchKind: decision.dispatchKind,
        };
        await this.runRepo.finish(pulseRun.id, {
          status: "completed",
          summary: `${decision.kind}: ${decision.reason}`,
        });
        if (coreTrace) {
          await this.deps.coreTraceService?.appendPhaseEvent(
            coreTrace.id,
            "decision",
            "heartbeat.advisory_dispatch",
            `${decision.dispatchKind} noted; not executed.`,
          );
          await this.deps.coreTraceService?.completeTrace(
            coreTrace.id,
            "completed",
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
        await this.finishPulse(agent, result);
        return result;
      }

      // Task creation also spends the shared per-workspace background budget, which
      // Workflow Intelligence and the Strategic Planner draw from too. Over
      // budget, the dispatch becomes a suggestion. Manual pulses are recorded, never refused.
      let budgetTicket: string | undefined;
      let durableBudgetTicket: string | undefined;
      if (decision.dispatchKind === "task") {
        const grant = await this.getDispatchBudget().tryConsume({
          workspaceId,
          source: "heartbeat",
          occurrenceKey: dispatchOccurrenceKey("heartbeat", [
            agent.id,
            manualOverride ? "manual" : "scheduled",
            manualOverride ? pulseRun.id : agent.lastPulseAt || 0,
          ]),
          manual: manualOverride,
        });
        if (grant.allowed) {
          budgetTicket = grant.ticket;
          durableBudgetTicket = grant.durable ? grant.ticket : undefined;
        } else if (grant.reason === "duplicate_occurrence") {
          const summary = "This scheduled pulse has already been admitted for dispatch.";
          result = { ...result, pulseOutcome: "idle", triggerReason: summary, runId: pulseRun.id };
          await this.runRepo.finish(pulseRun.id, { status: "completed", summary });
          if (coreTrace) {
            await this.deps.coreTraceService?.completeTrace(coreTrace.id, "completed", summary);
            await this.finalizeCoreLearning(coreTrace.id);
          }
          this.emitHeartbeatEvent({
            type: "pulse_completed",
            agentRoleId: agent.id,
            agentName: agent.displayName,
            timestamp: Date.now(),
            result,
            runId: pulseRun.id,
            runType: "pulse",
          });
          await this.finishPulse(agent, result);
          return result;
        } else {
          decision = {
            ...decision,
            kind: "suggestion",
            dispatchKind: "suggestion",
            reason: `${decision.reason} (workspace background task budget reached; suggested instead of creating a task)`,
          };
          result = { ...result, pulseOutcome: decision.kind, triggerReason: decision.reason };
        }
      }

      const dispatchRun = await this.runRepo.create({
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
        await this.deps.coreTraceService?.appendPhaseEvent(
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
          backgroundDispatchTicket: durableBudgetTicket,
          agent,
          heartbeatRunId: dispatchRun.id,
          workspaceId,
          reason: decision.reason,
          signalSummaries: pulseSignals.map(buildSignalSummary).slice(0, 8),
          evidenceRefs: decision.evidenceRefs,
          dueChecklistItems: scopedChecklistItems,
          dueProactiveTasks,
          // Narrowing is lost by the budget downgrade above; the idle branch already returned.
          dispatchKind: decision.dispatchKind ?? "suggestion",
        });
      } catch (error) {
        await this.getDispatchBudget().refund(budgetTicket);
        const message = error instanceof Error ? error.message : String(error);
        await this.runRepo.recordEvent(dispatchRun.id, "dispatch.failed", {
          dispatchKind: decision.dispatchKind,
          triggerReason: decision.reason,
          error: message,
        });
        await this.runRepo.finish(dispatchRun.id, {
          status: "failed",
          summary: decision.reason,
          error: message,
          evidenceRefs: decision.evidenceRefs,
        });
        throw error;
      }

      // A created task is the dispatch's real work: the run stays in flight until the task
      // reaches a terminal state (settleInFlightDispatches), so the in-flight guard holds.
      const tracksTask = dispatchResult.status !== "error" && Boolean(dispatchResult.taskCreated);
      if (!dispatchResult.taskCreated) await this.getDispatchBudget().refund(budgetTicket);
      await this.runRepo.recordEvent(
        dispatchRun.id,
        tracksTask ? "dispatch.task_created" : "dispatch.completed",
        {
          dispatchKind: decision.dispatchKind,
          triggerReason: decision.reason,
          taskId: dispatchResult.taskCreated,
        },
      );
      if (dispatchResult.taskCreated) {
        await this.runRepo.attachTask(dispatchRun.id, dispatchResult.taskCreated);
        if (coreTrace) {
          await this.deps.coreTraceService?.attachTask(coreTrace.id, dispatchResult.taskCreated);
        }
      }
      if (!tracksTask) {
        await this.runRepo.finish(dispatchRun.id, {
          status: dispatchResult.status === "error" ? "failed" : "completed",
          summary: decision.reason,
          error: dispatchResult.error,
          taskId: dispatchResult.taskCreated,
          evidenceRefs: decision.evidenceRefs,
        });
      }
      if (dispatchResult.status !== "error") {
        this.markMaintenanceCompleted(
          agent,
          scopedChecklistItems,
          dueProactiveTasks,
          decision.kind,
        );
        this.removeDecisionSignals(agent.id, pulseSignals, decision.signalIds);
      }
      await this.deps.agentRoleRepo.updateHeartbeatRunTimestamps?.(agent.id, {
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

      await this.runRepo.finish(pulseRun.id, {
        status: "completed",
        summary: `${decision.kind}: ${decision.reason}`,
      });
      if (coreTrace) {
        await this.deps.coreTraceService?.appendPhaseEvent(
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
        await this.deps.coreTraceService?.completeTrace(
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
      await this.recordDispatchOutcome({
        agent,
        workspaceId,
        sourceRunId: dispatchRun.id,
        trigger: manualOverride ? "manual" : "heartbeat",
        decision,
        dispatchResult,
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
      await this.finishPulse(agent, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (coreTrace) {
        await this.deps.coreTraceService?.appendPhaseEvent(
          coreTrace.id,
          "error",
          "heartbeat.error",
          message,
        );
        await this.deps.coreTraceService?.failTrace(coreTrace.id, message);
        await this.finalizeCoreLearning(coreTrace.id);
      }
      await this.runRepo.finish(pulseRun.id, { status: "failed", error: message });
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
      await this.deps.agentRoleRepo.updateHeartbeatStatus(agent.id, "error");
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
      await this.recordHeartbeatError(
        agent,
        pulseRun.id,
        manualOverride ? "manual" : "heartbeat",
        message,
        workspaceId,
      );
      return result;
    }
  }

  private async finishPulse(agent: AgentRole, result: HeartbeatResult): Promise<void> {
    const now = Date.now();
    await this.deps.agentRoleRepo.updateHeartbeatStatus(agent.id, "idle", now);
    await this.deps.agentRoleRepo.updateHeartbeatRunTimestamps?.(agent.id, {
      lastPulseAt: now,
      lastHeartbeatAt: now,
      lastPulseResult: result.pulseOutcome,
    });
    // The cadence restarts from this pulse: drop (and clear) any pending timer; the pulse
    // re-arms exactly one when it releases its slot.
    const timer = this.timers.get(agent.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(agent.id);
  }

  /**
   * Settle this agent's dispatch runs whose task finished, vanished, or has been running for
   * longer than STALE_DISPATCH_MS. Until then the run counts as in flight.
   */
  private async settleInFlightDispatches(agentRoleId: string): Promise<void> {
    const runs = await this.runRepo.listRunningDispatches(agentRoleId);
    if (runs.length === 0) return;
    const now = Date.now();
    for (const run of runs) {
      let status: "completed" | "failed" | undefined;
      let error: string | undefined;
      if (run.taskId && this.deps.getTaskStatus) {
        const taskStatus = await this.deps.getTaskStatus(run.taskId);
        if (!taskStatus) {
          status = "failed";
          error = "Dispatched task no longer exists";
        } else if (taskStatus === "completed") {
          status = "completed";
        } else if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(taskStatus)) {
          status = "failed";
          error = `Dispatched task ended as ${taskStatus}`;
        }
      }
      if (!status && now - (run.startedAt || run.createdAt) > STALE_DISPATCH_MS) {
        status = "failed";
        error = "Dispatch abandoned: still in flight after the stale-dispatch limit";
      }
      if (!status) continue;
      await this.runRepo.recordEvent(run.id, "dispatch.settled", {
        taskId: run.taskId,
        status,
        error,
      });
      await this.runRepo.finish(run.id, {
        status,
        summary: run.reason,
        error,
        taskId: run.taskId,
      });
    }
  }

  private async reconcileStaleDispatchRuns(): Promise<void> {
    try {
      const settled = await this.runRepo.reconcileStaleDispatchRuns({
        maxAgeMs: STALE_DISPATCH_MS,
        message: "Stale dispatch run reconciled at heartbeat startup",
      });
      if (settled > 0) {
        console.info(`[HeartbeatService] Reconciled ${settled} stale dispatch run(s)`);
      }
    } catch (error) {
      console.warn("[HeartbeatService] Failed to reconcile stale dispatch runs:", error);
    }
  }

  /**
   * Attach concrete evidence for the dispatch (pending mentions, assigned tasks, a manual wake)
   * and refuse to create a task without any evidence: such dispatches become suggestions.
   */
  private withDispatchEvidence(
    decision: HeartbeatPulseDecision,
    context: {
      agent: AgentRole;
      mentions: AgentMention[];
      tasks: Task[];
      manualOverride: boolean;
    },
  ): HeartbeatPulseDecision {
    if (!decision.dispatchKind) return decision;
    const refs = new Set(decision.evidenceRefs);
    for (const mention of context.mentions.slice(0, 10)) refs.add(`mention:${mention.id}`);
    for (const task of context.tasks.slice(0, 10)) refs.add(`task:${task.id}`);
    if (context.manualOverride) refs.add(`manual_wake:${context.agent.id}`);
    const evidenceRefs = Array.from(refs);
    if (decision.dispatchKind === "task" && evidenceRefs.length === 0) {
      return {
        ...decision,
        kind: "suggestion",
        dispatchKind: "suggestion",
        reason: `${decision.reason} (no evidence refs; suggested instead of creating a task)`,
        evidenceRefs,
      };
    }
    return { ...decision, evidenceRefs };
  }

  private removeDecisionSignals(
    agentRoleId: string,
    pulseSignals: HeartbeatSignal[],
    signalIds: string[],
  ): void {
    this.signalStore.removeSignals(
      agentRoleId,
      pulseSignals
        .filter((signal) => signalIds.includes(signal.id))
        .map((signal) => ({
          id: signal.id,
          lastSeenAt: signal.lastSeenAt,
          mergedCount: signal.mergedCount,
        })),
    );
  }

  private checklistKey(agent: AgentRole, item: HeartbeatChecklistItem): string {
    return `checklist:${agent.id}:${item.workspaceId || "*"}:${item.id}`;
  }

  private proactiveKey(agent: AgentRole, task: ProactiveTaskDefinition): string {
    return `proactive:${agent.id}:${task.id}`;
  }

  private isAdvisoryAcknowledged(key: string, cadenceMs: number, now: number): boolean {
    const acknowledgedAt = this.advisoryAcknowledgedAt.get(key);
    if (!acknowledgedAt) return false;
    return now - acknowledgedAt < Math.max(ADVISORY_ACK_MIN_MS, cadenceMs || 0);
  }

  private acknowledgeAdvisoryItems(
    agent: AgentRole,
    checklistItems: HeartbeatChecklistItem[],
    proactiveTasks: ProactiveTaskDefinition[],
  ): void {
    const now = Date.now();
    for (const item of checklistItems) {
      this.advisoryAcknowledgedAt.set(this.checklistKey(agent, item), now);
    }
    for (const task of proactiveTasks) {
      this.advisoryAcknowledgedAt.set(this.proactiveKey(agent, task), now);
    }
  }

  private async recordDispatchOutcome(params: {
    agent: AgentRole;
    workspaceId: string;
    sourceRunId: string;
    trigger: "manual" | "heartbeat";
    decision: HeartbeatPulseDecision;
    dispatchResult: HeartbeatResult;
  }): Promise<void> {
    try {
      await this.deps.recordAutomationOutcome?.(
        classifyHeartbeatDispatchOutcome({
          agent: params.agent,
          workspaceId: params.workspaceId,
          sourceRunId: params.sourceRunId,
          trigger: params.trigger,
          reason: params.decision.reason,
          dispatchKind: params.decision.dispatchKind,
          result: params.dispatchResult,
          evidenceRefs: params.decision.evidenceRefs.map((id) => ({
            type: "heartbeat_evidence",
            id,
            label: id,
          })),
        }),
      );
    } catch (error) {
      console.warn("[HeartbeatService] Failed to record dispatch outcome:", error);
    }
  }

  private async recordHeartbeatError(
    agent: AgentRole,
    runId: string,
    trigger: "manual" | "heartbeat",
    message: string,
    workspaceId?: string,
  ): Promise<void> {
    try {
      await this.deps.recordAutomationOutcome?.(
        classifyHeartbeatErrorOutcome({
          agent,
          workspaceId,
          sourceRunId: runId,
          trigger,
          error: message,
        }),
      );
    } catch (error) {
      console.warn("[HeartbeatService] Failed to record heartbeat error outcome:", error);
    }
  }

  private getDispatchBudget(): BackgroundDispatchBudgetAuthority {
    return this.deps.dispatchBudget || getBackgroundDispatchBudget();
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

  /**
   * Commitment expiry: only when heartbeat maintenance is on and no task is in the
   * foreground. The service's own cooldown makes this a daily pass.
   */
  private async maybeRunCommitmentExpiry(): Promise<{ expired: number } | null> {
    const runCommitmentExpiry = this.deps.runCommitmentExpiry;
    if (!runCommitmentExpiry) return null;
    try {
      if (this.isHeartbeatMaintenanceDisabled()) return null;
      if (this.deps.hasActiveForegroundTask?.()) return null;
      return await runCommitmentExpiry();
    } catch (error) {
      logger.warn("Commitment expiry failed:", error);
      return null;
    }
  }

  /**
   * Offer the memory folder its daily dream: once per pulse, only when no task is in the
   * foreground and heartbeat maintenance is on. Fire-and-forget; failures are logged.
   */
  private offerMemoryRepoDream(): void {
    const runMemoryRepoDream = this.deps.runMemoryRepoDream;
    if (!runMemoryRepoDream) return;
    try {
      if (this.isHeartbeatMaintenanceDisabled()) return;
      if (this.deps.hasActiveForegroundTask?.()) return;
      void Promise.resolve()
        .then(() => runMemoryRepoDream())
        .catch((error) => logger.warn("Memory folder dream failed:", error));
    } catch (error) {
      logger.warn("Memory folder dream could not start:", error);
    }
  }

  private isHeartbeatMaintenanceDisabled(): boolean {
    try {
      return this.deps.getMemoryFeaturesSettings?.()?.heartbeatMaintenanceEnabled === false;
    } catch {
      return false;
    }
  }

  private getDeferredStateForAgent(agentRoleId: string) {
    return this.signalStore.getDeferredState(agentRoleId);
  }

  private async getDispatchesToday(agentRoleId: string): Promise<number> {
    return (await this.runRepo.listRecentDispatches(agentRoleId, getStartOfDay(Date.now()))).filter(
      (run) => run.status !== "cancelled",
    ).length;
  }

  private async getDispatchCooldownUntil(agent: AgentRole): Promise<number | undefined> {
    const latestDispatch = await this.runRepo.getLatestRun(agent.id, "dispatch");
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

  private getCadenceMs(agent?: AgentRole): number {
    return (
      (agent?.heartbeatPolicy?.cadenceMinutes ||
        agent?.pulseEveryMinutes ||
        agent?.heartbeatIntervalMinutes ||
        15) *
      60 *
      1000
    );
  }

  private getNextHeartbeatTime(agent: AgentRole): number | undefined {
    if (!(agent.heartbeatPolicy?.enabled || agent.heartbeatEnabled)) return undefined;
    const intervalMs = this.getCadenceMs(agent);
    const staggerMs =
      (agent.heartbeatPolicy?.staggerOffsetMinutes || agent.heartbeatStaggerOffset || 0) *
      60 *
      1000;
    if (agent.lastPulseAt) {
      return agent.lastPulseAt + intervalMs;
    }
    return Date.now() + Math.max(5_000, staggerMs || 5_000);
  }

  private async reconcileLegacyMigratedRuns(): Promise<void> {
    if (!this.deps.db) return;
    const reconciled = await this.runRepo.reconcileLegacyMigratedRuns(
      "Legacy v2 heartbeat run reconciled during v3 startup",
    );
    if (reconciled === 0) return;
    console.info(`[HeartbeatService] Reconciled ${reconciled} legacy migrated heartbeat run(s)`);
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

  private getDueProactiveTasks(
    agent: AgentRole,
    signals: HeartbeatSignal[],
  ): ProactiveTaskDefinition[] {
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
      this.maintenanceState.setChecklistLastRunAt(
        `${agent.id}:${item.workspaceId}:${item.id}`,
        now,
      );
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
