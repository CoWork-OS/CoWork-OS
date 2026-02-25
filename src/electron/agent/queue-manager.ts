/**
 * Task Queue Manager
 *
 * Manages parallel task execution with configurable concurrency limits.
 * Provides queue management, status tracking, and settings persistence.
 * Settings are stored encrypted in the database using SecureSettingsRepository.
 */

import * as fs from "fs";
import * as path from "path";
import {
  Task,
  TaskStatus,
  QueueSettings,
  QueueStatus,
  DEFAULT_QUEUE_SETTINGS,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getUserDataDir } from "../utils/user-data-dir";

const LEGACY_SETTINGS_FILE = "queue-settings.json";

// Previous default values — used to detect users who never changed the setting
// so we can transparently upgrade them to the new defaults.
const PREVIOUS_DEFAULTS = {
  maxConcurrentTasks: 5,
  taskTimeoutMinutes: 30,
};

// Hard ceiling for total running tasks (top-level + sub-agents) to prevent
// runaway resource consumption. Set to 2× the max configurable concurrency.
const ABSOLUTE_MAX_RUNNING = 40;

// Forward declaration - will be set by daemon
type DaemonCallbacks = {
  startTaskImmediate: (task: Task) => Promise<void>;
  emitQueueUpdate: (status: QueueStatus) => void;
  getTaskById: (taskId: string) => Task | undefined;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  onTaskTimeout: (taskId: string) => Promise<void>; // Called when a task times out
};

export class TaskQueueManager {
  private queuedTaskIds: string[] = []; // FIFO queue of task IDs
  private runningTaskIds: Set<string> = new Set(); // Currently executing task IDs
  private taskStartTimes: Map<string, number> = new Map(); // Track when each task started
  private settings: QueueSettings;
  private legacySettingsPath: string;
  private callbacks: DaemonCallbacks;
  private initialized: boolean = false;
  private timeoutCheckInterval?: ReturnType<typeof setInterval>;
  private static migrationCompleted = false;

  constructor(callbacks: DaemonCallbacks) {
    this.callbacks = callbacks;
    const userDataPath = getUserDataDir();
    this.legacySettingsPath = path.join(userDataPath, LEGACY_SETTINGS_FILE);

    // Migrate from legacy file if needed
    this.migrateFromLegacyFile();

    this.settings = this.loadSettings();

    // Start periodic timeout check (every minute)
    this.timeoutCheckInterval = setInterval(() => this.checkForTimedOutTasks(), 60 * 1000);
  }

  /**
   * Migrate settings from legacy JSON file to encrypted database
   */
  private migrateFromLegacyFile(): void {
    if (TaskQueueManager.migrationCompleted) return;

    try {
      if (!SecureSettingsRepository.isInitialized()) {
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      if (repository.exists("queue")) {
        TaskQueueManager.migrationCompleted = true;
        return;
      }

      if (!fs.existsSync(this.legacySettingsPath)) {
        TaskQueueManager.migrationCompleted = true;
        return;
      }

      console.log(
        "[TaskQueueManager] Migrating settings from legacy JSON file to encrypted database...",
      );

      // Create backup before migration
      const backupPath = this.legacySettingsPath + ".migration-backup";
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        const data = fs.readFileSync(this.legacySettingsPath, "utf-8");
        const parsed = JSON.parse(data);
        const merged = this.upgradeLegacyQueueDefaults({ ...DEFAULT_QUEUE_SETTINGS, ...parsed });

        repository.save("queue", merged);
        console.log("[TaskQueueManager] Settings migrated to encrypted database");

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log("[TaskQueueManager] Migration complete, cleaned up legacy files");

        TaskQueueManager.migrationCompleted = true;
      } catch (migrationError) {
        console.error("[TaskQueueManager] Migration failed, backup preserved at:", backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error("[TaskQueueManager] Migration failed:", error);
    }
  }

  /**
   * Apply a one-time defaults migration only when loading from legacy settings.
   * This avoids accidentally overriding explicit user-defined values already stored
   * in the encrypted settings repository.
   */
  private upgradeLegacyQueueDefaults(settings: QueueSettings): QueueSettings {
    let upgraded = false;
    if (settings.maxConcurrentTasks === PREVIOUS_DEFAULTS.maxConcurrentTasks) {
      settings.maxConcurrentTasks = DEFAULT_QUEUE_SETTINGS.maxConcurrentTasks;
      upgraded = true;
    }
    if (settings.taskTimeoutMinutes === PREVIOUS_DEFAULTS.taskTimeoutMinutes) {
      settings.taskTimeoutMinutes = DEFAULT_QUEUE_SETTINGS.taskTimeoutMinutes;
      upgraded = true;
    }

    if (upgraded) {
      console.log(
        "[TaskQueueManager] Upgraded legacy queue settings from old defaults to new defaults",
        settings,
      );
    }

    return settings;
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
  async initialize(queuedTasks: Task[], runningTasks: Task[]): Promise<void> {
    if (this.initialized) {
      console.log("[TaskQueueManager] Already initialized, skipping");
      return;
    }

    console.log("[TaskQueueManager] Initializing queue manager");
    console.log(
      `[TaskQueueManager] Found ${queuedTasks.length} queued tasks, ${runningTasks.length} running tasks`,
    );

    // Restore queued tasks in FIFO order by creation time
    this.queuedTaskIds = queuedTasks.sort((a, b) => a.createdAt - b.createdAt).map((t) => t.id);

    // Track currently running tasks
    runningTasks.forEach((t) => this.runningTaskIds.add(t.id));

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
    const bypassQueue = task.agentConfig?.bypassQueue;
    const shouldBypassQueue = isSubAgent && bypassQueue !== false;

    if (shouldBypassQueue) {
      // Safety cap: even sub-agents are queued if total running tasks hit the absolute ceiling
      if (this.runningTaskIds.size >= ABSOLUTE_MAX_RUNNING) {
        console.warn(
          `[TaskQueueManager] Absolute running cap (${ABSOLUTE_MAX_RUNNING}) reached — queuing sub-agent`,
        );
        this.queuedTaskIds.push(task.id);
        this.callbacks.updateTaskStatus(task.id, "queued");
        this.emitQueueUpdate();
        return;
      }
      console.log(`[TaskQueueManager] Starting sub-agent immediately (bypasses concurrency limit)`);
      await this.startTask(task);
    } else if (this.canStartImmediately()) {
      console.log(
        `[TaskQueueManager] Starting task immediately (${this.runningTaskIds.size}/${this.settings.maxConcurrentTasks} slots used)`,
      );
      await this.startTask(task);
    } else {
      console.log(
        `[TaskQueueManager] Queue full, adding task to queue (position: ${this.queuedTaskIds.length + 1})`,
      );
      this.queuedTaskIds.push(task.id);
      this.callbacks.updateTaskStatus(task.id, "queued");
      this.emitQueueUpdate();
    }
  }

  /**
   * Register an externally-started task (e.g. resumed after interruption) so it
   * is tracked for concurrency limits and timeout enforcement.
   *
   * Returns `true` if the task was registered as running, or `false` if the
   * concurrency limit was reached and the task should be re-queued instead.
   */
  registerResumedTask(taskId: string): boolean {
    if (this.runningTaskIds.size >= this.settings.maxConcurrentTasks) {
      console.log(
        `[TaskQueueManager] Concurrency limit reached (${this.runningTaskIds.size}/${this.settings.maxConcurrentTasks}), cannot resume task ${taskId} — re-queuing`,
      );
      // Place at front of queue so resumed tasks take priority
      this.queuedTaskIds.unshift(taskId);
      this.emitQueueUpdate();
      return false;
    }
    this.runningTaskIds.add(taskId);
    this.taskStartTimes.set(taskId, Date.now());
    this.emitQueueUpdate();
    return true;
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

    console.log(
      `[TaskQueueManager] Clearing ${clearedRunning} running tasks and ${clearedQueued} queued tasks`,
    );

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
      newSettings.maxConcurrentTasks = Math.max(1, Math.min(20, newSettings.maxConcurrentTasks));
    }

    // Validate taskTimeoutMinutes (5 min to 4 hours)
    if (newSettings.taskTimeoutMinutes !== undefined) {
      newSettings.taskTimeoutMinutes = Math.max(5, Math.min(240, newSettings.taskTimeoutMinutes));
    }

    this.settings = { ...this.settings, ...newSettings };

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        repository.save("queue", this.settings);
        console.log("[TaskQueueManager] Settings saved to encrypted database");
      } else {
        console.warn(
          "[TaskQueueManager] SecureSettingsRepository not initialized, settings not persisted",
        );
      }
    } catch (error) {
      console.error("[TaskQueueManager] Failed to save settings:", error);
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

      if (task && task.status === "queued") {
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
        console.log(
          `[TaskQueueManager] Task ${taskId} has timed out (running for ${elapsedMinutes} minutes, timeout: ${this.settings.taskTimeoutMinutes} minutes)`,
        );
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
   * Load settings from encrypted database.
   */
  private loadSettings(): QueueSettings {
    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<QueueSettings>("queue");
        if (stored) {
          console.log("[TaskQueueManager] Loaded settings from encrypted database");
          const merged = { ...DEFAULT_QUEUE_SETTINGS, ...stored };
          return merged;
        }
      }
    } catch (error) {
      console.error("[TaskQueueManager] Failed to load settings:", error);
    }
    return { ...DEFAULT_QUEUE_SETTINGS };
  }
}
