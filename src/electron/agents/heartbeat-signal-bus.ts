import type { SubmitHeartbeatSignalInput } from "./HeartbeatSignalStore";

/**
 * Fire-and-forget bridge for emitting Heartbeat signals from modules that must not depend on
 * HeartbeatService (e.g. the agent daemon). main.ts registers the emitter once Heartbeat exists;
 * until then, and after shutdown, signals are dropped.
 */
export type HeartbeatSignalForAllInput = Omit<SubmitHeartbeatSignalInput, "agentRoleId">;
type HeartbeatSignalEmitter = (input: HeartbeatSignalForAllInput) => Promise<unknown>;

let emitter: HeartbeatSignalEmitter | null = null;

export function setHeartbeatSignalEmitter(next: HeartbeatSignalEmitter | null): void {
  emitter = next;
}

/** Submit a signal to every heartbeat-enabled agent. Never throws. */
export function emitHeartbeatSignal(input: HeartbeatSignalForAllInput): void {
  const current = emitter;
  if (!current) return;
  try {
    void current(input).catch(() => {
      // Signals are advisory; a failed submission must not affect the caller.
    });
  } catch {
    // Same as above for synchronous failures.
  }
}

/**
 * Emit `correction_learning` when the user corrects the agent mid-task. Repeated corrections
 * in a workspace merge into one signal; the user's text is not copied into the signal.
 */
export function emitCorrectionLearningSignal(params: {
  workspaceId: string;
  taskId: string;
}): void {
  emitHeartbeatSignal({
    workspaceId: params.workspaceId,
    signalFamily: "correction_learning",
    source: "tasks",
    // Below the dispatch thresholds: this signal is meant for Dreaming, not for new tasks.
    urgency: "low",
    confidence: 0.6,
    fingerprint: `correction_learning:${params.workspaceId}`,
    reason: "User corrected the agent during a task",
    evidenceRefs: [`task:${params.taskId}`],
  });
}
