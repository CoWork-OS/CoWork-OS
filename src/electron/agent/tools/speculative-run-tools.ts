/**
 * `speculative_runs`: a read-only view of the speculative reproduce-and-fix runs that
 * `speculate_fix` triggers started for this workspace, and how each one ended.
 */
import type { SpeculativeRun, Workspace } from "../../../shared/types";
import type { LLMTool } from "../llm/types";
import { getActiveSpeculativeFixService } from "../../triggers/SpeculativeFixService";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function summarizeRun(run: SpeculativeRun): Record<string, unknown> {
  return {
    id: run.id,
    trigger: run.triggerName,
    status: run.status,
    outcome: run.outcome,
    delivery: run.delivery,
    destination: run.destination,
    issue: run.issueExcerpt,
    startedAt: new Date(run.startedAt).toISOString(),
    ...(run.finishedAt ? { finishedAt: new Date(run.finishedAt).toISOString() } : {}),
    ...(run.taskId ? { taskId: run.taskId } : {}),
    ...(run.report
      ? {
          reproduced: run.report.reproduced,
          fixed: run.report.fixed,
          summary: run.report.summary,
          testEvidence: run.report.testEvidence.slice(0, 500),
        }
      : {}),
    ...(typeof run.filesChanged === "number"
      ? {
          diffStat: {
            filesChanged: run.filesChanged,
            linesAdded: run.linesAdded ?? 0,
            linesRemoved: run.linesRemoved ?? 0,
          },
        }
      : {}),
    ...(run.branchName ? { branch: run.branchName } : {}),
    ...(run.prUrl ? { pullRequest: run.prUrl } : {}),
    ...(run.worktreeKept ? { worktreeKept: true } : {}),
    ...(run.note ? { note: run.note } : {}),
  };
}

export class SpeculativeRunTools {
  /** Reads the workspace on each call: the task's workspace can change while it runs. */
  constructor(private readonly getWorkspace: () => Pick<Workspace, "id">) {}

  /** Offered only while the speculative fix runtime is running. */
  static isAvailable(): boolean {
    return getActiveSpeculativeFixService() !== null;
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "speculative_runs",
        description:
          "List recent speculative reproduce-and-fix runs for this workspace and how each ended. " +
          "Use when the user asks what the background bug-fixing runs did, whether a reported " +
          "problem was reproduced, or where a candidate fix or its pull request is. Read-only: " +
          "it never starts, stops, or delivers a run.",
        input_schema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: `How many runs to return, newest first (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})`,
            },
            status: {
              type: "string",
              enum: ["running", "delivered", "discarded", "failed"],
              description: "Only runs in this state",
            },
          },
        },
      },
    ];
  }

  async listRuns(input: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const service = getActiveSpeculativeFixService();
    if (!service) {
      return { success: false, error: "Speculative fix runs are not available in this runtime." };
    }
    const rawLimit = Number(input?.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.round(rawLimit)))
      : DEFAULT_LIMIT;
    const status = typeof input?.status === "string" ? input.status : undefined;
    const runs = service
      .listRuns({ workspaceId: this.getWorkspace().id, limit: status ? 100 : limit })
      .filter((run) => !status || run.status === status)
      .slice(0, limit);
    return { success: true, count: runs.length, runs: runs.map(summarizeRun) };
  }
}
