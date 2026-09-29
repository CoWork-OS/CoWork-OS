import { parentPort, workerData } from "worker_threads";
import { DatabaseManager } from "./schema";

/**
 * Schema initialization off the host thread (async SQLite migration plan, DB6). Receives
 * an absolute database path from the host (which already prepared the profile
 * directory), runs the migration-locked initialization, and exits.
 */
try {
  const manager = new DatabaseManager({ dbPath: String(workerData.dbPath) });
  manager.close();
  parentPort?.postMessage({ ok: true });
} catch (error) {
  const failure = error as Error & { code?: string; found?: number; supported?: number };
  parentPort?.postMessage({
    ok: false,
    code: failure.code,
    message: failure.message,
    found: failure.found,
    supported: failure.supported,
  });
}
