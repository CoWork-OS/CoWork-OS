import fs from "fs/promises";
import path from "path";
import { InputSanitizer } from "../agent/security/input-sanitizer";
import { extractFtsTerms, foldForMatch } from "../database/fts-query";
import { DurableContextService, type ConversationHit } from "./DurableContextService";
import {
  TranscriptStore,
  type TranscriptCheckpointPayload,
  type TranscriptReadGuard,
} from "./TranscriptStore";

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

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Checkpoints read per workspace-wide query, newest first. */
export const MAX_CHECKPOINTS_PER_QUERY = 50;

/**
 * Task ids of the most recently written checkpoints. `.previous.json` generations
 * and temp files are not separate tasks; `loadCheckpoint` considers the previous
 * generation itself.
 */
async function listRecentCheckpointTaskIds(dir: string, cap: number): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const entries: Array<{ taskId: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".previous.json")) continue;
    const taskId = name.slice(0, -".json".length);
    if (!SAFE_TASK_ID.test(taskId)) continue;
    const stat = await fs.lstat(path.join(dir, name)).catch(() => null);
    if (!stat?.isFile()) continue;
    entries.push({ taskId, mtimeMs: stat.mtimeMs });
  }
  return entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.taskId.localeCompare(b.taskId))
    .slice(0, cap)
    .map((entry) => entry.taskId);
}

function checkpointSearchText(checkpoint: TranscriptCheckpointPayload): string {
  try {
    return JSON.stringify([
      checkpoint.explicitChatSummaryBlock,
      checkpoint.planSummary,
      checkpoint.trackerState,
      checkpoint.structuredSummary,
      checkpoint.conversationHistory,
    ]);
  } catch {
    return "";
  }
}

function summarizePayload(payload: unknown): string {
  if (typeof payload === "string") return payload.replace(/\s+/g, " ").trim().slice(0, 280);
  try {
    return JSON.stringify(payload).replace(/\s+/g, " ").trim().slice(0, 280);
  } catch {
    return "";
  }
}

/** Snippets are recalled history: instruction-override patterns are neutralized. */
function cleanSnippet(text: string): string {
  return InputSanitizer.sanitizeMemoryContent(text.replace(/\s+/g, " ").trim()).slice(0, 600);
}

function mapConversationHit(hit: ConversationHit): SessionRecallResult {
  return {
    taskId: hit.taskId,
    timestamp: hit.timestamp,
    type: hit.type,
    snippet: cleanSnippet(hit.snippet),
    ...(hit.eventId ? { eventId: hit.eventId } : {}),
    ...(typeof hit.seq === "number" ? { seq: hit.seq } : {}),
  };
}

/** Every query term occurs in the text (case- and accent-insensitive). */
function matchesAllTerms(text: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const haystack = foldForMatch(text);
  return terms.every((term) => haystack.includes(foldForMatch(term)));
}

/**
 * `search_sessions` and the recovery prompt's "earlier session evidence": hits from the
 * conversation index (every task of the workspace, ranked by relevance), optionally
 * filled with matching resume checkpoints.
 */
export class SessionRecallService {
  static async search(params: {
    workspaceId: string;
    workspacePath: string;
    query: string;
    taskId?: string;
    limit?: number;
    includeCheckpoints?: boolean;
    readGuard?: TranscriptReadGuard;
  }): Promise<SessionRecallResult[]> {
    const query = String(params.query || "").trim();
    if (!query) return [];

    const limit = Math.max(1, params.limit ?? 10);
    const indexResults = (
      await DurableContextService.searchConversation({
        workspaceId: params.workspaceId,
        taskId: params.taskId,
        query,
        limit,
        mode: "auto",
      })
    ).map(mapConversationHit);

    if (!params.includeCheckpoints || indexResults.length >= limit) {
      return indexResults.slice(0, limit);
    }

    const checkpointResults = await this.searchCheckpoints({
      workspacePath: params.workspacePath,
      query,
      taskId: params.taskId,
      limit: limit - indexResults.length,
      readGuard: params.readGuard,
    });

    return [...indexResults, ...checkpointResults].slice(0, limit);
  }

  private static async searchCheckpoints(params: {
    workspacePath: string;
    query: string;
    taskId?: string;
    limit: number;
    readGuard?: TranscriptReadGuard;
  }): Promise<SessionRecallResult[]> {
    const terms = extractFtsTerms(params.query);
    if (terms.length === 0) return [];
    const dir = checkpointsDir(params.workspacePath);
    if (params.readGuard && !params.taskId) {
      try {
        if (!params.readGuard(dir)) return [];
      } catch {
        return [];
      }
    }
    if (params.taskId && !SAFE_TASK_ID.test(params.taskId)) {
      return [];
    }
    const taskIds = params.taskId
      ? [params.taskId]
      : await listRecentCheckpointTaskIds(dir, MAX_CHECKPOINTS_PER_QUERY);

    const results: SessionRecallResult[] = [];
    for (const taskId of taskIds) {
      // loadCheckpoint applies the read guard to each generation, verifies the
      // signature and picks the freshest valid one; unsigned files are ignored.
      const checkpoint = await TranscriptStore.loadCheckpoint(
        params.workspacePath,
        taskId,
        params.readGuard,
      );
      if (!checkpoint) continue;
      const searchable = checkpointSearchText(checkpoint);
      if (!matchesAllTerms(searchable, terms)) continue;
      const snippet = summarizePayload(
        checkpoint.explicitChatSummaryBlock ||
          checkpoint.planSummary ||
          checkpoint.trackerState ||
          checkpoint.conversationHistory,
      );
      results.push({
        taskId,
        timestamp: Number(checkpoint.timestamp || 0),
        type: "checkpoint",
        snippet: cleanSnippet(snippet || searchable.slice(0, 280)),
      });
    }
    return results.sort(compareRecallResults).slice(0, params.limit);
  }
}
