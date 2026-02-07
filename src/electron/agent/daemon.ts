import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DatabaseManager } from '../database/schema';
import {
  TaskRepository,
  TaskEventRepository,
  WorkspaceRepository,
  ApprovalRepository,
  ArtifactRepository,
  MemoryType,
} from '../database/repositories';
import { ActivityRepository } from '../activity/ActivityRepository';
import { AgentRoleRepository } from '../agents/AgentRoleRepository';
import { MentionRepository } from '../agents/MentionRepository';
import { buildAgentDispatchPrompt } from '../agents/agent-dispatch';
import { Task, TaskStatus, TaskEvent, IPC_CHANNELS, QueueSettings, QueueStatus, Workspace, WorkspacePermissions, AgentConfig, AgentType, ActivityActorType, ActivityType, CreateActivityRequest, Plan, BoardColumn, Activity, AgentMention } from '../../shared/types';
import { TaskExecutor } from './executor';
import { TaskQueueManager } from './queue-manager';
import { approvalIdempotency, taskIdempotency, IdempotencyManager } from '../security/concurrency';
import { MemoryService } from '../memory/MemoryService';

// Memory management constants
const MAX_CACHED_EXECUTORS = 10; // Maximum number of completed task executors to keep in memory
const EXECUTOR_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes - time before completed executors are cleaned up

// Activity throttling constants
const ACTIVITY_THROTTLE_WINDOW_MS = 2000; // 2 seconds - window for deduping similar activities
const THROTTLED_ACTIVITY_TYPES = new Set(['tool_call', 'file_created', 'file_modified', 'file_deleted']);

interface CachedExecutor {
  executor: TaskExecutor;
  lastAccessed: number;
  status: 'active' | 'completed';
}

/**
 * AgentDaemon is the core orchestrator that manages task execution
 * It coordinates between the database, task executors, and UI
 */
export class AgentDaemon extends EventEmitter {
  private taskRepo: TaskRepository;
  private eventRepo: TaskEventRepository;
  private workspaceRepo: WorkspaceRepository;
  private approvalRepo: ApprovalRepository;
  private artifactRepo: ArtifactRepository;
  private activityRepo: ActivityRepository;
  private agentRoleRepo: AgentRoleRepository;
  private mentionRepo: MentionRepository;
  private activeTasks: Map<string, CachedExecutor> = new Map();
  private pendingApprovals: Map<string, { taskId: string; resolve: (value: boolean) => void; reject: (reason?: unknown) => void; resolved: boolean; timeoutHandle: ReturnType<typeof setTimeout> }> = new Map();
  private cleanupIntervalHandle?: ReturnType<typeof setInterval>;
  private queueManager: TaskQueueManager;
  // Activity throttle: Map<taskId:eventType, lastTimestamp>
  private activityThrottle: Map<string, number> = new Map();
  private pendingRetries: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private retryCounts: Map<string, number> = new Map();
  private readonly maxTaskRetries = 2;
  private readonly retryDelayMs = 30 * 1000;

  constructor(private dbManager: DatabaseManager) {
    super();
    const db = dbManager.getDatabase();
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new TaskEventRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.approvalRepo = new ApprovalRepository(db);
    this.artifactRepo = new ArtifactRepository(db);
    this.activityRepo = new ActivityRepository(db);
    this.agentRoleRepo = new AgentRoleRepository(db);
    this.mentionRepo = new MentionRepository(db);

    // Initialize queue manager with callbacks
    this.queueManager = new TaskQueueManager({
      startTaskImmediate: (task: Task) => this.startTaskImmediate(task),
      emitQueueUpdate: (status: QueueStatus) => this.emitQueueUpdate(status),
      getTaskById: (taskId: string) => this.taskRepo.findById(taskId),
      updateTaskStatus: (taskId: string, status: TaskStatus) => this.taskRepo.update(taskId, { status }),
      onTaskTimeout: (taskId: string) => this.handleTaskTimeout(taskId),
    });

    // Start periodic cleanup of old executors
    this.cleanupIntervalHandle = setInterval(() => this.cleanupOldExecutors(), 5 * 60 * 1000); // Run every 5 minutes
  }

  /**
   * Merge agent role tool restrictions into the task's agentConfig.
   *
   * Note: Tasks support an additive deny-list via AgentConfig.toolRestrictions. Agent roles store
   * restrictions as { deniedTools, allowedTools }. For now we enforce deniedTools (deny-wins),
   * merging them into the task's existing toolRestrictions (if any).
   */
  private applyAgentRoleToolRestrictions(task: Task): Task {
    const roleId = task.assignedAgentRoleId;
    if (!roleId) return task;

    const role = this.agentRoleRepo.findById(roleId);
    const denied = role?.toolRestrictions?.deniedTools;
    if (!Array.isArray(denied) || denied.length === 0) return task;

    const merged = new Set<string>();

    const addAll = (values: unknown) => {
      if (!Array.isArray(values)) return;
      for (const raw of values) {
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (!value) continue;
        merged.add(value);
      }
    };

    addAll(task.agentConfig?.toolRestrictions);
    addAll(denied);

    if (merged.size === 0) return task;

    const nextAgentConfig: AgentConfig = task.agentConfig ? { ...task.agentConfig } : {};
    nextAgentConfig.toolRestrictions = Array.from(merged);
    return { ...task, agentConfig: nextAgentConfig };
  }

  /**
   * Initialize the daemon - call after construction to set up queue
   */
  async initialize(): Promise<void> {
    // Find queued tasks from database for queue recovery
    const queuedTasks = this.taskRepo.findByStatus('queued');

    // Find "running" tasks from previous session - these are orphaned since we lost their executors
    const orphanedTasks = this.taskRepo.findByStatus(['planning', 'executing']);

    // Mark orphaned tasks as failed - they can't be resumed since we lost their state
    if (orphanedTasks.length > 0) {
      console.log(`[AgentDaemon] Found ${orphanedTasks.length} orphaned tasks from previous session, marking as failed`);
      for (const task of orphanedTasks) {
        this.taskRepo.update(task.id, {
          status: 'failed',
          error: 'Task interrupted - application was restarted while task was running',
        });
      }
    }

    // Only initialize queue with queued tasks (not orphaned "running" tasks)
    await this.queueManager.initialize(queuedTasks, []);
  }

  /**
   * Clean up old completed task executors to prevent memory leaks
   */
  private cleanupOldExecutors(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    let completedCount = 0;

    // Find executors to clean up
    this.activeTasks.forEach((cached, taskId) => {
      if (cached.status === 'completed') {
        completedCount++;
        // Remove if older than TTL
        if (now - cached.lastAccessed > EXECUTOR_CACHE_TTL_MS) {
          toDelete.push(taskId);
        }
      }
    });

    // Also remove oldest completed executors if we have too many
    if (completedCount > MAX_CACHED_EXECUTORS) {
      const completedTasks = Array.from(this.activeTasks.entries())
        .filter(([_, cached]) => cached.status === 'completed')
        .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

      const excessCount = completedCount - MAX_CACHED_EXECUTORS;
      for (let i = 0; i < excessCount; i++) {
        const [taskId] = completedTasks[i];
        if (!toDelete.includes(taskId)) {
          toDelete.push(taskId);
        }
      }
    }

    // Delete the marked executors
    for (const taskId of toDelete) {
      console.log(`[AgentDaemon] Cleaning up cached executor for task ${taskId}`);
      this.activeTasks.delete(taskId);
    }

    if (toDelete.length > 0) {
      console.log(`[AgentDaemon] Cleaned up ${toDelete.length} old executor(s). Active: ${this.activeTasks.size}`);
    }
  }

  /**
   * Queue a task for execution
   * The task will either start immediately or be queued based on concurrency limits
   */
  async startTask(task: Task): Promise<void> {
    await this.queueManager.enqueue(task);

    // If the task was queued (concurrency full), emit an explicit event so
    // remote gateways (WhatsApp/Telegram/etc) can inform the user instead of
    // appearing to "hang" silently.
    const refreshed = this.taskRepo.findById(task.id);
    if (refreshed?.status === 'queued') {
      const status = this.queueManager.getStatus();
      const idx = status.queuedTaskIds.indexOf(task.id);
      const position = idx >= 0 ? idx + 1 : undefined;
      const message = position
        ? `⏳ Queued (position ${position}). I’ll start as soon as a slot is free.`
        : '⏳ Queued. I’ll start as soon as a slot is free.';
      this.logEvent(task.id, 'task_queued', {
        position,
        reason: 'concurrency',
        message,
      });
    }
  }

  /**
   * Start executing a task immediately (internal - called by queue manager)
   */
  async startTaskImmediate(task: Task): Promise<void> {
    console.log(`[AgentDaemon] Starting task ${task.id}: ${task.title}`);
    const effectiveTask = this.applyAgentRoleToolRestrictions(task);

    const wasQueued = effectiveTask.status === 'queued';
    if (wasQueued) {
      const isRetry = this.retryCounts.has(effectiveTask.id);
      const count = this.retryCounts.get(effectiveTask.id) ?? 0;
      const retrySuffix = isRetry ? ` (retry ${count}/${this.maxTaskRetries})` : '';
      this.logEvent(effectiveTask.id, 'task_dequeued', { message: `▶️ Starting now${retrySuffix}.` });
    }

    // Get workspace details
    const workspace = this.workspaceRepo.findById(effectiveTask.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${effectiveTask.workspaceId} not found`);
    }
    console.log(`[AgentDaemon] Workspace found: ${workspace.name}`);

    // Create task executor - wrapped in try-catch to handle provider initialization errors
    let executor: TaskExecutor;
    try {
      console.log(`[AgentDaemon] Creating TaskExecutor...`);
      executor = new TaskExecutor(effectiveTask, workspace, this);
      console.log(`[AgentDaemon] TaskExecutor created successfully`);
    } catch (error: any) {
      console.error(`[AgentDaemon] Task ${effectiveTask.id} failed to initialize:`, error);
      this.taskRepo.update(effectiveTask.id, {
        status: 'failed',
        error: error.message || 'Failed to initialize task executor',
        completedAt: Date.now(),
      });
      this.clearRetryState(effectiveTask.id);
      this.logEvent(effectiveTask.id, 'error', { error: error.message });
      // Notify queue manager so it can start next task
      this.queueManager.onTaskFinished(effectiveTask.id);
      return;
    }

    this.activeTasks.set(effectiveTask.id, {
      executor,
      lastAccessed: Date.now(),
      status: 'active',
    });

    // Update task status
    this.taskRepo.update(effectiveTask.id, { status: 'planning', error: undefined });
    this.logEvent(effectiveTask.id, 'task_created', { task: effectiveTask });
    console.log(`[AgentDaemon] Task status updated to 'planning', starting execution...`);

    // Start execution (non-blocking)
    executor.execute().catch(error => {
      console.error(`[AgentDaemon] Task ${effectiveTask.id} execution failed:`, error);
      this.taskRepo.update(effectiveTask.id, {
        status: 'failed',
        error: error.message,
        completedAt: Date.now(),
      });
      this.clearRetryState(effectiveTask.id);
      this.logEvent(effectiveTask.id, 'error', { error: error.message });
      this.activeTasks.delete(effectiveTask.id);
      // Notify queue manager so it can start next task
      this.queueManager.onTaskFinished(effectiveTask.id);
    });
  }

  /**
   * Create a new task in the database and start it
   * This is a convenience method used by the cron service
   */
  async createTask(params: {
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig?: AgentConfig;
    budgetTokens?: number;
    budgetCost?: number;
  }): Promise<Task> {
    const task = this.taskRepo.create({
      title: params.title,
      prompt: params.prompt,
      status: 'pending',
      workspaceId: params.workspaceId,
      agentConfig: params.agentConfig,
      budgetTokens: params.budgetTokens,
      budgetCost: params.budgetCost,
    });

    // Start the task (will be queued if necessary)
    await this.startTask(task);

    return task;
  }

  /**
   * Get a task by its ID
   */
  async getTaskById(taskId: string): Promise<Task | undefined> {
    return this.taskRepo.findById(taskId);
  }

  /**
   * Get all child tasks for a given parent task
   */
  async getChildTasks(parentTaskId: string): Promise<Task[]> {
    return this.taskRepo.findByParent(parentTaskId);
  }

  /**
   * Create a child task (sub-agent or parallel agent)
   */
  async createChildTask(params: {
    title: string;
    prompt: string;
    workspaceId: string;
    parentTaskId: string;
    agentType: AgentType;
    agentConfig?: AgentConfig;
    depth?: number;
    budgetTokens?: number;
    budgetCost?: number;
  }): Promise<Task> {
    const parent = this.taskRepo.findById(params.parentTaskId);
    const parentGatewayContext = parent?.agentConfig?.gatewayContext;
    const childGatewayContext = params.agentConfig?.gatewayContext;

    // Prevent privilege escalation: a child task may not become "more private" than its parent.
    const mergedGatewayContext: AgentConfig['gatewayContext'] | undefined = (() => {
      const rank: Record<NonNullable<AgentConfig['gatewayContext']>, number> = {
        private: 0,
        group: 1,
        public: 2,
      };
      const contexts = [parentGatewayContext, childGatewayContext].filter(
        (value): value is NonNullable<AgentConfig['gatewayContext']> =>
          value === 'private' || value === 'group' || value === 'public'
      );
      if (contexts.length === 0) return undefined;
      return contexts.sort((a, b) => rank[b] - rank[a])[0];
    })();

    // Prevent privilege escalation: tool restrictions are inherited and additive.
    const mergedToolRestrictions: string[] | undefined = (() => {
      const merged = new Set<string>();
      const addAll = (values: unknown) => {
        if (!Array.isArray(values)) return;
        for (const raw of values) {
          const value = typeof raw === 'string' ? raw.trim() : '';
          if (!value) continue;
          merged.add(value);
        }
      };
      addAll(parent?.agentConfig?.toolRestrictions);
      addAll(params.agentConfig?.toolRestrictions);
      return merged.size > 0 ? Array.from(merged) : undefined;
    })();

    const mergedAgentConfig: AgentConfig | undefined = (() => {
      const next: AgentConfig = params.agentConfig ? { ...params.agentConfig } : {};
      if (mergedGatewayContext) {
        next.gatewayContext = mergedGatewayContext;
      }
      if (mergedToolRestrictions) {
        next.toolRestrictions = mergedToolRestrictions;
      }
      return Object.keys(next).length > 0 ? next : undefined;
    })();

    const task = this.taskRepo.create({
      title: params.title,
      prompt: params.prompt,
      status: 'pending',
      workspaceId: params.workspaceId,
      parentTaskId: params.parentTaskId,
      agentType: params.agentType,
      agentConfig: mergedAgentConfig,
      depth: params.depth ?? 0,
      budgetTokens: params.budgetTokens,
      budgetCost: params.budgetCost,
    });

    // Start the task (will be queued if necessary)
    await this.startTask(task);

    return task;
  }

  private buildPlanSummary(plan?: Plan): string | undefined {
    if (!plan) return undefined;
    const lines: string[] = [];
    if (plan.description) {
      lines.push(`Plan: ${plan.description}`);
    }
    if (plan.steps && plan.steps.length > 0) {
      lines.push('Steps:');
      const stepLines = plan.steps
        .slice(0, 7)
        .map((step) => `- ${step.description}`);
      lines.push(...stepLines);
      if (plan.steps.length > 7) {
        lines.push(`- …and ${plan.steps.length - 7} more steps`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private emitActivityEvent(activity: Activity): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(window => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, { type: 'created', activity });
        }
      } catch (error) {
        console.error('[AgentDaemon] Error sending activity IPC:', error);
      }
    });
  }

  private emitMentionEvent(mention: AgentMention): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(window => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.MENTION_EVENT, { type: 'created', mention });
        }
      } catch (error) {
        console.error('[AgentDaemon] Error sending mention IPC:', error);
      }
    });
  }

  /**
   * Dispatch mentioned agent roles after the main plan is created.
   * This avoids starting sub-agents before the task is clearly defined.
   */
  async dispatchMentionedAgents(taskId: string, plan?: Plan): Promise<void> {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.parentTaskId) return;

    const mentionedRoleIds = (task.mentionedAgentRoleIds || []).filter(Boolean);
    if (mentionedRoleIds.length === 0) return;

    const activeRoles = this.agentRoleRepo.findAll(false).filter(role => role.isActive);
    const mentionedRoles = activeRoles.filter(role => mentionedRoleIds.includes(role.id));
    if (mentionedRoles.length === 0) return;

    const existingChildren = this.taskRepo.findByParent(taskId);
    const assignedRoleIds = new Set(
      existingChildren
        .map(child => child.assignedAgentRoleId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    );

    const rolesToDispatch = mentionedRoles.filter(role => !assignedRoleIds.has(role.id));
    if (rolesToDispatch.length === 0) return;

    const planSummary = this.buildPlanSummary(plan);

    for (const role of rolesToDispatch) {
      const childPrompt = buildAgentDispatchPrompt(
        role,
        { title: task.title, prompt: task.prompt },
        planSummary ? { planSummary } : undefined
      );
      const childTask = await this.createChildTask({
        title: `@${role.displayName}: ${task.title}`,
        prompt: childPrompt,
        workspaceId: task.workspaceId,
        parentTaskId: task.id,
        agentType: 'sub',
        agentConfig: {
          ...(role.modelKey ? { modelKey: role.modelKey } : {}),
          ...(role.personalityId ? { personalityId: role.personalityId } : {}),
          ...(Array.isArray(role.toolRestrictions?.deniedTools) && role.toolRestrictions!.deniedTools.length > 0
            ? { toolRestrictions: role.toolRestrictions!.deniedTools }
            : {}),
          retainMemory: false,
        },
      });

      this.taskRepo.update(childTask.id, {
        assignedAgentRoleId: role.id,
        boardColumn: 'todo' as BoardColumn,
      });

      const dispatchActivity = this.activityRepo.create({
        workspaceId: task.workspaceId,
        taskId: task.id,
        agentRoleId: role.id,
        actorType: 'system',
        activityType: 'agent_assigned',
        title: `Dispatched to ${role.displayName}`,
        description: childTask.title,
      });
      this.emitActivityEvent(dispatchActivity);

      const mention = this.mentionRepo.create({
        workspaceId: task.workspaceId,
        taskId: task.id,
        toAgentRoleId: role.id,
        mentionType: 'request',
        context: `New task: ${task.title}`,
      });
      this.emitMentionEvent(mention);

      const mentionActivity = this.activityRepo.create({
        workspaceId: task.workspaceId,
        taskId: task.id,
        agentRoleId: role.id,
        actorType: 'user',
        activityType: 'mention',
        title: `@${role.displayName} mentioned`,
        description: mention.context,
        metadata: { mentionId: mention.id, mentionType: mention.mentionType },
      });
      this.emitActivityEvent(mentionActivity);
    }
  }

  /**
   * Cancel a running or queued task
   */
  async cancelTask(taskId: string): Promise<void> {
    // Check if task is queued (not yet started)
    if (this.queueManager.cancelQueuedTask(taskId)) {
      this.taskRepo.update(taskId, { status: 'cancelled', completedAt: Date.now() });
      this.clearRetryState(taskId);
      this.logEvent(taskId, 'task_cancelled', {
        message: 'Task removed from queue',
      });
      return;
    }

    // Task is running - cancel it
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      await cached.executor.cancel();
      this.activeTasks.delete(taskId);
    }

    // Always notify queue manager to remove from running set
    // (handles orphaned tasks that are in runningTaskIds but have no executor)
    this.queueManager.onTaskFinished(taskId);

    // Always emit cancelled event so UI updates
    this.clearRetryState(taskId);
    this.logEvent(taskId, 'task_cancelled', {
      message: 'Task was stopped by user',
    });
  }

  /**
   * Handle transient provider errors by scheduling a retry instead of failing.
   * Returns true if a retry was scheduled, false if retries are exhausted.
   */
  handleTransientTaskFailure(taskId: string, reason: string, delayMs: number = this.retryDelayMs): boolean {
    const currentCount = this.retryCounts.get(taskId) ?? 0;
    const nextCount = currentCount + 1;
    if (nextCount > this.maxTaskRetries) {
      return false;
    }

    this.retryCounts.set(taskId, nextCount);

    if (this.pendingRetries.has(taskId)) {
      return true;
    }

    // Mark as queued with a helpful message
    const retrySeconds = Math.ceil(delayMs / 1000);
    const queuedError = `Transient provider error. Retry ${nextCount}/${this.maxTaskRetries} in ${retrySeconds}s.`;
    this.taskRepo.update(taskId, {
      status: 'queued',
      error: queuedError,
    });

    this.logEvent(taskId, 'task_queued', {
      reason: 'transient_retry',
      message: `⏳ Temporary provider error. Retrying ${nextCount}/${this.maxTaskRetries} in ${retrySeconds}s.`,
    });

    this.logEvent(taskId, 'log', {
      message: `Transient provider error detected. Scheduling retry ${nextCount}/${this.maxTaskRetries} in ${Math.ceil(delayMs / 1000)}s.`,
      reason,
    });

    // Clear executor and free queue slot
    this.activeTasks.delete(taskId);
    this.queueManager.onTaskFinished(taskId);

    const handle = setTimeout(async () => {
      this.pendingRetries.delete(taskId);
      const task = this.taskRepo.findById(taskId);
      if (!task) {
        this.retryCounts.delete(taskId);
        return;
      }
      if (task.status !== 'queued') return;
      if (this.activeTasks.has(taskId) || this.queueManager.isRunning(taskId) || this.queueManager.isQueued(taskId)) {
        return;
      }
      await this.startTask(task);
    }, delayMs);

    this.pendingRetries.set(taskId, handle);
    return true;
  }

  /**
   * Pause a running task
   */
  async pauseTask(taskId: string): Promise<void> {
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.lastAccessed = Date.now();
      await cached.executor.pause();
    }
  }

  /**
   * Resume a paused task
   */
  async resumeTask(taskId: string): Promise<boolean> {
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.lastAccessed = Date.now();
      cached.status = 'active';
      this.updateTaskStatus(taskId, 'executing');
      this.logEvent(taskId, 'task_resumed', { message: 'Task resumed' });
      await cached.executor.resume();
      return true;
    }
    return false;
  }

  /**
   * Send stdin input to a running command in a task
   */
  sendStdinToTask(taskId: string, input: string): boolean {
    const cached = this.activeTasks.get(taskId);
    if (!cached) {
      return false;
    }
    return cached.executor.sendStdin(input);
  }

  /**
   * Kill the running command in a task (send SIGINT like Ctrl+C)
   * @param taskId - The task ID
   * @param force - If true, send SIGKILL immediately instead of graceful escalation
   */
  killCommandInTask(taskId: string, force?: boolean): boolean {
    const cached = this.activeTasks.get(taskId);
    if (!cached) {
      return false;
    }
    return cached.executor.killShellProcess(force);
  }

  /**
   * Request approval from user for an action
   */
  async requestApproval(
    taskId: string,
    type: string,
    description: string,
    details: any
  ): Promise<boolean> {
    const approval = this.approvalRepo.create({
      taskId,
      type: type as any,
      description,
      details,
      status: 'pending',
      requestedAt: Date.now(),
    });

    // Emit event to UI
    this.logEvent(taskId, 'approval_requested', { approval });

    // Wait for user response
    return new Promise((resolve, reject) => {
      // Timeout after 5 minutes
      const timeoutHandle = setTimeout(() => {
        const pending = this.pendingApprovals.get(approval.id);
        if (pending && !pending.resolved) {
          pending.resolved = true;
          this.pendingApprovals.delete(approval.id);
          this.approvalRepo.update(approval.id, 'denied');
          this.logEvent(taskId, 'approval_denied', { approvalId: approval.id, reason: 'timeout' });
          reject(new Error('Approval request timed out'));
        }
      }, 5 * 60 * 1000);

      this.pendingApprovals.set(approval.id, { taskId, resolve, reject, resolved: false, timeoutHandle });
    });
  }

  /**
   * Respond to an approval request
   * Uses idempotency to prevent double-approval race conditions
   * Implements C6: Approval Gate Enforcement
   */
  async respondToApproval(
    approvalId: string,
    approved: boolean
  ): Promise<'handled' | 'duplicate' | 'not_found' | 'in_progress'> {
    // Generate idempotency key for this approval response
    const idempotencyKey = IdempotencyManager.generateKey(
      'approval:respond',
      approvalId,
      approved ? 'approve' : 'deny'
    );

    // Check if this exact response was already processed
    const existing = approvalIdempotency.check(idempotencyKey);
    if (existing.exists) {
      console.log(`[AgentDaemon] Duplicate approval response ignored: ${approvalId}`);
      return 'duplicate';
    }

    // Start tracking this operation
    if (!approvalIdempotency.start(idempotencyKey)) {
      console.log(`[AgentDaemon] Concurrent approval response in progress: ${approvalId}`);
      return 'in_progress';
    }

    try {
      const pending = this.pendingApprovals.get(approvalId);
      if (pending && !pending.resolved) {
        // Mark as resolved first to prevent race condition with timeout
        pending.resolved = true;

        // Clear the timeout
        clearTimeout(pending.timeoutHandle);

        this.pendingApprovals.delete(approvalId);
        this.approvalRepo.update(approvalId, approved ? 'approved' : 'denied');

        // Emit event so UI knows the approval has been handled
        const eventType = approved ? 'approval_granted' : 'approval_denied';
        this.logEvent(pending.taskId, eventType, { approvalId });

        if (approved) {
          pending.resolve(true);
        } else {
          pending.reject(new Error('User denied approval'));
        }

        approvalIdempotency.complete(idempotencyKey, { success: true, status: 'handled' });
        return 'handled';
      }

      approvalIdempotency.complete(idempotencyKey, { success: true, status: 'not_found' });
      return 'not_found';
    } catch (error) {
      approvalIdempotency.fail(idempotencyKey, error);
      throw error;
    }
  }

  /**
   * Log an event for a task
   */
  logEvent(taskId: string, type: string, payload: any): void {
    this.eventRepo.create({
      taskId,
      timestamp: Date.now(),
      type: type as any,
      payload,
    });
    this.logActivityForEvent(taskId, type, payload);
    this.emitTaskEvent(taskId, type, payload);

    // Capture to memory system (async, don't block)
    this.captureToMemory(taskId, type, payload).catch((error) => {
      // Silently log - memory capture is optional enhancement
      console.debug('[AgentDaemon] Memory capture failed:', error);
    });
  }

  /**
   * Capture task event to memory system for cross-session context
   */
  private async captureToMemory(taskId: string, type: string, payload: any): Promise<void> {
    // Map event types to memory types
    const memoryTypeMap: Record<string, MemoryType> = {
      tool_call: 'observation',
      tool_result: 'observation',
      tool_error: 'error',
      step_started: 'observation',
      step_completed: 'observation',
      step_failed: 'error',
      assistant_message: 'observation',
      plan_created: 'decision',
      plan_revised: 'decision',
      error: 'error',
      verification_passed: 'insight',
      verification_failed: 'error',
      file_created: 'observation',
      file_modified: 'observation',
    };

    const memoryType = memoryTypeMap[type];
    if (!memoryType) return;

    const task = this.taskRepo.findById(taskId);
    if (!task) return;

    // Memory retention:
    // - Sub-agents (child tasks) default to retainMemory=false to avoid leaking sensitive
    //   private context into disposable agents.
    // - Shared gateway contexts (group/public) must never contribute injectable memories.
    const isSubAgentTask = (task.agentType ?? 'main') === 'sub' || !!task.parentTaskId;
    const retainMemory = task.agentConfig?.retainMemory ?? !isSubAgentTask;
    if (!retainMemory) return;

    // Build content string based on event type
    let content = '';
    if (type === 'tool_call') {
      content = `Tool called: ${payload.tool || payload.name}\nInput: ${JSON.stringify(payload.input, null, 2)}`;
    } else if (type === 'tool_result') {
      const result =
        typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result);
      content = `Tool result for ${payload.tool || payload.name}:\n${result}`;
    } else if (type === 'tool_error') {
      content = `Tool error for ${payload.tool || payload.name}: ${payload.error}`;
    } else if (type === 'assistant_message') {
      content = payload.content || payload.message || JSON.stringify(payload);
    } else if (type === 'plan_created' || type === 'plan_revised') {
      content = `Plan ${type === 'plan_revised' ? 'revised' : 'created'}:\n${JSON.stringify(payload.plan || payload, null, 2)}`;
    } else if (type === 'step_completed') {
      content = `Step completed: ${payload.step?.description || JSON.stringify(payload)}`;
    } else if (type === 'step_failed') {
      content = `Step failed: ${payload.step?.description || ''}\nError: ${payload.error || 'Unknown error'}`;
    } else if (type === 'file_created' || type === 'file_modified') {
      content = `File ${type === 'file_created' ? 'created' : 'modified'}: ${payload.path}`;
    } else if (type === 'verification_passed') {
      content = `Verification passed: ${payload.message || 'Task completed successfully'}`;
    } else if (type === 'verification_failed') {
      content = `Verification failed: ${payload.message || payload.error || 'Unknown failure'}`;
    } else {
      content = JSON.stringify(payload);
    }

    // Truncate very long content
    if (content.length > 5000) {
      content = content.slice(0, 5000) + '\n[... truncated]';
    }

    const gatewayContext = task.agentConfig?.gatewayContext;
    const forcePrivate = gatewayContext === 'group' || gatewayContext === 'public';
    await MemoryService.capture(task.workspaceId, taskId, memoryType, content, forcePrivate);
  }

  /**
   * Log notable task events to the Activity feed
   */
  private logActivityForEvent(taskId: string, type: string, payload: any): void {
    const task = this.taskRepo.findById(taskId);
    if (!task) return;

    // Throttle high-frequency activity types to reduce database writes
    if (THROTTLED_ACTIVITY_TYPES.has(type)) {
      const throttleKey = `${taskId}:${type}`;
      const now = Date.now();
      const lastTime = this.activityThrottle.get(throttleKey);

      if (lastTime && (now - lastTime) < ACTIVITY_THROTTLE_WINDOW_MS) {
        // Skip this activity - too soon after the last one of the same type
        return;
      }

      this.activityThrottle.set(throttleKey, now);

      // Clean up old throttle entries periodically (keep map from growing unbounded)
      if (this.activityThrottle.size > 1000) {
        const cutoff = now - ACTIVITY_THROTTLE_WINDOW_MS * 10;
        for (const [key, time] of this.activityThrottle) {
          if (time < cutoff) {
            this.activityThrottle.delete(key);
          }
        }
      }
    }

    const activity = this.buildActivityFromEvent(task, type, payload);
    if (!activity) return;

    const created = this.activityRepo.create(activity);
    this.emitActivityEvent(created);
  }

  private buildActivityFromEvent(task: Task, type: string, payload: any): CreateActivityRequest | undefined {
    const actorType: ActivityActorType = task.assignedAgentRoleId ? 'agent' : 'system';
    const agentRoleId = task.assignedAgentRoleId;
    const activityType = type as ActivityType;

    switch (type) {
      case 'task_created':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: 'Task created',
          description: task.title,
        };
      case 'task_completed':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: 'Task completed',
          description: task.title,
        };
      case 'executing':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: 'task_started',
          title: 'Task started',
          description: task.title,
        };
      case 'task_cancelled':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: 'info',
          title: 'Task cancelled',
          description: task.title,
        };
      case 'task_paused':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: 'Task paused',
          description: task.title,
        };
      case 'task_resumed':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: 'Task resumed',
          description: task.title,
        };
      case 'approval_requested':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: 'info',
          title: 'Approval requested',
          description: payload?.approval?.description || task.title,
        };
      case 'approval_granted':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: 'info',
          title: 'Approval granted',
          description: task.title,
        };
      case 'approval_denied':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: 'info',
          title: 'Approval denied',
          description: payload?.reason || task.title,
        };
      case 'error':
      case 'step_failed':
      case 'verification_failed':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: 'error',
          title: type === 'error' ? 'Task error' : 'Execution issue',
          description: payload?.error || payload?.message || payload?.step?.description || task.title,
        };
      case 'verification_passed':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: 'info',
          title: 'Verification passed',
          description: payload?.message || task.title,
        };
      case 'file_created':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: 'File created',
          description: payload?.path || task.title,
        };
      case 'file_modified':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: 'File modified',
          description: payload?.path || task.title,
        };
      case 'file_deleted':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: 'File deleted',
          description: payload?.path || task.title,
        };
      case 'tool_call':
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: 'tool_used',
          title: 'Tool used',
          description: payload?.tool || payload?.name || task.title,
        };
      default:
        return undefined;
    }
  }

  /**
   * Register an artifact (file created during task execution)
   * This allows files like screenshots to be sent back to the user
   */
  registerArtifact(taskId: string, filePath: string, mimeType: string): void {
    try {
      if (!fs.existsSync(filePath)) {
        console.error(`[AgentDaemon] Artifact file not found: ${filePath}`);
        return;
      }

      const stats = fs.statSync(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      this.artifactRepo.create({
        taskId,
        path: filePath,
        mimeType,
        sha256,
        size: stats.size,
        createdAt: Date.now(),
      });

      console.log(`[AgentDaemon] Registered artifact: ${filePath}`);
    } catch (error) {
      console.error(`[AgentDaemon] Failed to register artifact:`, error);
    }
  }

  /**
   * Emit event to renderer process and local listeners
   */
  private emitTaskEvent(taskId: string, type: string, payload: any): void {
    // Emit to local EventEmitter listeners (for gateway integration)
    try {
      this.emit(type, { taskId, ...payload });
    } catch (error) {
      console.error(`[AgentDaemon] Error emitting event ${type}:`, error);
    }

    // Emit to renderer process via IPC
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(window => {
      // Check if window is still valid before sending
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.TASK_EVENT, {
            taskId,
            type,
            payload,
            timestamp: Date.now(),
          });
        }
      } catch (error) {
        // Window might have been destroyed between check and send
        console.error(`[AgentDaemon] Error sending IPC to window:`, error);
      }
    });
  }

  /**
   * Update task status
   */
  updateTaskStatus(taskId: string, status: Task['status']): void {
    this.taskRepo.update(taskId, { status });
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.clearRetryState(taskId);
    }
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.taskRepo.findById(taskId);
  }

  getTaskEvents(taskId: string, options?: { limit?: number; types?: string[] }): TaskEvent[] {
    const all = this.eventRepo.findByTaskId(taskId);
    const normalizedTypes = (options?.types || []).map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
    const filtered = normalizedTypes.length > 0 ? all.filter((event) => normalizedTypes.includes(event.type)) : all;
    const limit = typeof options?.limit === 'number' && Number.isFinite(options.limit)
      ? Math.min(Math.max(options.limit, 1), 200)
      : undefined;
    if (typeof limit !== 'number') {
      return filtered;
    }
    // Return the most recent events, preserving chronological order.
    return filtered.slice(Math.max(filtered.length - limit, 0));
  }

  /**
   * Update task workspace ID in database
   */
  updateTaskWorkspace(taskId: string, workspaceId: string): void {
    this.taskRepo.update(taskId, { workspaceId });
  }

  /**
   * Get workspace by ID
   */
  getWorkspaceById(id: string): Workspace | undefined {
    return this.workspaceRepo.findById(id);
  }

  /**
   * Get workspace by path
   */
  getWorkspaceByPath(path: string): Workspace | undefined {
    return this.workspaceRepo.findByPath(path);
  }

  /**
   * Create a new workspace with default permissions
   */
  createWorkspace(name: string, path: string): Workspace {
    const defaultPermissions: WorkspacePermissions = {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
    };
    return this.workspaceRepo.create(name, path, defaultPermissions);
  }

  /**
   * Update task fields (for Goal Mode attempt tracking, etc.)
   */
  updateTask(taskId: string, updates: Partial<Pick<Task, 'currentAttempt' | 'status' | 'error' | 'completedAt'>>): void {
    this.taskRepo.update(taskId, updates);
  }

  private clearRetryState(taskId: string): void {
    const pending = this.pendingRetries.get(taskId);
    if (pending) {
      clearTimeout(pending);
      this.pendingRetries.delete(taskId);
    }
    this.retryCounts.delete(taskId);
  }

  /**
   * Mark task as completed
   * Note: We keep the executor in memory for follow-up messages (with TTL-based cleanup)
   */
  completeTask(taskId: string, resultSummary?: string): void {
    const updates: Partial<Task> = {
      status: 'completed',
      completedAt: Date.now(),
    };
    if (typeof resultSummary === 'string' && resultSummary.trim().length > 0) {
      updates.resultSummary = resultSummary.trim();
    }
    this.taskRepo.update(taskId, updates);
    this.clearRetryState(taskId);
    // Mark executor as completed for TTL-based cleanup
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.status = 'completed';
      cached.lastAccessed = Date.now();
    }
    this.logEvent(taskId, 'task_completed', {
      message: 'Task completed successfully',
      ...(updates.resultSummary ? { resultSummary: updates.resultSummary } : {}),
    });
    // Notify queue manager so it can start next task
    this.queueManager.onTaskFinished(taskId);
  }

  /**
   * Send a follow-up message to a task
   */
  async sendMessage(taskId: string, message: string): Promise<void> {
    let cached = this.activeTasks.get(taskId);
    let executor: TaskExecutor;

    // Always get fresh task and workspace from DB to pick up permission changes
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const effectiveTask = this.applyAgentRoleToolRestrictions(task);

    const workspace = this.workspaceRepo.findById(effectiveTask.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${effectiveTask.workspaceId} not found`);
    }

    if (!cached) {
      // Task executor not in memory - need to recreate it
      // Create new executor
      executor = new TaskExecutor(effectiveTask, workspace, this);

      // Rebuild conversation history from saved events
      const events = this.eventRepo.findByTaskId(taskId);
      if (events.length > 0) {
        executor.rebuildConversationFromEvents(events);
      }

      this.activeTasks.set(taskId, {
        executor,
        lastAccessed: Date.now(),
        status: 'active',
      });
    } else {
      executor = cached.executor;
      // Update workspace to pick up permission changes (e.g., shell enabled)
      executor.updateWorkspace(workspace);
      cached.lastAccessed = Date.now();
      cached.status = 'active';
    }

    // Send the message
    await executor.sendMessage(message);
  }

  // ===== Queue Management Methods =====

  /**
   * Get current queue status
   */
  getQueueStatus(): QueueStatus {
    return this.queueManager.getStatus();
  }

  /**
   * Get queue settings
   */
  getQueueSettings(): QueueSettings {
    return this.queueManager.getSettings();
  }

  /**
   * Save queue settings
   */
  saveQueueSettings(settings: Partial<QueueSettings>): void {
    this.queueManager.saveSettings(settings);
  }

  /**
   * Clear stuck tasks from the queue
   * Used to recover from stuck state when tasks fail to clean up
   * Also properly cancels running tasks to clean up resources (browser sessions, etc.)
   */
  async clearStuckTasks(): Promise<{ clearedRunning: number; clearedQueued: number }> {
    // Get running task IDs before clearing
    const status = this.queueManager.getStatus();
    const runningTaskIds = [...status.runningTaskIds];
    const queuedTaskIds = [...status.queuedTaskIds];

    console.log(`[AgentDaemon] Clearing ${runningTaskIds.length} running tasks and ${queuedTaskIds.length} queued tasks`);

    // Cancel all running tasks properly (this cleans up browser sessions, etc.)
    for (const taskId of runningTaskIds) {
      const cached = this.activeTasks.get(taskId);
      if (cached) {
        try {
          console.log(`[AgentDaemon] Cancelling running task: ${taskId}`);
          await cached.executor.cancel();
          this.activeTasks.delete(taskId);
        } catch (error) {
          console.error(`[AgentDaemon] Error cancelling task ${taskId}:`, error);
        }
      }
    }

    // Now clear the queue state
    return this.queueManager.clearStuckTasks();
  }

  /**
   * Handle a task that has timed out
   * Called by queue manager when a task exceeds the configured timeout
   */
  async handleTaskTimeout(taskId: string): Promise<void> {
    console.log(`[AgentDaemon] Task ${taskId} has timed out, cancelling...`);

    const cached = this.activeTasks.get(taskId);
    if (cached) {
      try {
        // Cancel the task (this cleans up browser sessions, etc.)
        await cached.executor.cancel();
        this.activeTasks.delete(taskId);
      } catch (error) {
        console.error(`[AgentDaemon] Error cancelling timed out task ${taskId}:`, error);
      }
    }

    // Update task status to failed with timeout message
    this.taskRepo.update(taskId, {
      status: 'failed',
      error: 'Task timed out - exceeded maximum allowed execution time',
    });
    this.clearRetryState(taskId);

    // Emit timeout event
    this.logEvent(taskId, 'step_timeout', {
      message: 'Task exceeded maximum execution time and was automatically cancelled',
    });
  }

  /**
   * Emit queue update event to all windows
   */
  private emitQueueUpdate(status: QueueStatus): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(window => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.QUEUE_UPDATE, status);
        }
      } catch (error) {
        console.error(`[AgentDaemon] Error sending queue update to window:`, error);
      }
    });
  }

  /**
   * Shutdown daemon
   * Properly awaits all task cancellations and clears intervals
   */
  async shutdown(): Promise<void> {
    console.log('Shutting down agent daemon...');

    // Clear the cleanup interval
    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = undefined;
    }

    // Clear all pending approval timeouts and reject pending promises
    this.pendingApprovals.forEach((pending, approvalId) => {
      clearTimeout(pending.timeoutHandle);
      if (!pending.resolved) {
        pending.resolved = true;
        pending.reject(new Error('Daemon shutting down'));
      }
    });
    this.pendingApprovals.clear();

    // Cancel all active tasks and wait for them to complete
    const cancelPromises: Promise<void>[] = [];
    this.activeTasks.forEach((cached, taskId) => {
      const promise = cached.executor.cancel().catch(err => {
        console.error(`Error cancelling task ${taskId}:`, err);
      });
      cancelPromises.push(promise);
    });

    // Wait for all cancellations to complete (with timeout)
    await Promise.race([
      Promise.all(cancelPromises),
      new Promise<void>(resolve => setTimeout(resolve, 5000)), // 5 second timeout
    ]);

    this.activeTasks.clear();

    // Remove all EventEmitter listeners to prevent memory leaks
    this.removeAllListeners();

    console.log('Agent daemon shutdown complete');
  }

  /**
   * Prune old conversation snapshots for a task, keeping only the most recent one.
   * This prevents database bloat from accumulating snapshots.
   */
  pruneOldSnapshots(taskId: string): void {
    try {
      this.eventRepo.pruneOldSnapshots(taskId);
    } catch (error) {
      console.debug('[AgentDaemon] Failed to prune old snapshots:', error);
    }
  }
}
