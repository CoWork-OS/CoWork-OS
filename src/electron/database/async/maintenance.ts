import type { StorageStats } from "./commands";
import type { DatabaseClient } from "./DatabaseClient";

/**
 * Maintenance through the database worker, the DB2 pilot domain. Each batch is a
 * separate bounded write command, so other commands interleave between batches and
 * the host thread never runs the deletes.
 */
export async function pruneTaskEventsWithWorker(
  client: DatabaseClient,
  retentionDays: number,
  batchSize = 500,
): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (;;) {
    // Deleting by predicate is idempotent, so a batch with an unknown outcome is
    // reconciled simply by running the next one.
    const result = await client.execute("maintenance.pruneTaskEventsBatch", { cutoff, batchSize });
    deleted += result.deleted;
    if (result.deleted < batchSize) return deleted;
  }
}

export function readStorageStats(client: DatabaseClient): Promise<StorageStats> {
  return client.execute("maintenance.storageStats", undefined);
}
