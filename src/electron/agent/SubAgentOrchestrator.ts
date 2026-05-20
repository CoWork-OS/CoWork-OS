/**
 * Sub-Agent Orchestrator
 *
 * DAG-aware orchestration engine that:
 * - Decomposes a goal into dependency-tracked tasks
 * - Executes independent tasks in parallel
 * - Only unblocks a task when all its dependsOn tasks are completed
 * - Persists run state to the DB for crash recovery
 *
 * Usage:
 *   const orchestrator = new SubAgentOrchestrator(db, daemon, workspaceId, parentTaskId);
 *   const run = await orchestrator.start(tasks);
 */

import { EventEmitter } from "events";
import Database from "better-sqlite3";
import { OrchestrationRepository, OrchestrationRun, OrchestrationTask } from "./OrchestrationRepository";
import type { AgentDaemon } from "./daemon";
import { getACPRegistry } from "../acp";
import { RemoteAgentInvoker } from "../acp/remote-invoker";

export interface OrchestratorDeps {
  daemon: AgentDaemon;
  workspaceId: string;
  parentTaskId: string;
}

export type OrchestratorEvent =
  | { type: "task_spawned"; nodeId: string; taskId: string }
  | { type: "task_completed"; nodeId: string; taskId: string; output: string }
  | { type: "task_failed"; nodeId: string; taskId: string; error: string }
  | { type: "run_completed"; runId: string; succeeded: number; failed: number }
  | { type: "run_failed"; runId: string; reason: string };

export class SubAgentOrchestrator extends EventEmitter {
  private repo: OrchestrationRepository;
  private remoteInvoker = new RemoteAgentInvoker();

  constructor(
    private db: Database.Database,
    private deps: OrchestratorDeps,
  ) {
    super();
    this.repo = new OrchestrationRepository(db);
  }

  /**
   * Start a new orchestration run from a set of tasks.
   * Tasks with no dependsOn are immediately spawned; others wait for their deps.
   */
  async start(tasks: Omit<OrchestrationTask, "status">[]): Promise<OrchestrationRun> {
    const initialTasks: OrchestrationTask[] = tasks.map((t) => ({
      ...t,
      status: "pending" as const,
    }));

    const run = this.repo.create({
      rootTaskId: this.deps.parentTaskId,
      workspaceId: this.deps.workspaceId,
      tasks: initialTasks,
      status: "running",
    });

    // Begin execution loop
    await this.executeRun(run);
    return run;
  }

  /**
   * Resume a run that was interrupted (e.g., app restart).
   * Re-attaches to any tasks still in-flight and continues the DAG.
   */
  async resume(runId: string): Promise<void> {
    const run = this.repo.findById(runId);
    if (!run || run.status !== "running") return;
    await this.executeRun(run);
  }

  // ── Internal DAG execution ──────────────────────────────────────────────────

  private taskCompletionNotifier: (() => void) | null = null;

  /** Signal the DAG loop that a task finished so it can re-evaluate immediately. */
  notifyTaskCompleted(): void {
    this.taskCompletionNotifier?.();
  }

  private waitForTaskCompletion(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.taskCompletionNotifier = null;
        resolve();
      }, timeoutMs);
      this.taskCompletionNotifier = () => {
        clearTimeout(timer);
        this.taskCompletionNotifier = null;
        resolve();
      };
    });
  }

  private async executeRun(run: OrchestrationRun): Promise<void> {
    let current = run;

    while (true) {
      const ready = this.getReadyTasks(current);
      if (ready.length === 0) {
        const allDone = current.tasks.every((t) => t.status === "completed" || t.status === "failed");
        if (allDone) {
          const succeeded = current.tasks.filter((t) => t.status === "completed").length;
          const failed = current.tasks.filter((t) => t.status === "failed").length;
          current = this.setRunStatus(current, "completed");
          this.emit("run_completed", { type: "run_completed", runId: current.id, succeeded, failed });
          return;
        }
        // Wait for a task completion signal instead of busy-polling
        await this.waitForTaskCompletion(15_000);
        const refreshed = this.repo.findById(current.id);
        if (!refreshed) return;
        current = refreshed;
        continue;
      }

      // Spawn all ready tasks in parallel
      const spawnPromises = ready.map((task) => this.spawnTask(current, task));
      const spawnedRuns = await Promise.all(spawnPromises);

      // Merge all spawned task updates
      for (const updated of spawnedRuns) {
        current = updated;
      }

      // Refresh state from DB — no artificial delay needed since spawnTask
      // already awaited task completion
      const refreshed = this.repo.findById(current.id);
      if (!refreshed) return;
      current = refreshed;
    }
  }

  /**
   * Returns tasks whose all dependencies are completed and that are still pending.
   */
  getReadyTasks(run: OrchestrationRun): OrchestrationTask[] {
    const completedIds = new Set(
      run.tasks.filter((t) => t.status === "completed").map((t) => t.id),
    );
    return run.tasks.filter(
      (t) => t.status === "pending" && t.dependsOn.every((dep) => completedIds.has(dep)),
    );
  }

  private async spawnTask(
    run: OrchestrationRun,
    task: OrchestrationTask,
  ): Promise<OrchestrationRun> {
    // Mark as spawned immediately to prevent double-spawn
    const updated = this.updateTask(run, task.id, { status: "spawned" });
    this.repo.update(updated.id, { tasks: updated.tasks });

    try {
      let taskId = "";
      let remoteTaskId: string | undefined;
      if (task.acpAgentId) {
        const agent = getACPRegistry(this.db).getAgent(
          task.acpAgentId,
          this.deps.daemon.getActiveAgentRoles(),
        );
        if (!agent) {
          throw new Error(`ACP agent not found: ${task.acpAgentId}`);
        }
        if (agent.origin === "remote" && agent.endpoint) {
          const remoteResult = await this.remoteInvoker.invoke(agent, {
            assigneeId: task.acpAgentId,
            title: task.title,
            prompt: this.buildPromptWithContext(task, run),
            workspaceId: this.deps.workspaceId,
          });
          taskId = remoteResult.remoteTaskId || task.acpAgentId;
          remoteTaskId = remoteResult.remoteTaskId;
          if (remoteResult.status === "failed" || remoteResult.status === "cancelled") {
            throw new Error(remoteResult.error || `Remote ACP task ${remoteResult.status}`);
          }
        } else if (agent.origin === "local" && agent.localRoleId) {
          const childTask = await this.deps.daemon.createChildTask({
            title: task.title,
            prompt: this.buildPromptWithContext(task, run),
            workspaceId: this.deps.workspaceId,
            parentTaskId: this.deps.parentTaskId,
            agentType: "sub",
            assignedAgentRoleId: agent.localRoleId,
            agentConfig: {
              maxTurns: 30,
              retainMemory: false,
              ...(task.capabilityHint ? { capabilityHint: task.capabilityHint } : {}),
            },
          });
          taskId = childTask.id;
        } else {
          throw new Error(`ACP agent ${task.acpAgentId} is not invokable`);
        }
      } else {
        const childTask = await this.deps.daemon.createChildTask({
          title: task.title,
          prompt: this.buildPromptWithContext(task, run),
          workspaceId: this.deps.workspaceId,
          parentTaskId: this.deps.parentTaskId,
          agentType: "sub",
          agentConfig: {
            maxTurns: 30,
            retainMemory: false,
            ...(task.capabilityHint ? { capabilityHint: task.capabilityHint } : {}),
          },
        });
        taskId = childTask.id;
      }

      const afterSpawn = this.updateTask(updated, task.id, {
        status: "running",
        taskId,
        remoteTaskId,
        startedAt: Date.now(),
      });
      this.repo.update(afterSpawn.id, { tasks: afterSpawn.tasks });
      this.emit("task_spawned", { type: "task_spawned", nodeId: task.id, taskId });

      // Wait for completion
      const result = task.acpAgentId && remoteTaskId
        ? await this.waitForRemoteTask(task.acpAgentId, remoteTaskId, 600)
        : await this.waitForTask(taskId, 600);

      if (result.success) {
        const afterDone = this.updateTask(afterSpawn, task.id, {
          status: "completed",
          output: result.output,
          completedAt: Date.now(),
        });
        this.repo.update(afterDone.id, { tasks: afterDone.tasks });
        this.emit("task_completed", {
          type: "task_completed",
          nodeId: task.id,
          taskId,
          output: result.output ?? "",
        });
        return afterDone;
      } else {
        const afterFail = this.updateTask(afterSpawn, task.id, {
          status: "failed",
          error: result.error,
          completedAt: Date.now(),
        });
        this.repo.update(afterFail.id, { tasks: afterFail.tasks });
        this.emit("task_failed", {
          type: "task_failed",
          nodeId: task.id,
          taskId,
          error: result.error ?? "unknown",
        });
        return afterFail;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const afterError = this.updateTask(updated, task.id, {
        status: "failed",
        error,
        completedAt: Date.now(),
      });
      this.repo.update(afterError.id, { tasks: afterError.tasks });
      this.emit("task_failed", { type: "task_failed", nodeId: task.id, taskId: "", error });
      return afterError;
    }
  }

  /**
   * Build a prompt that injects outputs from completed dependency tasks as context.
   */
  private buildPromptWithContext(task: OrchestrationTask, run: OrchestrationRun): string {
    const deps = task.dependsOn
      .map((depId) => run.tasks.find((t) => t.id === depId))
      .filter((t): t is OrchestrationTask => !!t && t.status === "completed" && !!t.output);

    if (deps.length === 0) return task.prompt;

    const context = deps
      .map((d) => `### Output from "${d.title}"\n${d.output}`)
      .join("\n\n");

    return `${task.prompt}\n\n---\n## Context from preceding tasks\n\n${context}`;
  }

  private async waitForTask(
    taskId: string,
    timeoutSeconds: number,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    // Escalating backoff: check quickly at first, then back off
    let pollInterval = 1000;
    while (Date.now() < deadline) {
      try {
        const task = await this.deps.daemon.getTask(taskId);
        if (!task) {
          return { success: false, error: "Task not found" };
        }
        if (task.status === "completed") {
          return { success: true, output: task.resultSummary };
        }
        if (task.status === "failed" || task.status === "cancelled" || task.status === "interrupted") {
          return { success: false, error: (task.error ?? undefined) || task.status };
        }
      } catch {
        // Transient error — keep polling
      }
      await sleep(pollInterval);
      pollInterval = Math.min(pollInterval * 1.5, 10_000);
    }
    return { success: false, error: `Timed out after ${timeoutSeconds}s` };
  }

  private async waitForRemoteTask(
    acpAgentId: string,
    remoteTaskId: string,
    timeoutSeconds: number,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let pollInterval = 2000;
    while (Date.now() < deadline) {
      try {
        const agent = getACPRegistry(this.db).getAgent(
          acpAgentId,
          this.deps.daemon.getActiveAgentRoles(),
        );
        if (!agent || agent.origin !== "remote" || !agent.endpoint) {
          return { success: false, error: "ACP agent unavailable" };
        }
        const result = await this.remoteInvoker.pollStatus(agent, remoteTaskId);
        if (result.status === "completed") {
          return { success: true, output: result.result };
        }
        if (result.status === "failed" || result.status === "cancelled") {
          return { success: false, error: result.error || result.status };
        }
      } catch {
        // Keep polling on transient errors.
      }
      await sleep(pollInterval);
      pollInterval = Math.min(pollInterval * 1.5, 15_000);
    }
    return { success: false, error: `Timed out after ${timeoutSeconds}s` };
  }

  private updateTask(
    run: OrchestrationRun,
    nodeId: string,
    updates: Partial<OrchestrationTask>,
  ): OrchestrationRun {
    return {
      ...run,
      tasks: run.tasks.map((t) => (t.id === nodeId ? { ...t, ...updates } : t)),
    };
  }

  private setRunStatus(
    run: OrchestrationRun,
    status: OrchestrationRun["status"],
  ): OrchestrationRun {
    const updated = { ...run, status, completedAt: Date.now() };
    this.repo.update(run.id, { status, completedAt: updated.completedAt });
    return updated;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
