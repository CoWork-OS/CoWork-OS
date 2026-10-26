import type { Task } from "../shared/types";

/**
 * Pauses that can't clear while `cowork run` waits: the daemon doesn't retry them, so the task
 * stays paused until someone fixes the cause and resumes it.
 */
const STUCK_PAUSE_REASONS = new Set(["access_profile_unavailable"]);

export interface RunUserActionStop {
  payload: Record<string, unknown>;
  text: string;
}

/**
 * Whether `cowork run` should stop waiting (exit 3) because a person must act. The daemon marks
 * those pauses `needs_user_action`; other pauses and blocks (an application operation still
 * running, an event wait, independent verification) clear on their own and are waited out.
 * `--exit-on-input` stops at any of them, and a pause that can't clear stops the run anyway.
 */
export function describeUserActionStop(
  task: Pick<Task, "id" | "status" | "terminalStatus" | "awaitingUserInputReasonCode" | "error">,
  options: { exitOnInput: boolean },
): RunUserActionStop | null {
  if (task.status !== "paused" || task.terminalStatus !== "needs_user_action") return null;
  const reason = task.awaitingUserInputReasonCode?.trim() || "needs_user_action";
  if (!options.exitOnInput && !STUCK_PAUSE_REASONS.has(reason)) return null;
  const message = task.error?.trim() || "The task is waiting for a person to act.";
  return {
    payload: { type: "needs_user_action", reason, taskId: task.id, message },
    text: `Needs your action: ${message}`,
  };
}

/** `cowork run --timeout-ms`: a whole number of milliseconds above zero, or absent. */
export function validateRunTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("--timeout-ms must be a whole number of milliseconds greater than 0.");
  }
  return value;
}
