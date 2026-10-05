/**
 * One-time re-index of archive summaries, embeddings and observation text (audit DATA-5).
 *
 * Runs once per profile database, in the background after the archive cleanup
 * (MemoryService schedules both well after startup), claimed like the other one-time
 * memory jobs (maintenance-claim-sql.ts) so the desktop app and the node daemon never run
 * it together. Each chunk is one memory-domain transaction unit (in the database worker
 * when memory is routed there) that also stores the progress, so an interrupted run
 * resumes where it stopped. The marker `memory_summary_reindex_v1` records the counts.
 * What a chunk rewrites is described in memory-summary-reindex-sql.ts.
 */

import { createLogger } from "../utils/logger";
import { withMaintenanceClaim } from "./maintenance-claim-sql";
import type { MemoryStatementPort } from "./memory-statement-port";
import {
  MEMORY_SUMMARY_REINDEX_KEY,
  type MemorySummaryReindexChunk,
  type MemorySummaryReindexCounts,
} from "./memory-summary-reindex-sql";

export {
  MEMORY_SUMMARY_REINDEX_KEY,
  type MemorySummaryReindexCounts,
} from "./memory-summary-reindex-sql";

const logger = createLogger("MemorySummaryReindex");

export const MEMORY_SUMMARY_REINDEX_CHUNK_SIZE = 100;

export type MemorySummaryReindexResult =
  | { ran: true; counts: MemorySummaryReindexCounts }
  | { ran: false; reason: "done" | "held" | "stopped" };

export interface MemorySummaryReindexOptions {
  chunkSize?: number;
  /** Yield between chunks (to the event loop) so the archive never blocks other work. */
  pause?: () => Promise<void>;
  /** After each chunk, with the rows that changed (cache invalidation). */
  onChunk?: (chunk: MemorySummaryReindexChunk) => void;
  /** Stop between chunks (shutdown); the next run resumes from the stored progress. */
  shouldStop?: () => boolean;
  now?: () => number;
  /** Claim owner (tests); defaults to this process. */
  owner?: string;
}

export async function runMemorySummaryReindex(
  port: MemoryStatementPort,
  options: MemorySummaryReindexOptions = {},
): Promise<MemorySummaryReindexResult> {
  if (!(await port.unit("memorySummaryReindex_pending", {}))) return { ran: false, reason: "done" };
  const now = options.now ?? Date.now;
  const pause = options.pause ?? (async () => undefined);
  const limit = Math.max(1, Math.floor(options.chunkSize ?? MEMORY_SUMMARY_REINDEX_CHUNK_SIZE));
  let stopped = false;
  const result = await withMaintenanceClaim(
    port,
    MEMORY_SUMMARY_REINDEX_KEY,
    async () => {
      for (;;) {
        if (options.shouldStop?.()) {
          stopped = true;
          return null;
        }
        const chunk = await port.unit("memorySummaryReindex_chunk", {
          limit,
          now: Math.floor(now()),
        });
        options.onChunk?.(chunk);
        if (chunk.done) break;
        await pause();
      }
      // The marker carries the totals of every run, including interrupted earlier ones.
      return port.unit("memorySummaryReindex_complete", { now: Math.floor(now()) });
    },
    { owner: options.owner, now },
  );
  if (stopped) return { ran: false, reason: "stopped" };
  if (!result) {
    return (await port.unit("memorySummaryReindex_pending", {}))
      ? { ran: false, reason: "held" }
      : { ran: false, reason: "done" };
  }
  logger.info("Memory summary re-index completed", result);
  return { ran: true, counts: result };
}
