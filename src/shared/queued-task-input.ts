/** A server-owned input that has not yet been incorporated into a turn. */
export interface QueuedTaskInput {
  id: string;
  kind: "initial" | "follow_up";
  message: string;
  revision: number;
}

export interface EditQueuedTaskInput {
  taskId: string;
  id: string;
  kind: QueuedTaskInput["kind"];
  expectedMessage: string;
  expectedRevision: number;
  message: string;
}
