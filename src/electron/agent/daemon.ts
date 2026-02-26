import { EventEmitter } from "events";
import * as fs from "fs";
import * as crypto from "crypto";
import { DatabaseManager } from "../database/schema";
import type Database from "better-sqlite3";
import {
  TaskRepository,
  TaskEventRepository,
  WorkspaceRepository,
  ApprovalRepository,
  ArtifactRepository,
  MemoryType,
} from "../database/repositories";
import { ActivityRepository } from "../activity/ActivityRepository";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { MentionRepository } from "../agents/MentionRepository";
import { buildAgentDispatchPrompt } from "../agents/agent-dispatch";
import { extractMentionedRoles } from "../agents/mentions";
import {
  Task,
  TaskStatus,
  TaskEvent,
  IPC_CHANNELS,
  QueueSettings,
  QueueStatus,
  Workspace,
  WorkspacePermissions,
  AgentConfig,
  AgentType,
  ActivityActorType,
  ActivityType,
  CreateActivityRequest,
  Plan,
  BoardColumn,
  Activity,
  AgentMention,
  AgentRole,
  TeamThoughtEvent,
  isTempWorkspaceId,
  ImageAttachment,
  MULTI_LLM_PROVIDER_DISPLAY,
  AgentTeamRun,
  AgentTeamItem,
  StepFeedbackAction,
  TASK_ERROR_CODES,
} from "../../shared/types";
import { TaskExecutor } from "./executor";
import { TaskQueueManager } from "./queue-manager";
import { approvalIdempotency, taskIdempotency, IdempotencyManager } from "../security/concurrency";
import { MemoryService } from "../memory/MemoryService";
import { PlaybookService } from "../memory/PlaybookService";
import { UserProfileService } from "../memory/UserProfileService";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import { PersonalityManager } from "../settings/personality-manager";
import { IntentRoute, IntentRouter } from "./strategy/IntentRouter";
import { DerivedTaskStrategy, TaskStrategyService } from "./strategy/TaskStrategyService";
import type { AgentTeamOrchestrator } from "../agents/AgentTeamOrchestrator";
import { AgentTeamItemRepository } from "../agents/AgentTeamItemRepository";
import { AgentTeamRunRepository } from "../agents/AgentTeamRunRepository";
import { WorktreeManager } from "../git/WorktreeManager";
import type { ComparisonService } from "../git/ComparisonService";

// Memory management constants
const MAX_CACHED_EXECUTORS = 10; // Maximum number of completed task executors to keep in memory
const EXECUTOR_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes - time before completed executors are cleaned up

// Mid-conversation correction detection patterns.
// Regex-based (no LLM calls) to detect when a user is correcting the agent during a task.
const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(do it|try|use|make|that'?s not|wrong)\b/i,
  /\bthat'?s\s+wrong\b/i,
  /\bactually\s+i\s+meant\b/i,
  /\bnot\s+like\s+that\b/i,
  /\binstead\s+of\s+that\b/i,
  /\byou\s+should\s+have\b/i,
  /\bthe\s+correct\s+way\s+is\b/i,
  /\bdon'?t\s+do\s+that\b/i,
  /\bstop\b.*\binstead\b/i,
  /\bwrong\s+approach\b/i,
  /\bi\s+didn'?t\s+(mean|ask|want)\b/i,
  /\bnot\s+what\s+i\s+(meant|asked|wanted)\b/i,
];

function detectsCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

// Activity throttling constants
const ACTIVITY_THROTTLE_WINDOW_MS = 2000; // 2 seconds - window for deduping similar activities
const THROTTLED_ACTIVITY_TYPES = new Set([
  "tool_call",
  "file_created",
  "file_modified",
  "file_deleted",
]);

interface CachedExecutor {
  executor: TaskExecutor;
  lastAccessed: number;
  status: "active" | "completed";
}

function getAllElectronWindows(): any[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as any;
    const BrowserWindow = electron?.BrowserWindow;
    if (BrowserWindow?.getAllWindows) {
      return BrowserWindow.getAllWindows();
    }
  } catch {
    // Not running under Electron (or Electron APIs unavailable).
  }
  return [];
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
  private teamOrchestrator: AgentTeamOrchestrator | null = null;
  private activeTasks: Map<string, CachedExecutor> = new Map();
  private pendingApprovals: Map<
    string,
    {
      taskId: string;
      resolve: (value: boolean) => void;
      reject: (reason?: unknown) => void;
      resolved: boolean;
      timeoutHandle: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  private cleanupIntervalHandle?: ReturnType<typeof setInterval>;
  private queueManager: TaskQueueManager;
  // Activity throttle: Map<taskId:eventType, lastTimestamp>
  private activityThrottle: Map<string, number> = new Map();
  private pendingRetries: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private retryCounts: Map<string, number> = new Map();
  private readonly maxTaskRetries = 2;
  private readonly retryDelayMs = 30 * 1000;
  /** Session-level auto-approve: when true, all approval requests are auto-granted.
   *  Set via IPC when the user clicks "Approve all" in the UI.
   *  Persists for the app lifetime (survives HMR/renderer reloads). */
  private sessionAutoApproveAll = false;
  /** Transient storage for images attached to task creation (not persisted to DB). */
  private pendingTaskImages: Map<string, ImageAttachment[]> = new Map();
  /**
   * Tasks queued via "Continue" after turn-limit exhaustion.
   * When dequeued, these must resume via continuation flow, not normal execution.
   */
  private pendingContinuationTaskIds: Set<string> = new Set();
  /** Git worktree manager for task isolation. */
  private worktreeManager: WorktreeManager;
  /** Comparison service for agent comparison mode. */
  private comparisonService: ComparisonService | null = null;

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
      updateTaskStatus: (taskId: string, status: TaskStatus) =>
        this.taskRepo.update(taskId, { status }),
      onTaskTimeout: (taskId: string) => this.handleTaskTimeout(taskId),
    });

    // Initialize worktree manager
    this.worktreeManager = new WorktreeManager(db);

    // Start periodic cleanup of old executors
    this.cleanupIntervalHandle = setInterval(() => this.cleanupOldExecutors(), 5 * 60 * 1000); // Run every 5 minutes
  }

  /** Get the worktree manager instance. */
  getWorktreeManager(): WorktreeManager {
    return this.worktreeManager;
  }

  /** Set the comparison service (initialized after daemon construction). */
  setComparisonService(service: ComparisonService): void {
    this.comparisonService = service;
  }

  /** Get the comparison service instance. */
  getComparisonService(): ComparisonService | null {
    return this.comparisonService;
  }

  getDatabase(): Database.Database {
    return this.dbManager.getDatabase();
  }

  setTeamOrchestrator(orchestrator: AgentTeamOrchestrator | null): void {
    this.teamOrchestrator = orchestrator;
  }

  /**
   * Apply agent role configuration to the task before execution.
   *
   * Agent roles act like worker profiles. We apply role defaults only when the
   * task does not specify its own overrides.
   *
   * - Merge denied tools into AgentConfig.toolRestrictions (deny-wins)
   * - Apply provider/model/personality defaults
   */
  private applyAgentRoleOverrides(task: Task): { task: Task; changed: boolean } {
    const roleId = task.assignedAgentRoleId;
    if (!roleId) return { task, changed: false };

    const role = this.agentRoleRepo.findById(roleId);
    if (!role) return { task, changed: false };

    const nextAgentConfig: AgentConfig = task.agentConfig ? { ...task.agentConfig } : {};
    let changed = false;

    // Apply provider/model/personality defaults only when the task didn't override them.
    if (
      !nextAgentConfig.providerType &&
      typeof role.providerType === "string" &&
      role.providerType.trim().length > 0
    ) {
      nextAgentConfig.providerType = role.providerType.trim() as any;
      changed = true;
    }

    if (
      !nextAgentConfig.modelKey &&
      typeof role.modelKey === "string" &&
      role.modelKey.trim().length > 0
    ) {
      nextAgentConfig.modelKey = role.modelKey.trim();
      changed = true;
    }

    if (
      !nextAgentConfig.personalityId &&
      typeof role.personalityId === "string" &&
      role.personalityId.trim().length > 0
    ) {
      nextAgentConfig.personalityId = role.personalityId.trim() as any;
      changed = true;
    }

    const denied = role.toolRestrictions?.deniedTools;
    if (!Array.isArray(denied) || denied.length === 0) {
      return { task: changed ? { ...task, agentConfig: nextAgentConfig } : task, changed };
    }

    const merged = new Set<string>();

    const addAll = (values: unknown) => {
      if (!Array.isArray(values)) return;
      for (const raw of values) {
        const value = typeof raw === "string" ? raw.trim() : "";
        if (!value) continue;
        merged.add(value);
      }
    };

    addAll(nextAgentConfig.toolRestrictions);
    addAll(denied);

    if (merged.size > 0) {
      nextAgentConfig.toolRestrictions = Array.from(merged);
      changed = true;
    }

    return { task: changed ? { ...task, agentConfig: nextAgentConfig } : task, changed };
  }

  private maybeCaptureMentionedAgentRoleIds(task: Task): void {
    if (task.parentTaskId) return;
    if ((task.agentType ?? "main") !== "main") return;
    if (
      Array.isArray(task.mentionedAgentRoleIds) &&
      task.mentionedAgentRoleIds.filter(Boolean).length > 0
    )
      return;

    try {
      const activeRoles = this.agentRoleRepo.findAll(false).filter((role) => role.isActive);
      if (activeRoles.length === 0) return;

      const mentioned = extractMentionedRoles(`${task.title}\n${task.prompt}`, activeRoles);
      const ids = mentioned.map((role) => role.id).filter(Boolean);
      if (ids.length === 0) return;

      this.taskRepo.update(task.id, { mentionedAgentRoleIds: ids });
      task.mentionedAgentRoleIds = ids;
    } catch (error) {
      console.warn("[AgentDaemon] Failed to capture mentioned agent roles:", error);
    }
  }

  private sameAgentConfig(a?: AgentConfig, b?: AgentConfig): boolean {
    return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
  }

  private deriveTaskStrategy(input: { title: string; prompt: string; agentConfig?: AgentConfig }): {
    route: IntentRoute;
    strategy: DerivedTaskStrategy;
    prompt: string;
    agentConfig: AgentConfig;
    promptChanged: boolean;
    agentConfigChanged: boolean;
  } {
    const route = IntentRouter.route(input.title, input.prompt);
    const strategy = TaskStrategyService.derive(route, input.agentConfig);
    const agentConfig = TaskStrategyService.applyToAgentConfig(input.agentConfig, strategy);
    // Store detected intent for intent-based tool filtering
    agentConfig.taskIntent = route.intent;
    const relationshipContext = RelationshipMemoryService.buildPromptContext({
      maxPerLayer: 2,
      maxChars: 1200,
    });
    const prompt = TaskStrategyService.decoratePrompt(
      input.prompt,
      route,
      strategy,
      relationshipContext,
    );
    return {
      route,
      strategy,
      prompt,
      agentConfig,
      promptChanged: prompt !== input.prompt,
      agentConfigChanged: !this.sameAgentConfig(input.agentConfig, agentConfig),
    };
  }

  private applyRuntimeTaskStrategy(task: Task): {
    task: Task;
    route: IntentRoute;
    strategy: DerivedTaskStrategy;
    promptChanged: boolean;
    agentConfigChanged: boolean;
  } {
    const derived = this.deriveTaskStrategy({
      title: task.title,
      prompt: task.prompt,
      agentConfig: task.agentConfig,
    });
    const nextTask: Task =
      derived.promptChanged || derived.agentConfigChanged
        ? { ...task, prompt: derived.prompt, agentConfig: derived.agentConfig }
        : task;

    return {
      task: nextTask,
      route: derived.route,
      strategy: derived.strategy,
      promptChanged: derived.promptChanged,
      agentConfigChanged: derived.agentConfigChanged,
    };
  }

  /**
   * Initialize the daemon - call after construction to set up queue
   */
  async initialize(): Promise<void> {
    // Find queued tasks from database for queue recovery
    const queuedTasks = this.taskRepo.findByStatus("queued");

    // Find tasks that were gracefully interrupted (app shutdown while running).
    // These have a conversation snapshot saved and can be resumed.
    const interruptedTasks = this.taskRepo.findByStatus("interrupted");

    // Find orphaned tasks from a crash / force-kill (still in planning/executing
    // without the explicit "interrupted" marker, e.g. Ctrl+C during npm run dev).
    // If they have a conversation snapshot saved from normal execution we can still
    // resume them; otherwise mark as failed.
    const orphanedTasks = this.taskRepo.findByStatus(["planning", "executing"]);

    const tasksToResume = [...interruptedTasks];

    if (orphanedTasks.length > 0) {
      console.log(
        `[AgentDaemon] Found ${orphanedTasks.length} orphaned task(s) from previous session`,
      );
      for (const task of orphanedTasks) {
        const events = this.eventRepo.findByTaskId(task.id);
        const hasSnapshot = events.some((e) => e.type === "conversation_snapshot");
        const hasPlan = events.some((e) => e.type === "plan_created" && e.payload?.plan);

        if (hasSnapshot || hasPlan) {
          // Recoverable: mark as interrupted and add to the resume list
          console.log(
            `[AgentDaemon] Orphaned task ${task.id} has saved state — scheduling for resume`,
          );
          this.taskRepo.update(task.id, {
            status: "interrupted" as TaskStatus,
            error:
              "Application exited unexpectedly while task was running - will resume on restart",
          });
          this.logEvent(task.id, "task_interrupted", {
            message: "Task interrupted by unexpected application exit. Will resume on restart.",
          });
          tasksToResume.push({ ...task, status: "interrupted" as TaskStatus });
        } else {
          // No saved state — unrecoverable
          console.log(
            `[AgentDaemon] Orphaned task ${task.id} has no saved state — marking as failed`,
          );
          this.taskRepo.update(task.id, {
            status: "failed",
            error: "Task interrupted - application crashed before any progress was saved",
          });
        }
      }
    }

    // Initialize queue with queued tasks
    await this.queueManager.initialize(queuedTasks, []);

    // Resume all resumable tasks after a short delay to let the rest of the app
    // (IPC handlers, tray, cron, UI) finish initializing first.
    if (tasksToResume.length > 0) {
      console.log(`[AgentDaemon] ${tasksToResume.length} task(s) scheduled for resume`);
      setTimeout(() => {
        this.resumeInterruptedTasks(tasksToResume);
      }, 2000);
    }
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
      if (cached.status === "completed") {
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
        .filter(([_, cached]) => cached.status === "completed")
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
      console.log(
        `[AgentDaemon] Cleaned up ${toDelete.length} old executor(s). Active: ${this.activeTasks.size}`,
      );
    }
  }

  /**
   * Queue a task for execution
   * The task will either start immediately or be queued based on concurrency limits
   */
  async startTask(task: Task, images?: ImageAttachment[]): Promise<void> {
    // Store images transiently until the task starts executing
    if (images && images.length > 0) {
      this.pendingTaskImages.set(task.id, images);
    }
    await this.queueManager.enqueue(task);

    // If the task was queued (concurrency full), emit an explicit event so
    // remote gateways (WhatsApp/Telegram/etc) can inform the user instead of
    // appearing to "hang" silently.
    const refreshed = this.taskRepo.findById(task.id);
    if (refreshed?.status === "queued") {
      const status = this.queueManager.getStatus();
      const idx = status.queuedTaskIds.indexOf(task.id);
      const position = idx >= 0 ? idx + 1 : undefined;
      const message = position
        ? `⏳ Queued (position ${position}). I’ll start as soon as a slot is free.`
        : "⏳ Queued. I’ll start as soon as a slot is free.";
      this.logEvent(task.id, "task_queued", {
        position,
        reason: "concurrency",
        message,
      });
    }
  }

  /**
   * Start executing a task immediately (internal - called by queue manager)
   */
  async startTaskImmediate(task: Task): Promise<void> {
    console.log(`[AgentDaemon] Starting task ${task.id}: ${task.title}`);

    if (this.shouldStartAsQueuedContinuation(task)) {
      this.pendingContinuationTaskIds.delete(task.id);
      await this.startQueuedContinuation(task);
      return;
    }

    const { task: effectiveTask, changed: roleOverridesChanged } =
      this.applyAgentRoleOverrides(task);
    if (roleOverridesChanged) {
      try {
        this.taskRepo.update(effectiveTask.id, { agentConfig: effectiveTask.agentConfig });
      } catch (error) {
        console.warn("[AgentDaemon] Failed to persist agent role overrides:", error);
      }
    }

    // Ensure @mentions are recorded for deferred dispatch regardless of task creation entrypoint.
    this.maybeCaptureMentionedAgentRoleIds(effectiveTask);
    const runtimeStrategy = this.applyRuntimeTaskStrategy(effectiveTask);
    const executionTask = runtimeStrategy.task;
    if (runtimeStrategy.agentConfigChanged) {
      try {
        this.taskRepo.update(effectiveTask.id, { agentConfig: executionTask.agentConfig });
      } catch (error) {
        console.warn("[AgentDaemon] Failed to persist runtime strategy agent config:", error);
      }
    }
    if (runtimeStrategy.promptChanged || runtimeStrategy.agentConfigChanged) {
      this.logEvent(effectiveTask.id, "log", {
        message: `Execution strategy active: intent=${runtimeStrategy.route.intent}, mode=${runtimeStrategy.strategy.conversationMode}, answerFirst=${runtimeStrategy.strategy.answerFirst}`,
      });
    }

    const wasQueued = effectiveTask.status === "queued";
    if (wasQueued) {
      const isRetry = this.retryCounts.has(effectiveTask.id);
      const count = this.retryCounts.get(effectiveTask.id) ?? 0;
      const retrySuffix = isRetry ? ` (retry ${count}/${this.maxTaskRetries})` : "";
      this.logEvent(effectiveTask.id, "task_dequeued", {
        message: `▶️ Starting now${retrySuffix}.`,
      });
    }

    // Get workspace details
    const workspace = this.workspaceRepo.findById(executionTask.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${executionTask.workspaceId} not found`);
    }
    console.log(`[AgentDaemon] Workspace found: ${workspace.name}`);

    // === WORKTREE ISOLATION ===
    // If worktree isolation is enabled, create an isolated worktree for this task.
    // The executor gets a "virtual workspace" with the path swapped to the worktree directory.
    let effectiveWorkspace = workspace;
    if (await this.worktreeManager.shouldUseWorktree(workspace.path, workspace.isTemp)) {
      try {
        const worktreeInfo = await this.worktreeManager.createForTask(
          executionTask.id,
          executionTask.title,
          workspace.id,
          workspace.path,
        );

        // Create a virtual workspace pointing to the worktree
        effectiveWorkspace = {
          ...workspace,
          path: worktreeInfo.worktreePath,
        };

        // Update task record with worktree metadata
        this.taskRepo.update(executionTask.id, {
          worktreePath: worktreeInfo.worktreePath,
          worktreeBranch: worktreeInfo.branchName,
          worktreeStatus: "active",
        });
        executionTask.worktreePath = worktreeInfo.worktreePath;
        executionTask.worktreeBranch = worktreeInfo.branchName;
        executionTask.worktreeStatus = "active";

        this.logEvent(executionTask.id, "worktree_created", {
          branch: worktreeInfo.branchName,
          path: worktreeInfo.worktreePath,
          baseBranch: worktreeInfo.baseBranch,
          message: `Working on branch "${worktreeInfo.branchName}" in isolated worktree.`,
        });
        console.log(
          `[AgentDaemon] Worktree created: branch=${worktreeInfo.branchName}, path=${worktreeInfo.worktreePath}`,
        );
      } catch (error: any) {
        // Non-fatal: fall back to shared workspace
        console.error(
          `[AgentDaemon] Worktree creation failed for task ${executionTask.id}:`,
          error,
        );
        this.logEvent(executionTask.id, "log", {
          message: `Worktree creation failed: ${error.message}. Using shared workspace.`,
        });
      }
    }

    // Create task executor - wrapped in try-catch to handle provider initialization errors
    let executor: TaskExecutor;
    try {
      console.log(`[AgentDaemon] Creating TaskExecutor...`);
      executor = new TaskExecutor(executionTask, effectiveWorkspace, this);
      // Attach any images that were provided at task creation time
      const initialImages = this.pendingTaskImages.get(executionTask.id);
      if (initialImages && initialImages.length > 0) {
        executor.setInitialImages(initialImages);
        this.pendingTaskImages.delete(executionTask.id);
      }
      console.log(`[AgentDaemon] TaskExecutor created successfully`);
    } catch (error: any) {
      console.error(`[AgentDaemon] Task ${effectiveTask.id} failed to initialize:`, error);
      this.taskRepo.update(effectiveTask.id, {
        status: "failed",
        error: error.message || "Failed to initialize task executor",
        completedAt: Date.now(),
      });
      this.pendingTaskImages.delete(effectiveTask.id);
      this.clearRetryState(effectiveTask.id);
      this.logEvent(effectiveTask.id, "error", { error: error.message });
      // Notify queue manager so it can start next task
      this.queueManager.onTaskFinished(effectiveTask.id);
      return;
    }

    this.activeTasks.set(effectiveTask.id, {
      executor,
      lastAccessed: Date.now(),
      status: "active",
    });

    // Update task status
    this.taskRepo.update(effectiveTask.id, { status: "planning", error: undefined });
    this.logEvent(effectiveTask.id, "task_created", { task: executionTask });
    console.log(`[AgentDaemon] Task status updated to 'planning', starting execution...`);

    // Pause background memory compression to avoid contention with the executor's
    // LLM calls — compression creates its own provider instance and its API calls
    // interleave with the executor's, adding latency and cost.
    MemoryService.pauseCompression();

    // Start execution (non-blocking)
    executor
      .execute()
      .then(() => {
        MemoryService.resumeCompression();
        // After execution completes, process any follow-ups that were queued
        // while the executor was running but arrived too late for the loop to pick up.
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      })
      .catch((error) => {
        MemoryService.resumeCompression();
        console.error(`[AgentDaemon] Task ${effectiveTask.id} execution failed:`, error);
        this.taskRepo.update(effectiveTask.id, {
          status: "failed",
          error: error.message,
          completedAt: Date.now(),
        });
        this.clearRetryState(effectiveTask.id);
        this.logEvent(effectiveTask.id, "error", { error: error.message });
        this.activeTasks.delete(effectiveTask.id);
        // Notify queue manager so it can start next task
        this.queueManager.onTaskFinished(effectiveTask.id);
        // Even on failure, process orphaned follow-ups so they aren't silently lost
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      });
  }

  /**
   * Resume tasks that were interrupted by a previous graceful app shutdown.
   * Called from initialize() after a short delay to let the app finish starting.
   */
  private async resumeInterruptedTasks(tasks: Task[]): Promise<void> {
    for (const task of tasks) {
      try {
        console.log(`[AgentDaemon] Resuming interrupted task ${task.id}: ${task.title}`);
        await this.resumeInterruptedTask(task);
      } catch (error: any) {
        console.error(`[AgentDaemon] Failed to resume task ${task.id}:`, error);
        this.taskRepo.update(task.id, {
          status: "failed",
          error: `Failed to resume after interruption: ${error.message}`,
          completedAt: Date.now(),
        });
        this.logEvent(task.id, "error", {
          message: `Failed to resume interrupted task: ${error.message}`,
        });
      }
    }
  }

  /**
   * Resume a single interrupted task by reconstructing the executor from saved
   * conversation snapshots and plan events, then continuing execution.
   */
  private async resumeInterruptedTask(task: Task): Promise<void> {
    // Guard against double-resume (e.g. rapid restarts)
    const currentTask = this.taskRepo.findById(task.id);
    if (!currentTask || currentTask.status !== "interrupted") {
      console.log(
        `[AgentDaemon] Task ${task.id} is no longer interrupted (status: ${currentTask?.status}), skipping resume`,
      );
      return;
    }

    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${task.workspaceId} not found - cannot resume task`);
    }

    // Fetch all events for this task
    const events = this.eventRepo.findByTaskId(task.id);

    // Check if we have meaningful state to restore from
    const hasSnapshot = events.some((e) => e.type === "conversation_snapshot");
    const planEvent = events.filter((e) => e.type === "plan_created").pop();
    const hasPlan = planEvent && planEvent.payload?.plan;

    if (!hasSnapshot && !hasPlan) {
      // Task was interrupted very early (during planning, before any meaningful state).
      // Re-queue it to start from scratch.
      console.log(
        `[AgentDaemon] Task ${task.id} has no snapshot or plan - restarting from scratch`,
      );
      this.taskRepo.update(task.id, { status: "queued", error: undefined });
      this.logEvent(task.id, "log", {
        message: "Task interrupted before meaningful progress. Restarting from scratch.",
      });
      await this.queueManager.enqueue(task);
      return;
    }

    // Apply agent role overrides (same as startTaskImmediate)
    const { task: effectiveTask } = this.applyAgentRoleOverrides(task);

    // Handle worktree workspace if applicable
    let effectiveWorkspace = workspace;
    if (task.worktreePath && task.worktreeStatus === "active") {
      if (fs.existsSync(task.worktreePath)) {
        effectiveWorkspace = { ...workspace, path: task.worktreePath };
      } else {
        console.warn(
          `[AgentDaemon] Worktree path ${task.worktreePath} no longer exists for task ${task.id}`,
        );
      }
    }

    // Create new executor and restore conversation state
    const executor = new TaskExecutor(effectiveTask, effectiveWorkspace, this);
    executor.rebuildConversationFromEvents(events);

    // Reconstruct the Plan from events with correct step statuses
    if (hasPlan) {
      const rawPlan = planEvent!.payload.plan as Plan;
      const completedStepIds = new Set<string>();
      const failedStepIds = new Set<string>();
      for (const event of events) {
        if (event.type === "step_completed" && event.payload?.step?.id) {
          completedStepIds.add(event.payload.step.id);
        }
        if (event.type === "step_failed" && event.payload?.step?.id) {
          failedStepIds.add(event.payload.step.id);
        }
      }
      const restoredPlan: Plan = {
        description: rawPlan.description,
        steps: rawPlan.steps.map((step) => ({
          ...step,
          status: completedStepIds.has(step.id)
            ? ("completed" as const)
            : failedStepIds.has(step.id)
              ? ("failed" as const)
              : ("pending" as const),
        })),
      };
      executor.setPlan(restoredPlan);
    }

    // Register in active tasks map
    this.activeTasks.set(effectiveTask.id, {
      executor,
      lastAccessed: Date.now(),
      status: "active",
    });

    // Register with queue manager for concurrency limits and timeout tracking.
    // If the concurrency limit is already reached, the task is re-queued and
    // will start automatically when a slot opens up.
    const canRun = this.queueManager.registerResumedTask(effectiveTask.id);
    if (!canRun) {
      // Clean up the executor we just created — it will be rebuilt when the
      // task is dequeued via the normal startTaskImmediate path.
      this.activeTasks.delete(effectiveTask.id);
      this.taskRepo.update(effectiveTask.id, { status: "queued" });
      this.logEvent(effectiveTask.id, "task_queued", {
        reason: "concurrency",
        message:
          "⏳ Queued — concurrency limit reached during resume. Will start when a slot opens.",
      });
      return;
    }

    // Update status and log resumption
    this.taskRepo.update(effectiveTask.id, {
      status: "executing",
      error: undefined,
    });
    this.logEvent(effectiveTask.id, "task_resumed", {
      message: "Resuming task after application restart",
      hadSnapshot: hasSnapshot,
      hadPlan: !!hasPlan,
    });

    // Start execution (non-blocking, same pattern as startTaskImmediate)
    executor
      .resumeAfterInterruption()
      .then(() => {
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      })
      .catch((error) => {
        console.error(`[AgentDaemon] Resumed task ${effectiveTask.id} failed:`, error);
        this.taskRepo.update(effectiveTask.id, {
          status: "failed",
          error: error.message,
          completedAt: Date.now(),
        });
        this.clearRetryState(effectiveTask.id);
        this.logEvent(effectiveTask.id, "error", { error: error.message });
        this.activeTasks.delete(effectiveTask.id);
        this.queueManager.onTaskFinished(effectiveTask.id);
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      });
  }

  /**
   * Continue a failed task that was stopped due to budget/limit exhaustion.
   * Reconstructs the executor from persisted events, resets budgets, and
   * resumes execution from where the plan left off.
   */
  private isTurnLimitContinuationEligible(task: Task, events: TaskEvent[]): boolean {
    const latestErrorEvent = [...events].reverse().find((event) => event.type === "error");
    if (latestErrorEvent) {
      const errorCode = latestErrorEvent.payload?.errorCode;
      const actionHintType = latestErrorEvent.payload?.actionHint?.type;
      if (
        errorCode === TASK_ERROR_CODES.TURN_LIMIT_EXCEEDED ||
        actionHintType === "continue_task"
      ) {
        return true;
      }

      const latestErrorText =
        latestErrorEvent.payload?.message ||
        latestErrorEvent.payload?.error ||
        latestErrorEvent.payload?.detail ||
        "";
      return /Global turn limit exceeded/i.test(String(latestErrorText));
    }

    // Backward compatibility for older tasks that predate structured error metadata.
    return /Global turn limit exceeded/i.test(String(task.error || ""));
  }

  private shouldStartAsQueuedContinuation(task: Task): boolean {
    if (this.pendingContinuationTaskIds.has(task.id)) {
      return true;
    }
    if (task.status !== "queued") {
      return false;
    }

    const events = this.eventRepo.findByTaskId(task.id);
    const latestQueueEvent = [...events].reverse().find((event) => event.type === "task_queued");
    const wasQueuedForContinuation =
      latestQueueEvent?.payload?.reason === "continuation_concurrency";
    if (!wasQueuedForContinuation) {
      return false;
    }

    return this.isTurnLimitContinuationEligible(task, events);
  }

  private buildContinuationPlan(rawPlan: Plan, events: TaskEvent[]): Plan {
    const terminalStatusByStep = new Map<string, "completed" | "skipped">();
    for (const event of events) {
      const stepId = event.payload?.step?.id;
      if (!stepId) continue;
      if (event.type === "step_completed") {
        terminalStatusByStep.set(stepId, "completed");
      } else if (event.type === "step_skipped") {
        terminalStatusByStep.set(stepId, "skipped");
      }
    }

    return {
      description: rawPlan.description,
      steps: rawPlan.steps.map((step) => ({
        ...step,
        status: terminalStatusByStep.get(step.id) ?? ("pending" as const),
      })),
    };
  }

  private createContinuationExecutor(
    task: Task,
    events: TaskEvent[],
  ): { effectiveTask: Task; executor: TaskExecutor } {
    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${task.workspaceId} not found`);
    }

    const planEvent = events.filter((e) => e.type === "plan_created").pop();
    if (!planEvent?.payload?.plan) {
      throw new Error(
        `Task ${task.id} cannot be continued because no execution plan could be restored`,
      );
    }

    const { task: effectiveTask } = this.applyAgentRoleOverrides(task);

    let effectiveWorkspace = workspace;
    if (task.worktreePath && task.worktreeStatus === "active" && fs.existsSync(task.worktreePath)) {
      effectiveWorkspace = { ...workspace, path: task.worktreePath };
    }

    const executor = new TaskExecutor(effectiveTask, effectiveWorkspace, this);
    executor.rebuildConversationFromEvents(events);

    const rawPlan = planEvent.payload.plan as Plan;
    executor.setPlan(this.buildContinuationPlan(rawPlan, events));

    return { effectiveTask, executor };
  }

  private launchContinuationExecution(effectiveTask: Task, executor: TaskExecutor): void {
    executor
      .continueAfterBudgetExhausted()
      .then(() => {
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      })
      .catch((error) => {
        console.error(`[AgentDaemon] Continued task ${effectiveTask.id} failed:`, error);
        this.taskRepo.update(effectiveTask.id, {
          status: "failed",
          error: error.message,
          completedAt: Date.now(),
        });
        this.clearRetryState(effectiveTask.id);
        this.logEvent(effectiveTask.id, "error", { error: error.message });
        this.activeTasks.delete(effectiveTask.id);
        this.queueManager.onTaskFinished(effectiveTask.id);
        this.processOrphanedFollowUps(effectiveTask.id, executor);
      });
  }

  private async startQueuedContinuation(task: Task): Promise<void> {
    console.log(`[AgentDaemon] Starting queued continuation for task ${task.id}: ${task.title}`);
    const events = this.eventRepo.findByTaskId(task.id);
    if (!this.isTurnLimitContinuationEligible(task, events)) {
      this.taskRepo.update(task.id, {
        status: "failed",
        error:
          "Task can no longer be continued because latest failure is not turn-limit exhaustion.",
        completedAt: Date.now(),
      });
      this.logEvent(task.id, "error", {
        error: "Queued continuation was rejected because latest task error is not turn-limit.",
      });
      await this.queueManager.onTaskFinished(task.id);
      return;
    }

    let effectiveTask: Task;
    let executor: TaskExecutor;
    try {
      ({ effectiveTask, executor } = this.createContinuationExecutor(task, events));
    } catch (error: any) {
      const message = error?.message || String(error);
      this.taskRepo.update(task.id, {
        status: "failed",
        error: message,
        completedAt: Date.now(),
      });
      this.logEvent(task.id, "error", { error: message });
      await this.queueManager.onTaskFinished(task.id);
      return;
    }

    this.activeTasks.set(effectiveTask.id, {
      executor,
      lastAccessed: Date.now(),
      status: "active",
    });

    this.taskRepo.update(effectiveTask.id, {
      status: "executing",
      error: undefined,
      completedAt: undefined,
    });
    this.logEvent(effectiveTask.id, "task_resumed", {
      message: "Continuing task after queue wait (turn-limit continuation)",
    });

    this.launchContinuationExecution(effectiveTask, executor);
  }

  async continueTask(taskId: string): Promise<void> {
    // Guard against double-click: if the task is already running, bail out
    if (this.activeTasks.has(taskId)) {
      console.log(`[AgentDaemon] Task ${taskId} is already active, ignoring continue request`);
      return;
    }

    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (task.status !== "failed") {
      throw new Error(`Task ${taskId} is not in failed status (current: ${task.status})`);
    }
    // Fetch all events for this task
    const events = this.eventRepo.findByTaskId(taskId);
    if (!this.isTurnLimitContinuationEligible(task, events)) {
      throw new Error(
        `Task ${taskId} cannot be continued because it was not stopped by turn-limit exhaustion`,
      );
    }

    const { effectiveTask, executor } = this.createContinuationExecutor(task, events);

    // Register in active tasks map
    this.activeTasks.set(effectiveTask.id, {
      executor,
      lastAccessed: Date.now(),
      status: "active",
    });

    // Register with queue manager for concurrency limits and timeout tracking.
    const canRun = this.queueManager.registerResumedTask(effectiveTask.id);
    if (!canRun) {
      this.activeTasks.delete(effectiveTask.id);
      this.pendingContinuationTaskIds.add(effectiveTask.id);
      this.taskRepo.update(effectiveTask.id, { status: "queued" });
      this.logEvent(effectiveTask.id, "task_queued", {
        reason: "continuation_concurrency",
        message:
          "Queued — concurrency limit reached. Continuation will resume automatically when a slot opens.",
      });
      return;
    }

    // Update status and log continuation
    this.taskRepo.update(effectiveTask.id, {
      status: "executing",
      error: undefined,
      completedAt: undefined,
    });
    this.logEvent(effectiveTask.id, "task_resumed", {
      message: "Continuing task after budget/limit exhaustion",
    });

    this.launchContinuationExecution(effectiveTask, executor);
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
    source?: Task["source"];
  }): Promise<Task> {
    const derived = this.deriveTaskStrategy({
      title: params.title,
      prompt: params.prompt,
      agentConfig: params.agentConfig,
    });
    const task = this.taskRepo.create({
      title: params.title,
      prompt: derived.prompt,
      status: "pending",
      workspaceId: params.workspaceId,
      agentConfig: derived.agentConfig,
      budgetTokens: params.budgetTokens,
      budgetCost: params.budgetCost,
      ...(params.source ? { source: params.source } : {}),
    });
    this.logEvent(task.id, "log", {
      message: `Intent routed: ${derived.route.intent} (${derived.strategy.conversationMode})`,
      confidence: Number(derived.route.confidence.toFixed(2)),
      signals: derived.route.signals,
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
    userPrompt?: string;
    workspaceId: string;
    parentTaskId: string;
    agentType: AgentType;
    agentConfig?: AgentConfig;
    depth?: number;
    assignedAgentRoleId?: string;
    boardColumn?: BoardColumn;
    priority?: number;
    budgetTokens?: number;
    budgetCost?: number;
  }): Promise<Task> {
    const parent = this.taskRepo.findById(params.parentTaskId);
    const parentGatewayContext = parent?.agentConfig?.gatewayContext;
    const childGatewayContext = params.agentConfig?.gatewayContext;
    const parentAutonomousMode = parent?.agentConfig?.autonomousMode === true;
    const mergedAutonomousMode =
      parentAutonomousMode || params.agentConfig?.autonomousMode === true;
    const mergedAllowUserInput = mergedAutonomousMode
      ? false
      : (params.agentConfig?.allowUserInput ?? parent?.agentConfig?.allowUserInput);

    // Prevent privilege escalation: a child task may not become "more private" than its parent.
    const mergedGatewayContext: AgentConfig["gatewayContext"] | undefined = (() => {
      const rank: Record<NonNullable<AgentConfig["gatewayContext"]>, number> = {
        private: 0,
        group: 1,
        public: 2,
      };
      const contexts = [parentGatewayContext, childGatewayContext].filter(
        (value): value is NonNullable<AgentConfig["gatewayContext"]> =>
          value === "private" || value === "group" || value === "public",
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
          const value = typeof raw === "string" ? raw.trim() : "";
          if (!value) continue;
          merged.add(value);
        }
      };
      addAll(parent?.agentConfig?.toolRestrictions);
      addAll(params.agentConfig?.toolRestrictions);
      return merged.size > 0 ? Array.from(merged) : undefined;
    })();

    // Prevent privilege escalation for allow-lists:
    // if both parent and child specify allow-lists, child gets the intersection.
    // if only one side specifies allow-list, keep that scope.
    const allowlistMerge = (() => {
      const normalize = (values: unknown): Set<string> => {
        const set = new Set<string>();
        if (!Array.isArray(values)) return set;
        for (const raw of values) {
          const value = typeof raw === "string" ? raw.trim() : "";
          if (!value) continue;
          set.add(value);
        }
        return set;
      };

      const parentAllowlistRaw = parent?.agentConfig?.allowedTools;
      const childAllowlistRaw = params.agentConfig?.allowedTools;
      const parentAllowed = normalize(parentAllowlistRaw);
      const childAllowed = normalize(childAllowlistRaw);
      const parentHasAllowlist = Array.isArray(parentAllowlistRaw);
      const childHasAllowlist = Array.isArray(childAllowlistRaw);
      const parentAllowsAll = parentAllowed.has("*");
      const childAllowsAll = childAllowed.has("*");

      if (!parentHasAllowlist && !childHasAllowlist) {
        return {
          mergedAllowedTools: undefined as string[] | undefined,
          parentHasAllowlist,
          childHasAllowlist,
          parentAllowsAll,
          childAllowsAll,
          parentAllowlistSize: parentAllowed.size,
          childAllowlistSize: childAllowed.size,
        };
      }
      if (!parentHasAllowlist) {
        return {
          mergedAllowedTools: Array.from(childAllowed),
          parentHasAllowlist,
          childHasAllowlist,
          parentAllowsAll,
          childAllowsAll,
          parentAllowlistSize: parentAllowed.size,
          childAllowlistSize: childAllowed.size,
        };
      }
      if (!childHasAllowlist) {
        return {
          mergedAllowedTools: Array.from(parentAllowed),
          parentHasAllowlist,
          childHasAllowlist,
          parentAllowsAll,
          childAllowsAll,
          parentAllowlistSize: parentAllowed.size,
          childAllowlistSize: childAllowed.size,
        };
      }

      // Handle wildcard semantics before computing concrete intersections.
      // "*" means "allow all", not a literal tool name.
      let mergedAllowedTools: string[];
      if (parentAllowsAll && childAllowsAll) {
        mergedAllowedTools = ["*"];
      } else if (parentAllowsAll) {
        mergedAllowedTools = Array.from(childAllowed).filter((tool) => tool !== "*");
      } else if (childAllowsAll) {
        mergedAllowedTools = Array.from(parentAllowed).filter((tool) => tool !== "*");
      } else {
        mergedAllowedTools = Array.from(childAllowed).filter((tool) => parentAllowed.has(tool));
      }

      return {
        mergedAllowedTools,
        parentHasAllowlist,
        childHasAllowlist,
        parentAllowsAll,
        childAllowsAll,
        parentAllowlistSize: parentAllowed.size,
        childAllowlistSize: childAllowed.size,
      };
    })();
    const mergedAllowedTools = allowlistMerge.mergedAllowedTools;
    if (
      allowlistMerge.parentHasAllowlist &&
      allowlistMerge.childHasAllowlist &&
      Array.isArray(mergedAllowedTools) &&
      mergedAllowedTools.length === 0 &&
      !allowlistMerge.parentAllowsAll &&
      !allowlistMerge.childAllowsAll &&
      allowlistMerge.parentAllowlistSize > 0 &&
      allowlistMerge.childAllowlistSize > 0
    ) {
      throw new Error(
        "Cannot create child task: parent and child tool allow-lists have no overlap.",
      );
    }

    const mergedAgentConfig: AgentConfig | undefined = (() => {
      const next: AgentConfig = params.agentConfig ? { ...params.agentConfig } : {};
      if (mergedGatewayContext) {
        next.gatewayContext = mergedGatewayContext;
      }
      if (mergedToolRestrictions) {
        next.toolRestrictions = mergedToolRestrictions;
      }
      if (mergedAllowedTools) {
        next.allowedTools = mergedAllowedTools;
      }
      if (mergedAutonomousMode !== undefined) {
        next.autonomousMode = mergedAutonomousMode;
      }
      if (mergedAllowUserInput !== undefined) {
        next.allowUserInput = mergedAllowUserInput;
      }
      return Object.keys(next).length > 0 ? next : undefined;
    })();

    const task = this.taskRepo.create({
      title: params.title,
      prompt: params.prompt,
      userPrompt: params.userPrompt,
      status: "pending",
      workspaceId: params.workspaceId,
      parentTaskId: params.parentTaskId,
      agentType: params.agentType,
      agentConfig: mergedAgentConfig,
      depth: params.depth ?? 0,
      budgetTokens: params.budgetTokens,
      budgetCost: params.budgetCost,
    });

    // Apply agent squad metadata before starting so role context is available immediately.
    const initialUpdates: Partial<Task> = {};
    if (
      typeof params.assignedAgentRoleId === "string" &&
      params.assignedAgentRoleId.trim().length > 0
    ) {
      initialUpdates.assignedAgentRoleId = params.assignedAgentRoleId.trim();
    }
    if (typeof params.boardColumn === "string" && params.boardColumn.trim().length > 0) {
      initialUpdates.boardColumn = params.boardColumn as BoardColumn;
    }
    if (typeof params.priority === "number" && Number.isFinite(params.priority)) {
      initialUpdates.priority = params.priority;
    }
    if (Object.keys(initialUpdates).length > 0) {
      this.taskRepo.update(task.id, initialUpdates);
      Object.assign(task, initialUpdates);
    }

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
      lines.push("Steps:");
      const stepLines = plan.steps.slice(0, 7).map((step) => `- ${step.description}`);
      lines.push(...stepLines);
      if (plan.steps.length > 7) {
        lines.push(`- …and ${plan.steps.length - 7} more steps`);
      }
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  private emitActivityEvent(activity: Activity): void {
    const windows = getAllElectronWindows();
    windows.forEach((window) => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, { type: "created", activity });
        }
      } catch (error) {
        console.error("[AgentDaemon] Error sending activity IPC:", error);
      }
    });
  }

  private emitMentionEvent(mention: AgentMention): void {
    const windows = getAllElectronWindows();
    windows.forEach((window) => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.MENTION_EVENT, { type: "created", mention });
        }
      } catch (error) {
        console.error("[AgentDaemon] Error sending mention IPC:", error);
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

    const activeRoles = this.agentRoleRepo.findAll(false).filter((role) => role.isActive);
    const mentionedRoles = activeRoles.filter((role) => mentionedRoleIds.includes(role.id));
    if (mentionedRoles.length === 0) return;

    const existingChildren = this.taskRepo.findByParent(taskId);
    const assignedRoleIds = new Set(
      existingChildren
        .map((child) => child.assignedAgentRoleId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );

    const rolesToDispatch = mentionedRoles.filter((role) => !assignedRoleIds.has(role.id));
    if (rolesToDispatch.length === 0) return;

    const planSummary = this.buildPlanSummary(plan);

    for (const role of rolesToDispatch) {
      const workspacePath = task.workspaceId
        ? this.workspaceRepo.findById(task.workspaceId)?.path
        : undefined;

      const childPrompt = buildAgentDispatchPrompt(
        role,
        { title: task.title, prompt: task.prompt },
        {
          ...(planSummary ? { planSummary } : {}),
          includeRoleDetails: false,
          includeRoleProfile: true,
          workspacePath,
        },
      );
      const childTask = await this.createChildTask({
        title: `@${role.displayName}: ${task.title}`,
        prompt: childPrompt,
        userPrompt: task.prompt,
        workspaceId: task.workspaceId,
        parentTaskId: task.id,
        agentType: "sub",
        assignedAgentRoleId: role.id,
        boardColumn: "todo" as BoardColumn,
        agentConfig: {
          ...(role.providerType ? { providerType: role.providerType } : {}),
          ...(role.modelKey ? { modelKey: role.modelKey } : {}),
          ...(role.personalityId ? { personalityId: role.personalityId } : {}),
          ...(Array.isArray(role.toolRestrictions?.deniedTools) &&
          role.toolRestrictions!.deniedTools.length > 0
            ? { toolRestrictions: role.toolRestrictions!.deniedTools }
            : {}),
          retainMemory: false,
        },
      });

      const dispatchActivity = this.activityRepo.create({
        workspaceId: task.workspaceId,
        taskId: task.id,
        agentRoleId: role.id,
        actorType: "system",
        activityType: "agent_assigned",
        title: `Dispatched to ${role.displayName}`,
        description: childTask.title,
      });
      this.emitActivityEvent(dispatchActivity);

      const mention = this.mentionRepo.create({
        workspaceId: task.workspaceId,
        taskId: task.id,
        toAgentRoleId: role.id,
        mentionType: "request",
        context: `New task: ${task.title}`,
      });
      this.emitMentionEvent(mention);

      const mentionActivity = this.activityRepo.create({
        workspaceId: task.workspaceId,
        taskId: task.id,
        agentRoleId: role.id,
        actorType: "user",
        activityType: "mention",
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
    const existing = this.taskRepo.findById(taskId);
    if (!existing) {
      throw new Error(`Task ${taskId} not found`);
    }
    // Don't clobber terminal states.
    if (
      existing.status === "completed" ||
      existing.status === "failed" ||
      existing.status === "cancelled"
    ) {
      return;
    }
    this.pendingContinuationTaskIds.delete(taskId);

    // Check if task is queued (not yet started)
    if (this.queueManager.cancelQueuedTask(taskId)) {
      this.taskRepo.update(taskId, { status: "cancelled", completedAt: Date.now() });
      this.pendingTaskImages.delete(taskId);
      this.clearRetryState(taskId);
      this.logEvent(taskId, "task_cancelled", {
        message: "Task removed from queue",
      });
      if (this.teamOrchestrator) {
        void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
      }
      // Cascade cancellation to child tasks even for queued parents
      const queuedChildren = this.taskRepo.findByParent(taskId);
      for (const child of queuedChildren) {
        if (
          child.status !== "completed" &&
          child.status !== "failed" &&
          child.status !== "cancelled"
        ) {
          await this.cancelTask(child.id);
        }
      }
      return;
    }

    // Task is running - cancel it
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      await cached.executor.cancel("user");
      this.activeTasks.delete(taskId);
    }

    // Persist cancellation for running tasks too (important for remote clients querying task status).
    this.taskRepo.update(taskId, { status: "cancelled", completedAt: Date.now() });
    if (this.teamOrchestrator) {
      void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
    }

    // Always notify queue manager to remove from running set
    // (handles orphaned tasks that are in runningTaskIds but have no executor)
    this.queueManager.onTaskFinished(taskId);

    // Always emit cancelled event so UI updates
    this.pendingTaskImages.delete(taskId);
    this.clearRetryState(taskId);
    this.logEvent(taskId, "task_cancelled", {
      message: "Task was stopped by user",
    });

    // Cascade cancellation to all child tasks (agent sub-tasks)
    const children = this.taskRepo.findByParent(taskId);
    for (const child of children) {
      if (
        child.status !== "completed" &&
        child.status !== "failed" &&
        child.status !== "cancelled"
      ) {
        await this.cancelTask(child.id);
      }
    }
  }

  /**
   * Wrap up a task gracefully - signal the executor to finish with its current progress.
   * Unlike cancelTask, this produces a "completed" task, not a "cancelled" one.
   */
  async wrapUpTask(taskId: string): Promise<void> {
    const existing = this.taskRepo.findById(taskId);
    if (!existing) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Don't wrap up terminal tasks
    if (
      existing.status === "completed" ||
      existing.status === "failed" ||
      existing.status === "cancelled"
    ) {
      return;
    }
    this.pendingContinuationTaskIds.delete(taskId);

    const cached = this.activeTasks.get(taskId);
    if (cached) {
      await cached.executor.wrapUp();
    } else if (this.queueManager.cancelQueuedTask(taskId)) {
      // Task was queued but hadn't started — no work to preserve, just cancel it
      this.taskRepo.update(taskId, { status: "cancelled", completedAt: Date.now() });
      this.queueManager.onTaskFinished(taskId);
      this.logEvent(taskId, "task_cancelled", {
        message: "Task removed from queue during wrap-up request",
      });
      if (this.teamOrchestrator) {
        void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
      }
    }
  }

  /**
   * Handle transient provider errors by scheduling a retry instead of failing.
   * Returns true if a retry was scheduled, false if retries are exhausted.
   */
  handleTransientTaskFailure(
    taskId: string,
    reason: string,
    delayMs: number = this.retryDelayMs,
  ): boolean {
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
      status: "queued",
      error: queuedError,
    });

    this.logEvent(taskId, "task_queued", {
      reason: "transient_retry",
      message: `⏳ Temporary provider error. Retrying ${nextCount}/${this.maxTaskRetries} in ${retrySeconds}s.`,
    });

    this.logEvent(taskId, "log", {
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
      if (task.status !== "queued") return;
      if (
        this.activeTasks.has(taskId) ||
        this.queueManager.isRunning(taskId) ||
        this.queueManager.isQueued(taskId)
      ) {
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
      cached.status = "active";
      this.updateTaskStatus(taskId, "executing");
      this.logEvent(taskId, "task_resumed", { message: "Task resumed" });
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
  setSessionAutoApproveAll(enabled: boolean): void {
    this.sessionAutoApproveAll = enabled;
    console.log(`[AgentDaemon] Session auto-approve ${enabled ? "ENABLED" : "DISABLED"}`);
  }

  getSessionAutoApproveAll(): boolean {
    return this.sessionAutoApproveAll;
  }

  async requestApproval(
    taskId: string,
    type: string,
    description: string,
    details: any,
  ): Promise<boolean> {
    // Session-level auto-approve (set via "Approve all" UI button)
    if (this.sessionAutoApproveAll) {
      const approval = this.approvalRepo.create({
        taskId,
        type: type as any,
        description,
        details,
        status: "approved",
        requestedAt: Date.now(),
      });
      this.approvalRepo.update(approval.id, "approved");
      this.logEvent(taskId, "approval_requested", {
        approval,
        autoApproved: true,
      });
      this.logEvent(taskId, "approval_granted", {
        approvalId: approval.id,
        autoApproved: true,
        reason: "session_auto_approve",
      });
      return true;
    }

    const task = this.taskRepo.findById(taskId);
    if (task?.agentConfig?.autonomousMode) {
      const approval = this.approvalRepo.create({
        taskId,
        type: type as any,
        description,
        details,
        status: "approved",
        requestedAt: Date.now(),
      });
      this.approvalRepo.update(approval.id, "approved");
      this.logEvent(taskId, "approval_requested", {
        approval,
        autoApproved: true,
      });
      this.logEvent(taskId, "approval_granted", {
        approvalId: approval.id,
        autoApproved: true,
      });
      return true;
    }

    const approval = this.approvalRepo.create({
      taskId,
      type: type as any,
      description,
      details,
      status: "pending",
      requestedAt: Date.now(),
    });

    // Emit event to UI
    this.logEvent(taskId, "approval_requested", { approval });

    // Wait for user response
    return new Promise((resolve, reject) => {
      // Timeout after 5 minutes
      const timeoutHandle = setTimeout(
        () => {
          const pending = this.pendingApprovals.get(approval.id);
          if (pending && !pending.resolved) {
            pending.resolved = true;
            this.pendingApprovals.delete(approval.id);
            this.approvalRepo.update(approval.id, "denied");
            this.logEvent(taskId, "approval_denied", {
              approvalId: approval.id,
              reason: "timeout",
            });
            reject(new Error("Approval request timed out"));
          }
        },
        5 * 60 * 1000,
      );

      this.pendingApprovals.set(approval.id, {
        taskId,
        resolve,
        reject,
        resolved: false,
        timeoutHandle,
      });
    });
  }

  /**
   * Respond to an approval request
   * Uses idempotency to prevent double-approval race conditions
   * Implements C6: Approval Gate Enforcement
   */
  async respondToApproval(
    approvalId: string,
    approved: boolean,
  ): Promise<"handled" | "duplicate" | "not_found" | "in_progress"> {
    // Generate idempotency key for this approval response
    const idempotencyKey = IdempotencyManager.generateKey(
      "approval:respond",
      approvalId,
      approved ? "approve" : "deny",
    );

    // Check if this exact response was already processed
    const existing = approvalIdempotency.check(idempotencyKey);
    if (existing.exists) {
      console.log(`[AgentDaemon] Duplicate approval response ignored: ${approvalId}`);
      return "duplicate";
    }

    // Start tracking this operation
    if (!approvalIdempotency.start(idempotencyKey)) {
      console.log(`[AgentDaemon] Concurrent approval response in progress: ${approvalId}`);
      return "in_progress";
    }

    try {
      const pending = this.pendingApprovals.get(approvalId);
      if (pending && !pending.resolved) {
        // Mark as resolved first to prevent race condition with timeout
        pending.resolved = true;

        // Clear the timeout
        clearTimeout(pending.timeoutHandle);

        this.pendingApprovals.delete(approvalId);
        this.approvalRepo.update(approvalId, approved ? "approved" : "denied");

        // Emit event so UI knows the approval has been handled
        const eventType = approved ? "approval_granted" : "approval_denied";
        this.logEvent(pending.taskId, eventType, { approvalId });

        if (approved) {
          pending.resolve(true);
        } else {
          pending.reject(new Error("User denied approval"));
        }

        approvalIdempotency.complete(idempotencyKey, { success: true, status: "handled" });
        return "handled";
      }

      approvalIdempotency.complete(idempotencyKey, { success: true, status: "not_found" });
      return "not_found";
    } catch (error) {
      approvalIdempotency.fail(idempotencyKey, error);
      throw error;
    }
  }

  /**
   * Log an event for a task
   */
  logEvent(taskId: string, type: string, payload: any): void {
    // Streaming progress events are ephemeral UI state (~3/sec).
    // Skip DB persistence, activity logging, and memory capture.
    if (type === "llm_streaming") {
      this.emitTaskEvent(taskId, type, payload);
      // Forward streaming progress to collaborative/multi-LLM thought panel
      this.maybeEmitTeamStreamingProgress(taskId, payload);
      return;
    }

    this.eventRepo.create({
      taskId,
      timestamp: Date.now(),
      type: type as any,
      payload,
    });
    this.logActivityForEvent(taskId, type, payload);
    this.emitTaskEvent(taskId, type, payload);

    // Capture agent thoughts for collaborative team runs
    const teamThoughtEventTypes = new Set([
      "assistant_message",
      "tool_call",
      "step_completed",
      "file_created",
      "file_modified",
    ]);
    if (teamThoughtEventTypes.has(type)) {
      this.maybeEmitTeamThought(taskId, type, payload);
    }

    // Capture to memory system (async, don't block)
    this.captureToMemory(taskId, type, payload).catch((error) => {
      // Silently log - memory capture is optional enhancement
      console.debug("[AgentDaemon] Memory capture failed:", error);
    });
  }

  /**
   * Check if a task event from a sub-agent task should be captured as a
   * collaborative thought for its team run.
   */
  private maybeEmitTeamThought(taskId: string, eventType: string, payload: any): void {
    if (!this.teamOrchestrator) return;

    const task = this.taskRepo.findById(taskId);
    if (!task || !task.parentTaskId) return;

    const thoughtRepo = this.teamOrchestrator.getThoughtRepo();
    if (!thoughtRepo) return;

    const db = this.dbManager.getDatabase();
    const itemRepo = new AgentTeamItemRepository(db);
    const runRepo = new AgentTeamRunRepository(db);

    // Primary path: look up the team item linked to this child task
    let items = itemRepo.listBySourceTaskId(taskId);
    let run: AgentTeamRun | undefined;
    let teamItem: AgentTeamItem | undefined;

    if (items.length > 0) {
      teamItem = items[0];
      run = runRepo.findById(teamItem.teamRunId);
    }

    // Fallback: if no item found yet (race with sourceTaskId assignment),
    // try to find the run via the parent task (root task of the team run)
    if (!run && task.parentTaskId) {
      run = runRepo.findByRootTaskId(task.parentTaskId) || undefined;
      if (run) {
        // Find any item in this run to attach the thought to
        const runItems = itemRepo.listByRun(run.id);
        teamItem = runItems.find((i) => i.sourceTaskId === taskId) || runItems[0];
      }
    }

    if (!run || !run.collaborativeMode) return;

    // Capture thoughts during think, dispatch, and synthesize phases
    const phase = run.phase || "dispatch";
    if (phase !== "think" && phase !== "dispatch" && phase !== "synthesize") return;

    // Extract content based on event type
    let content = "";
    switch (eventType) {
      case "assistant_message":
        content =
          typeof payload?.message === "string" ? payload.message : String(payload?.content || "");
        break;
      case "tool_call":
        content = payload?.tool ? `🔧 Using tool: ${payload.tool}` : "";
        break;
      case "step_completed":
        content = payload?.step?.description
          ? `✅ Step completed: ${payload.step.description}`
          : "";
        break;
      case "file_created":
        content = payload?.path ? `📄 Created: ${payload.path}` : "";
        break;
      case "file_modified":
        content = payload?.path ? `✏️ Modified: ${payload.path}` : "";
        break;
      default:
        content = typeof payload?.message === "string" ? payload.message : "";
    }
    if (!content.trim()) return;

    // Determine agent identity based on mode
    let agentRoleId: string;
    let agentDisplayName: string;
    let agentIcon: string;
    let agentColor: string;

    if (run.multiLlmMode) {
      // Multi-LLM mode: derive identity from task's provider config
      const providerType = task.agentConfig?.providerType || "unknown";
      const modelKey = task.agentConfig?.modelKey || "default";
      const providerInfo = MULTI_LLM_PROVIDER_DISPLAY[providerType];
      agentRoleId = `multi-llm-${providerType}-${modelKey}`;
      agentDisplayName = providerInfo
        ? `${providerInfo.name} (${modelKey})`
        : `${providerType} (${modelKey})`;
      agentIcon = providerInfo?.icon || "\u{1F916}";
      agentColor = providerInfo?.color || "#6366f1";
    } else {
      // Standard collaborative mode: use agent role
      if (!task.assignedAgentRoleId) return;
      const role = this.agentRoleRepo.findById(task.assignedAgentRoleId);
      if (!role) return;
      agentRoleId = role.id;
      agentDisplayName = role.displayName;
      agentIcon = role.icon;
      agentColor = role.color;
    }

    try {
      const thought = thoughtRepo.create({
        teamRunId: run.id,
        teamItemId: teamItem?.id,
        agentRoleId,
        agentDisplayName,
        agentIcon,
        agentColor,
        phase: phase === "think" ? "analysis" : phase === "synthesize" ? "synthesis" : "dispatch",
        content: content.trim(),
        sourceTaskId: taskId,
      });

      // Emit to UI
      this.emitTeamThoughtEvent({
        type: "team_thought_added",
        timestamp: Date.now(),
        runId: run.id,
        thought,
      });
    } catch (error: any) {
      console.error("[AgentDaemon] Team thought capture failed:", error?.message);
    }
  }

  /**
   * Broadcast a team thought event to all renderer windows.
   */
  private emitTeamThoughtEvent(event: TeamThoughtEvent): void {
    const windows = getAllElectronWindows();
    windows.forEach((window) => {
      try {
        if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.TEAM_THOUGHT_EVENT, event);
        }
      } catch {
        // ignore
      }
    });
  }

  /**
   * Forward streaming progress from a child task to the collaborative/multi-LLM
   * thought panel as an ephemeral streaming indicator (no DB write).
   */
  private maybeEmitTeamStreamingProgress(taskId: string, payload: any): void {
    if (!this.teamOrchestrator) return;

    const task = this.taskRepo.findById(taskId);
    if (!task || !task.parentTaskId) return;

    const db = this.dbManager.getDatabase();
    const itemRepo = new AgentTeamItemRepository(db);
    const runRepo = new AgentTeamRunRepository(db);

    // Find the run this child task belongs to
    let items = itemRepo.listBySourceTaskId(taskId);
    let run: AgentTeamRun | undefined;

    if (items.length > 0) {
      run = runRepo.findById(items[0].teamRunId);
    }

    // Fallback: look up via parent task
    if (!run && task.parentTaskId) {
      run = runRepo.findByRootTaskId(task.parentTaskId) || undefined;
    }

    if (!run || !run.collaborativeMode) return;

    // Only emit during think/dispatch phases (not synthesis)
    const phase = run.phase || "dispatch";
    if (phase !== "think" && phase !== "dispatch") return;

    // Derive agent identity
    let agentRoleId: string;
    let agentDisplayName: string;
    let agentIcon: string;
    let agentColor: string;

    if (run.multiLlmMode) {
      const providerType = task.agentConfig?.providerType || "unknown";
      const modelKey = task.agentConfig?.modelKey || "default";
      const providerInfo = MULTI_LLM_PROVIDER_DISPLAY[providerType];
      agentRoleId = `multi-llm-${providerType}-${modelKey}`;
      agentDisplayName = providerInfo
        ? `${providerInfo.name} (${modelKey})`
        : `${providerType} (${modelKey})`;
      agentIcon = providerInfo?.icon || "\u{1F916}";
      agentColor = providerInfo?.color || "#6366f1";
    } else {
      if (!task.assignedAgentRoleId) return;
      const role = this.agentRoleRepo.findById(task.assignedAgentRoleId);
      if (!role) return;
      agentRoleId = role.id;
      agentDisplayName = role.displayName;
      agentIcon = role.icon;
      agentColor = role.color;
    }

    const outputTokens = payload?.outputTokens ?? 0;
    const elapsedMs = payload?.elapsedMs ?? 0;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    const streaming = payload?.streaming !== false;

    // Build a synthetic (ephemeral) thought — not persisted to DB
    const syntheticThought = {
      id: `streaming-${taskId}`,
      teamRunId: run.id,
      agentRoleId,
      agentDisplayName,
      agentIcon,
      agentColor,
      phase: "analysis" as const,
      content: streaming
        ? `Generating response... (${outputTokens} tokens, ${elapsedSec}s)`
        : `Response complete (${outputTokens} tokens, ${elapsedSec}s)`,
      isStreaming: streaming,
      sourceTaskId: taskId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.emitTeamThoughtEvent({
      type: "team_thought_streaming",
      timestamp: Date.now(),
      runId: run.id,
      thought: syntheticThought as any,
    });
  }

  /**
   * Capture task event to memory system for cross-session context
   */
  private async captureToMemory(taskId: string, type: string, payload: any): Promise<void> {
    // Map event types to memory types
    const memoryTypeMap: Record<string, MemoryType> = {
      tool_call: "observation",
      tool_result: "observation",
      tool_error: "error",
      step_started: "observation",
      step_completed: "observation",
      step_failed: "error",
      assistant_message: "observation",
      user_message: "observation",
      user_feedback: "decision",
      plan_created: "decision",
      plan_revised: "decision",
      error: "error",
      verification_passed: "insight",
      verification_failed: "error",
      file_created: "observation",
      file_modified: "observation",
    };

    const memoryType = memoryTypeMap[type];
    if (!memoryType) return;

    const task = this.taskRepo.findById(taskId);
    if (!task) return;

    // Memory retention:
    // - Sub-agents (child tasks) default to retainMemory=false to avoid leaking sensitive
    //   private context into disposable agents.
    // - Shared gateway contexts (group/public) must never contribute injectable memories.
    const isSubAgentTask = (task.agentType ?? "main") === "sub" || !!task.parentTaskId;
    const retainMemory = task.agentConfig?.retainMemory ?? !isSubAgentTask;
    if (!retainMemory) return;
    const gatewayContext = task.agentConfig?.gatewayContext;
    const isSharedGatewayContext = gatewayContext === "group" || gatewayContext === "public";
    const allowProfileIngest =
      !isSharedGatewayContext || task.agentConfig?.allowSharedContextMemory === true;
    if (allowProfileIngest) {
      if (type === "user_message") {
        const text =
          (typeof payload?.message === "string" ? payload.message : "") ||
          (typeof payload?.content === "string" ? payload.content : "");
        if (text) {
          UserProfileService.ingestUserMessage(text, taskId);

          // Mid-conversation correction detection: capture when the user corrects the agent.
          if (taskId && task.workspaceId && detectsCorrection(text)) {
            try {
              const correctionContent = [
                `[CORRECTION] User corrected agent during task "${task.title || taskId}"`,
                `User said: ${text.slice(0, 300)}`,
                `Task context: ${(task.prompt || "").slice(0, 200)}`,
              ].join("\n");
              MemoryService.capture(task.workspaceId, taskId, "insight", correctionContent).catch(
                () => {},
              );

              PlaybookService.captureOutcome(
                task.workspaceId,
                taskId,
                task.title || "unknown",
                task.prompt || "",
                "failure",
                "Agent approach was corrected by user mid-task",
                [],
                `[CORRECTION] ${text.slice(0, 200)}`,
              ).catch(() => {});
            } catch {
              // best-effort
            }
          }
        }
      } else if (type === "user_feedback") {
        UserProfileService.ingestUserFeedback(
          typeof payload?.decision === "string" ? payload.decision : undefined,
          typeof payload?.reason === "string" ? payload.reason : undefined,
          taskId,
        );
      }
    }
    if (isSharedGatewayContext && task.agentConfig?.allowSharedContextMemory !== true) {
      return;
    }

    // Build content string based on event type
    let content = "";
    if (type === "tool_call") {
      content = `Tool called: ${payload.tool || payload.name}\nInput: ${JSON.stringify(payload.input, null, 2)}`;
    } else if (type === "tool_result") {
      const result =
        typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result);
      content = `Tool result for ${payload.tool || payload.name}:\n${result}`;
    } else if (type === "tool_error") {
      content = `Tool error for ${payload.tool || payload.name}: ${payload.error}`;
    } else if (type === "assistant_message") {
      content = payload.content || payload.message || JSON.stringify(payload);
    } else if (type === "user_message") {
      content = payload.message || payload.content || JSON.stringify(payload);
    } else if (type === "user_feedback") {
      const decision = payload?.decision ? `Decision: ${payload.decision}` : "Feedback received";
      const reason = payload?.reason ? `\nReason: ${payload.reason}` : "";
      content = `${decision}${reason}`;
    } else if (type === "plan_created" || type === "plan_revised") {
      content = `Plan ${type === "plan_revised" ? "revised" : "created"}:\n${JSON.stringify(payload.plan || payload, null, 2)}`;
    } else if (type === "step_completed") {
      content = `Step completed: ${payload.step?.description || JSON.stringify(payload)}`;
    } else if (type === "step_failed") {
      content = `Step failed: ${payload.step?.description || ""}\nError: ${payload.error || "Unknown error"}`;
    } else if (type === "file_created" || type === "file_modified") {
      content = `File ${type === "file_created" ? "created" : "modified"}: ${payload.path}`;
    } else if (type === "verification_passed") {
      content = `Verification passed: ${payload.message || "Task completed successfully"}`;
    } else if (type === "verification_failed") {
      content = `Verification failed: ${payload.message || payload.error || "Unknown failure"}`;
    } else {
      content = JSON.stringify(payload);
    }

    // Truncate very long content
    if (content.length > 5000) {
      content = content.slice(0, 5000) + "\n[... truncated]";
    }

    const forcePrivate = gatewayContext === "group" || gatewayContext === "public";
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

      if (lastTime && now - lastTime < ACTIVITY_THROTTLE_WINDOW_MS) {
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

  private buildActivityFromEvent(
    task: Task,
    type: string,
    payload: any,
  ): CreateActivityRequest | undefined {
    const actorType: ActivityActorType = task.assignedAgentRoleId ? "agent" : "system";
    const agentRoleId = task.assignedAgentRoleId;
    const activityType = type as ActivityType;

    switch (type) {
      case "task_created":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "Task created",
          description: task.title,
        };
      case "task_completed":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "Task completed",
          description: task.title,
        };
      case "executing":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "task_started",
          title: "Task started",
          description: task.title,
        };
      case "task_cancelled":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Task cancelled",
          description: task.title,
        };
      case "task_paused":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "Task paused",
          description: task.title,
        };
      case "task_resumed":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "Task resumed",
          description: task.title,
        };
      case "approval_requested":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Approval requested",
          description: payload?.approval?.description || task.title,
        };
      case "approval_granted":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Approval granted",
          description: task.title,
        };
      case "approval_denied":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Approval denied",
          description: payload?.reason || task.title,
        };
      case "error":
      case "step_failed":
      case "verification_failed":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "error",
          title: type === "error" ? "Task error" : "Execution issue",
          description:
            payload?.error || payload?.message || payload?.step?.description || task.title,
        };
      case "verification_passed":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "info",
          title: "Verification passed",
          description: payload?.message || task.title,
        };
      case "file_created":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "File created",
          description: payload?.path || task.title,
        };
      case "file_modified":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "File modified",
          description: payload?.path || task.title,
        };
      case "file_deleted":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType,
          title: "File deleted",
          description: payload?.path || task.title,
        };
      case "tool_call":
        return {
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId,
          actorType,
          activityType: "tool_used",
          title: "Tool used",
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
      const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");

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
    const windows = getAllElectronWindows();
    windows.forEach((window) => {
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
  updateTaskStatus(taskId: string, status: Task["status"]): void {
    const existing = this.taskRepo.findById(taskId);
    this.taskRepo.update(taskId, { status });
    if (status === "completed" || status === "failed" || status === "cancelled") {
      this.clearRetryState(taskId);
      if (this.teamOrchestrator && existing?.status !== status) {
        void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
      }
    }
  }

  /**
   * Get agent role by ID
   */
  getAgentRoleById(agentRoleId: string): AgentRole | undefined {
    return this.agentRoleRepo.findById(agentRoleId);
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.taskRepo.findById(taskId);
  }

  getTaskEvents(taskId: string, options?: { limit?: number; types?: string[] }): TaskEvent[] {
    const all = this.eventRepo.findByTaskId(taskId);
    const normalizedTypes = (options?.types || [])
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter(Boolean);
    const filtered =
      normalizedTypes.length > 0
        ? all.filter((event) => normalizedTypes.includes(event.type))
        : all;
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.min(Math.max(options.limit, 1), 200)
        : undefined;
    if (typeof limit !== "number") {
      return filtered;
    }
    // Return the most recent events, preserving chronological order.
    return filtered.slice(Math.max(filtered.length - limit, 0));
  }

  /**
   * Query recent task history across the local database.
   * Intended for answering questions like "what did we talk about yesterday?".
   *
   * Note: This is intentionally read-only and returns truncated text to avoid huge payloads.
   */
  queryTaskHistory(params: {
    period: "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";
    from?: string | number;
    to?: string | number;
    limit?: number;
    workspaceId?: string;
    query?: string;
    includeMessages?: boolean;
  }):
    | {
        success: true;
        period: string;
        range: { startMs: number; endMs: number; startIso: string; endIso: string };
        tasks: any[];
      }
    | { success: false; error: string } {
    try {
      const period = params?.period;
      if (!period) {
        return { success: false, error: "Missing required field: period" };
      }

      const clampLimit = (value: unknown): number => {
        const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 20;
        return Math.min(Math.max(n, 1), 50);
      };

      const truncate = (value: unknown, maxChars: number): string => {
        const s = typeof value === "string" ? value : "";
        if (!s) return "";
        if (s.length <= maxChars) return s;
        return s.slice(0, maxChars) + "…";
      };

      const now = new Date();
      const startOfDayMs = (d: Date): number =>
        new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

      const parseTime = (v: unknown): number | null => {
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v !== "string") return null;
        const raw = v.trim();
        if (!raw) return null;
        const dt = new Date(raw);
        const ms = dt.getTime();
        return Number.isFinite(ms) ? ms : null;
      };

      const nowMs = now.getTime();
      const todayStart = startOfDayMs(now);

      let startMs: number;
      let endMs: number;

      switch (period) {
        case "today": {
          startMs = todayStart;
          endMs = todayStart + 24 * 60 * 60 * 1000;
          break;
        }
        case "yesterday": {
          endMs = todayStart;
          startMs = endMs - 24 * 60 * 60 * 1000;
          break;
        }
        case "last_7_days": {
          startMs = nowMs - 7 * 24 * 60 * 60 * 1000;
          endMs = nowMs;
          break;
        }
        case "last_30_days": {
          startMs = nowMs - 30 * 24 * 60 * 60 * 1000;
          endMs = nowMs;
          break;
        }
        case "custom": {
          const fromMs = parseTime(params?.from);
          const toMs = parseTime(params?.to);
          if (fromMs != null && toMs != null) {
            startMs = fromMs;
            endMs = toMs;
          } else if (fromMs != null) {
            startMs = fromMs;
            endMs = nowMs;
          } else if (toMs != null) {
            endMs = toMs;
            startMs = endMs - 24 * 60 * 60 * 1000;
          } else {
            startMs = nowMs - 7 * 24 * 60 * 60 * 1000;
            endMs = nowMs;
          }
          break;
        }
        default: {
          return { success: false, error: `Unsupported period: ${String(period)}` };
        }
      }

      // Guard against inverted ranges.
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return { success: false, error: "Invalid time range" };
      }

      const limit = clampLimit(params?.limit);
      const workspaceId =
        typeof params?.workspaceId === "string" ? params.workspaceId.trim() : undefined;
      const query = typeof params?.query === "string" ? params.query.trim() : undefined;
      const includeMessages = params?.includeMessages !== false;

      const tasks = this.taskRepo.findByCreatedAtRange({
        startMs,
        endMs,
        limit,
        workspaceId,
        query,
      });

      const taskIds = tasks.map((t) => t.id);
      const messageEvents =
        includeMessages && taskIds.length > 0
          ? this.eventRepo.findByTaskIds(taskIds, ["assistant_message", "user_message"])
          : [];

      const lastAssistant = new Map<string, string>();
      const lastUser = new Map<string, string>();
      for (const evt of messageEvents) {
        const msg = (evt.payload as any)?.message ?? (evt.payload as any)?.content;
        const text = typeof msg === "string" ? msg : "";
        if (!text) continue;
        if (evt.type === "assistant_message") lastAssistant.set(evt.taskId, truncate(text, 900));
        if (evt.type === "user_message") lastUser.set(evt.taskId, truncate(text, 900));
      }

      const items = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        workspaceId: t.workspaceId,
        createdAtMs: t.createdAt,
        createdAtIso: new Date(t.createdAt).toISOString(),
        prompt: truncate(t.prompt, 700),
        lastUserMessage: includeMessages ? lastUser.get(t.id) : undefined,
        lastAssistantMessage: includeMessages ? lastAssistant.get(t.id) : undefined,
      }));

      return {
        success: true,
        period,
        range: {
          startMs,
          endMs,
          startIso: new Date(startMs).toISOString(),
          endIso: new Date(endMs).toISOString(),
        },
        tasks: items,
      };
    } catch (error: any) {
      return { success: false, error: error?.message ? String(error.message) : String(error) };
    }
  }

  /**
   * Query task event logs from the local database (tool calls/results, messages, feedback, file ops).
   * This is privacy-sensitive and may be blocked in shared gateway contexts.
   */
  queryTaskEvents(params: {
    period: "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";
    from?: string | number;
    to?: string | number;
    limit?: number;
    workspaceId?: string;
    types?: string[];
    includePayload?: boolean;
  }):
    | {
        success: true;
        period: string;
        range: { startMs: number; endMs: number; startIso: string; endIso: string };
        stats: any;
        events: any[];
      }
    | { success: false; error: string } {
    try {
      const period = params?.period;
      if (!period) {
        return { success: false, error: "Missing required field: period" };
      }

      const clampLimit = (value: unknown): number => {
        const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 200;
        return Math.min(Math.max(n, 1), 500);
      };

      const truncate = (value: unknown, maxChars: number): string => {
        const s = typeof value === "string" ? value : "";
        if (!s) return "";
        if (s.length <= maxChars) return s;
        return s.slice(0, maxChars) + "…";
      };

      const now = new Date();
      const startOfDayMs = (d: Date): number =>
        new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

      const parseTime = (v: unknown): number | null => {
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v !== "string") return null;
        const raw = v.trim();
        if (!raw) return null;
        const dt = new Date(raw);
        const ms = dt.getTime();
        return Number.isFinite(ms) ? ms : null;
      };

      const nowMs = now.getTime();
      const todayStart = startOfDayMs(now);

      let startMs: number;
      let endMs: number;

      switch (period) {
        case "today": {
          startMs = todayStart;
          endMs = todayStart + 24 * 60 * 60 * 1000;
          break;
        }
        case "yesterday": {
          endMs = todayStart;
          startMs = endMs - 24 * 60 * 60 * 1000;
          break;
        }
        case "last_7_days": {
          startMs = nowMs - 7 * 24 * 60 * 60 * 1000;
          endMs = nowMs;
          break;
        }
        case "last_30_days": {
          startMs = nowMs - 30 * 24 * 60 * 60 * 1000;
          endMs = nowMs;
          break;
        }
        case "custom": {
          const fromMs = parseTime(params?.from);
          const toMs = parseTime(params?.to);
          if (fromMs != null && toMs != null) {
            startMs = fromMs;
            endMs = toMs;
          } else if (fromMs != null) {
            startMs = fromMs;
            endMs = nowMs;
          } else if (toMs != null) {
            endMs = toMs;
            // Default to last hour when only end is provided (used by scheduled digests).
            startMs = endMs - 60 * 60 * 1000;
          } else {
            // Default to last hour for custom when no bounds provided.
            startMs = nowMs - 60 * 60 * 1000;
            endMs = nowMs;
          }
          break;
        }
        default: {
          return { success: false, error: `Unsupported period: ${String(period)}` };
        }
      }

      // Guard against inverted ranges.
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return { success: false, error: "Invalid time range" };
      }

      const limit = clampLimit(params?.limit);
      const workspaceId = typeof params?.workspaceId === "string" ? params.workspaceId.trim() : "";
      const workspaceFilter = workspaceId.length > 0 ? workspaceId : undefined;
      const normalizedTypes = Array.isArray(params?.types)
        ? params.types
            .map((t) => (typeof t === "string" ? t.trim() : ""))
            .filter(Boolean)
            .slice(0, 50)
        : [];
      const includePayload = params?.includePayload !== false;

      const db = this.dbManager.getDatabase();

      let sql = `
        SELECT
          e.id as id,
          e.task_id as taskId,
          e.timestamp as timestamp,
          e.type as type,
          e.payload as payload,
          t.title as taskTitle,
          t.workspace_id as workspaceId
        FROM task_events e
        JOIN tasks t ON t.id = e.task_id
        WHERE e.timestamp >= ? AND e.timestamp < ?
      `;

      const args: any[] = [startMs, endMs];
      if (workspaceFilter) {
        sql += " AND t.workspace_id = ?";
        args.push(workspaceFilter);
      }
      if (normalizedTypes.length > 0) {
        const placeholders = normalizedTypes.map(() => "?").join(", ");
        sql += ` AND e.type IN (${placeholders})`;
        args.push(...normalizedTypes);
      }

      sql += " ORDER BY e.timestamp ASC LIMIT ?";
      args.push(limit);

      const rows = db.prepare(sql).all(...args) as Array<{
        id: string;
        taskId: string;
        timestamp: number;
        type: string;
        payload: string;
        taskTitle: string;
        workspaceId: string;
      }>;

      const byType: Record<string, number> = {};
      const toolCallsByName: Record<string, number> = {};
      const feedbackByDecision: Record<string, number> = {};
      const tasksTouched = new Set<string>();
      let assistantMessages = 0;
      let userMessages = 0;
      let toolCalls = 0;
      let toolErrors = 0;
      let filesCreated = 0;
      let filesModified = 0;
      let filesDeleted = 0;

      const parseJson = (raw: unknown): any => {
        if (typeof raw !== "string" || !raw) return {};
        try {
          const obj = JSON.parse(raw);
          return obj && typeof obj === "object" ? obj : {};
        } catch {
          return {};
        }
      };

      const compactPayloadPreview = (payload: any): string => {
        if (!payload || typeof payload !== "object") return "";
        const keys = Object.keys(payload).slice(0, 12);
        const preview: Record<string, any> = {};
        for (const k of keys) {
          const v = (payload as any)[k];
          if (typeof v === "string") preview[k] = truncate(v, 260);
          else if (typeof v === "number" || typeof v === "boolean") preview[k] = v;
          else if (v && typeof v === "object") preview[k] = "[object]";
          else preview[k] = v;
        }
        const rendered = JSON.stringify(preview);
        return truncate(rendered, 520);
      };

      const summarizeEvent = (type: string, payload: any): string => {
        switch (type) {
          case "tool_call": {
            const tool = (payload?.tool || payload?.name || "").toString();
            return tool ? `Tool call: ${tool}` : "Tool call";
          }
          case "tool_result": {
            const tool = (payload?.tool || payload?.name || "").toString();
            return tool ? `Tool result: ${tool}` : "Tool result";
          }
          case "tool_error": {
            const tool = (payload?.tool || payload?.name || "").toString();
            const err = typeof payload?.error === "string" ? payload.error : "";
            return truncate(
              tool
                ? `Tool error: ${tool}${err ? ` - ${err}` : ""}`
                : `Tool error${err ? ` - ${err}` : ""}`,
              520,
            );
          }
          case "assistant_message": {
            const text =
              (typeof payload?.message === "string" ? payload.message : "") ||
              (typeof payload?.content === "string" ? payload.content : "");
            return text ? `Assistant: ${truncate(text, 260)}` : "Assistant message";
          }
          case "user_message": {
            const text =
              (typeof payload?.message === "string" ? payload.message : "") ||
              (typeof payload?.content === "string" ? payload.content : "");
            return text ? `User: ${truncate(text, 260)}` : "User message";
          }
          case "user_feedback": {
            const decision = typeof payload?.decision === "string" ? payload.decision : "";
            const reason = typeof payload?.reason === "string" ? payload.reason : "";
            return truncate(
              `Feedback: ${decision || "unknown"}${reason ? ` - ${reason}` : ""}`,
              520,
            );
          }
          case "file_created":
          case "file_modified":
          case "file_deleted": {
            const p = typeof payload?.path === "string" ? payload.path : "";
            return p ? `${type.replace("_", " ")}: ${truncate(p, 320)}` : type.replace("_", " ");
          }
          case "step_started":
          case "step_completed":
          case "step_failed": {
            const desc =
              typeof payload?.step?.description === "string" ? payload.step.description : "";
            const err = typeof payload?.error === "string" ? payload.error : "";
            const base = desc ? `${type.replace("_", " ")}: ${desc}` : type.replace("_", " ");
            return truncate(err ? `${base} - ${err}` : base, 520);
          }
          default: {
            return type;
          }
        }
      };

      const events = rows.map((row) => {
        tasksTouched.add(row.taskId);
        byType[row.type] = (byType[row.type] || 0) + 1;

        const payloadObj = parseJson(row.payload);

        if (row.type === "assistant_message") assistantMessages += 1;
        if (row.type === "user_message") userMessages += 1;
        if (row.type === "tool_call") {
          toolCalls += 1;
          const tool = (payloadObj?.tool || payloadObj?.name || "").toString().trim();
          if (tool) {
            toolCallsByName[tool] = (toolCallsByName[tool] || 0) + 1;
          }
        }
        if (row.type === "tool_error") toolErrors += 1;

        if (row.type === "file_created") filesCreated += 1;
        if (row.type === "file_modified") filesModified += 1;
        if (row.type === "file_deleted") filesDeleted += 1;

        if (row.type === "user_feedback") {
          const decision =
            typeof payloadObj?.decision === "string" ? payloadObj.decision.trim() : "unknown";
          const key = decision || "unknown";
          feedbackByDecision[key] = (feedbackByDecision[key] || 0) + 1;
        }

        return {
          id: row.id,
          taskId: row.taskId,
          taskTitle: row.taskTitle,
          workspaceId: row.workspaceId,
          timestampMs: row.timestamp,
          timestampIso: new Date(row.timestamp).toISOString(),
          type: row.type,
          summary: summarizeEvent(row.type, payloadObj),
          ...(includePayload ? { payloadPreview: compactPayloadPreview(payloadObj) } : {}),
        };
      });

      // Sort tools by usage desc, keep top 30 for readability.
      const toolsUsed = Object.entries(toolCallsByName)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 30)
        .reduce(
          (acc, [k, v]) => {
            acc[k] = v;
            return acc;
          },
          {} as Record<string, number>,
        );

      const stats = {
        totalEvents: rows.length,
        tasksTouched: tasksTouched.size,
        byType,
        messageCounts: {
          user: userMessages,
          assistant: assistantMessages,
        },
        toolCalls: {
          total: toolCalls,
          errors: toolErrors,
          byTool: toolsUsed,
        },
        fileOps: {
          created: filesCreated,
          modified: filesModified,
          deleted: filesDeleted,
        },
        feedback: {
          byDecision: feedbackByDecision,
        },
      };

      return {
        success: true,
        period,
        range: {
          startMs,
          endMs,
          startIso: new Date(startMs).toISOString(),
          endIso: new Date(endMs).toISOString(),
        },
        stats,
        events,
      };
    } catch (error: any) {
      return { success: false, error: error?.message ? String(error.message) : String(error) };
    }
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
   * Update workspace permissions and return the refreshed workspace.
   */
  updateWorkspacePermissions(
    workspaceId: string,
    patch: Partial<WorkspacePermissions>,
  ): Workspace | undefined {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) return undefined;
    const updatedPermissions: WorkspacePermissions = {
      ...workspace.permissions,
      ...patch,
    };
    this.workspaceRepo.updatePermissions(workspaceId, updatedPermissions);
    return this.workspaceRepo.findById(workspaceId);
  }

  /**
   * Get the most recently used non-temporary workspace, if any.
   */
  getMostRecentNonTempWorkspace(): Workspace | undefined {
    const workspaces = this.workspaceRepo.findAll();
    return workspaces.find(
      (workspace) =>
        !isTempWorkspaceId(workspace.id) &&
        !workspace.isTemp &&
        typeof workspace.path === "string" &&
        workspace.path.trim().length > 0,
    );
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
   * Update task fields (for retry/verification attempt tracking, etc.)
   */
  updateTask(
    taskId: string,
    updates: Partial<Pick<Task, "currentAttempt" | "status" | "error" | "completedAt">>,
  ): void {
    const existing = this.taskRepo.findById(taskId);
    this.taskRepo.update(taskId, updates);
    if (
      updates.status === "completed" ||
      updates.status === "failed" ||
      updates.status === "cancelled"
    ) {
      this.clearRetryState(taskId);
      if (this.teamOrchestrator && existing?.status !== updates.status) {
        void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
      }
    }
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
    const existingTask = this.taskRepo.findById(taskId);
    if (!existingTask) {
      console.warn(`[AgentDaemon] completeTask called for unknown task ${taskId}`);
      return;
    }
    const updates: Partial<Task> = {
      status: "completed",
      completedAt: Date.now(),
      // Clear any previous error so completed tasks don't display stale failure state.
      error: null,
    };
    if (typeof resultSummary === "string" && resultSummary.trim().length > 0) {
      updates.resultSummary = resultSummary.trim();
    }
    this.taskRepo.update(taskId, updates);
    this.clearRetryState(taskId);
    // Mark executor as completed for TTL-based cleanup
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.status = "completed";
      cached.lastAccessed = Date.now();
    }
    this.logEvent(taskId, "task_completed", {
      message: "Task completed successfully",
      ...(updates.resultSummary ? { resultSummary: updates.resultSummary } : {}),
    });

    // === WORKTREE AUTO-COMMIT ===
    // If the task has an active worktree, auto-commit changes on completion.
    if (existingTask?.worktreeStatus === "active" && existingTask.worktreePath) {
      const worktreeSettings = this.worktreeManager.getSettings();
      if (worktreeSettings.autoCommitOnComplete) {
        void (async () => {
          try {
            this.taskRepo.update(taskId, { worktreeStatus: "committing" });
            const commitResult = await this.worktreeManager.commitTaskChanges(
              taskId,
              `${worktreeSettings.commitMessagePrefix}${existingTask.title}`,
            );
            if (commitResult) {
              this.logEvent(taskId, "worktree_committed", {
                sha: commitResult.sha,
                filesChanged: commitResult.filesChanged,
                message: `Auto-committed ${commitResult.filesChanged} changed file(s) (${commitResult.sha.slice(0, 7)}).`,
              });
            }
            this.taskRepo.update(taskId, { worktreeStatus: "active" });
          } catch (error: any) {
            console.error(`[AgentDaemon] Auto-commit failed for task ${taskId}:`, error);
            this.logEvent(taskId, "log", {
              message: `Auto-commit failed: ${error.message}`,
            });
          }
        })();
      }
    }

    // === COMPARISON SESSION CALLBACK ===
    // Notify the comparison service when a task in a comparison session completes.
    // This must be outside the auto-commit block so it fires regardless of worktree settings.
    const comparisonSvc = this.comparisonService;
    if (existingTask?.comparisonSessionId && comparisonSvc) {
      void (async () => {
        try {
          await comparisonSvc.onTaskCompleted(taskId);
        } catch (error: any) {
          console.error(`[AgentDaemon] Comparison callback failed for task ${taskId}:`, error);
        }
      })();
    }

    try {
      const isTopLevelTask =
        existingTask && !existingTask.parentTaskId && (existingTask.agentType ?? "main") === "main";
      if (isTopLevelTask) {
        const workspaceName = this.workspaceRepo.findById(existingTask.workspaceId)?.name;
        PersonalityManager.recordTaskCompleted(workspaceName);
        const gatewayContext = existingTask.agentConfig?.gatewayContext ?? "private";
        const canCaptureRelationshipMemory =
          gatewayContext === "private" ||
          existingTask.agentConfig?.allowSharedContextMemory === true;
        if (canCaptureRelationshipMemory) {
          RelationshipMemoryService.recordTaskCompletion(
            existingTask.title,
            typeof updates.resultSummary === "string" ? updates.resultSummary : undefined,
            taskId,
          );
        }
      }
    } catch (error) {
      console.warn("[AgentDaemon] Failed to record relationship milestone:", error);
    }
    if (this.teamOrchestrator) {
      void this.teamOrchestrator.onTaskTerminal(taskId).catch(() => {});
    }
    // Notify queue manager so it can start next task
    this.queueManager.onTaskFinished(taskId);
  }

  /**
   * Send a follow-up message to a task.
   *
   * If the executor is currently running (mutex held), the message is queued
   * for injection into the active execution loop and a user_message event is
   * emitted immediately so the UI shows the message right away.
   */
  async sendMessage(
    taskId: string,
    message: string,
    images?: ImageAttachment[],
  ): Promise<{ queued: boolean }> {
    let cached = this.activeTasks.get(taskId);
    let executor: TaskExecutor;

    // Always get fresh task and workspace from DB to pick up permission changes
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const { task: effectiveTask } = this.applyAgentRoleOverrides(task);

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
        status: "active",
      });
    } else {
      executor = cached.executor;
      // Update workspace to pick up permission changes (e.g., shell enabled)
      executor.updateWorkspace(workspace);
      cached.lastAccessed = Date.now();
      cached.status = "active";
    }

    // If the executor is busy (mutex locked), queue the message for the running
    // loop to pick up and return immediately so the IPC doesn't block.
    if (executor.isRunning) {
      executor.queueFollowUp(message, images);
      // Emit user_message event immediately so the UI shows the message right away.
      // The executor's sendMessageLegacy won't re-emit because the message is
      // injected directly into the conversation loop, not through sendMessage.
      this.logEvent(taskId, "user_message", { message });
      return { queued: true };
    }

    // Send the message (executor is idle, acquire mutex normally)
    await executor.sendMessage(message, images);
    return { queued: false };
  }

  /**
   * Handle step-level feedback from the user.
   * Routes the feedback signal to the appropriate executor.
   */
  async handleStepFeedback(
    taskId: string,
    stepId: string,
    action: StepFeedbackAction,
    message?: string,
  ): Promise<void> {
    const cached = this.activeTasks.get(taskId);
    if (!cached) {
      throw new Error(`Task ${taskId} not found or not active`);
    }
    cached.lastAccessed = Date.now();

    const executor = cached.executor;
    if (!executor) {
      throw new Error(`No executor found for task ${taskId}`);
    }

    // Log the feedback event for UI
    this.logEvent(taskId, "step_feedback", {
      stepId,
      action,
      message,
      timestamp: Date.now(),
    });

    // Route to executor
    executor.setStepFeedback(stepId, action, message);
  }

  /**
   * After execution completes, process any follow-up messages that were queued
   * but never picked up by the execution loop (e.g. arrived on the last iteration).
   */
  private processOrphanedFollowUps(taskId: string, executor: TaskExecutor): void {
    const orphaned = executor.drainAllPendingFollowUps();
    if (orphaned.length === 0) return;

    console.log(
      `[AgentDaemon] Processing ${orphaned.length} orphaned follow-up(s) for task ${taskId}`,
    );

    // Process each follow-up sequentially via sendMessage (mutex is now free).
    // The user_message event was already emitted when the message was queued, so
    // tell the executor to suppress the duplicate emission.
    // Fire-and-forget: each follow-up is independent and errors are logged.
    let chain: Promise<void> = Promise.resolve();
    for (const followUp of orphaned) {
      chain = chain
        .then(() => {
          executor.suppressNextUserMessageEvent();
          return this.sendMessage(taskId, followUp.message, followUp.images);
        })
        .then(() => {
          /* result intentionally ignored */
        })
        .catch((err) => {
          console.error(
            `[AgentDaemon] Failed to process orphaned follow-up for task ${taskId}:`,
            err,
          );
        });
    }
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

    console.log(
      `[AgentDaemon] Clearing ${runningTaskIds.length} running tasks and ${queuedTaskIds.length} queued tasks`,
    );

    // Cancel all running tasks properly (this cleans up browser sessions, etc.)
    for (const taskId of runningTaskIds) {
      const cached = this.activeTasks.get(taskId);
      if (cached) {
        try {
          console.log(`[AgentDaemon] Cancelling running task: ${taskId}`);
          await cached.executor.cancel("system");
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
        await cached.executor.cancel("timeout");
        this.activeTasks.delete(taskId);
      } catch (error) {
        console.error(`[AgentDaemon] Error cancelling timed out task ${taskId}:`, error);
      }
    }

    // Update task status to failed with timeout message
    this.taskRepo.update(taskId, {
      status: "failed",
      error: "Task timed out - exceeded maximum allowed execution time",
    });
    this.pendingTaskImages.delete(taskId);
    this.clearRetryState(taskId);

    // Emit timeout event
    this.logEvent(taskId, "step_timeout", {
      message: "Task exceeded maximum execution time and was automatically cancelled",
    });
  }

  /**
   * Emit queue update event to all windows
   */
  private emitQueueUpdate(status: QueueStatus): void {
    const windows = getAllElectronWindows();
    windows.forEach((window) => {
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
    console.log("Shutting down agent daemon...");

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
        pending.reject(new Error("Daemon shutting down"));
      }
    });
    this.pendingApprovals.clear();

    // Save conversation snapshots and mark active tasks as "interrupted" so they
    // can be automatically resumed on next startup. Snapshots must be saved BEFORE
    // calling executor.cancel() which aborts in-flight requests.
    this.activeTasks.forEach((cached, taskId) => {
      if (cached.status !== "active") return;

      // Best-effort snapshot save
      try {
        cached.executor.saveConversationSnapshot();
      } catch (err) {
        console.error(`[AgentDaemon] Failed to save snapshot for task ${taskId} on shutdown:`, err);
      }

      // Mark as "interrupted" instead of "cancelled" so we can resume on restart
      try {
        this.taskRepo.update(taskId, {
          status: "interrupted" as TaskStatus,
          error: "Application shutdown while task was running - will resume on restart",
        });
        this.logEvent(taskId, "task_interrupted", {
          message: "Task interrupted by application shutdown. Will resume on restart.",
        });
      } catch (err) {
        console.error(`[AgentDaemon] Failed to update task ${taskId} status on shutdown:`, err);
      }
    });

    // Cancel all active tasks and wait for them to complete
    const cancelPromises: Promise<void>[] = [];
    this.activeTasks.forEach((cached, taskId) => {
      const promise = cached.executor.cancel("shutdown").catch((err) => {
        console.error(`Error cancelling task ${taskId}:`, err);
      });
      cancelPromises.push(promise);
    });

    // Wait for all cancellations to complete (with timeout)
    await Promise.race([
      Promise.all(cancelPromises),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)), // 5 second timeout
    ]);

    this.activeTasks.clear();
    this.pendingTaskImages.clear();

    // Remove all EventEmitter listeners to prevent memory leaks
    this.removeAllListeners();

    console.log("Agent daemon shutdown complete");
  }

  /**
   * Prune old conversation snapshots for a task, keeping only the most recent one.
   * This prevents database bloat from accumulating snapshots.
   */
  pruneOldSnapshots(taskId: string): void {
    try {
      this.eventRepo.pruneOldSnapshots(taskId);
    } catch (error) {
      console.debug("[AgentDaemon] Failed to prune old snapshots:", error);
    }
  }
}
