/**
 * Adapters from the app's stores to the attention queue's sources. Kept apart from the IPC
 * wiring so each one can be tested with a plain fake.
 */
import type { AttentionCommitment, AttentionFlowStep } from "../../shared/attention";
import type {
  RoutineWorkflowRunRecord,
  RoutineWorkflowStepRecord,
} from "../../shared/routine-workflow";
import type { MemoryCurationChange } from "../../shared/memory-review-types";
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

/** Active suggestions across the saved workspaces, each with the workspace it belongs to. */
export async function listSuggestionsAcross(
  workspaces: Workspace[],
  listActive: (
    workspaceId: string,
    options: undefined,
    workspaceIds: string[],
  ) => Promise<ProactiveSuggestion[]>,
): Promise<Array<{ workspaceId: string; suggestion: ProactiveSuggestion }>> {
  const saved = suggestionWorkspaces(workspaces);
  if (saved.length === 0) return [];
  const ids = saved.map((workspace) => workspace.id);
  const suggestions = await listActive(ids[0], undefined, ids);
  return suggestions.map((suggestion) => ({
    workspaceId: suggestion.workspaceId || ids[0],
    suggestion,
  }));
}

/** How long an automatic commitment expiry stays in the queue for undo. */
export const MEMORY_CHANGE_WINDOW_MS = 48 * 60 * 60 * 1000;

type MemoryChangeEntry = { workspaceId: string; change: MemoryCurationChange };

/**
 * Recent automatic commitment expiries across the saved workspaces, newest first. A
 * workspace that cannot be read is skipped; if none can be read the error is passed on, so
 * the queue reports the source as failed.
 */
export async function listMemoryChangesAcross(
  workspaces: Workspace[],
  recentSince: (workspaceId: string, since: number) => Promise<MemoryCurationChange[]>,
  now = Date.now(),
): Promise<MemoryChangeEntry[]> {
  const saved = suggestionWorkspaces(workspaces);
  const since = now - MEMORY_CHANGE_WINDOW_MS;
  const results = await Promise.allSettled(
    saved.map(async (workspace) =>
      (await recentSince(workspace.id, since)).map((change) => ({
        workspaceId: workspace.id,
        change,
      })),
    ),
  );
  const read = results.filter(
    (result): result is PromiseFulfilledResult<MemoryChangeEntry[]> =>
      result.status === "fulfilled",
  );
  if (saved.length > 0 && read.length === 0) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
  return read
    .flatMap((result) => result.value)
    .sort((a, b) => b.change.appliedAt - a.change.appliedAt);
}
