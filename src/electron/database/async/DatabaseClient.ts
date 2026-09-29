import path from "path";
import { Worker } from "worker_threads";
import { createLogger } from "../../utils/logger";
import type { DatabaseCommandArgs, DatabaseCommandName, DatabaseCommandResult } from "./commands";
import {
  DATABASE_PROTOCOL_VERSION,
  type DatabaseCommandKind,
  type DatabaseErrorPayload,
  DatabaseRequestError,
  type DatabaseWorkerData,
  type HostToWorkerMessage,
  type WorkerToHostMessage,
} from "./protocol";

const logger = createLogger("DatabaseClient");

export interface DatabaseClientOptions {
  dbPath: string;
  requiredTables: string[];
  /** Refuse to start unless the database carries this schema version (DB6). */
  expectedSchemaVersion?: number;
  /** Compiled worker entry point; defaults to `database-worker.js` next to this file. */
  workerPath?: string;
  /** In-connection busy wait inside the worker. Kept short: the scheduler parks and retries. */
  busyTimeoutMs?: number;
  startupTimeoutMs?: number;
  /** Default time a request may wait in the worker's queue before it is rejected. */
  readDeadlineMs?: number;
  writeDeadlineMs?: number;
  /** Extra time after the deadline before an unanswered request fails as a reply timeout. */
  replyGraceMs?: number;
  maxPending?: number;
  maxPendingBytes?: number;
  /** Unexpected exits tolerated before the client stays failed. */
  maxRestarts?: number;
  /** Tests only: extra worker commands for crash and contention scenarios. */
  testCommandsModule?: string;
  /** Start a read-only reporting reader instead of the write worker. */
  readonly?: boolean;
}

export interface DatabaseRequestOptions {
  /** Overrides the default queue deadline for this request. */
  deadlineMs?: number;
  orderingKey?: string;
  /**
   * Cancels the request if it has not started. A read rejects at once as `cancelled`; a
   * write keeps waiting for the worker, which reports either `cancelled` (not committed)
   * or the real outcome if it was already running.
   */
  signal?: AbortSignal;
}

export type DatabaseClientState =
  | "starting"
  | "ready"
  | "restarting"
  | "closing"
  | "closed"
  | "failed";

interface PendingRequest {
  command: string;
  kind: DatabaseCommandKind;
  bytes: number;
  resolve(value: unknown): void;
  reject(error: DatabaseRequestError): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
}

const DEFAULTS = {
  busyTimeoutMs: 50,
  startupTimeoutMs: 10_000,
  readDeadlineMs: 10_000,
  writeDeadlineMs: 15_000,
  replyGraceMs: 30_000,
  maxPending: 256,
  maxPendingBytes: 8 * 1024 * 1024,
  maxRestarts: 3,
};
const RESTART_BASE_DELAY_MS = 500;

function argumentBytes(args: unknown): number {
  if (args === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(args) ?? "", "utf8");
  } catch {
    // Not JSON-serializable; postMessage decides whether it can be cloned.
    return 0;
  }
}

/**
 * Host side of the database worker (async SQLite migration plan, DB2). Requests are
 * asynchronous and resolve only after the worker has committed; failures carry an
 * outcome that says whether anything may have been committed.
 *
 * Pending work is bounded by count and bytes, so an unavailable or slow worker yields
 * explicit `overloaded` or `worker_unavailable` errors instead of a growing queue.
 * Any unexpected worker exit, including code 0, fails in-flight requests (writes as
 * `unknown`) and triggers a bounded number of restarts with a new generation; replies
 * from an older generation are ignored.
 */
export class DatabaseClient {
  private readonly options: Required<
    Omit<DatabaseClientOptions, "testCommandsModule" | "readonly" | "expectedSchemaVersion">
  > &
    Pick<DatabaseClientOptions, "testCommandsModule" | "readonly" | "expectedSchemaVersion">;
  private worker: Worker | null = null;
  private generation = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private pendingBytes = 0;
  private readonly commandKinds = new Map<string, DatabaseCommandKind>();
  private state: DatabaseClientState = "starting";
  private restarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private drainWaiter: (() => void) | null = null;

  private constructor(options: DatabaseClientOptions) {
    this.options = {
      ...DEFAULTS,
      workerPath: path.join(__dirname, "database-worker.js"),
      ...options,
    };
  }

  /** Spawn the worker and wait for its ready handshake. */
  static async start(options: DatabaseClientOptions): Promise<DatabaseClient> {
    const client = new DatabaseClient(options);
    try {
      await client.spawn();
    } catch (error) {
      client.state = "failed";
      throw error;
    }
    return client;
  }

  getState(): DatabaseClientState {
    return this.state;
  }

  getStatus(): {
    state: DatabaseClientState;
    generation: number;
    pending: number;
    restarts: number;
  } {
    return {
      state: this.state,
      generation: this.generation,
      pending: this.pending.size,
      restarts: this.restarts,
    };
  }

  execute<Name extends DatabaseCommandName>(
    command: Name,
    args: DatabaseCommandArgs<Name>,
    options?: DatabaseRequestOptions,
  ): Promise<DatabaseCommandResult<Name>> {
    return this.executeCommand(command, args, options) as Promise<DatabaseCommandResult<Name>>;
  }

  /** Untyped variant for commands registered outside `DATABASE_COMMANDS` (tests). */
  executeCommand(
    command: string,
    args: unknown,
    options: DatabaseRequestOptions = {},
  ): Promise<unknown> {
    const fail = (payload: DatabaseErrorPayload) =>
      Promise.reject(new DatabaseRequestError(payload));
    if (this.state !== "ready" || !this.worker) {
      return fail({
        code: this.state === "closing" || this.state === "closed" ? "closed" : "worker_unavailable",
        message: `Database worker is ${this.state}`,
        outcome: "not_committed",
      });
    }
    const kind = this.commandKinds.get(command);
    if (kind === "write" && this.options.readonly) {
      return fail({
        code: "invalid_request",
        message: `${command} is a write command; this client is a read-only reader`,
        outcome: "not_committed",
      });
    }
    if (!kind) {
      return fail({
        code: "invalid_request",
        message: `Unknown database command: ${command}`,
        outcome: "not_committed",
      });
    }
    const bytes = argumentBytes(args);
    if (
      this.pending.size >= this.options.maxPending ||
      this.pendingBytes + bytes > this.options.maxPendingBytes
    ) {
      return fail({
        code: "overloaded",
        message: `Database worker queue is full (${this.pending.size} requests)`,
        outcome: "not_committed",
      });
    }

    const deadlineMs =
      options.deadlineMs ??
      (kind === "write" ? this.options.writeDeadlineMs : this.options.readDeadlineMs);
    const requestId = this.nextRequestId++;
    const message: HostToWorkerMessage = {
      type: "request",
      requestId,
      generation: this.generation,
      command,
      kind,
      args,
      deadlineAt: Date.now() + deadlineMs,
      ...(options.orderingKey ? { orderingKey: options.orderingKey } : {}),
    };

    if (options.signal?.aborted) {
      return fail({
        code: "cancelled",
        message: `${command} was cancelled before it was sent`,
        outcome: "not_committed",
      });
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(requestId)) return;
        try {
          this.worker?.postMessage({ type: "cancel", requestId } satisfies HostToWorkerMessage);
        } catch {
          // The worker is gone; its exit handler settles the request.
        }
        if (kind === "read") {
          this.settle(requestId, {
            code: "cancelled",
            message: `${command} was cancelled`,
            outcome: "not_committed",
          });
        }
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        this.settle(requestId, {
          code: "reply_timeout",
          message: `No reply for ${command} within ${deadlineMs + this.options.replyGraceMs} ms`,
          outcome: kind === "write" ? "unknown" : "not_committed",
        });
      }, deadlineMs + this.options.replyGraceMs);
      timer.unref?.();
      this.pending.set(requestId, {
        command,
        kind,
        bytes,
        resolve,
        reject,
        timer,
        cleanup: options.signal
          ? () => options.signal?.removeEventListener("abort", onAbort)
          : undefined,
      });
      this.pendingBytes += bytes;
      try {
        this.worker!.postMessage(message);
      } catch (error) {
        this.settle(requestId, {
          code: "invalid_request",
          message: `Arguments for ${command} could not be sent: ${error instanceof Error ? error.message : String(error)}`,
          outcome: "not_committed",
        });
      }
    });
  }

  /**
   * Stop accepting requests, let the worker drain queued work, and wait for it to exit.
   * Returns `drained: false` if the deadline passed; unfinished writes then fail as `unknown`.
   */
  async close(timeoutMs = 10_000): Promise<{ drained: boolean }> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.state === "closed") return { drained: true };
    const worker = this.worker;
    this.state = "closing";
    if (!worker) {
      this.state = "closed";
      this.failAll("closed", "Database client closed");
      return { drained: true };
    }
    const drained = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      this.drainWaiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      worker.postMessage({ type: "shutdown" } satisfies HostToWorkerMessage);
    });
    this.drainWaiter = null;
    this.worker = null;
    this.state = "closed";
    this.failAll("closed", "Database client closed before the worker replied");
    await worker.terminate().catch(() => undefined);
    return { drained };
  }

  private spawn(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    const workerData: DatabaseWorkerData = {
      protocolVersion: DATABASE_PROTOCOL_VERSION,
      generation,
      dbPath: this.options.dbPath,
      busyTimeoutMs: this.options.busyTimeoutMs,
      requiredTables: this.options.requiredTables,
      ...(this.options.expectedSchemaVersion !== undefined
        ? { schemaVersion: this.options.expectedSchemaVersion }
        : {}),
      ...(this.options.readonly ? { readonly: true } : {}),
      ...(this.options.testCommandsModule
        ? { testCommandsModule: this.options.testCommandsModule }
        : {}),
    };
    const worker = new Worker(this.options.workerPath, { workerData });

    return new Promise<void>((resolve, reject) => {
      let started = false;
      const startupTimer = setTimeout(() => {
        if (started) return;
        started = true;
        void worker.terminate();
        reject(
          new Error(
            `Database worker did not become ready within ${this.options.startupTimeoutMs} ms`,
          ),
        );
      }, this.options.startupTimeoutMs);

      worker.on("message", (message: WorkerToHostMessage) => {
        if (message.generation !== generation) return;
        if (message.type === "ready") {
          if (started) return;
          started = true;
          clearTimeout(startupTimer);
          this.commandKinds.clear();
          for (const command of message.commands) this.commandKinds.set(command.name, command.kind);
          this.worker = worker;
          this.state = "ready";
          resolve();
          return;
        }
        if (message.type === "startup_failed") {
          if (started) return;
          started = true;
          clearTimeout(startupTimer);
          reject(new Error(`Database worker failed to start: ${message.message}`));
          return;
        }
        if (message.type === "drained") {
          this.drainWaiter?.();
          return;
        }
        if (message.type === "response") {
          if (message.ok) {
            // A worker that answers is healthy again.
            this.restarts = 0;
            this.settle(message.requestId, null, message.result);
          } else {
            this.settle(message.requestId, message.error);
          }
        }
      });
      worker.on("error", (error) => {
        logger.error("Database worker error:", error);
      });
      worker.on("exit", (code) => {
        clearTimeout(startupTimer);
        if (!started) {
          started = true;
          reject(new Error(`Database worker exited during startup (code ${code})`));
          return;
        }
        if (this.worker === worker) this.handleUnexpectedExit(code);
      });
    });
  }

  private handleUnexpectedExit(code: number): void {
    this.worker = null;
    if (this.state === "closing" || this.state === "closed") return;
    logger.error(`Database worker exited unexpectedly (code ${code})`);
    this.failAll(
      "worker_exited",
      `Database worker exited (code ${code}) before replying`,
      "unknown",
    );
    if (this.restarts >= this.options.maxRestarts) {
      this.state = "failed";
      logger.error(`Database worker exceeded ${this.options.maxRestarts} restarts; staying down`);
      return;
    }
    this.state = "restarting";
    const delay = RESTART_BASE_DELAY_MS * 2 ** this.restarts;
    this.restarts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn().catch((error) => {
        this.state = "failed";
        logger.error("Database worker restart failed:", error);
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  /** Reject every pending request. Writes get `writeOutcome` because they may have committed. */
  private failAll(
    code: DatabaseErrorPayload["code"],
    message: string,
    writeOutcome: DatabaseErrorPayload["outcome"] = "unknown",
  ): void {
    // Deleting the current entry while iterating a Map is well defined.
    for (const [requestId, request] of this.pending) {
      this.settle(requestId, {
        code,
        message,
        outcome: request.kind === "write" ? writeOutcome : "not_committed",
      });
    }
  }

  private settle(requestId: number, error: DatabaseErrorPayload | null, result?: unknown): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    this.pendingBytes -= request.bytes;
    clearTimeout(request.timer);
    request.cleanup?.();
    if (error) request.reject(new DatabaseRequestError(error));
    else request.resolve(result);
  }
}
