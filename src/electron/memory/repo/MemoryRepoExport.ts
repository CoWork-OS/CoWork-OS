/**
 * One-time export of the existing facts into the memory repo
 * (docs/memory-repo-phase1-design.md §8).
 *
 * Active, non-private `memory_items` of global and workspace scope go to the repo through
 * `MemoryRepoService.remember` (so the normal file choice, dedupe and redaction apply):
 * stated, confirmed and curated facts as `by: user`, the rest as `by: agent`. Contact and
 * task scopes and third-party text stay in `memory_items`. The rows are not deleted.
 *
 * The marker lives in the repo's own `.git` folder: a repo at a new path gets its own
 * export, and the repo's write lock keeps two processes from exporting at once (a re-run
 * adds nothing anyway, because writes dedupe).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../utils/logger";
import type { MemoryItem, MemoryItemSource } from "../memory-items-types";
import type { MemoryRepoService } from "./MemoryRepoService";

const logger = createLogger("MemoryRepoExport");

export const MEMORY_REPO_EXPORT_MARKER = "cowork-export-v1";

const USER_SOURCES: ReadonlySet<MemoryItemSource> = new Set([
  "user_stated",
  "user_confirmed",
  "curated",
]);

export interface MemoryRepoExportDeps {
  listItems: () => Promise<MemoryItem[]>;
  workspaceName: (workspaceId: string) => Promise<string | null>;
}

export interface MemoryRepoExportResult {
  ran: boolean;
  written: number;
  skipped: number;
}

function markerPath(service: MemoryRepoService): string {
  return path.join(service.root, ".git", MEMORY_REPO_EXPORT_MARKER);
}

export async function runMemoryRepoExport(
  service: MemoryRepoService,
  deps: MemoryRepoExportDeps,
): Promise<MemoryRepoExportResult> {
  if (!service.isWritable()) return { ran: false, written: 0, skipped: 0 };
  const marker = markerPath(service);
  const gitDir = path.dirname(marker);
  const hasGitDir = await fs
    .stat(gitDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  // Without git there is no history to mark; the dedupe keeps a re-run from adding anything.
  if (hasGitDir && (await fs.stat(marker).catch(() => null))) {
    return { ran: false, written: 0, skipped: 0 };
  }
  let written = 0;
  let skipped = 0;
  const names = new Map<string, string | null>();
  const items = (await deps.listItems())
    .filter(
      (item) =>
        item.status === "active" &&
        item.privacy !== "private" &&
        item.source !== "third_party" &&
        (item.scope === "global" || (item.scope === "workspace" && item.workspaceId)),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const item of items) {
    let workspaceName: string | null = null;
    if (item.scope === "workspace" && item.workspaceId) {
      if (!names.has(item.workspaceId)) {
        names.set(item.workspaceId, await deps.workspaceName(item.workspaceId).catch(() => null));
      }
      workspaceName = names.get(item.workspaceId) ?? null;
    }
    const byUser = USER_SOURCES.has(item.source);
    const result = await service.remember({
      text: item.content,
      kind: item.kind,
      scope: item.scope === "global" ? "global" : "workspace",
      workspaceId: item.workspaceId,
      workspaceName,
      by: byUser ? "user" : "agent",
      pinned: byUser && item.pinned,
      subject: item.subjectKey && !item.subjectKey.includes(":") ? item.subjectKey : null,
      taskId: item.taskId,
      origin: "export",
      addedAt: item.createdAt,
      skipWorkspacePolicy: true,
    });
    if (result.status === "written") written += 1;
    else skipped += 1;
  }
  if (hasGitDir) {
    await fs.writeFile(marker, JSON.stringify({ at: Date.now(), written, skipped }), { mode: 0o600 });
  }
  logger.info(`Exported ${written} fact(s) into the memory repo (${skipped} skipped)`);
  return { ran: true, written, skipped };
}
