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
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../utils/logger";
import { writeBackup } from "../LegacyMemoryRetirement";
import type { MemoryItem } from "../memory-items-types";
import type { SafeStorageLike } from "../../utils/safe-storage";
import type { MemoryRepoService } from "./MemoryRepoService";
import { MEMORY_REPO_EXPORT_MARKER } from "./MemoryRepoExport";
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
  if (await exists(marker)) return { ran: false, reason: "done", retired: 0, kept: 0 };
  try {
    return await withMemoryRepoLock(
      path.join(gitDir, "cowork-fact-retirement.lock"),
      async () => {
        if (await exists(marker)) return { ran: false, reason: "done" as const, retired: 0, kept: 0 };
        const now = (deps.now ?? Date.now)();
        const inFolder = new Set<string>();
        for (const file of await service.listFiles()) {
          // Swarm notes are agents' notes, not the user's facts.
          if (isSwarmRepoPath(file)) continue;
          for (const entry of await service.entries(file)) inFolder.add(entry.hash);
        }
        const rows = (await deps.listItems()).filter(isRetiredFactRow);
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
          JSON.stringify({ at: now, retired: retire.length, kept, backup }),
          { mode: 0o600 },
        );
        logger.info(`Retired ${retire.length} fact row(s) now held by the memory folder (${kept} kept)`);
        return { ran: true, retired: retire.length, kept, backup };
      },
      { timeoutMs: 0, staleMs: 10 * 60 * 1000 },
    );
  } catch (error) {
    if (error instanceof MemoryRepoBusyError) return { ran: false, reason: "busy", retired: 0, kept: 0 };
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}
