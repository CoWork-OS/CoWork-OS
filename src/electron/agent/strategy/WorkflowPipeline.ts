/**
 * WorkflowPipeline — manages sequential execution of workflow phases.
 *
 * Each phase becomes a child task.  When phase N completes, its output
 * is piped as context into phase N+1's prompt.
 */

import { EventEmitter } from "events";
import { WorkflowPhase } from "./WorkflowDecomposer";

export interface WorkflowPipelineDeps {
  createChildTask: (params: {
    title: string;
    prompt: string;
    workspaceId: string;
    parentTaskId: string;
    agentConfig?: Any;
  }) => Promise<{ id: string }>;
  getTaskStatus: (taskId: string) => Promise<{ status: string; resultSummary?: string }>;
  log?: (...args: unknown[]) => void;
}

export interface WorkflowPipelineState {
  id: string;
  rootTaskId: string;
  workspaceId: string;
  phases: WorkflowPhase[];
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

const POLL_INTERVAL_MS = 2000;
const DEFAULT_PHASE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per phase

export interface WorkflowPipelineOptions {
  /** Override the per-phase timeout (ms). Defaults to 5 minutes. */
  phaseTimeoutMs?: number;
}

export class WorkflowPipeline extends EventEmitter {
  private state: WorkflowPipelineState;
  private deps: WorkflowPipelineDeps;
  private phaseTimeoutMs: number;

  constructor(
    rootTaskId: string,
    workspaceId: string,
    phases: WorkflowPhase[],
    deps: WorkflowPipelineDeps,
    options?: WorkflowPipelineOptions,
  ) {
    super();
    this.deps = deps;
    this.phaseTimeoutMs = options?.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
    this.state = {
      id: `wf-${rootTaskId}`,
      rootTaskId,
      workspaceId,
      phases: phases.map((p) => ({ ...p, status: "pending" })),
      status: "pending",
    };
  }

  getState(): WorkflowPipelineState {
    return { ...this.state, phases: this.state.phases.map((p) => ({ ...p })) };
  }

  /**
   * Execute the pipeline: run each phase sequentially, piping outputs forward.
   */
  async execute(): Promise<WorkflowPipelineState> {
    this.state.status = "running";
    this.state.startedAt = Date.now();
    this.emit("pipeline_started", this.getState());

    let previousOutput = "";

    for (const phase of this.state.phases) {
      try {
        phase.status = "running";
        this.emit("phase_started", { phaseId: phase.id, pipeline: this.getState() });

        // Build phase prompt with context from previous phase
        let phasePrompt = phase.prompt;
        if (previousOutput) {
          phasePrompt = [
            `You are executing phase ${phase.order} of a multi-phase workflow.`,
            "",
            `Previous phase output:`,
            "---",
            previousOutput,
            "---",
            "",
            `Your task for this phase:`,
            phase.prompt,
          ].join("\n");
        }

        // Create child task
        const child = await this.deps.createChildTask({
          title: phase.title,
          prompt: phasePrompt,
          workspaceId: this.state.workspaceId,
          parentTaskId: this.state.rootTaskId,
          agentConfig: {
            retainMemory: false,
            bypassQueue: false,
            workflowPhaseId: phase.id,
            workflowPhaseType: phase.phaseType,
          },
        });

        phase.taskId = child.id;

        // Wait for completion
        const result = await this.waitForTask(child.id);

        if (result.status === "completed") {
          phase.status = "completed";
          phase.output = result.resultSummary || "";
          previousOutput = result.resultSummary || "";
          this.emit("phase_completed", {
            phaseId: phase.id,
            output: phase.output,
            pipeline: this.getState(),
          });
        } else {
          phase.status = "failed";
          this.state.status = "failed";
          this.state.error = `Phase ${phase.order} failed: ${result.status}`;
          this.emit("phase_failed", {
            phaseId: phase.id,
            error: result.status,
            pipeline: this.getState(),
          });
          break;
        }
      } catch (err) {
        phase.status = "failed";
        this.state.status = "failed";
        this.state.error = `Phase ${phase.order} error: ${err instanceof Error ? err.message : String(err)}`;
        this.emit("phase_failed", {
          phaseId: phase.id,
          error: this.state.error,
          pipeline: this.getState(),
        });
        break;
      }
    }

    if (this.state.status === "running") {
      this.state.status = "completed";
    }
    this.state.completedAt = Date.now();
    this.emit("pipeline_completed", this.getState());

    return this.getState();
  }

  /**
   * Poll task status until terminal.
   */
  private async waitForTask(taskId: string): Promise<{ status: string; resultSummary?: string }> {
    const deadline = Date.now() + this.phaseTimeoutMs;

    while (Date.now() < deadline) {
      const status = await this.deps.getTaskStatus(taskId);
      if (
        status.status === "completed" ||
        status.status === "failed" ||
        status.status === "cancelled"
      ) {
        return status;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    return { status: "timeout" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
