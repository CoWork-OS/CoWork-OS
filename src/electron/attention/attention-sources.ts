/**
 * Adapters from the app's stores to the attention queue's sources. Kept apart from the IPC
 * wiring so each one can be tested with a plain fake.
 */
import type { AttentionCommitment, AttentionFlowStep } from "../../shared/attention";
import type {
  RoutineWorkflowRunRecord,
  RoutineWorkflowStepRecord,
} from "../../shared/routine-workflow";
import type { ProactiveSuggestion, Workspace } from "../../shared/types";

type MaybePromise<T> = T | Promise<T>;

/** The parts of the routine service the queue reads. */
export interface WorkflowRunReader {
  listWorkflowRuns: (
    routineId?: string,
    limit?: number,
  ) => MaybePromise<RoutineWorkflowRunRecord[]>;
  listWorkflowRunSteps: (runId: string) => MaybePromise<RoutineWorkflowStepRecord[]>;
  get: (routineId: string) => MaybePromise<{ name?: string } | null | undefined>;
}

/** How many recent flow runs to scan for steps waiting on an approval. */
const FLOW_RUN_SCAN_LIMIT = 100;

/** Flow steps paused for the user's approval, one entry per waiting step. */
export async function listWaitingFlowSteps(
  routines: WorkflowRunReader | null,
): Promise<AttentionFlowStep[]> {
  if (!routines) return [];
  const runs = (await routines.listWorkflowRuns(undefined, FLOW_RUN_SCAN_LIMIT)).filter(
    (run) => run.status === "waiting_for_approval",
  );
  const names = new Map<string, string>();
  const waiting: AttentionFlowStep[] = [];
  for (const run of runs) {
    if (!names.has(run.routineId)) {
      const routine = await routines.get(run.routineId);
      names.set(run.routineId, routine?.name?.trim() || "An automation");
    }
    const steps = await routines.listWorkflowRunSteps(run.id);
    for (const step of steps) {
      if (step.status !== "waiting_for_approval") continue;
      waiting.push({
        routineId: run.routineId,
        routineName: names.get(run.routineId)!,
        runId: run.id,
        stepId: step.id,
        message: step.error,
        waitingSince: step.updatedAt || run.updatedAt,
      });
    }
  }
  return waiting;
}

/** The commitment fields the queue reads. */
export function toAttentionCommitment(item: {
  id: string;
  text: string;
  dueAt?: number;
  createdAt?: number;
}): AttentionCommitment {
  return { id: item.id, text: item.text, dueAt: item.dueAt, createdAt: item.createdAt };
}

/** Saved workspaces only: temporary scratch workspaces carry no suggestions. */
export function suggestionWorkspaces(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter(
    (workspace) => !workspace.isTemp && !String(workspace.id).startsWith("__temp_workspace__"),
  );
}

/**
 * Active suggestions across the saved workspaces, each with the workspace it belongs to.
 * Reading the queue is not showing anyone a suggestion, so it records no "surfaced" event:
 * otherwise every refresh would count as one, and a day later as "ignored", which lowers the
 * suggestion's ranking.
 */
export async function listSuggestionsAcross(
  workspaces: Workspace[],
  listActive: (
    workspaceId: string,
    options: { recordSurface: false },
    workspaceIds: string[],
  ) => Promise<ProactiveSuggestion[]>,
): Promise<Array<{ workspaceId: string; suggestion: ProactiveSuggestion }>> {
  const saved = suggestionWorkspaces(workspaces);
  if (saved.length === 0) return [];
  const ids = saved.map((workspace) => workspace.id);
  const suggestions = await listActive(ids[0], { recordSurface: false }, ids);
  return suggestions.map((suggestion) => ({
    workspaceId: suggestion.workspaceId || ids[0],
    suggestion,
  }));
}
