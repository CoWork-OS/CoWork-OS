import { createLogger } from "../../utils/logger";
import { DATABASE_COMMANDS, requiredTablesFor } from "./commands";
import { DatabaseClient } from "./DatabaseClient";
import { setDeferredMigrationExecutor } from "../deferred-event-migrations";
import { setSettingsCommitClient } from "../secure-settings-commit-route";
import { CURRENT_SCHEMA_VERSION } from "../profile-lifecycle";
import { setReportReaderClient, setStatementClient } from "../statements/statement-route";
import { STATEMENT_DOMAIN_FLAGS } from "../statements/statement-catalogs";

/**
 * Runtime bootstrap for the database worker (async SQLite migration plan, DB2).
 *
 * The worker backend is on by default (DB7, `DATABASE_WORKER_ROLLOUT`) and chosen once
 * per run: if it is turned off (`COWORK_DB_WORKER=0`) or fails to start, migrated domains use the host backend for the whole
 * run. Once a domain has chosen the worker, a later worker failure surfaces as an
 * explicit error; nothing falls back to synchronous host SQL mid-run (decision 7).
 * Start it only after `DatabaseManager` has created and migrated the schema.
 */

const logger = createLogger("DatabaseWorker");

let startup: Promise<DatabaseClient | null> | null = null;
let activeClient: DatabaseClient | null = null;
let readerStartup: Promise<DatabaseClient | null> | null = null;
let activeReader: DatabaseClient | null = null;

export type DatabaseRuntime = "desktop" | "daemon" | "cli";

/**
 * Rollout defaults (DB7): whether each backend flag is on when the environment leaves it
 * unset, per runtime. An explicit `0`/`false`/`off` turns a flag off (the rollback
 * switch, per domain or for the whole worker with `COWORK_DB_WORKER=0`); an explicit
 * `1`/`true`/`on` turns it on. Code that runs outside a runtime (tools, tests) sees only
 * explicit flags.
 */
const ALL_DOMAINS_ON: Readonly<Record<string, boolean>> = {
  COWORK_DB_WORKER: true,
  COWORK_DB_WORKER_TIMELINE: true,
  COWORK_DB_WORKER_REPORTS: true,
  COWORK_DB_WORKER_SETTINGS: true,
  COWORK_DB_WORKER_STORAGE: true,
  COWORK_DB_WORKER_SERVICES: true,
  COWORK_DB_WORKER_MEMORY: true,
  COWORK_DB_WORKER_MAILBOX: true,
  COWORK_DB_WORKER_CONTROL_PLANE: true,
};

// Every domain is on by default in every runtime since DB7: the workload matrix, recovery
// matrix and rollback checks passed with all domains routed (docs/async-sqlite-db0-
// baseline-2026-09-27.md, "DB7 rollout").
export const DATABASE_WORKER_ROLLOUT: Readonly<
  Record<DatabaseRuntime, Readonly<Record<string, boolean>>>
> = {
  desktop: ALL_DOMAINS_ON,
  daemon: ALL_DOMAINS_ON,
  cli: ALL_DOMAINS_ON,
};

let rolloutRuntime: DatabaseRuntime | null = null;

/** Record the runtime whose rollout defaults apply; the first worker start sets it. */
export function configureDatabaseRuntime(runtime: DatabaseRuntime | null): void {
  rolloutRuntime = runtime;
}

/** A backend flag's effective state: explicit environment first, then the rollout default. */
export function isDatabaseFlagEnabled(flag: string): boolean {
  const raw = (process.env[flag] || "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return rolloutRuntime ? DATABASE_WORKER_ROLLOUT[rolloutRuntime][flag] === true : false;
}

function isFlagOn(flag: string): boolean {
  return isDatabaseWorkerEnabled() && isDatabaseFlagEnabled(flag);
}

export function isDatabaseWorkerEnabled(): boolean {
  return isDatabaseFlagEnabled("COWORK_DB_WORKER");
}

/**
 * Timeline projections in the worker (DB3). Requires the worker itself; without it
 * projections stay inline on the host.
 */
export function isTimelineProjectionWorkerEnabled(): boolean {
  return isFlagOn("COWORK_DB_WORKER_TIMELINE");
}

/**
 * Usage reports in the reporting reader and usage rollup rebuilds in the write worker
 * (DB4). Requires the worker itself.
 */
export function isReportingWorkerEnabled(): boolean {
  return isFlagOn("COWORK_DB_WORKER_REPORTS");
}

/**
 * Settings and policy transactions in the worker (DB5): encrypted settings commits under
 * revision checks, and Pulse's consent, outbox and lease groups. Requires the worker.
 */
export function isSettingsWorkerEnabled(): boolean {
  return isFlagOn("COWORK_DB_WORKER_SETTINGS");
}

export function startDatabaseWorker(options: {
  dbPath: string;
  runtime: DatabaseRuntime;
}): Promise<DatabaseClient | null> {
  if (startup) return startup;
  configureDatabaseRuntime(options.runtime);
  if (!isDatabaseWorkerEnabled()) {
    startup = Promise.resolve(null);
    return startup;
  }
  startup = DatabaseClient.start({
    dbPath: options.dbPath,
    requiredTables: requiredTablesFor(DATABASE_COMMANDS),
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
  })
    .then((client) => {
      activeClient = client;
      // DB4: legacy events converted on host reads of this database are written here.
      setDeferredMigrationExecutor(options.dbPath, async (taskId, rows) => {
        await client.execute("timeline.persistMigratedEvents", { taskId, rows });
      });
      if (isSettingsWorkerEnabled()) setSettingsCommitClient(options.dbPath, client);
      // DB6: migrated domains whose flag is on run their catalogued statements here.
      for (const [domain, flag] of Object.entries(STATEMENT_DOMAIN_FLAGS)) {
        if (isFlagOn(flag)) setStatementClient(domain, options.dbPath, client);
      }
      logger.info(`Database worker ready (${options.runtime})`);
      return client;
    })
    .catch((error) => {
      logger.error(
        "Database worker unavailable; migrated domains use the host backend for this run:",
        error,
      );
      return null;
    });
  return startup;
}

/**
 * The read-only reporting reader (DB4), started with the write worker. Heavy report and
 * history scans run here so they never queue behind writes or block the host.
 */
export function startReportingReader(options: {
  dbPath: string;
  runtime: DatabaseRuntime;
}): Promise<DatabaseClient | null> {
  if (readerStartup) return readerStartup;
  if (!isReportingWorkerEnabled()) {
    readerStartup = Promise.resolve(null);
    return readerStartup;
  }
  // Read workers start after the write worker is ready (DB6): it has confirmed the
  // schema version, and a reader never races the host's initialization.
  readerStartup = (startup ?? Promise.resolve(null))
    .then(() =>
      DatabaseClient.start({
        dbPath: options.dbPath,
        requiredTables: [],
        expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
        readonly: true,
        // Reports can take seconds on a large profile; they only wait in the reader's queue.
        readDeadlineMs: 60_000,
      }),
    )
    .then((client) => {
      activeReader = client;
      // DB6: report-style read units of routed domains run here too.
      setReportReaderClient(options.dbPath, client);
      logger.info(`Reporting reader ready (${options.runtime})`);
      return client;
    })
    .catch((error) => {
      logger.error("Reporting reader unavailable; reports use the host for this run:", error);
      return null;
    });
  return readerStartup;
}

export function getReportingReader(): Promise<DatabaseClient | null> {
  return readerStartup ?? Promise.resolve(null);
}

/** The worker client once startup has settled, or null when this run uses the host backend. */
export function getDatabaseClient(): Promise<DatabaseClient | null> {
  return startup ?? Promise.resolve(null);
}

/**
 * Close the reporting reader, then drain and close the write worker. Resolves with
 * whether every accepted operation settled before the deadline; the caller records an
 * incomplete shutdown otherwise (DB6).
 */
export async function stopDatabaseWorker(timeoutMs = 10_000): Promise<{ drained: boolean }> {
  // Pending conversions are dropped at shutdown; the next read converts them again.
  const reader = activeReader ?? (await readerStartup?.catch(() => null)) ?? null;
  activeReader = null;
  readerStartup = null;
  setReportReaderClient(null, null);
  if (reader) await reader.close(timeoutMs);
  const client = activeClient ?? (await startup?.catch(() => null)) ?? null;
  activeClient = null;
  setDeferredMigrationExecutor(null, null);
  setSettingsCommitClient(null, null);
  setStatementClient(null, null, null);
  startup = null;
  // The next start chooses its runtime's rollout defaults again.
  configureDatabaseRuntime(null);
  if (!client) return { drained: true };
  const { drained } = await client.close(timeoutMs);
  if (!drained) logger.warn("Database worker did not drain before the shutdown deadline");
  return { drained };
}
