/**
 * Task Queue Manager
 *
 * Manages parallel task execution with configurable concurrency limits.
 * Provides queue management, status tracking, and settings persistence.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Task, TaskStatus, QueueSettings, QueueStatus, DEFAULT_QUEUE_SETTINGS } from '../../shared/types';

const SETTINGS_FILE = 'queue-settings.json';

// Forward declaration - will be set by daemon
type DaemonCallbacks = {
  startTaskImmediate: (task: Task) => Promise<void>;
  emitQueueUpdate: (status: QueueStatus) => void;
  getTaskById: (taskId: string) => Task | undefined;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  onTaskTimeout: (taskId: string) => Promise<void>;  // Called when a task times out
};

export class TaskQueueManager {
  private queuedTaskIds: string[] = [];           // FIFO queue of task IDs
  private runningTaskIds: Set<string> = new Set(); // Currently executing task IDs
  private taskStartTimes: Map<string, number> = new Map(); // Track when each task started
  private settings: QueueSettings;
  private settingsPath: string;
  private callbacks: DaemonCallbacks;
  private initialized: boolean = false;
  private timeoutCheckInterval?: ReturnType<typeof setInterval>;

  constructor(callbacks: DaemonCallbacks) {
    this.callbacks = callbacks;
    const userDataPath = app.getPath('userData');
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE);
    this.settings = this.loadSettings();

    // Start periodic timeout check (every minute)
    this.timeoutCheckInterval = setInterval(() => this.checkForTimedOutTasks(), 60 * 1000);
  }

  /**
   * Cleanup resources (call on shutdown)
   */
  destroy(): void {
    if (this.timeoutCheckInterval) {
      clearInterval(this.timeoutCheckInterval);
      this.timeoutCheckInterval = undefined;
    }
  }

  /**
   * Initialize the queue manager - recover queue from database on startup
   * Should be called after database is ready
   */
  async initialize(
    queuedTasks: Task[],
    runningTasks: Task[]
  ): Promise<void> {
    if (this.initialized) {
      console.log('[TaskQueueManager] Already initialized, skipping');
      return;
    }

    console.log('[TaskQueueManager] Initializing queue manager');
    console.log(`[TaskQueueManager] Found ${queuedTasks.length} queued tasks, ${runningTasks.length} running tasks`);

    // Restore queued tasks in FIFO order by creation time
    this.queuedTaskIds = queuedTasks
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(t => t.id);

    // Track currently running tasks
    runningTasks.forEach(t => this.runningTaskIds.add(t.id));

    this.initialized = true;

    // Start processing queue if there are slots available
    await this.processQueue();

    // Emit initial queue status
    this.emitQueueUpdate();
  }

  /**
   * Enqueue a new task - either start immediately or add to queue
   *
   * Sub-agents (tasks with parentTaskId) bypass the concurrency limit to prevent
   * deadlocks where a parent task waits for sub-agents that are stuck in the queue.
   */
  async enqueue(task: Task): Promise<void> {
    console.log(`[TaskQueueManager] Enqueueing task ${task.id}: ${task.title}`);

    // Sub-agents bypass concurrency limits to prevent deadlock
    // (parent would wait forever for sub-agents stuck in queue)
    const isSubAgent = !!task.parentTaskId;

    if (isSubAgent) {
      console.log(`[TaskQueueManager] Starting sub-agent immediately (bypasses concurrency limit)`);
      await this.startTask(task);
    } else if (this.canStartImmediately()) {
      console.log(`[TaskQueueManager] Starting task immediately (${this.runningTaskIds.size}/${this.settings.maxConcurrentTasks} slots used)`);
      await this.startTask(task);
    } else {
      console.log(`[TaskQueueManager] Queue full, adding task to queue (position: ${this.queuedTaskIds.length + 1})`);
      this.queuedTaskIds.push(task.id);
      this.callbacks.updateTaskStatus(task.id, 'queued');
      this.emitQueueUpdate();
    }
  }

  /**
   * Called when a task finishes (completed, failed, or cancelled)
   */
  async onTaskFinished(taskId: string): Promise<void> {
    console.log(`[TaskQueueManager] Task ${taskId} finished`);

    // Remove from running set and clear start time
    this.runningTaskIds.delete(taskId);
    this.taskStartTimes.delete(taskId);

    // Process next task in queue
    await this.processQueue();

    // Emit updated status
    this.emitQueueUpdate();
  }

  /**
   * Cancel a queued task (remove from queue without starting)
   * Returns true if task was in queue and removed
   */
  cancelQueuedTask(taskId: string): boolean {
    const index = this.queuedTaskIds.indexOf(taskId);
    if (index !== -1) {
      console.log(`[TaskQueueManager] Removing task ${taskId} from queue`);
      this.queuedTaskIds.splice(index, 1);
      this.emitQueueUpdate();
      return true;
    }
    return false;
  }

  /**
   * Check if a task is currently in the queue
   */
  isQueued(taskId: string): boolean {
    return this.queuedTaskIds.includes(taskId);
  }

  /**
   * Check if a task is currently running
   */
  isRunning(taskId: string): boolean {
    return this.runningTaskIds.has(taskId);
  }

  /**
   * Clear all stuck tasks from the running set
   * This should be used to recover from stuck state when tasks fail to clean up
   * Returns the number of tasks cleared
   */
  clearStuckTasks(): { clearedRunning: number; clearedQueued: number } {
    const clearedRunning = this.runningTaskIds.size;
    const clearedQueued = this.queuedTaskIds.length;

    console.log(`[TaskQueueManager] Clearing ${clearedRunning} running tasks and ${clearedQueued} queued tasks`);

    // Clear running tasks and their start times
    this.runningTaskIds.clear();
    this.taskStartTimes.clear();

    // Clear queued tasks
    this.queuedTaskIds = [];

    // Emit update
    this.emitQueueUpdate();

    return { clearedRunning, clearedQueued };
  }

  /**
   * Get current queue status for UI
   */
  getStatus(): QueueStatus {
    return {
      runningCount: this.runningTaskIds.size,
      queuedCount: this.queuedTaskIds.length,
      runningTaskIds: Array.from(this.runningTaskIds),
      queuedTaskIds: [...this.queuedTaskIds],
      maxConcurrent: this.settings.maxConcurrentTasks,
    };
  }

  /**
   * Get current settings
   */
  getSettings(): QueueSettings {
    return { ...this.settings };
  }

  /**
   * Update settings
   */
  saveSettings(newSettings: Partial<QueueSettings>): void {
    // Validate maxConcurrentTasks
    if (newSettings.maxConcurrentTasks !== undefined) {
      newSettings.maxConcurrentTasks = Math.max(1, Math.min(10, newSettings.maxConcurrentTasks));
    }

    // Validate taskTimeoutMinutes (5 min to 4 hours)
    if (newSettings.taskTimeoutMinutes !== undefined) {
      newSettings.taskTimeoutMinutes = Math.max(5, Math.min(240, newSettings.taskTimeoutMinutes));
    }

    this.settings = { ...this.settings, ...newSettings };

    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf-8');
      console.log('[TaskQueueManager] Settings saved');
    } catch (error) {
      console.error('[TaskQueueManager] Failed to save settings:', error);
    }

    // Process queue in case we increased concurrency
    this.processQueue();
    this.emitQueueUpdate();
  }

  // ===== Private Methods =====

  /**
   * Process the queue - start tasks if slots are available
   */
  private async processQueue(): Promise<void> {
    while (this.canStartImmediately() && this.queuedTaskIds.length > 0) {
      const nextTaskId = this.queuedTaskIds.shift()!;
      const task = this.callbacks.getTaskById(nextTaskId);

      if (task && task.status === 'queued') {
        console.log(`[TaskQueueManager] Dequeuing task ${nextTaskId}`);
        await this.startTask(task);
      } else {
        console.log(`[TaskQueueManager] Skipping task ${nextTaskId} (not found or status changed)`);
      }
    }
  }

  /**
   * Check if we can start a task immediately
   */
  private canStartImmediately(): boolean {
    return this.runningTaskIds.size < this.settings.maxConcurrentTasks;
  }

  /**
   * Start a task
   */
  private async startTask(task: Task): Promise<void> {
    this.runningTaskIds.add(task.id);
    this.taskStartTimes.set(task.id, Date.now());
    this.emitQueueUpdate();

    try {
      await this.callbacks.startTaskImmediate(task);
    } catch (error) {
      console.error(`[TaskQueueManager] Failed to start task ${task.id}:`, error);
      this.runningTaskIds.delete(task.id);
      this.taskStartTimes.delete(task.id);
      this.emitQueueUpdate();
    }
  }

  /**
   * Emit queue status update
   */
  private emitQueueUpdate(): void {
    this.callbacks.emitQueueUpdate(this.getStatus());
  }

  /**
   * Check for tasks that have exceeded the timeout and clear them
   */
  private async checkForTimedOutTasks(): Promise<void> {
    const now = Date.now();
    const timeoutMs = this.settings.taskTimeoutMinutes * 60 * 1000;
    const timedOutTasks: string[] = [];

    // Find tasks that have exceeded the timeout
    for (const [taskId, startTime] of this.taskStartTimes) {
      const elapsed = now - startTime;
      if (elapsed > timeoutMs) {
        const elapsedMinutes = Math.round(elapsed / 60000);
        console.log(`[TaskQueueManager] Task ${taskId} has timed out (running for ${elapsedMinutes} minutes, timeout: ${this.settings.taskTimeoutMinutes} minutes)`);
        timedOutTasks.push(taskId);
      }
    }

    // Process timed out tasks
    for (const taskId of timedOutTasks) {
      try {
        // Notify daemon to handle the timeout (cancel task, cleanup resources)
        await this.callbacks.onTaskTimeout(taskId);

        // Remove from tracking (daemon will call onTaskFinished which also removes, but do it here just in case)
        this.runningTaskIds.delete(taskId);
        this.taskStartTimes.delete(taskId);
      } catch (error) {
        console.error(`[TaskQueueManager] Error handling timeout for task ${taskId}:`, error);
        // Force remove from tracking even if daemon callback fails
        this.runningTaskIds.delete(taskId);
        this.taskStartTimes.delete(taskId);
      }
    }

    // If any tasks were cleared, process the queue and emit update
    if (timedOutTasks.length > 0) {
      await this.processQueue();
      this.emitQueueUpdate();
    }
  }

  /**
   * Load settings from disk
   */
  private loadSettings(): QueueSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf-8');
        const parsed = JSON.parse(data);
        // Merge with defaults to handle missing fields
        return { ...DEFAULT_QUEUE_SETTINGS, ...parsed };
      }
    } catch (error) {
      console.error('[TaskQueueManager] Failed to load settings:', error);
    }
    return { ...DEFAULT_QUEUE_SETTINGS };
  }
}
