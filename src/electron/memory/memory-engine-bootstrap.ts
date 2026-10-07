/**
 * Startup wiring of the memory engine (docs/memory-engine.md): create the process-wide
 * MemoryWriter, copy the retired legacy lanes into `memory_items` once (awaited, so no
 * service reads a half-migrated store), then start the synchronous facts snapshot and the
 * profile's read model over the memory folder. Legacy data an older release wrote after the
 * retirement re-arms the migration once first (`rearmLegacyMemoryRetirement`).
 */
import type Database from "better-sqlite3";
import { createLogger } from "../utils/logger";
import { MemoryWriter, type MemoryWriterDeps } from "./MemoryWriter";
import { MemoryFactsSnapshot } from "./memory-facts-snapshot";
import { UserProfileFolderModel } from "./user-profile-folder";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";
import { withMaintenanceClaim } from "./maintenance-claim-sql";
import type { LegacyLaneSources } from "./MemoryItemsLaneMigration";
import { MEMORY_ITEMS_LANE_MIGRATION_KEY } from "./memory-items-sql";
import {
  rearmLegacyMemoryRetirement,
  scheduleLegacyMemoryRetirement,
} from "./LegacyMemoryRetirement";

const logger = createLogger("MemoryEngine");

/**
 * How long startup waits for another process (the desktop app or the node daemon on the
 * same profile) that holds the lane migration claim.
 */
export const MEMORY_ITEMS_MIGRATION_WAIT_MS = 60_000;
const MIGRATION_POLL_MS = 500;

function isStatementPort(
  source: Database.Database | MemoryStatementPort,
): source is MemoryStatementPort {
  return typeof (source as Partial<MemoryStatementPort>).unit === "function";
}

/**
 * Run the lane migration now (idempotent; a no-op once its marker exists). With `port`,
 * the run is claimed first, so the desktop app and the node daemon sharing one profile
 * never run it at the same time (maintenance-claim-sql.ts); while the other process runs
 * it, this one waits up to `waitMs` for the marker. Never throws: a failed run is retried
 * on the next start.
 */
export async function runMemoryItemsLaneMigrationNow(
  writer: MemoryWriter,
  port?: MemoryStatementPort,
  options: {
    waitMs?: number;
    pollMs?: number;
    /** The legacy lanes (tests); defaults to the stored ones. */
    loadSources?: () => Promise<LegacyLaneSources>;
  } = {},
): Promise<void> {
  try {
    const { RERUN_LANES, loadLegacyLaneSources, runMemoryItemsLaneMigration } =
      await import("./MemoryItemsLaneMigration");
    const run = async () => {
      // A re-run after a downgrade copies only the lanes the older release wrote to.
      const rerun = port ? await port.unit("legacyRetirement_rerunRequest", {}) : null;
      const sources = await (options.loadSources ?? loadLegacyLaneSources)();
      return runMemoryItemsLaneMigration(writer, sources, {
        pause: () => new Promise((resolve) => setImmediate(resolve)),
        ...(rerun ? { only: RERUN_LANES } : {}),
      });
    };
    if (!port) {
      const result = await run();
      if (result.ran) logger.info("Memory item lane migration finished", result.lanes);
      return;
    }
    const result = await withMaintenanceClaim(port, MEMORY_ITEMS_LANE_MIGRATION_KEY, run);
    if (result?.ran) {
      logger.info("Memory item lane migration finished", result.lanes);
      return;
    }
    if (result) return;
    // Done already, or another process is running it: wait for its marker.
    const deadline = Date.now() + Math.max(0, options.waitMs ?? MEMORY_ITEMS_MIGRATION_WAIT_MS);
    while (!(await writer.repository.isLaneMigrationComplete())) {
      if (Date.now() >= deadline) {
        logger.warn(
          "Memory item lane migration is still running in another process; continuing startup",
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? MIGRATION_POLL_MS));
    }
  } catch (error) {
    logger.warn("Memory item lane migration failed; it will be retried on the next start:", error);
  }
}

/**
 * Initialize the writer, run the lane migration (awaited), and start the facts snapshot
 * and the profile read model. Returns a function that stops them (call it on quit).
 */
export async function startMemoryEngine(
  source: Database.Database | MemoryStatementPort,
  options: Omit<MemoryWriterDeps, "repository"> & { migrationWaitMs?: number } = {},
): Promise<() => void> {
  const { migrationWaitMs, ...deps } = options;
  const writer = MemoryWriter.initialize(source, deps);
  const port = isStatementPort(source) ? source : createMemoryStatementPort(source);
  await rearmLegacyMemoryRetirement(port);
  await runMemoryItemsLaneMigrationNow(writer, port, { waitMs: migrationWaitMs });
  const stopSnapshot = MemoryFactsSnapshot.install();
  // The user profile reads the memory folder once it runs (UserProfileService).
  const stopProfileModel = UserProfileFolderModel.install();
  await MemoryFactsSnapshot.refresh();
  // One-time legacy data retirement, deferred off the startup path.
  const cancelRetirement = scheduleLegacyMemoryRetirement(writer, port);
  return () => {
    cancelRetirement();
    stopSnapshot();
    stopProfileModel();
  };
}
