/**
 * Retire the old fact rows once the memory folder holds them
 * (docs/memory-repo-phase3-design.md §3).
 *
 * After the one-time export into the current folder (`MemoryRepoExport`, marker
 * `.git/cowork-export-v1`), active `memory_items` facts of scope `global`/`workspace` (any kind
 * but `commitment`; not private, not third-party) whose normalized text is in a folder file are
 * written to an encrypted backup and then deleted (tombstoned, so every revision is scrubbed).
 * Rows the folder does not hold (the export skipped them) stay. The marker
 * `.git/cowork-fact-retirement-v1` lives in the folder, like the export's, and a lock in `.git`
 * keeps the desktop app and the node daemon from running it twice at once.
 *
 * Re-run after a downgrade: like the export, a marker older than the re-run request counts as
 * absent, and only rows of the re-run lanes are considered. `runMemoryRepoExportChain` runs
 * both and then consumes the request (`legacy_memory_rerun_v1`).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../utils/logger";
import { writeBackup } from "../LegacyMemoryRetirement";
import type { MemoryItem } from "../memory-items-types";
import type { SafeStorageLike } from "../../utils/safe-storage";
import type { MemoryRepoService } from "./MemoryRepoService";
import {
  MEMORY_REPO_EXPORT_MARKER,
  folderMarkerTime,
  folderRunMode,
  inRerunStores,
  runMemoryRepoExport,
  type MemoryRepoExportDeps,
  type MemoryRepoRerun,
} from "./MemoryRepoExport";
import { isSwarmRepoPath } from "./memory-repo-format";
import { MemoryRepoBusyError, withMemoryRepoLock } from "./memory-repo-lock";

const logger = createLogger("MemoryItemsFactRetirement");

export const MEMORY_ITEMS_FACT_RETIREMENT_MARKER = "cowork-fact-retirement-v1";

export interface MemoryItemsFactRetirementDeps {
  listItems: () => Promise<MemoryItem[]>;
  deleteItem: (id: string) => Promise<unknown>;
  encryption: SafeStorageLike | null;
  backupDir: string;
  now?: () => number;
  rerun?: MemoryRepoRerun;
}

export interface MemoryItemsFactRetirementResult {
  ran: boolean;
  reason?: "not_ready" | "done" | "busy";
  retired: number;
  kept: number;
  backup?: string | null;
}

/** The rows Phase 3 retires: user and workspace facts, never commitments or other people. */
export function isRetiredFactRow(item: MemoryItem): boolean {
  return (
    item.status === "active" &&
    (item.scope === "global" || item.scope === "workspace") &&
    item.kind !== "commitment" &&
    item.privacy !== "private" &&
    item.source !== "third_party"
  );
}

export async function runMemoryItemsFactRetirement(
  service: MemoryRepoService,
  deps: MemoryItemsFactRetirementDeps,
): Promise<MemoryItemsFactRetirementResult> {
  const gitDir = path.join(service.root, ".git");
  const exportMarker = path.join(gitDir, MEMORY_REPO_EXPORT_MARKER);
  const marker = path.join(gitDir, MEMORY_ITEMS_FACT_RETIREMENT_MARKER);
  if (!service.isWritable() || !(await exists(exportMarker))) {
    return { ran: false, reason: "not_ready", retired: 0, kept: 0 };
  }
  const mode = async () => folderRunMode(await folderMarkerTime(marker), deps.rerun);
  if ((await mode()) === "done") return { ran: false, reason: "done", retired: 0, kept: 0 };
  try {
    return await withMemoryRepoLock(
      path.join(gitDir, "cowork-fact-retirement.lock"),
      async () => {
        const current = await mode();
        if (current === "done") return { ran: false, reason: "done" as const, retired: 0, kept: 0 };
        const rerun = current === "rerun" ? deps.rerun : undefined;
        const now = (deps.now ?? Date.now)();
        const inFolder = new Set<string>();
        for (const file of await service.listFiles()) {
          // Swarm notes are agents' notes, not the user's facts.
          if (isSwarmRepoPath(file)) continue;
          for (const entry of await service.entries(file)) inFolder.add(entry.hash);
        }
        const rows = (await deps.listItems()).filter(
          (item) => isRetiredFactRow(item) && (!rerun || inRerunStores(item, rerun)),
        );
        const retire = rows.filter((item) => inFolder.has(item.contentHash));
        let backup: string | null = null;
        if (retire.length > 0) {
          const written = await writeBackup(
            deps.backupDir,
            now,
            { kind: "memory_items_facts", exportedAt: now, items: retire },
            {},
            deps.encryption,
            "memory-items-facts",
          );
          backup = written.file;
          for (const item of retire) await deps.deleteItem(item.id);
        }
        const kept = rows.length - retire.length;
        await fs.writeFile(
          marker,
          JSON.stringify({
            at: now,
            retired: retire.length,
            kept,
            backup,
            ...(rerun ? { rerun: true } : {}),
          }),
          { mode: 0o600 },
        );
        logger.info(
          `Retired ${retire.length} fact row(s) now held by the memory folder (${kept} kept)`,
        );
        return { ran: true, retired: retire.length, kept, backup };
      },
      { timeoutMs: 0, staleMs: 10 * 60 * 1000 },
    );
  } catch (error) {
    if (error instanceof MemoryRepoBusyError)
      return { ran: false, reason: "busy", retired: 0, kept: 0 };
    throw error;
  }
}

/** The pending re-run request (`legacy_memory_rerun_v1`) as the memory folder sees it. */
export interface MemoryRepoRerunRequests {
  /** Null when none is pending. */
  request: () => Promise<{ token: string; requestedAt: number; laneMigrationDone: boolean } | null>;
  consume: (token: string) => Promise<unknown>;
  stores: ReadonlySet<string>;
}

/**
 * The export, then the fact retirement. A pending re-run request is applied once the lane
 * migration has run again since it was made, and consumed when both steps are through (the
 * folder is on and writable, and no other process holds the retirement lock); otherwise it
 * waits for a later start, also while the folder is off.
 */
export async function runMemoryRepoExportChain(
  service: MemoryRepoService,
  deps: MemoryRepoExportDeps &
    Omit<MemoryItemsFactRetirementDeps, "rerun"> & { rerun?: MemoryRepoRerunRequests },
): Promise<{
  exported: Awaited<ReturnType<typeof runMemoryRepoExport>>;
  retired: MemoryItemsFactRetirementResult;
}> {
  // An unreadable request leaves it pending; the plain export and retirement still run.
  const request = deps.rerun ? await deps.rerun.request().catch(() => null) : null;
  const rerun =
    request?.laneMigrationDone && deps.rerun
      ? { after: request.requestedAt, stores: deps.rerun.stores }
      : undefined;
  const exported = await runMemoryRepoExport(service, deps, { rerun });
  const retired = await runMemoryItemsFactRetirement(service, { ...deps, rerun });
  if (request && rerun && exported.reason !== "not_writable" && retired.reason !== "busy") {
    await deps.rerun?.consume(request.token);
  }
  return { exported, retired };
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}
