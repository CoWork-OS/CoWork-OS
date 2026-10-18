import type { Task, TaskEvent } from "../../shared/types";
import type { EditQueuedTaskInput, QueuedTaskInput } from "../../shared/queued-task-input";
import type { SessionRuntime } from "./runtime/SessionRuntime";

function editableReceipts(events: TaskEvent[]): TaskEvent[] {
  const latest = new Map<string, TaskEvent>();
  for (const event of events) {
    const p = event.payload;
    if (
      (event.legacyType || p?.legacyType || event.type) === "user_message" &&
      typeof p?.messageId === "string"
    )
      latest.set(p.messageId, event);
  }
  return [...latest.values()].filter(
    ({ payload: p }) =>
      p.deliveryMode === "follow_up" &&
      (p.deliveryStatus ?? p.status) === "queued" &&
      p.messageSource !== "agent" &&
      typeof p.message === "string" &&
      p.message.length <= 60_000 &&
      !p.__coworkPayloadTruncated &&
      !p.annotationContextInjected,
  );
}

export function listQueuedTaskInputs(
  task: Task,
  queued: boolean,
  events: TaskEvent[],
  runtime?: SessionRuntime,
): QueuedTaskInput[] {
  if (task.status === "queued" && queued)
    return [{ id: task.id, kind: "initial", message: task.prompt, revision: task.updatedAt ?? 0 }];
  if (["cancelled", "failed"].includes(task.status)) return [];
  return editableReceipts(events)
    .filter(({ payload: p }) => !runtime?.isFollowUpMessageConsumed(p.messageId))
    .map(({ payload: p }) => ({
      id: p.messageId,
      kind: "follow_up",
      message: p.message,
      revision: p.queuedEditRevision ?? 0,
    }));
}

/** No await between checking admission and updating the receipt/queue: the turn may drain it. */
export function editQueuedFollowUp(
  input: EditQueuedTaskInput,
  events: TaskEvent[],
  runtime: SessionRuntime | undefined,
  persist: (event: TaskEvent) => void,
): QueuedTaskInput {
  const event = editableReceipts(events).find((e) => e.payload.messageId === input.id);
  if (!event || runtime?.isFollowUpMessageConsumed(input.id))
    throw new Error("This message has already started. Send a new message to steer the task.");
  const p = event.payload;
  const revision = p.queuedEditRevision ?? 0;
  if (p.message !== input.expectedMessage || revision !== input.expectedRevision)
    throw new Error("This queued message changed in another window. Reload it before saving.");
  const pending = runtime?.state.queues.pendingFollowUps.find((f) => f.messageId === input.id);
  // A live queue without this item may already have handed it to the executor.
  if (runtime && !pending) throw new Error("This message is no longer waiting in the queue.");
  const message = input.message.trim();
  if (!message) throw new Error("Message cannot be empty.");
  if (message.length > 60_000)
    throw new Error(
      "Queued follow-up edits must be at most 60,000 characters so their full text survives recovery.",
    );
  const updated = {
    ...event,
    payload: { ...p, message, queuedEditRevision: revision + 1, editedAt: Date.now() },
  };
  persist(updated);
  // Preserve the object identity: a drain may already hold a reference to it.
  if (pending) pending.message = message;
  runtime?.saveSnapshot();
  return { id: input.id, kind: "follow_up", message, revision: revision + 1 };
}
