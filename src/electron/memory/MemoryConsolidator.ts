import fs from "fs/promises";
import { DailyLogSummarizer } from "./DailyLogSummarizer";
import { LayeredMemoryIndexService } from "./LayeredMemoryIndexService";
import { TranscriptStore } from "./TranscriptStore";

export type MemoryConsolidationPhase =
  | "orient"
  | "gather_signal"
  | "consolidate"
  | "prune_index";

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

export class MemoryConsolidator {
  static async run(params: {
    workspaceId: string;
    workspacePath: string;
    taskId?: string;
    taskPrompt: string;
  }): Promise<MemoryConsolidationResult> {
    const lockPath = LayeredMemoryIndexService.resolveLockPath(params.workspacePath);
    await LayeredMemoryIndexService.ensureLayout(params.workspacePath);

    let lockHandle: fs.FileHandle | null = null;
    const phases: MemoryConsolidationPhase[] = [];

    try {
      lockHandle = await fs.open(lockPath, "wx");
    } catch {
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
        ? await TranscriptStore.loadRecentSpans(params.workspacePath, params.taskId, 20)
        : [];

      phases.push("gather_signal");
      const searchResults = params.taskId
        ? await TranscriptStore.searchSpans({
            workspacePath: params.workspacePath,
            taskId: params.taskId,
            query: params.taskPrompt,
            limit: 8,
          })
        : [];

      phases.push("consolidate");
      const summaryBody = [
        "## Consolidated Signals",
        recentSpans.length > 0
          ? `- Recent transcript events: ${recentSpans.length}`
          : "- Recent transcript events: none captured",
        searchResults.length > 0
          ? `- Query-matched spans: ${searchResults.length}`
          : "- Query-matched spans: none",
        "",
        ...searchResults.slice(0, 5).map((entry) => {
          const payload =
            typeof entry.payload === "string"
              ? entry.payload
              : JSON.stringify(entry.payload).slice(0, 240);
          return `- [${entry.type}] ${payload}`;
        }),
      ]
        .filter(Boolean)
        .join("\n");

      await DailyLogSummarizer.writeSummary(params.workspacePath, todayIso(), summaryBody);
      const summaryPath = DailyLogSummarizer.resolveSummaryPath(params.workspacePath, todayIso());

      phases.push("prune_index");
      const snapshot = await LayeredMemoryIndexService.refreshIndex({
        workspaceId: params.workspaceId,
        workspacePath: params.workspacePath,
        taskPrompt: params.taskPrompt,
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
