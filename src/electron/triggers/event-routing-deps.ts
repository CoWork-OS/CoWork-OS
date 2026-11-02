/**
 * Wiring for the event trigger engine's semantic gate and thread subscriptions, shared by
 * the desktop app and the headless daemon so both route events the same way.
 */

import type Database from "better-sqlite3";
import { ThreadSubscriptionRepository, TaskRepository } from "../database/repository-facades";
import { EventGateSettingsManager } from "../settings/event-gate-manager";
import { deriveCanonicalTaskStatus, isTerminalTaskStatus } from "../../shared/task-status";
import { runSemanticGate } from "./semantic-gate";
import { formatThreadEventMessage } from "./thread-subscriptions";
import type { EventTriggerServiceDeps } from "./types";

type RoutingDeps = Pick<
  EventTriggerServiceDeps,
  | "resolveGateMode"
  | "runSemanticGate"
  | "findActiveThreadSubscribers"
  | "deliverThreadEvent"
  | "subscribeThread"
>;

export interface EventRoutingDaemon {
  sendMessage(taskId: string, message: string): Promise<unknown>;
}

export function createEventRoutingDeps(input: {
  db: Database.Database;
  agentDaemon: EventRoutingDaemon;
  /** Rejects when this runtime no longer owns automation (desktop and daemon on one profile). */
  assertOwnership?: () => Promise<void>;
}): RoutingDeps {
  const subscriptions = new ThreadSubscriptionRepository(input.db);
  return {
    resolveGateMode: (event) => EventGateSettingsManager.resolveEventMode(event),
    runSemanticGate: ({ trigger, event }) =>
      runSemanticGate({
        source: event.source,
        fields: event.fields,
        policies: EventGateSettingsManager.enabledPolicyTexts(),
        sourceId: trigger.id,
        workspaceId: trigger.workspaceId || undefined,
      }),
    findActiveThreadSubscribers: (threadKey) => subscriptions.findActiveSubscribers(threadKey),
    deliverThreadEvent: async ({ taskId, threadKey, event }) => {
      await input.assertOwnership?.();
      // No user_typed provenance: the text is an external event, never the user's words.
      await input.agentDaemon.sendMessage(taskId, formatThreadEventMessage(threadKey, event));
    },
    subscribeThread: async (threadKey, taskId) => {
      await subscriptions.subscribe(threadKey, taskId, Date.now());
    },
  };
}

const LIFECYCLE_EVENTS = [
  "task_completed",
  "task_cancelled",
  "task_failed",
  "task_status",
] as const;

export interface TaskLifecycleSource {
  on?(event: string, listener: (payload: { taskId?: unknown }) => void): unknown;
  off?(event: string, listener: (payload: { taskId?: unknown }) => void): unknown;
}

/**
 * Drop a task's thread subscriptions once it completes, fails or is cancelled, so its
 * threads go back to starting new work. Returns a detach function.
 */
export function attachThreadSubscriptionCleanup(input: {
  db: Database.Database;
  daemon: TaskLifecycleSource;
  log?: (...args: unknown[]) => void;
}): () => void {
  // Test doubles of the daemon may not emit lifecycle events.
  if (typeof input.daemon.on !== "function") return () => {};
  const subscriptions = new ThreadSubscriptionRepository(input.db);
  const tasks = new TaskRepository(input.db);
  const listener = (payload: { taskId?: unknown }) => {
    const taskId = typeof payload?.taskId === "string" ? payload.taskId : "";
    if (!taskId) return;
    void (async () => {
      const task = await tasks.findById(taskId);
      if (task && !isTerminalTaskStatus(deriveCanonicalTaskStatus(task))) return;
      await subscriptions.unsubscribeTask(taskId);
    })().catch((error: unknown) =>
      input.log?.("[ThreadSubscriptions] Could not clear a finished task's subscriptions:", error),
    );
  };
  for (const event of LIFECYCLE_EVENTS) input.daemon.on(event, listener);
  return () => {
    for (const event of LIFECYCLE_EVENTS) input.daemon.off?.(event, listener);
  };
}
