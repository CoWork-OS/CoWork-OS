import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import { DatabaseManager } from '../database/schema';
import {
  TaskRepository,
  TaskEventRepository,
  WorkspaceRepository,
  ApprovalRepository,
  ArtifactRepository,
} from '../database/repositories';
import { Task, TaskStatus, IPC_CHANNELS, QueueSettings, QueueStatus } from '../../shared/types';
import { TaskExecutor } from './executor';
import { TaskQueueManager } from './queue-manager';
import { approvalIdempotency, taskIdempotency, IdempotencyManager } from '../security/concurrency';

// Memory management constants
const MAX_CACHED_EXECUTORS = 10; // Maximum number of completed task executors to keep in memory
const EXECUTOR_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes - time before completed executors are cleaned up

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
  private activeTasks: Map<string, CachedExecutor> = new Map();
  private pendingApprovals: Map<string, { taskId: string; resolve: (value: boolean) => void; reject: (reason?: unknown) => void; resolved: boolean; timeoutHandle: ReturnType<typeof setTimeout> }> = new Map();
  private cleanupIntervalHandle?: ReturnType<typeof setInterval>;
  private queueManager: TaskQueueManager;

  constructor(private dbManager: DatabaseManager) {
    super();
    const db = dbManager.getDatabase();
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new TaskEventRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.approvalRepo = new ApprovalRepository(db);
    this.artifactRepo = new ArtifactRepository(db);

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
  }

  /**
   * Start executing a task immediately (internal - called by queue manager)
   */
  async startTaskImmediate(task: Task): Promise<void> {
    console.log(`[AgentDaemon] Starting task ${task.id}: ${task.title}`);

    // Get workspace details
    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${task.workspaceId} not found`);
    }
    console.log(`[AgentDaemon] Workspace found: ${workspace.name}`);

    // Create task executor - wrapped in try-catch to handle provider initialization errors
    let executor: TaskExecutor;
    try {
      console.log(`[AgentDaemon] Creating TaskExecutor...`);
      executor = new TaskExecutor(task, workspace, this);
      console.log(`[AgentDaemon] TaskExecutor created successfully`);
    } catch (error: any) {
      console.error(`[AgentDaemon] Task ${task.id} failed to initialize:`, error);
      this.taskRepo.update(task.id, {
        status: 'failed',
        error: error.message || 'Failed to initialize task executor',
        completedAt: Date.now(),
      });
      this.emitTaskEvent(task.id, 'error', { error: error.message });
      // Notify queue manager so it can start next task
      this.queueManager.onTaskFinished(task.id);
      return;
    }

    this.activeTasks.set(task.id, {
      executor,
      lastAccessed: Date.now(),
      status: 'active',
    });

    // Update task status
    this.taskRepo.update(task.id, { status: 'planning' });
    this.emitTaskEvent(task.id, 'task_created', { task });
    console.log(`[AgentDaemon] Task status updated to 'planning', starting execution...`);

    // Start execution (non-blocking)
    executor.execute().catch(error => {
      console.error(`[AgentDaemon] Task ${task.id} execution failed:`, error);
      this.taskRepo.update(task.id, {
        status: 'failed',
        error: error.message,
        completedAt: Date.now(),
      });
      this.emitTaskEvent(task.id, 'error', { error: error.message });
      this.activeTasks.delete(task.id);
      // Notify queue manager so it can start next task
      this.queueManager.onTaskFinished(task.id);
    });
  }

  /**
   * Cancel a running or queued task
   */
  async cancelTask(taskId: string): Promise<void> {
    // Check if task is queued (not yet started)
    if (this.queueManager.cancelQueuedTask(taskId)) {
      this.taskRepo.update(taskId, { status: 'cancelled', completedAt: Date.now() });
      this.emitTaskEvent(taskId, 'task_cancelled', {
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
    this.emitTaskEvent(taskId, 'task_cancelled', {
      message: 'Task was stopped by user',
    });
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
  async resumeTask(taskId: string): Promise<void> {
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.lastAccessed = Date.now();
      cached.status = 'active';
      await cached.executor.resume();
    }
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
    this.emitTaskEvent(taskId, 'approval_requested', { approval });

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
  async respondToApproval(approvalId: string, approved: boolean): Promise<void> {
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
      return; // Silently ignore duplicate
    }

    // Start tracking this operation
    if (!approvalIdempotency.start(idempotencyKey)) {
      console.log(`[AgentDaemon] Concurrent approval response in progress: ${approvalId}`);
      return; // Another response is being processed
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
      }

      approvalIdempotency.complete(idempotencyKey, { success: true });
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
    this.emitTaskEvent(taskId, type, payload);
  }

  /**
   * Register an artifact (file created during task execution)
   * This allows files like screenshots to be sent back to the user
   */
  registerArtifact(taskId: string, filePath: string, mimeType: string): void {
    const fs = require('fs');
    const crypto = require('crypto');

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
  }

  /**
   * Update task fields (for Goal Mode attempt tracking, etc.)
   */
  updateTask(taskId: string, updates: Partial<Pick<Task, 'currentAttempt' | 'status' | 'error' | 'completedAt'>>): void {
    this.taskRepo.update(taskId, updates);
  }

  /**
   * Mark task as completed
   * Note: We keep the executor in memory for follow-up messages (with TTL-based cleanup)
   */
  completeTask(taskId: string): void {
    this.taskRepo.update(taskId, {
      status: 'completed',
      completedAt: Date.now(),
    });
    // Mark executor as completed for TTL-based cleanup
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      cached.status = 'completed';
      cached.lastAccessed = Date.now();
    }
    this.emitTaskEvent(taskId, 'task_completed', { message: 'Task completed successfully' });
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

    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${task.workspaceId} not found`);
    }

    if (!cached) {
      // Task executor not in memory - need to recreate it
      // Create new executor
      executor = new TaskExecutor(task, workspace, this);

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

    // Emit timeout event
    this.emitTaskEvent(taskId, 'step_timeout', {
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
}
