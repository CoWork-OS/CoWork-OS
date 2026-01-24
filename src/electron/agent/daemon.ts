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

/**
 * AgentDaemon is the core orchestrator that manages task execution
 * It coordinates between the database, task executors, and UI
 */
export class AgentDaemon extends EventEmitter {
  private taskRepo: TaskRepository;
  private eventRepo: TaskEventRepository;
  private workspaceRepo: WorkspaceRepository;
  private approvalRepo: ApprovalRepository;
  private activeTasks: Map<string, TaskExecutor> = new Map();
  private pendingApprovals: Map<string, { taskId: string; resolve: (value: boolean) => void; reject: (reason?: unknown) => void }> = new Map();

  constructor(private dbManager: DatabaseManager) {
    super();
    const db = dbManager.getDatabase();
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new TaskEventRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.approvalRepo = new ApprovalRepository(db);
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
    this.activeTasks.set(task.id, executor);

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
    const executor = this.activeTasks.get(taskId);
    if (executor) {
      await executor.cancel();
      this.activeTasks.delete(taskId);
    }
  }

  /**
   * Pause a running task
   */
  async pauseTask(taskId: string): Promise<void> {
    const executor = this.activeTasks.get(taskId);
    if (executor) {
      await executor.pause();
    }
  }

  /**
   * Resume a paused task
   */
  async resumeTask(taskId: string): Promise<void> {
    const executor = this.activeTasks.get(taskId);
    if (executor) {
      await executor.resume();
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
    console.log('[Approval Debug] Requesting approval:', { taskId, type, description, details });

    const approval = this.approvalRepo.create({
      taskId,
      type: type as any,
      description,
      details,
      status: 'pending',
      requestedAt: Date.now(),
    });

    console.log('[Approval Debug] Created approval record:', approval);

    // Emit event to UI
    this.emitTaskEvent(taskId, 'approval_requested', { approval });
    console.log('[Approval Debug] Emitted approval_requested event');

    // Wait for user response
    return new Promise((resolve, reject) => {
      this.pendingApprovals.set(approval.id, { taskId, resolve, reject });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.pendingApprovals.has(approval.id)) {
          this.pendingApprovals.delete(approval.id);
          this.approvalRepo.update(approval.id, 'denied');
          this.logEvent(taskId, 'approval_denied', { approvalId: approval.id });
          reject(new Error('Approval request timed out'));
        }
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Respond to an approval request
   */
  async respondToApproval(approvalId: string, approved: boolean): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);
    if (pending) {
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
   * Emit event to renderer process
   */
  private emitTaskEvent(taskId: string, type: string, payload: any): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(window => {
      window.webContents.send(IPC_CHANNELS.TASK_EVENT, {
        taskId,
        type,
        payload,
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Update task status
   */
  updateTaskStatus(taskId: string, status: Task['status']): void {
    this.taskRepo.update(taskId, { status });
  }

  /**
   * Mark task as completed
   * Note: We keep the executor in memory for follow-up messages
   */
  completeTask(taskId: string): void {
    this.taskRepo.update(taskId, {
      status: 'completed',
      completedAt: Date.now(),
    });
    // Don't delete executor - keep it for follow-up messages
    this.emitTaskEvent(taskId, 'task_completed', { message: 'Task completed successfully' });
  }

  /**
   * Send a follow-up message to a task
   */
  async sendMessage(taskId: string, message: string): Promise<void> {
    let executor = this.activeTasks.get(taskId);

    if (!executor) {
      // Task executor not in memory - need to recreate it
      const task = this.taskRepo.findById(taskId);
      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      const workspace = this.workspaceRepo.findById(task.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace ${task.workspaceId} not found`);
      }

      // Create new executor
      executor = new TaskExecutor(task, workspace, this);

      // Rebuild conversation history from saved events
      const events = this.eventRepo.findByTaskId(taskId);
      if (events.length > 0) {
        executor.rebuildConversationFromEvents(events);
      }

      this.activeTasks.set(taskId, executor);
    }

    // Send the message
    await executor.sendMessage(message);
  }

  /**
   * Shutdown daemon
   */
  shutdown(): void {
    console.log('Shutting down agent daemon...');
    this.activeTasks.forEach((executor, taskId) => {
      executor.cancel().catch(err => console.error(`Error cancelling task ${taskId}:`, err));
    });
    this.activeTasks.clear();
  }
}
