import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import { DatabaseManager } from '../database/schema';
import {
  TaskRepository,
  TaskEventRepository,
  WorkspaceRepository,
  ApprovalRepository,
} from '../database/repositories';
import { Task, IPC_CHANNELS } from '../../shared/types';
import { TaskExecutor } from './executor';

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
  private activeTasks: Map<string, CachedExecutor> = new Map();
  private pendingApprovals: Map<string, { taskId: string; resolve: (value: boolean) => void; reject: (reason?: unknown) => void; resolved: boolean; timeoutHandle: ReturnType<typeof setTimeout> }> = new Map();
  private cleanupIntervalHandle?: ReturnType<typeof setInterval>;

  constructor(private dbManager: DatabaseManager) {
    super();
    const db = dbManager.getDatabase();
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new TaskEventRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.approvalRepo = new ApprovalRepository(db);

    // Start periodic cleanup of old executors
    this.cleanupIntervalHandle = setInterval(() => this.cleanupOldExecutors(), 5 * 60 * 1000); // Run every 5 minutes
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
   * Start executing a task
   */
  async startTask(task: Task): Promise<void> {
    console.log(`Starting task ${task.id}: ${task.title}`);

    // Get workspace details
    const workspace = this.workspaceRepo.findById(task.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${task.workspaceId} not found`);
    }

    // Create task executor
    const executor = new TaskExecutor(task, workspace, this);
    this.activeTasks.set(task.id, {
      executor,
      lastAccessed: Date.now(),
      status: 'active',
    });

    // Update task status
    this.taskRepo.update(task.id, { status: 'planning' });
    this.emitTaskEvent(task.id, 'task_created', { task });

    // Start execution (non-blocking)
    executor.execute().catch(error => {
      console.error(`Task ${task.id} failed:`, error);
      this.taskRepo.update(task.id, {
        status: 'failed',
        error: error.message,
        completedAt: Date.now(),
      });
      this.emitTaskEvent(task.id, 'error', { error: error.message });
      this.activeTasks.delete(task.id);
    });
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<void> {
    const cached = this.activeTasks.get(taskId);
    if (cached) {
      await cached.executor.cancel();
      this.activeTasks.delete(taskId);
    }
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
   */
  async respondToApproval(approvalId: string, approved: boolean): Promise<void> {
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
   * Emit event to renderer process and local listeners
   */
  private emitTaskEvent(taskId: string, type: string, payload: any): void {
    // Emit to local EventEmitter listeners (for gateway integration)
    this.emit(type, { taskId, ...payload });

    // Emit to renderer process via IPC
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(window => {
      // Check if window is still valid before sending
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.TASK_EVENT, {
          taskId,
          type,
          payload,
          timestamp: Date.now(),
        });
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

    // Clear all pending approval timeouts
    this.pendingApprovals.forEach((pending) => {
      clearTimeout(pending.timeoutHandle);
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
    console.log('Agent daemon shutdown complete');
  }
}
