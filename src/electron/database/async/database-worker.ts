import Database from "better-sqlite3";
import { performance } from "perf_hooks";
import { type MessagePort, parentPort, workerData } from "worker_threads";
import { applyConnectionPragmas } from "../connection";
import { instrumentDatabase } from "../sqlite-instrumentation";
import {
  DATABASE_COMMANDS,
  type DatabaseCommandDefinition,
  InvalidCommandArgumentsError,
} from "./commands";
import {
  DATABASE_PROTOCOL_VERSION,
  type DatabaseErrorPayload,
  type DatabaseRequestMessage,
  type DatabaseWorkerData,
  type HostToWorkerMessage,
  type WorkerToHostMessage,
} from "./protocol";

/**
 * Write-capable database worker (async SQLite migration plan, DB2). One per runtime
 * and profile. It owns a single connection and runs commands one at a time:
 *
 * - Requests run in arrival order. A write that cannot take the write lock (another
 *   process holds it) is parked rather than blocking the thread for the full busy
 *   timeout: later reads keep running unless they are ordered behind the parked write,
 *   and one probe retries the write with backoff until its deadline.
 * - Writes run in an IMMEDIATE transaction, so the lock is taken up front and a
 *   failure before COMMIT always means nothing was committed.
 * - Replies are posted after COMMIT. A request still queued at its deadline is
 *   rejected as not committed; a running statement cannot be interrupted.
 * - On shutdown it stops accepting requests, drains the queue, closes the connection,
 *   and reports `drained` before exiting.
 */

type AnyCommand = DatabaseCommandDefinition<unknown, unknown>;

const MIN_PARK_BACKOFF_MS = 10;
const MAX_PARK_BACKOFF_MS = 250;

if (!parentPort) throw new Error("database-worker must run in a worker thread");
const port: MessagePort = parentPort;
const data = workerData as DatabaseWorkerData;

const post = (message: WorkerToHostMessage): void => port.postMessage(message);

let db: Database.Database | null = null;
let commands: Record<string, AnyCommand> = DATABASE_COMMANDS as unknown as Record<
  string,
  AnyCommand
>;
const queue: DatabaseRequestMessage[] = [];
let draining = false;
let pumpScheduled = false;
let parkedRequestId: number | null = null;
let parkBackoffMs = MIN_PARK_BACKOFF_MS;
let probeAt = 0;
let probeTimer: ReturnType<typeof setTimeout> | null = null;

function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

function sqliteCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_") ? code : undefined;
}

function reject(request: DatabaseRequestMessage, error: DatabaseErrorPayload): void {
  post({
    type: "response",
    requestId: request.requestId,
    generation: data.generation,
    ok: false,
    error,
  });
}

function execute(request: DatabaseRequestMessage): "done" | "parked" {
  const command = commands[request.command];
  if (!command || command.kind !== request.kind || !db) {
    reject(request, {
      code: "invalid_request",
      message: `Unknown ${request.kind} command: ${request.command}`,
      outcome: "not_committed",
    });
    return "done";
  }
  if (data.readonly && command.kind === "write") {
    reject(request, {
      code: "invalid_request",
      message: `${request.command} is a write command; this worker is read-only`,
      outcome: "not_committed",
    });
    return "done";
  }
  const startedAt = performance.now();
  let result: unknown;
  try {
    const connection = db;
    result =
      command.kind === "write"
        ? connection.transaction(() => command.run(connection, request.args)).immediate()
        : command.run(connection, request.args);
  } catch (error) {
    if (command.kind === "write" && isBusyError(error)) return "parked";
    reject(request, {
      code: error instanceof InvalidCommandArgumentsError ? "invalid_request" : "command_failed",
      message: error instanceof Error ? error.message : String(error),
      // Reads change nothing; a failed IMMEDIATE transaction has been rolled back.
      outcome: "not_committed",
      sqliteCode: sqliteCode(error),
    });
    return "done";
  }
  try {
    post({
      type: "response",
      requestId: request.requestId,
      generation: data.generation,
      ok: true,
      result,
      durationMs: performance.now() - startedAt,
    });
  } catch (error) {
    // The result could not be cloned. A write has already committed at this point.
    reject(request, {
      code: "command_failed",
      message: `Result of ${request.command} could not be sent: ${error instanceof Error ? error.message : String(error)}`,
      outcome: command.kind === "write" ? "unknown" : "not_committed",
    });
  }
  return "done";
}

function schedulePump(delayMs = 0): void {
  if (delayMs > 0) {
    if (probeTimer) return;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      schedulePump();
    }, delayMs);
    return;
  }
  if (pumpScheduled) return;
  pumpScheduled = true;
  setImmediate(pump);
}

/** Pick the next runnable request, or null when everything left waits on the parked write. */
function nextRunnable(now: number): { index: number; probe: boolean } | null {
  if (parkedRequestId === null) return queue.length > 0 ? { index: 0, probe: false } : null;
  const parkedIndex = queue.findIndex((request) => request.requestId === parkedRequestId);
  if (parkedIndex < 0) return queue.length > 0 ? { index: 0, probe: false } : null;
  if (now >= probeAt) return { index: parkedIndex, probe: true };
  // While parked, writes keep their order behind the parked one. Reads may run ahead
  // of queued writes unless they share an ordering key with one: callers that need to
  // read their own write either await the write first or pass the same key.
  const blockedKeys = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const request = queue[index];
    if (request.kind === "write") {
      if (request.orderingKey) blockedKeys.add(request.orderingKey);
      continue;
    }
    if (request.orderingKey && blockedKeys.has(request.orderingKey)) continue;
    return { index, probe: false };
  }
  return null;
}

function pump(): void {
  pumpScheduled = false;
  const now = Date.now();

  // Reject anything that waited past its deadline without running.
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const request = queue[index];
    if (now < request.deadlineAt) continue;
    queue.splice(index, 1);
    const wasParked = request.requestId === parkedRequestId;
    if (wasParked) clearPark();
    reject(request, {
      code: wasParked ? "busy_timeout" : "deadline_exceeded",
      message: wasParked
        ? `Write lock was not available before the deadline for ${request.command}`
        : `Deadline passed before ${request.command} started`,
      outcome: "not_committed",
    });
  }

  const next = nextRunnable(now);
  if (next) {
    const request = queue[next.index];
    const outcome = execute(request);
    if (outcome === "parked") {
      parkedRequestId = request.requestId;
      probeAt = Date.now() + parkBackoffMs;
      parkBackoffMs = Math.min(MAX_PARK_BACKOFF_MS, parkBackoffMs * 2);
    } else {
      queue.splice(next.index, 1);
      if (request.requestId === parkedRequestId) clearPark();
    }
  }

  if (queue.length === 0) {
    if (draining) finishDrain();
    return;
  }
  if (nextRunnable(Date.now())) {
    schedulePump();
  } else {
    const earliestDeadline = Math.min(...queue.map((request) => request.deadlineAt));
    schedulePump(Math.max(1, Math.min(probeAt, earliestDeadline) - Date.now()));
  }
}

function clearPark(): void {
  parkedRequestId = null;
  parkBackoffMs = MIN_PARK_BACKOFF_MS;
  probeAt = 0;
}

function finishDrain(): void {
  if (probeTimer) clearTimeout(probeTimer);
  try {
    db?.close();
  } finally {
    db = null;
    post({ type: "drained", generation: data.generation });
    port.close();
  }
}

function handleMessage(message: HostToWorkerMessage): void {
  if (message.type === "shutdown") {
    draining = true;
    if (queue.length === 0) finishDrain();
    return;
  }
  if (message.type === "cancel") {
    const index = queue.findIndex((request) => request.requestId === message.requestId);
    // Only queued work can be dropped; the parked write is retried, so it can be too.
    if (index >= 0) {
      const [request] = queue.splice(index, 1);
      if (request.requestId === parkedRequestId) clearPark();
      reject(request, {
        code: "cancelled",
        message: `${request.command} was cancelled before it started`,
        outcome: "not_committed",
      });
    }
    return;
  }
  if (message.type !== "request") return;
  if (draining || message.generation !== data.generation) {
    reject(message, {
      code: "closed",
      message: "Database worker is shutting down",
      outcome: "not_committed",
    });
    return;
  }
  queue.push(message);
  schedulePump();
}

function start(): void {
  try {
    if (data.protocolVersion !== DATABASE_PROTOCOL_VERSION) {
      throw new Error(
        `Protocol version mismatch: host ${data.protocolVersion}, worker ${DATABASE_PROTOCOL_VERSION}`,
      );
    }
    if (data.testCommandsModule) {
      // Tests only: extra commands for crash and contention scenarios.
      // oxlint-disable-next-line typescript-eslint(no-require-imports) -- path is chosen at runtime by tests
      const extra = require(data.testCommandsModule) as { commands: Record<string, AnyCommand> };
      commands = { ...commands, ...extra.commands };
    }
    // fileMustExist: the host creates and migrates the database; a worker must never
    // create an empty database at a wrong path.
    // Same low-overhead statement timing as the host connection; read through the
    // `diagnostics.sqliteSnapshot` command.
    const connection = instrumentDatabase(
      new Database(data.dbPath, { fileMustExist: true, readonly: data.readonly === true }),
    );
    db = connection;
    if (data.readonly) {
      // Journal mode and durability belong to the writers; a reader only waits for locks.
      connection.pragma(`busy_timeout = ${Math.max(0, Math.floor(data.busyTimeoutMs))}`);
    } else {
      applyConnectionPragmas(connection, { busyTimeoutMs: data.busyTimeoutMs });
      connection.pragma("foreign_keys = ON");
    }
    const present = new Set(
      (
        connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    if (data.schemaVersion !== undefined) {
      // Ready only after the host finished initializing this exact schema (DB6).
      const found = Number(connection.pragma("user_version", { simple: true }) ?? 0);
      if (found !== data.schemaVersion) {
        throw new Error(
          `Database schema version is ${found}; this worker expects ${data.schemaVersion}`,
        );
      }
    }
    const missing = data.requiredTables.filter((table) => !present.has(table));
    if (missing.length > 0) throw new Error(`Database is missing tables: ${missing.join(", ")}`);
    const sqliteVersion = (
      connection.prepare("SELECT sqlite_version() AS version").get() as { version: string }
    ).version;
    port.on("message", handleMessage);
    post({
      type: "ready",
      generation: data.generation,
      protocolVersion: DATABASE_PROTOCOL_VERSION,
      sqliteVersion,
      commands: Object.entries(commands).map(([name, command]) => ({ name, kind: command.kind })),
    });
  } catch (error) {
    try {
      db?.close();
    } catch {
      // The connection may not have opened.
    }
    db = null;
    post({
      type: "startup_failed",
      generation: data.generation,
      message: error instanceof Error ? error.message : String(error),
    });
    port.close();
  }
}

start();
