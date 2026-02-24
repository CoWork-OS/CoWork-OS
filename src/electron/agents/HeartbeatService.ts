import { EventEmitter } from "events";
import {
  AgentRole,
  HeartbeatResult,
  HeartbeatEvent,
  HeartbeatStatus,
  HeartbeatConfig,
  AgentMention,
  Task,
  Activity,
  ProactiveTaskDefinition,
} from "../../shared/types";
import { AgentRoleRepository } from "./AgentRoleRepository";
import { MentionRepository } from "./MentionRepository";
import { ActivityRepository } from "../activity/ActivityRepository";
import { WorkingStateRepository } from "./WorkingStateRepository";
import { buildRolePersonaPrompt } from "./role-persona";

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
  ) => Promise<Task>;
  getTasksForAgent: (agentRoleId: string, workspaceId?: string) => Task[];
  getDefaultWorkspaceId: () => string | undefined;
  getDefaultWorkspacePath: () => string | undefined;
  getWorkspacePath: (workspaceId: string) => string | undefined;
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
  private wakeNowThrottleUntil: Map<string, number> = new Map();
  private wakeImmediateTimers: Map<string, NodeJS.Timeout> = new Map();
  private started = false;

  private static readonly WAKE_COALESCE_MS = 30_000;
  private static readonly MAX_WAKE_QUEUE_SIZE = 25;
  private static readonly MIN_IMMEDIATE_WAKE_GAP_MS = 10_000;

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

    for (const [agentId, timer] of this.timers) {
      clearTimeout(timer);
    }

    this.timers.clear();
    this.running.clear();
    this.wakeQueues.clear();
    this.wakeDedupe.clear();
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
        // Reschedule for next interval
        this.scheduleHeartbeat(currentAgent);
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
      const wakeRequests = this.consumeWakeRequests(agent.id);

      // Check for pending work
      const workItems = await this.checkForWork(agent);
      const result: HeartbeatResult = {
        agentRoleId: agent.id,
        status: "ok",
        pendingMentions: workItems.pendingMentions.length,
        assignedTasks: workItems.assignedTasks.length,
        relevantActivities: workItems.relevantActivities.length,
      };

      // If work is found, create a task or process it
      const hasWork =
        workItems.pendingMentions.length > 0 ||
        workItems.assignedTasks.length > 0 ||
        wakeRequests.length > 0;

      if (hasWork) {
        result.status = "work_done";

        const selectedWorkspace = this.selectWorkspaceForWork(workItems);
        const workspacePath = selectedWorkspace
          ? selectedWorkspace.workspacePath
          : this.deps.getDefaultWorkspacePath();

        // Build prompt for agent to handle the work
        const prompt = this.buildHeartbeatPrompt(agent, workItems, wakeRequests, workspacePath);
        const workspaceId = selectedWorkspace?.workspaceId || this.deps.getDefaultWorkspaceId();

        if (workspaceId) {
          const task = await this.deps.createTask(
            workspaceId,
            prompt,
            `Heartbeat: ${agent.displayName}`,
            agent.id,
          );
          result.taskCreated = task.id;
        } else {
          console.warn(
            "[HeartbeatService] Heartbeat skipped task creation: no workspace available",
          );
        }

        this.emitHeartbeatEvent({
          type: "work_found",
          agentRoleId: agent.id,
          agentName: agent.displayName,
          timestamp: Date.now(),
          result,
        });
      } else {
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

    // Get recent relevant activities (last hour)
    // Could be enhanced to filter by agent capabilities
    const relevantActivities: Activity[] = [];

    return {
      pendingMentions,
      assignedTasks,
      relevantActivities,
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

    // Add proactive tasks from digital twin cognitive offload config
    const proactiveTasks = this.extractProactiveTasks(agent);
    if (proactiveTasks.length > 0) {
      lines.push("## Proactive Tasks");
      lines.push(
        "As part of this heartbeat, perform these proactive checks for your human counterpart:",
      );
      lines.push("");
      for (const task of proactiveTasks) {
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
      wakeRequests.length > 0 ||
      proactiveTasks.length > 0;

    if (hasWorkOrSignal) {
      lines.push("Please review the above items and take appropriate action.");
      lines.push("For mentions, acknowledge them and respond as needed.");
      lines.push("For assigned tasks, continue working on them or report any blockers.");
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
  private extractProactiveTasks(agent: AgentRole): ProactiveTaskDefinition[] {
    if (!agent.soul || !agent.soul.trim()) return [];
    try {
      const soulData = JSON.parse(agent.soul);
      const tasks = soulData?.cognitiveOffload?.proactiveTasks;
      if (!Array.isArray(tasks)) return [];
      return tasks
        .filter((t: ProactiveTaskDefinition) => t.enabled && t.promptTemplate)
        .sort(
          (a: ProactiveTaskDefinition, b: ProactiveTaskDefinition) =>
            (a.priority ?? 99) - (b.priority ?? 99),
        );
    } catch {
      return [];
    }
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
