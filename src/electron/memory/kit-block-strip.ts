/**
 * One-time removal of the retired generated memory blocks from a workspace's
 * `.cowork/USER.md` / `.cowork/MEMORY.md` (docs/memory-repo-phase3-design.md §6) and
 * `.cowork/LORE.md` / `.cowork/MISTAKES.md` (docs/memory-repo-phase5-design.md §1). The
 * curated blocks were rendered views of memory_items and the lore block a per-task milestone
 * list; nothing writes them any more, and the prompt strips them meanwhile
 * (WorkspaceKitContext). The MISTAKES.md feedback-pattern block is removed only while the
 * memory folder is writable: with the folder off FeedbackService still writes it.
 *
 * Runs at most once per workspace per process, when a task plans in that workspace and
 * from "Clear All Memories". It is content-idempotent: a file without markers is never
 * written. The pass is skipped (and retried on a later call) when the kit files are
 * symlinks or resolve outside the workspace, or when the workspace's effective access
 * profile denies reading or writing them. A changed file gets a `.history` snapshot of
 * its previous content. Afterwards the workspace's leftover render-state keys are deleted.
 */
import fs from "fs";
import path from "path";
import type { Workspace } from "../../shared/types";
import { writeKitFileWithSnapshot } from "../context/kit-revisions";
import { createBackgroundKitPathGuard } from "../security/background-write-guard";
import { withEffectiveAccessProfile } from "../security/effective-workspace";
import { createLogger } from "../utils/logger";
import { removeGeneratedMemoryBlocks } from "./generated-kit-blocks";
import { KIT_FILE_NAMES, kitFilesInsideWorkspace } from "./kit-file-containment";
import { MemoryWriter } from "./MemoryWriter";
import { writableMemoryRepo } from "./repo/memory-repo-producers";

const logger = createLogger("KitBlockStrip");

export type KitBlockStripOutcome =
  | { status: "done"; changedFiles: string[] }
  | { status: "already_done" }
  | { status: "skipped"; reason: "no_workspace" | "outside_workspace" | "access_denied" | "error" };

const handledWorkspaces = new Set<string>();
const inFlight = new Map<string, Promise<KitBlockStripOutcome>>();

/** Text without the generated blocks; trailing blank lines left by a removed block collapse. */
function stripFileContent(content: string, keepFeedbackPatterns: boolean): string {
  const next = removeGeneratedMemoryBlocks(content, { keepFeedbackPatterns });
  if (next === content) return content;
  const trimmed = next.trimEnd();
  return trimmed ? `${trimmed}\n` : "";
}

async function stripWorkspace(
  workspace: Workspace,
  folderWritable: boolean,
): Promise<KitBlockStripOutcome> {
  if (!(await kitFilesInsideWorkspace(workspace.path))) {
    return { status: "skipped", reason: "outside_workspace" };
  }
  const guard = createBackgroundKitPathGuard(
    withEffectiveAccessProfile(workspace),
    "generated memory block cleanup",
  );
  const root = path.join(workspace.path, ".cowork");
  const files = KIT_FILE_NAMES.map((name) => path.join(root, name)).filter((abs) =>
    fs.existsSync(abs),
  );
  // Check every file before changing any, so a denied file leaves the pass for later.
  try {
    for (const abs of files) {
      guard(abs, "read");
      guard(abs, "write");
    }
  } catch {
    return { status: "skipped", reason: "access_denied" };
  }

  const changedFiles: string[] = [];
  for (const abs of files) {
    const content = fs.readFileSync(abs, "utf8");
    const next = stripFileContent(content, !folderWritable);
    if (next === content) continue;
    writeKitFileWithSnapshot(abs, next, "system", "remove generated memory block", guard);
    changedFiles.push(path.relative(workspace.path, abs));
  }

  try {
    await MemoryWriter.get()?.repository.clearKitRenderState(workspace.id);
  } catch (error) {
    logger.warn(`Clearing kit render state for workspace ${workspace.id} failed:`, error);
  }
  return { status: "done", changedFiles };
}

/**
 * Remove the generated blocks from the workspace's kit files once. Never throws; call it
 * fire-and-forget. `isFolderWritable` decides whether the MISTAKES.md feedback-pattern
 * block goes too (default: the memory folder service is running and writable).
 */
export async function stripCuratedKitBlocksOnce(
  workspace: Workspace | null | undefined,
  isFolderWritable: () => boolean = () => writableMemoryRepo() !== null,
): Promise<KitBlockStripOutcome> {
  if (!workspace?.id || !workspace.path) return { status: "skipped", reason: "no_workspace" };
  if (handledWorkspaces.has(workspace.id)) return { status: "already_done" };
  const running = inFlight.get(workspace.id);
  if (running) return running;
  const run = (async (): Promise<KitBlockStripOutcome> => {
    try {
      const outcome = await stripWorkspace(workspace, isFolderWritable());
      if (outcome.status === "done") {
        handledWorkspaces.add(workspace.id);
        if (outcome.changedFiles.length > 0) {
          logger.info(
            `Removed generated memory blocks from ${outcome.changedFiles.join(", ")} in workspace ${workspace.id}`,
          );
        }
      }
      return outcome;
    } catch (error) {
      logger.warn(`Removing generated memory blocks in workspace ${workspace.id} failed:`, error);
      return { status: "skipped", reason: "error" };
    } finally {
      inFlight.delete(workspace.id);
    }
  })();
  inFlight.set(workspace.id, run);
  return run;
}

/** Tests: forget which workspaces were handled. */
export function resetKitBlockStripForTests(): void {
  handledWorkspaces.clear();
  inFlight.clear();
}
