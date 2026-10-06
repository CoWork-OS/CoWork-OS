/**
 * MemoryWorkspacePurgeService — one place that removes everything memory-side for a
 * deleted task or for "Clear All Memories" (audit SEC-15).
 *
 * Task delete: database rows derived from the task (archive memories, durable context,
 * transcript span index, KG facts, Playbook entries and evidence, suggestions raised from the
 * task) are removed inside
 * `TaskStore.delete`'s transaction (memory-purge-sql.ts). This service removes the
 * file-side copies afterwards: transcripts (via `TranscriptStore.deleteTask`: conversation
 * index rows written after the delete, legacy JSONL spans,
 * checkpoints and lock file) and Chronicle observations with their screenshots.
 *
 * Workspace clear: every memory store for the workspace, each step failure-isolated, with
 * per-store counts so the UI can show what was cleared.
 *
 * File deletes are confined: directories are resolved with realpath and must stay inside
 * the workspace, only direct children with expected names are removed, and symlinks are
 * unlinked rather than followed. These are app-owned files under `.cowork/`, removed on an
 * explicit user action, so they do not go through the agent access profile.
 *
 * Supermemory (remote) copies (SEC-17): every copy recorded for the workspace is deleted
 * remotely on a workspace clear; after a task delete, copies of the purged rows are
 * forgotten by the orphan sweep. Copies sent before remote ids were recorded cannot be
 * addressed and stay remote.
 */
import { MemoryRepoService } from "./repo/MemoryRepoService";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { createLogger } from "../utils/logger";
import { ChronicleObservationRepository } from "../chronicle/ChronicleObservationRepository";
import { CuratedMemoryService } from "./CuratedMemoryService";
import { stripCuratedKitBlocksOnce } from "./kit-block-strip";
import { DurableContextService } from "./DurableContextService";
import { MemoryService } from "./MemoryService";
import { SupermemoryService } from "./SupermemoryService";
import { TranscriptStore, type TranscriptDeletionResult } from "./TranscriptStore";
import { purgeWorkspaceMemoryRowsOnHost, resolveWorkspacePathOnHost } from "./memory-purge-sql";

const logger = createLogger("MemoryWorkspacePurgeService");

const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MEMORY_DIR = path.join(".cowork", "memory");

export interface MemoryWorkspacePurgeCounts {
  memories: number;
  curatedEntries: number;
  durableContext: number;
  knowledgeGraph: number;
  transcripts: number;
  topicFiles: number;
  dailySummaries: number;
  chronicleObservations: number;
  dreaming: number;
  coreMemoryCandidates: number;
  playbookEvidence: number;
  playbookEntries: number;
  /** Proactive suggestions and suggestion feedback. */
  suggestions: number;
  /** Memory engine fact store (memory_items) rows owned by the workspace. */
  memoryItems: number;
  pendingMemoryWrites: number;
}

export interface MemoryWorkspacePurgeResult {
  success: boolean;
  workspaceId: string;
  counts: MemoryWorkspacePurgeCounts;
  /** Store name to error message, for the steps that failed. Other steps still ran. */
  errors: Partial<Record<keyof MemoryWorkspacePurgeCounts, string>>;
  notes: string[];
}

export interface MemoryTaskFilePurgeResult {
  transcripts: number;
  chronicleObservations: number;
  errors: string[];
}

export const SUPERMEMORY_NOT_PURGED_NOTE =
  "Copies sent to Supermemory before remote ids were recorded cannot be removed from it.";

function emptyCounts(): MemoryWorkspacePurgeCounts {
  return {
    memories: 0,
    curatedEntries: 0,
    durableContext: 0,
    knowledgeGraph: 0,
    transcripts: 0,
    topicFiles: 0,
    dailySummaries: 0,
    chronicleObservations: 0,
    dreaming: 0,
    coreMemoryCandidates: 0,
    playbookEvidence: 0,
    playbookEntries: 0,
    suggestions: 0,
    memoryItems: 0,
    pendingMemoryWrites: 0,
  };
}

function realpathOrNull(target: string): string | null {
  try {
    return fsSync.realpathSync(target);
  } catch {
    return null;
  }
}

/** Canonical `<workspace>/<relativeDir>` when it exists and stays inside the workspace. */
function resolveConfinedDir(workspacePath: string, relativeDir: string): string | null {
  const workspaceReal = realpathOrNull(workspacePath);
  const dirReal = realpathOrNull(path.join(workspacePath, relativeDir));
  if (!workspaceReal || !dirReal || dirReal === workspaceReal) return null;
  const relative = path.relative(workspaceReal, dirReal);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return dirReal;
}

/** Remove direct children of a confined directory whose names pass `accept`. */
async function removeConfinedFiles(
  workspacePath: string,
  relativeDir: string,
  accept: (name: string) => boolean,
): Promise<number> {
  const dir = resolveConfinedDir(workspacePath, relativeDir);
  if (!dir) return 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!accept(entry.name)) continue;
    // fs.rm on a symlink removes the link itself, never its target.
    await fs.rm(path.join(dir, entry.name), { force: true });
    removed += 1;
  }
  return removed;
}

/** Files and index rows removed by a TranscriptStore deletion. */
function transcriptDeletionCount(result: TranscriptDeletionResult): number {
  return result.indexRows + result.spanFiles + result.checkpointFiles;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MemoryWorkspacePurgeService {
  /**
   * Remove the file-side memory of a task after its database row was deleted. Each store
   * is failure-isolated; errors are returned (and logged), never thrown.
   */
  static async purgeTaskFiles(params: {
    taskId: string;
    workspacePath?: string | null;
    /** An explicit user delete: also remove what the task's agent saved to the memory repo. */
    purgeDerivedMemory?: boolean;
  }): Promise<MemoryTaskFilePurgeResult> {
    const result: MemoryTaskFilePurgeResult = {
      transcripts: 0,
      chronicleObservations: 0,
      errors: [],
    };
    try {
      MemoryService.clearPromptRecallCache();
    } catch {
      // Memory may not be initialized (CLI, tests); there is no cache to clear then.
    }
    // Supermemory copies of the rows the task delete purged (SEC-17).
    SupermemoryService.scheduleOrphanSweep();
    if (params.purgeDerivedMemory && SAFE_TASK_ID.test(params.taskId)) {
      try {
        await MemoryRepoService.get()?.purgeTask(params.taskId);
      } catch (error) {
        result.errors.push(`memory repo: ${errorMessage(error)}`);
      }
    }
    // A deleted root task takes its swarm folder with it (docs/memory-repo-phase5-design.md §2).
    if (SAFE_TASK_ID.test(params.taskId)) {
      try {
        await MemoryRepoService.get()?.purgeSwarm(params.taskId);
      } catch (error) {
        result.errors.push(`swarm notes: ${errorMessage(error)}`);
      }
    }
    const workspacePath = params.workspacePath;
    if (!workspacePath || !SAFE_TASK_ID.test(params.taskId)) return result;

    try {
      // The JSONL file, both checkpoint generations and the lock file.
      result.transcripts = transcriptDeletionCount(
        await TranscriptStore.deleteTask(params.taskId, { workspacePath }),
      );
    } catch (error) {
      result.errors.push(`transcripts: ${errorMessage(error)}`);
    }
    try {
      const observations = ChronicleObservationRepository.listSync(
        workspacePath,
        Number.MAX_SAFE_INTEGER,
      ).filter((record) => record.taskId === params.taskId);
      for (const observation of observations) {
        if (await ChronicleObservationRepository.deleteObservation(workspacePath, observation.id)) {
          result.chronicleObservations += 1;
        }
      }
    } catch (error) {
      result.errors.push(`chronicle: ${errorMessage(error)}`);
    }
    if (result.errors.length > 0) {
      logger.warn(`Task ${params.taskId} memory file cleanup was partial:`, result.errors);
    }
    return result;
  }

  /**
   * "Clear All Memories": remove every memory store for the workspace. Each store is a
   * separate step; a failing step is reported in `errors` and the rest still run.
   */
  static async purgeWorkspace(workspace: {
    id: string;
    /** The workspace folder; looked up when omitted. */
    path?: string | null;
  }): Promise<MemoryWorkspacePurgeResult> {
    const workspaceId = workspace.id;
    const workspacePath =
      workspace.path === undefined
        ? await resolveWorkspacePathOnHost(workspaceId).catch(() => null)
        : workspace.path || null;
    const counts = emptyCounts();
    const errors: MemoryWorkspacePurgeResult["errors"] = {};
    const step = async (
      key: keyof MemoryWorkspacePurgeCounts,
      action: () => Promise<number>,
    ): Promise<void> => {
      try {
        counts[key] += await action();
      } catch (error) {
        errors[key] = errorMessage(error);
        logger.warn(`Clearing ${key} for workspace ${workspaceId} failed:`, error);
      }
    };

    await step("memories", async () => {
      const before = await MemoryService.getStats(workspaceId).catch(() => ({ count: 0 }));
      await MemoryService.clearWorkspace(workspaceId);
      return before.count;
    });
    await step("durableContext", () => DurableContextService.clearWorkspace(workspaceId));

    // Database stores outside MemoryService, in one transaction. Their counts are
    // assigned per store; a failure is reported against each of them.
    try {
      const rows = await purgeWorkspaceMemoryRowsOnHost(workspaceId);
      if (rows) {
        counts.curatedEntries += rows.curatedEntries;
        counts.knowledgeGraph += rows.knowledgeGraph;
        counts.dreaming += rows.dreaming;
        counts.coreMemoryCandidates += rows.coreMemoryCandidates;
        counts.playbookEvidence += rows.playbookEvidence;
        counts.playbookEntries += rows.playbookEntries;
        counts.suggestions += rows.suggestions;
        counts.memoryItems += rows.memoryItems;
        counts.pendingMemoryWrites += rows.pendingMemoryWrites;
        counts.transcripts += rows.transcriptSpans;
      }
    } catch (error) {
      const message = errorMessage(error);
      for (const key of [
        "curatedEntries",
        "knowledgeGraph",
        "dreaming",
        "coreMemoryCandidates",
        "playbookEvidence",
        "playbookEntries",
        "suggestions",
        "memoryItems",
        "pendingMemoryWrites",
      ] as const) {
        errors[key] = message;
      }
      logger.warn(`Clearing memory rows for workspace ${workspaceId} failed:`, error);
    }

    await step("memoryItems", async () => {
      // The workspace's file in the memory repo (then the history is compacted).
      return (await MemoryRepoService.get()?.clearWorkspace(workspaceId)) ? 1 : 0;
    });

    if (workspacePath) {
      // Remove leftover generated memory blocks from .cowork/USER.md and .cowork/MEMORY.md
      // (retired views of memory_items), so cleared facts are not left quoted in the files.
      await step("curatedEntries", async () => {
        const stored = await CuratedMemoryService.findWorkspace(workspaceId);
        if (stored) await stripCuratedKitBlocksOnce({ ...stored, path: workspacePath });
        return 0;
      });
      await step("transcripts", async () =>
        transcriptDeletionCount(await TranscriptStore.deleteWorkspace(workspacePath)),
      );
      // Leftover files of the retired topic packs and daily summaries.
      await step("topicFiles", async () => {
        const topics = await removeConfinedFiles(
          workspacePath,
          path.join(MEMORY_DIR, "topics"),
          (name) => name.endsWith(".md"),
        );
        const index = await removeConfinedFiles(
          workspacePath,
          MEMORY_DIR,
          (name) => name === "MEMORY.md",
        );
        return topics + index;
      });
      await step("dailySummaries", () =>
        removeConfinedFiles(workspacePath, path.join(MEMORY_DIR, "summaries"), (name) =>
          /^\d{4}-\d{2}-\d{2}\.md$/.test(name),
        ),
      );
      await step("chronicleObservations", async () => {
        const before = ChronicleObservationRepository.listSync(
          workspacePath,
          Number.MAX_SAFE_INTEGER,
        ).length;
        await ChronicleObservationRepository.clearWorkspace(workspacePath);
        return before;
      });
    }

    try {
      MemoryService.clearPromptRecallCache();
    } catch {
      // Memory may not be initialized; nothing cached then.
    }

    const notes = [SUPERMEMORY_NOT_PURGED_NOTE];
    try {
      const remote = await SupermemoryService.forgetWorkspaceCopies(workspaceId);
      if (remote.forgotten > 0) {
        notes.push(`Deleted ${remote.forgotten} Supermemory ${remote.forgotten === 1 ? "copy" : "copies"}.`);
      }
      if (remote.failed > 0) {
        notes.push(
          `${remote.failed} Supermemory ${remote.failed === 1 ? "copy" : "copies"} could not be deleted (Supermemory unreachable or disconnected); they are kept on record for "Disconnect & purge".`,
        );
      }
    } catch (error) {
      logger.warn(`Forgetting Supermemory copies for workspace ${workspaceId} failed:`, error);
    }

    const success = Object.keys(errors).length === 0;
    logger.info(`Cleared memory for workspace ${workspaceId}`, counts);
    return {
      success,
      workspaceId,
      counts,
      errors,
      notes,
    };
  }
}
