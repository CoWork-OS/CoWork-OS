/**
 * Startup wiring for the memory engine's write side (docs/memory-engine.md): create the
 * process-wide MemoryWriter, then copy the legacy lanes into `memory_items` once, well after
 * startup so it never competes with the first task.
 */
import type Database from "better-sqlite3";
import { createLogger } from "../utils/logger";
import { MemoryWriter, type MemoryWriterDeps } from "./MemoryWriter";
import { installMemoryReadSide } from "./memory-read-side";
import type { MemoryStatementPort } from "./memory-statement-port";

const logger = createLogger("MemoryEngine");

export const MEMORY_ITEMS_MIGRATION_DELAY_MS = 120_000;

/** Run the lane migration now (idempotent; a no-op once its marker exists). */
export async function runMemoryItemsLaneMigrationNow(writer: MemoryWriter): Promise<void> {
  try {
    const { loadLegacyLaneSources, runMemoryItemsLaneMigration } =
      await import("./MemoryItemsLaneMigration");
    const result = await runMemoryItemsLaneMigration(writer, await loadLegacyLaneSources(), {
      pause: () => new Promise((resolve) => setImmediate(resolve)),
    });
    if (result.ran) logger.info("Memory item lane migration finished", result.lanes);
  } catch (error) {
    logger.warn("Memory item lane migration failed; it will be retried on the next start:", error);
  }
}

/**
 * Initialize the writer and schedule the deferred lane migration. Returns a function that
 * cancels the scheduled migration (call it on quit).
 */
export function startMemoryEngine(
  source: Database.Database | MemoryStatementPort,
  options: Omit<MemoryWriterDeps, "repository"> & { migrationDelayMs?: number } = {},
): () => void {
  const { migrationDelayMs = MEMORY_ITEMS_MIGRATION_DELAY_MS, ...deps } = options;
  const writer = MemoryWriter.initialize(source, deps);
  // Read side: preferred-name and explicit-style syncs follow memory_items writes.
  const readSide = installMemoryReadSide(writer);
  const timer = setTimeout(() => {
    void runMemoryItemsLaneMigrationNow(writer).then(() => readSide.refresh());
  }, migrationDelayMs);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
    readSide.dispose();
  };
}
