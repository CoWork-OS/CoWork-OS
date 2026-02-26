import Database from "better-sqlite3";
import { AgentDaemon } from "../agent/daemon";
import {
  ComparisonSessionRepository,
  TaskRepository,
  WorktreeInfoRepository,
} from "../database/repositories";
import { GitService } from "./GitService";
import { ComparisonSession, ComparisonAgentSpec, ComparisonResult } from "../../shared/types";

/**
 * Manages agent comparison sessions: spawning multiple agents with the same prompt,
 * tracking completion, and generating comparison results.
 */
export class ComparisonService {
  private static instance: ComparisonService | null = null;
  private sessionRepo: ComparisonSessionRepository;
  private worktreeInfoRepo: WorktreeInfoRepository;
  private taskRepo: TaskRepository;
  /** Guard against concurrent onTaskCompleted() calls for the same session. */
  private processingSessionIds = new Set<string>();

  constructor(
    private db: Database.Database,
    private daemon: AgentDaemon,
  ) {
    this.sessionRepo = new ComparisonSessionRepository(db);
    this.worktreeInfoRepo = new WorktreeInfoRepository(db);
    this.taskRepo = new TaskRepository(db);
    ComparisonService.instance = this;
  }

  static getInstance(): ComparisonService | null {
    return ComparisonService.instance;
  }

  /**
   * Create a comparison session: spawns N agents with the same prompt.
   * Each agent can have different model/config settings.
   */
  async createSession(params: {
    title: string;
    prompt: string;
    workspaceId: string;
    agents: ComparisonAgentSpec[];
  }): Promise<ComparisonSession> {
    if (params.agents.length < 2) {
      throw new Error("Comparison mode requires at least 2 agents");
    }

    const session = this.sessionRepo.create({
      title: params.title,
      prompt: params.prompt,
      workspaceId: params.workspaceId,
      status: "running",
      taskIds: [],
    });

    const taskIds: string[] = [];
    try {
      for (let i = 0; i < params.agents.length; i++) {
        const spec = params.agents[i];
        const label = spec.label || `Agent ${String.fromCharCode(65 + i)}`; // A, B, C...

        // Create each task via the daemon's proper task creation flow
        const task = await this.daemon.createTask({
          title: `[${label}] ${params.title}`,
          prompt: params.prompt,
          workspaceId: params.workspaceId,
          agentConfig: spec.agentConfig,
        });

        taskIds.push(task.id);

        // Link task to the comparison session and agent role
        this.taskRepo.update(task.id, {
          comparisonSessionId: session.id,
          assignedAgentRoleId: spec.assignedAgentRoleId,
        });
      }

      session.taskIds = this.sessionRepo.syncTaskIdsFromTasks(session.id);

      if (taskIds.length > 0) {
        this.daemon.logEvent(taskIds[0], "comparison_started", {
          sessionId: session.id,
          agentCount: params.agents.length,
          message: `Comparison session started with ${params.agents.length} agents.`,
        });
      }

      return session;
    } catch (error: Any) {
      console.error("[ComparisonService] Session creation failed, rolling back:", error);

      for (const taskId of taskIds) {
        try {
          await this.daemon.cancelTask(taskId);
        } catch {
          // Best-effort rollback: task might already be terminal.
        }
        try {
          this.db.prepare("UPDATE tasks SET comparison_session_id = NULL WHERE id = ?").run(taskId);
        } catch {
          // Best-effort cleanup.
        }
      }

      try {
        this.sessionRepo.delete(session.id);
      } catch {
        // Best-effort rollback.
      }

      throw new Error(error?.message || "Failed to create comparison session");
    }
  }

  /**
   * Called when a task in a comparison session completes.
   * Checks if all tasks are done and generates comparison result.
   */
  async onTaskCompleted(taskId: string): Promise<void> {
    // Find which session this task belongs to
    const task = await this.daemon.getTaskById(taskId);
    if (!task?.comparisonSessionId) return;

    const sessionId = task.comparisonSessionId;
    const session = this.sessionRepo.findById(sessionId);
    if (!session || session.status !== "running") return;

    // Guard: prevent concurrent processing of the same session
    // (e.g., two tasks completing simultaneously)
    if (this.processingSessionIds.has(sessionId)) return;
    this.processingSessionIds.add(sessionId);

    try {
      // Check if all tasks in the session are terminal
      let allDone = true;
      let anyFailed = false;

      for (const tid of session.taskIds) {
        const t = await this.daemon.getTaskById(tid);
        if (!t) continue;

        if (t.status === "failed" || t.status === "cancelled") {
          anyFailed = true;
        } else if (t.status !== "completed") {
          allDone = false;
        }
      }

      if (!allDone) return;

      // All tasks are terminal — generate comparison result
      try {
        const result = await this.generateComparisonResult(session.id);
        this.sessionRepo.update(session.id, {
          status: anyFailed ? "partial" : "completed",
          completedAt: Date.now(),
          comparisonResult: result,
        });

        this.daemon.logEvent(taskId, "comparison_completed", {
          sessionId: session.id,
          status: anyFailed ? "partial" : "completed",
          message: `Comparison session completed (${anyFailed ? "some agents failed" : "all agents succeeded"}).`,
        });
      } catch (error: Any) {
        console.error(`[ComparisonService] Failed to generate comparison result:`, error);
        this.sessionRepo.update(session.id, {
          status: "partial",
          completedAt: Date.now(),
        });
      }
    } finally {
      this.processingSessionIds.delete(sessionId);
    }
  }

  /**
   * Generate comparison result by collecting stats from all worktree branches.
   */
  async generateComparisonResult(sessionId: string): Promise<ComparisonResult> {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const taskResults: ComparisonResult["taskResults"] = [];

    for (const taskId of session.taskIds) {
      const task = await this.daemon.getTaskById(taskId);
      if (!task) continue;

      const label = task.title.match(/^\[(.+?)\]/)?.[1] || taskId.slice(0, 6);
      const duration = task.completedAt ? task.completedAt - task.createdAt : 0;

      let filesChanged = 0;
      let linesAdded = 0;
      let linesRemoved = 0;

      // Get diff stats from worktree if available
      const worktreeInfo = this.worktreeInfoRepo.findByTaskId(taskId);
      if (worktreeInfo && worktreeInfo.status !== "cleaned") {
        try {
          const stats = await GitService.getDiffStats(
            worktreeInfo.worktreePath,
            worktreeInfo.baseBranch,
          );
          filesChanged = stats.filesChanged;
          linesAdded = stats.linesAdded;
          linesRemoved = stats.linesRemoved;
        } catch {
          // Worktree might have been cleaned up already
        }
      }

      taskResults.push({
        taskId,
        label,
        status: task.status,
        branchName: task.worktreeBranch,
        filesChanged,
        linesAdded,
        linesRemoved,
        duration,
        summary: task.resultSummary,
      });
    }

    return { taskResults };
  }

  /**
   * Cancel a comparison session (cancels all running tasks).
   */
  async cancelSession(sessionId: string): Promise<void> {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) return;

    for (const taskId of session.taskIds) {
      try {
        await this.daemon.cancelTask(taskId);
      } catch {
        // Task might already be completed/cancelled
      }
    }

    this.sessionRepo.update(sessionId, {
      status: "cancelled",
      completedAt: Date.now(),
    });
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): ComparisonSession | undefined {
    return this.sessionRepo.findById(sessionId);
  }

  /**
   * List sessions for a workspace.
   */
  listSessions(workspaceId: string): ComparisonSession[] {
    return this.sessionRepo.findByWorkspaceId(workspaceId);
  }
}
