import fs from "fs/promises";
import { DailyLogSummarizer } from "./DailyLogSummarizer";
import { LayeredMemoryIndexService } from "./LayeredMemoryIndexService";
import { TranscriptStore } from "./TranscriptStore";
import type { MarkdownMemoryReadGuard } from "./MarkdownMemoryIndexService";

export type MemoryConsolidationPhase = "orient" | "gather_signal" | "consolidate" | "prune_index";

export interface MemoryConsolidationResult {
  ok: boolean;
  phases: MemoryConsolidationPhase[];
  summaryPath?: string;
  indexPath?: string;
  topicCount?: number;
  skipped?: boolean;
  reason?: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A lock older than this is left over from a crashed run and is removed. */
export const CONSOLIDATION_LOCK_STALE_MS = 10 * 60 * 1000;

async function acquireConsolidationLock(lockPath: string): Promise<fs.FileHandle | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fs.open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" || attempt > 0) return null;
      try {
        const stat = await fs.lstat(lockPath);
        if (!stat.isFile() || Date.now() - stat.mtimeMs <= CONSOLIDATION_LOCK_STALE_MS) {
          return null;
        }
        await fs.rm(lockPath, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

export class MemoryConsolidator {
  static async run(params: {
    workspaceId: string;
    workspacePath: string;
    taskId?: string;
    taskPrompt: string;
    readGuard?: MarkdownMemoryReadGuard;
    writeGuard?: (candidatePath: string) => boolean;
  }): Promise<MemoryConsolidationResult> {
    const lockPath = LayeredMemoryIndexService.resolveLockPath(params.workspacePath);
    const canWrite = (candidatePath: string): boolean => {
      if (!params.writeGuard) return true;
      try {
        return params.writeGuard(candidatePath) === true;
      } catch {
        return false;
      }
    };
    if (!canWrite(lockPath)) {
      return {
        ok: true,
        phases: [],
        skipped: true,
        reason: "access_profile_write_denied",
      };
    }
    const layoutReady = await LayeredMemoryIndexService.ensureLayout(
      params.workspacePath,
      params.writeGuard,
    );
    if (!layoutReady) {
      return {
        ok: true,
        phases: [],
        skipped: true,
        reason: "access_profile_write_denied",
      };
    }

    let lockHandle: fs.FileHandle | null = null;
    const phases: MemoryConsolidationPhase[] = [];

    lockHandle = await acquireConsolidationLock(lockPath);
    if (!lockHandle) {
      return {
        ok: true,
        phases,
        skipped: true,
        reason: "consolidation_locked",
      };
    }

    try {
      phases.push("orient");
      const recentSpans = params.taskId
        ? await TranscriptStore.loadRecentSpans(
            params.workspacePath,
            params.taskId,
            20,
            params.readGuard,
          )
        : [];

      phases.push("gather_signal");
      // Only counts and the task's own prompt are kept from the transcript. Raw span
      // payloads are never copied into the summary, because summaries are injected
      // into later prompts.
      const eventCount = recentSpans.length;

      phases.push("consolidate");
      if (params.taskId && eventCount > 0) {
        const promptExcerpt = params.taskPrompt.replace(/\s+/g, " ").trim().slice(0, 140);
        const time = new Date().toISOString().slice(11, 16);
        await DailyLogSummarizer.appendTaskLine(
          params.workspacePath,
          todayIso(),
          params.taskId,
          `${time} UTC: ${promptExcerpt || "task completed"} (${eventCount} transcript events)`,
          params.writeGuard,
        );
      }
      const summaryPath = DailyLogSummarizer.resolveSummaryPath(params.workspacePath, todayIso());

      phases.push("prune_index");
      const snapshot = await LayeredMemoryIndexService.refreshIndex({
        workspaceId: params.workspaceId,
        workspacePath: params.workspacePath,
        taskPrompt: params.taskPrompt,
        readGuard: params.readGuard,
        writeGuard: params.writeGuard,
      });

      return {
        ok: true,
        phases,
        summaryPath,
        indexPath: snapshot.indexPath,
        topicCount: snapshot.topics.length,
      };
    } finally {
      if (lockHandle) {
        await lockHandle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    }
  }
}
