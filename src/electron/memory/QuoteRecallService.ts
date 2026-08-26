import fs from "fs/promises";
import path from "path";
import type Database from "better-sqlite3";
import type { TaskEvent, VerbatimQuoteSearchResult, VerbatimQuoteSourceType } from "../../shared/types";
import {
  TaskEventRepository,
  TaskRepository,
  type MemorySearchResult,
} from "../database/repositories";
import { MemoryService } from "./MemoryService";
import { TranscriptStore, type TranscriptSearchResult } from "./TranscriptStore";

const MAX_EVENT_TASKS = 200;
const MAX_EXCERPT_CHARS = 280;
const MESSAGE_EVENT_TYPES = ["user_message", "assistant_message"] as const;
const SOURCE_PRIORITIES: Record<VerbatimQuoteSourceType, number> = {
  transcript_span: 4.5,
  task_message: 4.1,
  memory: 2.5,
  workspace_markdown: 2.8,
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeQueryTokens(query: string): string[] {
  return Array.from(
    new Set(
      normalizeText(query)
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length > 1),
    ),
  );
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return normalizeText(payload);
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const preferredFields = [
    "message",
    "text",
    "content",
    "summary",
    "result",
    "response",
    "assistantText",
    "userText",
  ];
  for (const field of preferredFields) {
    const value = normalizeText(record[field]);
    if (value) return value;
  }

  try {
    return normalizeText(JSON.stringify(payload));
  } catch {
    return "";
  }
}

function buildExcerpt(text: string, query: string, maxChars = MAX_EXCERPT_CHARS): string {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;

  const lowerText = normalized.toLowerCase();
  const lowerQuery = normalizeText(query).toLowerCase();
  let anchor = lowerQuery ? lowerText.indexOf(lowerQuery) : -1;
  if (anchor < 0) {
    const token = normalizeQueryTokens(query).find((candidate) => lowerText.includes(candidate));
    anchor = token ? lowerText.indexOf(token) : 0;
  }

  const halfWindow = Math.floor(maxChars / 2);
  const start = Math.max(0, anchor - halfWindow);
  const end = Math.min(normalized.length, start + maxChars);
  const excerpt = normalized.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < normalized.length ? "…" : ""}`;
}

function lexicalCoverageScore(text: string, query: string): { score: number; exact: boolean } {
  const normalizedText = normalizeText(text).toLowerCase();
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedText || !normalizedQuery) {
    return { score: 0, exact: false };
  }

  const exact = normalizedText.includes(normalizedQuery);
  const tokens = normalizeQueryTokens(query);
  const matches = tokens.filter((token) => normalizedText.includes(token)).length;
  const coverage = tokens.length > 0 ? matches / tokens.length : 0;
  return {
    score: (exact ? 1.2 : 0) + coverage,
    exact,
  };
}

function recencyScore(timestamp: number): number {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  const age = Math.max(0, Date.now() - timestamp);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  return Math.exp((-Math.LN2 * age) / weekMs);
}

function buildRankingReason(parts: {
  sourceType: VerbatimQuoteSourceType;
  exact: boolean;
  upstreamScore?: number;
  timestamp: number;
}): string {
  const reasons = [
    parts.exact ? "exact phrase match" : "token overlap match",
    `${parts.sourceType} priority`,
  ];
  if (typeof parts.upstreamScore === "number" && Number.isFinite(parts.upstreamScore)) {
    reasons.push(`upstream relevance ${parts.upstreamScore.toFixed(2)}`);
  }
  if (parts.timestamp > 0) {
    reasons.push("recency boost");
  }
  return reasons.join("; ");
}

function scoreQuoteCandidate(params: {
  sourceType: VerbatimQuoteSourceType;
  text: string;
  query: string;
  timestamp: number;
  upstreamScore?: number;
}): { score: number; rankingReason: string } {
  const lexical = lexicalCoverageScore(params.text, params.query);
  const sourcePriority = SOURCE_PRIORITIES[params.sourceType] ?? 1;
  const recency = recencyScore(params.timestamp);
  const upstream = Number.isFinite(params.upstreamScore)
    ? Math.max(0, Math.min(1, params.upstreamScore || 0))
    : 0;
  const score = sourcePriority * 10 + lexical.score * 5 + upstream * 2 + recency;
  return {
    score,
    rankingReason: buildRankingReason({
      sourceType: params.sourceType,
      exact: lexical.exact,
      upstreamScore: upstream,
      timestamp: params.timestamp,
    }),
  };
}

function compareQuoteResults(a: VerbatimQuoteSearchResult, b: VerbatimQuoteSearchResult): number {
  return (
    b.relevanceScore - a.relevanceScore ||
    b.timestamp - a.timestamp ||
    b.sourcePriority - a.sourcePriority ||
    a.id.localeCompare(b.id)
  );
}

function mapTranscriptSpan(entry: TranscriptSearchResult, query: string): VerbatimQuoteSearchResult | null {
  const text = stringifyPayload(entry.payload) || entry.rawLine;
  const excerpt = buildExcerpt(text, query);
  if (!excerpt) return null;
  const ranking = scoreQuoteCandidate({
    sourceType: "transcript_span",
    text,
    query,
    timestamp: entry.timestamp,
  });
  const objectId =
    entry.eventId || `${entry.taskId}:${typeof entry.seq === "number" ? entry.seq : entry.timestamp}`;
  return {
    id: `quote:transcript:${objectId}`,
    sourceType: "transcript_span",
    objectId,
    taskId: entry.taskId,
    timestamp: entry.timestamp,
    excerpt,
    relevanceScore: ranking.score,
    sourcePriority: SOURCE_PRIORITIES.transcript_span,
    rankingReason: ranking.rankingReason,
    ...(entry.eventId ? { eventId: entry.eventId } : {}),
    ...(typeof entry.seq === "number" ? { seq: entry.seq } : {}),
  };
}

function mapTaskEvent(entry: TaskEvent, query: string): VerbatimQuoteSearchResult | null {
  const text = stringifyPayload(entry.payload);
  const excerpt = buildExcerpt(text, query);
  if (!excerpt) return null;
  const ranking = scoreQuoteCandidate({
    sourceType: "task_message",
    text,
    query,
    timestamp: entry.timestamp,
  });
  const objectId =
    entry.eventId || entry.id || `${entry.taskId}:${typeof entry.seq === "number" ? entry.seq : entry.timestamp}`;
  return {
    id: `quote:event:${objectId}`,
    sourceType: "task_message",
    objectId,
    taskId: entry.taskId,
    timestamp: entry.timestamp,
    excerpt,
    relevanceScore: ranking.score,
    sourcePriority: SOURCE_PRIORITIES.task_message,
    rankingReason: ranking.rankingReason,
    ...(entry.eventId ? { eventId: entry.eventId } : {}),
    ...(typeof entry.seq === "number" ? { seq: entry.seq } : {}),
  };
}

async function readMarkdownExcerpt(
  workspacePath: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<string> {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const candidatePaths = path.isAbsolute(filePath)
    ? [filePath]
    : [
        path.join(workspacePath, filePath),
        ...(!normalizedPath.startsWith(".cowork/") ? [path.join(workspacePath, ".cowork", filePath)] : []),
      ];

  let raw = "";
  for (const candidatePath of candidatePaths) {
    raw = await fs.readFile(candidatePath, "utf8").catch(() => "");
    if (raw) break;
  }
  if (!raw) return "";
  const lines = raw.split(/\r?\n/);
  const from = Math.max(0, (startLine || 1) - 1);
  const to = Math.min(lines.length, endLine || from + 8);
  return lines.slice(from, Math.max(from + 1, to)).join("\n").trim();
}

export class QuoteRecallService {
  static async search(params: {
    db: Database.Database;
    workspaceId: string;
    workspacePath: string;
    query: string;
    taskId?: string;
    limit?: number;
    sourceTypes?: VerbatimQuoteSourceType[];
    includeWorkspaceNotes?: boolean;
  }): Promise<VerbatimQuoteSearchResult[]> {
    const query = normalizeText(params.query);
    if (!query) return [];

    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const candidateLimit = Math.min(Math.max(limit * 4, 12), 120);
    const requestedSourceTypes = new Set<VerbatimQuoteSourceType>(
      (params.sourceTypes || []).filter(Boolean),
    );
    const allowAllSources = requestedSourceTypes.size === 0;
    const allowSource = (sourceType: VerbatimQuoteSourceType): boolean =>
      allowAllSources || requestedSourceTypes.has(sourceType);

    const results: VerbatimQuoteSearchResult[] = [];

    if (allowSource("transcript_span")) {
      const transcriptHits = await TranscriptStore.searchSpans({
        workspacePath: params.workspacePath,
        query,
        taskId: params.taskId,
        limit: candidateLimit,
      });
      for (const hit of transcriptHits) {
        const mapped = mapTranscriptSpan(hit, query);
        if (mapped) {
          results.push(mapped);
        }
      }
    }

    if (allowSource("task_message")) {
      const eventRepo = new TaskEventRepository(params.db);
      const taskRepo = new TaskRepository(params.db);
      const taskIds = params.taskId
        ? [params.taskId]
        : taskRepo.findByWorkspace(params.workspaceId, MAX_EVENT_TASKS).map((task) => task.id);
      const events = taskIds.length > 0 ? eventRepo.findByTaskIds(taskIds, [...MESSAGE_EVENT_TYPES]) : [];
      for (const event of events) {
        const text = stringifyPayload(event.payload).toLowerCase();
        const lowerQuery = query.toLowerCase();
        const tokenHits = normalizeQueryTokens(query).some((token) => text.includes(token));
        if (!text || (!text.includes(lowerQuery) && !tokenHits)) {
          continue;
        }
        const mapped = mapTaskEvent(event, query);
        if (mapped) {
          results.push(mapped);
        }
      }
    }

    if (allowSource("memory")) {
      const memoryHits = MemoryService.search(params.workspaceId, query, candidateLimit);
      const fullEntriesById = new Map(
        MemoryService.getFullDetails(memoryHits.map((entry) => entry.id)).map((entry) => [entry.id, entry]),
      );
      for (const hit of memoryHits) {
        const full = fullEntriesById.get(hit.id);
        const text = full?.content || hit.snippet;
        const excerpt = buildExcerpt(text, query);
        if (!excerpt) continue;
        const ranking = scoreQuoteCandidate({
          sourceType: "memory",
          text,
          query,
          timestamp: full?.updatedAt || hit.createdAt,
          upstreamScore: hit.relevanceScore,
        });
        results.push({
          id: `quote:memory:${hit.id}`,
          sourceType: "memory",
          objectId: hit.id,
          taskId: hit.taskId,
          timestamp: full?.updatedAt || hit.createdAt,
          excerpt,
          relevanceScore: ranking.score,
          sourcePriority: SOURCE_PRIORITIES.memory,
          rankingReason: ranking.rankingReason,
          memoryType: hit.type,
        });
      }
    }

    if (params.includeWorkspaceNotes !== false && allowSource("workspace_markdown")) {
      const noteHits = MemoryService.searchWorkspaceMarkdown(
        params.workspaceId,
        path.join(params.workspacePath, ".cowork"),
        query,
        candidateLimit,
      ).filter(
        (entry): entry is Extract<MemorySearchResult, { source: "markdown" }> =>
          entry.source === "markdown",
      );

      for (const hit of noteHits) {
        const rawExcerpt = await readMarkdownExcerpt(
          params.workspacePath,
          hit.path,
          hit.startLine,
          hit.endLine,
        );
        const excerpt = buildExcerpt(rawExcerpt || hit.snippet, query);
        if (!excerpt) continue;
        const ranking = scoreQuoteCandidate({
          sourceType: "workspace_markdown",
          text: rawExcerpt || hit.snippet,
          query,
          timestamp: hit.createdAt,
          upstreamScore: hit.relevanceScore,
        });
        results.push({
          id: `quote:markdown:${hit.id}`,
          sourceType: "workspace_markdown",
          objectId: hit.id,
          timestamp: hit.createdAt,
          path: hit.path,
          excerpt,
          relevanceScore: ranking.score,
          sourcePriority: SOURCE_PRIORITIES.workspace_markdown,
          rankingReason: ranking.rankingReason,
          startLine: hit.startLine,
          endLine: hit.endLine,
        });
      }
    }

    const deduped = new Map<string, VerbatimQuoteSearchResult>();
    for (const result of results) {
      const key = result.eventId || `${result.sourceType}:${result.objectId}:${result.excerpt}`;
      const existing = deduped.get(key);
      if (!existing || result.relevanceScore > existing.relevanceScore) {
        deduped.set(key, result);
      }
    }

    return [...deduped.values()].sort(compareQuoteResults).slice(0, limit);
  }
}
