/**
 * Read one value from Cursor's app state database (`state.vscdb`) off the application
 * thread. The database belongs to Cursor and may be locked while Cursor writes, so the read
 * runs in a worker thread with a short busy timeout and never blocks CoWork's main thread.
 * The worker opens the file read-only; it is listed with the other off-thread SQLite
 * modules in scripts/qa/sqlite-ratchet.mjs.
 */

import { Worker } from "node:worker_threads";

const READ_TIMEOUT_MS = 5_000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const Database = require(workerData.modulePath);
  const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(workerData.key);
    const value = row ? row.value : null;
    parentPort.postMessage({
      value: value === null || value === undefined
        ? null
        : Buffer.isBuffer(value) ? value.toString("utf8") : String(value),
    });
  } finally {
    db.close();
  }
} catch (error) {
  parentPort.postMessage({ error: String((error && error.message) || error) });
}
`;

/**
 * The text stored under `key`, or null when the database or key is missing. Rejects when
 * the database can't be read in time.
 */
export function readCursorStateValue(dbPath: string, key: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      // Resolved here so the worker loads the same native build as the rest of the app.
      workerData: { modulePath: require.resolve("better-sqlite3"), dbPath, key },
    });
    const finish = (error: Error | null, value?: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value ?? null);
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out reading Cursor's settings.")),
      READ_TIMEOUT_MS,
    );
    worker.once("message", (message: { value?: string | null; error?: string }) => {
      if (message.error) finish(new Error(message.error));
      else finish(null, message.value ?? null);
    });
    worker.once("error", (error: unknown) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
    worker.once("exit", (code) => finish(new Error(`Reader exited early (code ${code}).`)));
  });
}
