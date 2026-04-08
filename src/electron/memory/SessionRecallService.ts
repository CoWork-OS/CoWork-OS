import fs from "fs/promises";
import path from "path";
import { TranscriptStore, type TranscriptSearchResult } from "./TranscriptStore";

export interface SessionRecallResult {
  taskId: string;
  timestamp: number;
  type: string;
  snippet: string;
  eventId?: string;
  seq?: number;
}

function compareRecallResults(a: SessionRecallResult, b: SessionRecallResult): number {
  return (
    b.timestamp - a.timestamp ||
    a.taskId.localeCompare(b.taskId) ||
    (typeof b.seq === "number" ? b.seq : -1) - (typeof a.seq === "number" ? a.seq : -1) ||
    a.type.localeCompare(b.type)
  );
}

function checkpointsDir(workspacePath: string): string {
  return path.join(workspacePath, ".cowork", "memory", "transcripts", "checkpoints");
}

function summarizePayload(payload: unknown): string {
  if (typeof payload === "string") return payload.replace(/\s+/g, " ").trim().slice(0, 280);
  try {
    return JSON.stringify(payload).replace(/\s+/g, " ").trim().slice(0, 280);
  } catch {
    return "";
  }
}

function mapSpanResult(entry: TranscriptSearchResult): SessionRecallResult {
  return {
    taskId: entry.taskId,
    timestamp: entry.timestamp,
    type: entry.type,
    snippet: summarizePayload(entry.payload) || entry.rawLine.slice(0, 280),
    ...(entry.eventId ? { eventId: entry.eventId } : {}),
    ...(typeof entry.seq === "number" ? { seq: entry.seq } : {}),
  };
}

export class SessionRecallService {
  static async search(params: {
    workspacePath: string;
    query: string;
    taskId?: string;
    limit?: number;
    includeCheckpoints?: boolean;
  }): Promise<SessionRecallResult[]> {
    const query = String(params.query || "").trim();
    if (!query) return [];

    const limit = Math.max(1, params.limit ?? 10);
    const transcriptResults = (
      await TranscriptStore.searchSpans({
        workspacePath: params.workspacePath,
        query,
        taskId: params.taskId,
        limit,
      })
    ).map(mapSpanResult);

    if (!params.includeCheckpoints || transcriptResults.length >= limit) {
      return transcriptResults.slice(0, limit);
    }

    const checkpointResults = await this.searchCheckpoints({
      workspacePath: params.workspacePath,
      query,
      taskId: params.taskId,
      limit: limit - transcriptResults.length,
    });

    return [...transcriptResults, ...checkpointResults]
      .sort(compareRecallResults)
      .slice(0, limit);
  }

  private static async searchCheckpoints(params: {
    workspacePath: string;
    query: string;
    taskId?: string;
    limit: number;
  }): Promise<SessionRecallResult[]> {
    const query = params.query.toLowerCase();
    const dir = checkpointsDir(params.workspacePath);
    const taskIds = params.taskId
      ? [`${params.taskId}.json`]
      : (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json"));

    const results: SessionRecallResult[] = [];
    for (const fileName of taskIds) {
      const filePath = path.join(dir, fileName);
      const raw = await fs.readFile(filePath, "utf8").catch(() => "");
      if (!raw || !raw.toLowerCase().includes(query)) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const snippet = summarizePayload(
          parsed.explicitChatSummaryBlock ||
            parsed.planSummary ||
            parsed.trackerState ||
            parsed.conversationHistory,
        );
        results.push({
          taskId: fileName.replace(/\.json$/, ""),
          timestamp: Number(parsed.timestamp || Date.now()),
          type: "checkpoint",
          snippet: snippet || raw.slice(0, 280),
        });
      } catch {
        continue;
      }
    }
    return results.sort(compareRecallResults).slice(0, params.limit);
  }
}
