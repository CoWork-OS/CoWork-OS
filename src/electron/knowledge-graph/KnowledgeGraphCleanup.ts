/**
 * One-time cleanup of knowledge graph noise (audit DATA-10). Runs once per profile
 * database, deferred after startup (KnowledgeGraphService schedules it), claimed like the
 * other one-time memory jobs (maintenance-claim-sql.ts) so the desktop app and the node
 * daemon never run it together, and records the marker `kg_quality_cleanup_v1` with its
 * counts. Every phase is idempotent, so an interrupted run is simply repeated.
 *
 *  1. merge entities that differ only in case (`Go`/`go`/`GO`);
 *  2. delete automatic technology entities that are ambiguous English words ("go",
 *     "rest", "express", lower-case "electron" from paths);
 *  3. delete free-mail and relay provider organizations ("Gmail", "Privaterelay") and the
 *     automatic `works_at` edges to them;
 *  4. rename organizations named after a mail subdomain ("News" from news.acme.com) to the
 *     registrable label ("Acme"), merging into an existing one;
 *  5. delete person entities of automated senders (noreply, notifications, bounces,
 *     newsletters) that the old ingest created from mailbox events;
 *  6. delete duplicate observations.
 *
 * Deletions only ever touch `source = 'auto'` entities that no manual or agent edge or
 * observation references; manual and agent entities are never deleted (a case duplicate
 * is merged into its canonical entity, keeping its edges, observations and description).
 */
import { createLogger } from "../utils/logger";
import { withMaintenanceClaim } from "../memory/maintenance-claim-sql";
import type { MemoryStatementPort } from "../memory/memory-statement-port";
import {
  KG_CLEANUP_MIGRATION_KEY,
  KG_CLEANUP_PHASES,
  emptyKGCleanupCounts,
  type KGCleanupCounts,
} from "./knowledge-graph-maintenance-sql";

export { KG_CLEANUP_MIGRATION_KEY, type KGCleanupCounts } from "./knowledge-graph-maintenance-sql";

const logger = createLogger("KnowledgeGraphCleanup");

export type KGCleanupResult =
  | { ran: true; counts: KGCleanupCounts }
  | { ran: false; reason: "done" | "held" };

export interface KGCleanupOptions {
  /** Yield between phases (to the event loop). */
  pause?: () => Promise<void>;
  now?: () => number;
  /** Claim owner (tests); defaults to this process. */
  owner?: string;
}

export async function runKnowledgeGraphCleanup(
  port: MemoryStatementPort,
  options: KGCleanupOptions = {},
): Promise<KGCleanupResult> {
  if (!(await port.unit("kgCleanup_pending", {}))) return { ran: false, reason: "done" };
  const now = options.now ?? Date.now;
  const pause = options.pause ?? (async () => undefined);
  const result = await withMaintenanceClaim(
    port,
    KG_CLEANUP_MIGRATION_KEY,
    async () => {
      const counts = emptyKGCleanupCounts();
      for (const [index, phase] of KG_CLEANUP_PHASES.entries()) {
        if (index > 0) await pause();
        const phaseCounts = await port.unit("kgCleanup_phase", { phase });
        for (const key of Object.keys(counts) as Array<keyof KGCleanupCounts>) {
          counts[key] += phaseCounts[key];
        }
      }
      await port.unit("kgCleanup_complete", { counts, now: Math.floor(now()) });
      return counts;
    },
    { owner: options.owner, now },
  );
  if (!result) {
    // Done meanwhile, or another process holds the claim.
    return (await port.unit("kgCleanup_pending", {}))
      ? { ran: false, reason: "held" }
      : { ran: false, reason: "done" };
  }
  logger.info("Knowledge graph cleanup completed", result);
  return { ran: true, counts: result };
}
