/** A server-owned input that has not yet been incorporated into a turn. */
export interface QueuedTaskInput {
  id: string;
  kind: "initial" | "follow_up";
  message: string;
  revision: number;
  /** Sent to wait until the current run finishes rather than steer it. */
  waitsForTurn?: boolean;
}

export interface EditQueuedTaskInput {
  taskId: string;
  id: string;
  kind: QueuedTaskInput["kind"];
  expectedMessage: string;
  expectedRevision: number;
  message: string;
}
