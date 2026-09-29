import path from "path";
import { Worker } from "worker_threads";
import { MigrationLockTimeoutError, UnsupportedSchemaVersionError } from "./profile-lifecycle";

/**
 * Host side of schema initialization in a worker (async SQLite migration plan, DB6). The
 * worker (`schema-bootstrap-worker.ts`) opens `dbPath`, initializes the schema and exits;
 * its failures come back with their type so callers can report them clearly.
 */

export interface SchemaBootstrapOptions {
  /** Compiled worker entry; defaults to `schema-bootstrap-worker.js` next to this file. */
  bootstrapWorkerPath?: string;
  /** Schema initialization on a large profile can take a while. */
  timeoutMs?: number;
}

type BootstrapReply =
  | { ok: true }
  | { ok: false; code?: string; message: string; found?: number; supported?: number };

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function unavailable(message: string): Error {
  return Object.assign(new Error(message), { code: "bootstrap_unavailable" });
}

export function runSchemaBootstrap(
  dbPath: string,
  options: SchemaBootstrapOptions = {},
): Promise<void> {
  const workerPath =
    options.bootstrapWorkerPath ?? path.join(__dirname, "schema-bootstrap-worker.js");
  return new Promise<void>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerPath, { workerData: { dbPath } });
    } catch (error) {
      reject(unavailable(`Cannot start the schema bootstrap worker: ${String(error)}`));
      return;
    }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(new Error("Schema initialization did not finish in time"));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    worker.once("message", (reply: BootstrapReply) => {
      if (reply.ok) {
        finish();
        return;
      }
      if (reply.code === "unsupported_schema_version") {
        finish(new UnsupportedSchemaVersionError(Number(reply.found), Number(reply.supported)));
      } else if (reply.code === "migration_lock_timeout") {
        finish(new MigrationLockTimeoutError(`${dbPath}.migration.lock`, null));
      } else {
        finish(Object.assign(new Error(reply.message), { code: reply.code }));
      }
    });
    worker.once("error", (error: Error & { code?: string }) => {
      finish(
        error.code === "MODULE_NOT_FOUND" || /Cannot find module/.test(error.message)
          ? unavailable(error.message)
          : error,
      );
    });
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`Schema bootstrap worker exited with code ${code}`));
    });
  });
}
