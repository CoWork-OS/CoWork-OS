/**
 * Messages between the host `DatabaseClient` and `database-worker` (async SQLite
 * migration plan, DB2). Everything here must survive structured clone: no
 * functions, database handles, or class instances.
 */

export const DATABASE_PROTOCOL_VERSION = 1;

export type DatabaseCommandKind = "read" | "write";

/**
 * Whether a failed request may have changed the database.
 * - `not_committed`: nothing was committed; retrying is safe if the caller wants to.
 * - `unknown`: the worker may have committed before the failure (for example it exited
 *   after COMMIT but before replying). Reconcile against durable state; never blindly retry.
 */
export type DatabaseFailureOutcome = "not_committed" | "unknown";

export type DatabaseErrorCode =
  | "busy_timeout"
  | "cancelled"
  | "closed"
  | "command_failed"
  | "deadline_exceeded"
  | "invalid_request"
  | "overloaded"
  | "reply_timeout"
  | "worker_exited"
  | "worker_unavailable";

export interface DatabaseWorkerData {
  protocolVersion: number;
  generation: number;
  dbPath: string;
  /** In-connection busy wait; the scheduler retries lock conflicts beyond it. */
  busyTimeoutMs: number;
  /** Tables the registered commands need; startup fails if any is missing. */
  requiredTables: string[];
  /**
   * Schema version the host initialized (`PRAGMA user_version`, DB6). When set, the
   * worker reports ready only if the database carries exactly this version.
   */
  schemaVersion?: number;
  /** Tests only: absolute path of a CommonJS module exporting extra commands. */
  testCommandsModule?: string;
  /**
   * Reporting reader: open the database read-only and refuse write commands. A reader
   * runs heavy scans without holding up the write worker (plan decision 2).
   */
  readonly?: boolean;
}

export interface DatabaseRequestMessage {
  type: "request";
  requestId: number;
  generation: number;
  command: string;
  kind: DatabaseCommandKind;
  args: unknown;
  /**
   * Requests with the same key keep their relative order. Without a key, a read may
   * run ahead of writes that are waiting for the write lock.
   */
  orderingKey?: string;
  /** Epoch ms; a request still queued at this time is rejected as `deadline_exceeded`. */
  deadlineAt: number;
}

export interface DatabaseShutdownMessage {
  type: "shutdown";
}

/** Drop a request that has not started; a running statement cannot be interrupted. */
export interface DatabaseCancelMessage {
  type: "cancel";
  requestId: number;
}

export type HostToWorkerMessage =
  | DatabaseRequestMessage
  | DatabaseShutdownMessage
  | DatabaseCancelMessage;

export interface DatabaseReadyMessage {
  type: "ready";
  generation: number;
  protocolVersion: number;
  sqliteVersion: string;
  commands: Array<{ name: string; kind: DatabaseCommandKind }>;
}

export interface DatabaseStartupFailedMessage {
  type: "startup_failed";
  generation: number;
  message: string;
}

export interface DatabaseErrorPayload {
  code: DatabaseErrorCode;
  message: string;
  outcome: DatabaseFailureOutcome;
  sqliteCode?: string;
}

export type DatabaseResponseMessage =
  | {
      type: "response";
      requestId: number;
      generation: number;
      ok: true;
      result: unknown;
      /** Worker-side execution time, excluding queueing. */
      durationMs: number;
    }
  | {
      type: "response";
      requestId: number;
      generation: number;
      ok: false;
      error: DatabaseErrorPayload;
    };

export interface DatabaseDrainedMessage {
  type: "drained";
  generation: number;
}

export type WorkerToHostMessage =
  | DatabaseReadyMessage
  | DatabaseStartupFailedMessage
  | DatabaseResponseMessage
  | DatabaseDrainedMessage;

export class DatabaseRequestError extends Error {
  readonly code: DatabaseErrorCode;
  readonly outcome: DatabaseFailureOutcome;
  readonly sqliteCode?: string;

  constructor(payload: DatabaseErrorPayload) {
    super(payload.message);
    this.name = "DatabaseRequestError";
    this.code = payload.code;
    this.outcome = payload.outcome;
    this.sqliteCode = payload.sqliteCode;
  }
}
