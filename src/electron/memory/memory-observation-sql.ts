import crypto from "crypto";
import type Database from "better-sqlite3";
import type { Memory, MemoryType } from "../database/repositories";
import { createLogger } from "../utils/logger";
import { type ObservationMetadataRow, writeObservationMetadata } from "./memory-capture-sql";
import {
  AGENT_HIDDEN_PRIVACY_STATES,
  AGENT_VISIBLE_PRIVACY_STATES,
  isAgentVisiblePrivacyState,
} from "./memory-visibility";
import type {
  MemoryObservationGeneratedBy,
  MemoryObservationMetadata,
  MemoryObservationMigrationStatus,
  MemoryObservationPrivacyState,
  MemoryObservationSearchQuery,
  MemoryObservationSearchResult,
  MemoryObservationTimelineEntry,
} from "../../shared/types";

const logger = createLogger("MemoryObservationStore");

/**
 * The context manager's token estimate. Not imported: that module pulls the LLM
 * providers into the database worker, which loads this file.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

type MemoryCaptureOrigin =
  | "task"
  | "heartbeat"
  | "tool"
  | "chronicle"
  | "playbook"
  | "proactive"
  | "import"
  | "system"
  | "unknown";

export interface CreateOptions {
  origin?: MemoryCaptureOrigin;
  captureReason?: string;
  generatedBy?: MemoryObservationGeneratedBy;
  migrationStatus?: MemoryObservationMigrationStatus;
  privacyState?: MemoryObservationPrivacyState;
  tools?: string[];
  sourceEventIds?: string[];
}

const MAX_ARRAY_ITEMS = 12;
const WORD_STOP = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "between",
  "could",
  "from",
  "have",
  "into",
  "memory",
  "that",
  "their",
  "there",
  "this",
  "with",
  "would",
  "your",
]);

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function stringifyArray(value: string[] | undefined): string {
  return JSON.stringify(
    (value || [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, MAX_ARRAY_ITEMS),
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  const cleaned = normalizeWhitespace(value);
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function contentHash(content: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeWhitespace(content).toLowerCase())
    .digest("hex");
}

/**
 * The observation `content_hash` of a memory's content (whitespace-normalized, lowercase
 * SHA-256). Capture dedupe looks memories up by it.
 */
export function observationContentHash(content: string): string {
  return contentHash(content);
}

function sourceLabel(origin: string): string {
  switch (origin) {
    case "chronicle":
      return "Screen context";
    case "playbook":
      return "Playbook";
    case "import":
      return "Imported memory";
    case "tool":
      return "Agent memory";
    case "proactive":
      return "Suggestion";
    case "system":
      return "System";
    default:
      return "Memory";
  }
}

function extractConcepts(text: string): string[] {
  const seen = new Set<string>();
  const concepts: string[] = [];
  const words = text
    .replace(/[`"'()[\]{}]/g, " ")
    .split(/[^A-Za-z0-9_./:-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && word.length <= 48);
  for (const word of words) {
    const key = word.toLowerCase();
    if (WORD_STOP.has(key) || seen.has(key)) continue;
    if (/^\d+$/.test(key)) continue;
    seen.add(key);
    concepts.push(word);
    if (concepts.length >= 8) break;
  }
  return concepts;
}

function extractFiles(text: string): { read: string[]; modified: string[] } {
  const files = new Set<string>();
  const modified = new Set<string>();
  const matches = text.matchAll(
    /(?:^|\s)([.~/A-Za-z0-9_-]+\/[A-Za-z0-9_.@ -]+\.[A-Za-z0-9]{1,8})(?=\s|$|[),.;:])/g,
  );
  for (const match of matches) {
    const file = match[1]?.trim();
    if (!file || file.length > 240) continue;
    files.add(file);
  }
  if (/\b(created|modified|updated|wrote|patched|edited|deleted|renamed)\b/i.test(text)) {
    for (const file of files) modified.add(file);
  }
  return {
    read: Array.from(files)
      .filter((file) => !modified.has(file))
      .slice(0, MAX_ARRAY_ITEMS),
    modified: Array.from(modified).slice(0, MAX_ARRAY_ITEMS),
  };
}

function deriveTitle(type: MemoryType | string, content: string, summary?: string): string {
  const source = normalizeWhitespace(summary || content);
  const firstSentence = source.split(/(?<=[.!?])\s+/)[0] || source;
  const title = truncate(firstSentence.replace(/^\[[^\]]+\]\s*/, ""), 96);
  if (title) return title;
  return `${String(type || "memory")} memory`;
}

function deriveFacts(content: string, summary?: string): string[] {
  const combined = normalizeWhitespace(summary || content);
  const sentences = combined
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => truncate(line, 180))
    .filter((line) => line.length > 12);
  return sentences.slice(0, 4);
}

function buildMetadata(
  memory: Memory,
  options: CreateOptions = {},
): Omit<MemoryObservationMetadata, "content" | "estimatedDetailTokens"> {
  const content = memory.content || "";
  const summary = memory.summary;
  const origin = options.origin || "unknown";
  const files = extractFiles(content);
  const facts = deriveFacts(content, summary);
  const title = deriveTitle(memory.type, content, summary);
  return {
    memoryId: memory.id,
    workspaceId: memory.workspaceId,
    taskId: memory.taskId,
    origin,
    observationType: memory.type,
    title,
    subtitle: memory.taskId ? `Task ${memory.taskId}` : sourceLabel(origin),
    narrative: truncate(summary || content, 900),
    facts,
    concepts: extractConcepts(`${title} ${summary || ""} ${content}`),
    filesRead: files.read,
    filesModified: files.modified,
    tools: options.tools || [],
    sourceEventIds: options.sourceEventIds || [],
    contentHash: contentHash(content),
    captureReason: options.captureReason || "memory_capture",
    privacyState: options.privacyState || (memory.isPrivate ? "private" : "normal"),
    generatedBy: options.generatedBy || "capture",
    migrationStatus: options.migrationStatus || "current",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    memoryCreatedAt: memory.createdAt,
    summary,
    tokens: memory.tokens,
  };
}

/**
 * Memory observation metadata as synchronous SQL: the store the memory domain's
 * transaction units run (async SQLite migration plan, DB6), on the host connection or
 * in the database worker. `MemoryObservationService` is the async facade.
 */
export class MemoryObservationStore {
  /** The observation a capture stores for `memory`, computed on the host (DB6). */
  static buildMetadataFor(memory: Memory, options: CreateOptions = {}): ObservationMetadataRow {
    return buildMetadata(memory, options);
  }

  constructor(private readonly db: Database.Database) {}

  createForMemory(memory: Memory, options: CreateOptions = {}): MemoryObservationMetadata | null {
    const db = this.db;
    const metadata = buildMetadata(memory, options);
    try {
      writeObservationMetadata(db, metadata);
      return {
        ...metadata,
        content: memory.content,
        estimatedDetailTokens: estimateTokens(memory.content),
      };
    } catch (error) {
      logger.warn("[MemoryObservationService] Failed to create metadata:", error);
      return null;
    }
  }

  /** Create missing (or, with `force`, all) observation rows; counts for the status. */
  backfill(force = false): {
    total: number;
    processed: number;
    failed: number;
    lastError?: string;
  } {
    const db = this.db;
    const result: { total: number; processed: number; failed: number; lastError?: string } = {
      total: 0,
      processed: 0,
      failed: 0,
    };
    const rows = db
      .prepare(`
        SELECT m.*
        FROM memories m
        LEFT JOIN memory_observation_metadata om ON om.memory_id = m.id
        WHERE ${force ? "1 = 1" : "om.memory_id IS NULL"}
        ORDER BY m.created_at ASC
      `)
      .all() as Record<string, unknown>[];
    result.total = rows.length;
    for (const row of rows) {
      try {
        const created = this.createForMemory(this.mapMemory(row), {
          origin: this.inferOrigin(row),
          generatedBy: "migration",
          migrationStatus: "backfilled",
          captureReason: "deterministic_backfill",
        });
        if (created) {
          result.processed += 1;
        } else {
          result.failed += 1;
          result.lastError = `Failed to backfill memory ${String(row.id || "unknown")}`;
        }
      } catch (error) {
        result.failed += 1;
        result.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return result;
  }

  search(query: MemoryObservationSearchQuery): MemoryObservationSearchResult[] {
    const db = this.db;
    const limit = Math.min(Math.max(query.limit || 20, 1), 100);
    const offset = Math.max(query.offset || 0, 0);
    const filters: string[] = ["om.workspace_id = ?"];
    const params: unknown[] = [query.workspaceId];
    if (query.observationTypes?.length) {
      filters.push(`om.observation_type IN (${query.observationTypes.map(() => "?").join(", ")})`);
      params.push(...query.observationTypes);
    }
    if (query.origins?.length) {
      filters.push(`om.origin IN (${query.origins.map(() => "?").join(", ")})`);
      params.push(...query.origins);
    }
    if (query.privacyStates?.length) {
      filters.push(`om.privacy_state IN (${query.privacyStates.map(() => "?").join(", ")})`);
      params.push(...query.privacyStates);
    } else {
      filters.push("om.privacy_state != 'suppressed'");
    }
    if (query.dateStart) {
      filters.push("m.created_at >= ?");
      params.push(query.dateStart);
    }
    if (query.dateEnd) {
      filters.push("m.created_at <= ?");
      params.push(query.dateEnd);
    }
    const where = filters.join(" AND ");
    const rawQuery = normalizeWhitespace(query.query || "");
    try {
      if (rawQuery) {
        const fts = this.buildFtsQuery(rawQuery);
        const rows = db
          .prepare(`
          SELECT om.*, m.summary, m.content, m.tokens, m.created_at AS memory_created_at,
                 bm25(memory_observation_metadata_fts) AS score
          FROM memory_observation_metadata_fts f
          JOIN memory_observation_metadata om ON f.rowid = om.rowid
          JOIN memories m ON m.id = om.memory_id
          WHERE memory_observation_metadata_fts MATCH ? AND ${where}
          ORDER BY score ASC, m.created_at DESC
          LIMIT ? OFFSET ?
        `)
          .all(fts, ...params, limit, offset) as Record<string, unknown>[];
        return rows.map((row) => this.mapSearchRow(row, Math.abs(Number(row.score || 0))));
      }
    } catch {
      // Fall through to LIKE query.
    }

    const likeParams = [...params];
    let likeWhere = where;
    if (rawQuery) {
      const like = `%${rawQuery}%`;
      likeWhere +=
        " AND (om.title LIKE ? OR om.subtitle LIKE ? OR om.narrative LIKE ? OR om.facts LIKE ? OR om.concepts LIKE ? OR om.files_read LIKE ? OR om.files_modified LIKE ? OR om.tools LIKE ?)";
      likeParams.push(like, like, like, like, like, like, like, like);
    }
    const rows = db
      .prepare(`
      SELECT om.*, m.summary, m.content, m.tokens, m.created_at AS memory_created_at
      FROM memory_observation_metadata om
      JOIN memories m ON m.id = om.memory_id
      WHERE ${likeWhere}
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `)
      .all(...likeParams, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapSearchRow(row, 1));
  }

  timeline(input: {
    workspaceId: string;
    memoryId?: string;
    query?: string;
    windowSize?: number;
  }): MemoryObservationTimelineEntry[] {
    const db = this.db;
    const windowSize = Math.min(Math.max(input.windowSize || 5, 1), 20);
    // Deleted (suppressed) and redacted memories are not part of any timeline.
    let anchor = input.memoryId
      ? this.getRow(input.memoryId, input.workspaceId)
      : this.search({
          workspaceId: input.workspaceId,
          query: input.query || "",
          limit: 1,
          privacyStates: [...AGENT_VISIBLE_PRIVACY_STATES],
        })[0];
    if (!anchor || !isAgentVisiblePrivacyState(anchor.privacyState)) return [];
    const anchorTime = "memoryCreatedAt" in anchor ? anchor.memoryCreatedAt : anchor.createdAt;
    const hidden = AGENT_HIDDEN_PRIVACY_STATES.map((state) => `'${state}'`).join(", ");
    const rows = db
      .prepare(`
      SELECT om.*, m.summary, m.content, m.tokens, m.created_at AS memory_created_at
      FROM memory_observation_metadata om
      JOIN memories m ON m.id = om.memory_id
      WHERE om.workspace_id = ?
        AND om.privacy_state NOT IN (${hidden})
        AND m.created_at BETWEEN ? AND ?
      ORDER BY m.created_at ASC
      LIMIT ?
    `)
      .all(
        input.workspaceId,
        anchorTime - 30 * 60 * 1000,
        anchorTime + 30 * 60 * 1000,
        windowSize * 2 + 1,
      ) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...this.mapSearchRow(row, row.memory_id === anchor.memoryId ? 2 : 1),
      isAnchor: row.memory_id === anchor.memoryId,
    }));
  }

  details(memoryIds: string[], workspaceId?: string): MemoryObservationMetadata[] {
    return memoryIds
      .map((id) => this.getRow(id, workspaceId))
      .filter(Boolean) as MemoryObservationMetadata[];
  }

  update(
    workspaceId: string,
    memoryId: string,
    patch: Partial<
      Pick<
        MemoryObservationMetadata,
        | "title"
        | "subtitle"
        | "narrative"
        | "facts"
        | "concepts"
        | "filesRead"
        | "filesModified"
        | "tools"
        | "sourceEventIds"
        | "privacyState"
      >
    >,
  ): MemoryObservationMetadata | null {
    const db = this.db;
    const current = this.getRow(memoryId, workspaceId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    db.prepare(`
      UPDATE memory_observation_metadata
      SET title = ?, subtitle = ?, narrative = ?, facts = ?, concepts = ?, files_read = ?,
          files_modified = ?, tools = ?, source_event_ids = ?, privacy_state = ?, generated_by = 'manual',
          updated_at = ?
      WHERE workspace_id = ? AND memory_id = ?
    `).run(
      next.title,
      next.subtitle || null,
      next.narrative,
      stringifyArray(next.facts),
      stringifyArray(next.concepts),
      stringifyArray(next.filesRead),
      stringifyArray(next.filesModified),
      stringifyArray(next.tools),
      stringifyArray(next.sourceEventIds),
      next.privacyState,
      next.updatedAt,
      workspaceId,
      memoryId,
    );
    if (next.privacyState !== current.privacyState || next.privacyState !== "normal") {
      // Keep `memories.is_private` in step with the observation: any non-normal state is
      // private, and an explicit change back to normal clears it.
      db.prepare(
        "UPDATE memories SET is_private = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      ).run(next.privacyState === "normal" ? 0 : 1, Date.now(), memoryId, workspaceId);
    }
    return this.getRow(memoryId, workspaceId);
  }

  redact(
    workspaceId: string,
    memoryId: string,
    replacement = "[redacted]",
  ): MemoryObservationMetadata | null {
    const db = this.db;
    const current = this.getRow(memoryId, workspaceId);
    if (!current) return null;
    db.prepare(
      "UPDATE memories SET content = ?, summary = ?, is_private = 1, updated_at = ? WHERE id = ? AND workspace_id = ?",
    ).run(replacement, replacement, Date.now(), memoryId, workspaceId);
    return this.update(workspaceId, memoryId, {
      title: "Redacted memory",
      subtitle: current.subtitle,
      narrative: replacement,
      facts: [],
      concepts: [],
      filesRead: [],
      filesModified: [],
      tools: current.tools,
      sourceEventIds: current.sourceEventIds,
      privacyState: "redacted",
    });
  }

  delete(workspaceId: string, memoryId: string): boolean {
    const db = this.db;
    const current = this.getRow(memoryId, workspaceId);
    if (!current) return false;
    db.prepare(
      "UPDATE memories SET is_private = 1, updated_at = ? WHERE id = ? AND workspace_id = ?",
    ).run(Date.now(), memoryId, workspaceId);
    const updated = this.update(workspaceId, memoryId, {
      title: "Deleted memory",
      subtitle: current.subtitle,
      narrative: "[deleted from Memory Hub Inspector]",
      facts: [],
      concepts: [],
      filesRead: [],
      filesModified: [],
      tools: current.tools,
      sourceEventIds: current.sourceEventIds,
      privacyState: "suppressed",
    });
    return Boolean(updated);
  }

  /** The ids among `memoryIds` whose observation hides them from prompts. */
  suppressedIds(memoryIds: string[]): string[] {
    if (memoryIds.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT memory_id FROM memory_observation_metadata
           WHERE memory_id IN (SELECT value FROM json_each(?))
             AND privacy_state IN ('suppressed', 'redacted')`,
        )
        .all(JSON.stringify(memoryIds)) as Array<{ memory_id: string }>
    ).map((row) => row.memory_id);
  }

  isPromptSuppressed(memoryId: string): boolean {
    const db = this.db;
    const row = db
      .prepare("SELECT privacy_state FROM memory_observation_metadata WHERE memory_id = ?")
      .get(memoryId) as { privacy_state?: string } | undefined;
    return row?.privacy_state === "suppressed" || row?.privacy_state === "redacted";
  }

  private getRow(memoryId: string, workspaceId?: string): MemoryObservationMetadata | null {
    const db = this.db;
    const workspaceFilter = workspaceId ? "AND om.workspace_id = ?" : "";
    const params = workspaceId ? [memoryId, workspaceId] : [memoryId];
    const row = db
      .prepare(`
      SELECT om.*, m.summary, m.content, m.tokens, m.created_at AS memory_created_at
      FROM memory_observation_metadata om
      JOIN memories m ON m.id = om.memory_id
      WHERE om.memory_id = ?
      ${workspaceFilter}
    `)
      .get(...params) as Record<string, unknown> | undefined;
    return row ? this.mapDetailRow(row) : null;
  }

  /** Memories and those still without an observation row. */
  countBackfill(): { total: number; pending: number } {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN om.memory_id IS NULL THEN 1 ELSE 0 END) AS pending
        FROM memories m
        LEFT JOIN memory_observation_metadata om ON om.memory_id = m.id
      `)
      .get() as { total?: number; pending?: number } | undefined;
    return { total: Number(row?.total || 0), pending: Number(row?.pending || 0) };
  }

  private mapSearchRow(row: Record<string, unknown>, rank: number): MemoryObservationSearchResult {
    const concepts = parseJsonArray(row.concepts);
    const filesRead = parseJsonArray(row.files_read);
    const filesModified = parseJsonArray(row.files_modified);
    const content = String(row.content || "");
    return {
      memoryId: String(row.memory_id),
      workspaceId: String(row.workspace_id),
      taskId: (row.task_id as string) || undefined,
      title: String(row.title || "Memory"),
      subtitle: (row.subtitle as string) || undefined,
      snippet: truncate(String(row.narrative || row.summary || content), 260),
      observationType: String(row.observation_type || "observation"),
      origin: String(row.origin || "unknown"),
      sourceLabel: sourceLabel(String(row.origin || "unknown")),
      privacyState: String(row.privacy_state || "normal") as MemoryObservationPrivacyState,
      concepts,
      filesRead,
      filesModified,
      tools: parseJsonArray(row.tools),
      sourceEventIds: parseJsonArray(row.source_event_ids),
      createdAt: Number(row.memory_created_at || row.created_at || 0),
      rank,
      estimatedDetailTokens: estimateTokens(content),
    };
  }

  private mapDetailRow(row: Record<string, unknown>): MemoryObservationMetadata {
    return {
      ...this.mapSearchRow(row, 1),
      memoryId: String(row.memory_id),
      workspaceId: String(row.workspace_id),
      origin: String(row.origin || "unknown"),
      observationType: String(row.observation_type || "observation"),
      narrative: String(row.narrative || ""),
      facts: parseJsonArray(row.facts),
      concepts: parseJsonArray(row.concepts),
      filesRead: parseJsonArray(row.files_read),
      filesModified: parseJsonArray(row.files_modified),
      tools: parseJsonArray(row.tools),
      sourceEventIds: parseJsonArray(row.source_event_ids),
      contentHash: String(row.content_hash || ""),
      captureReason: String(row.capture_reason || "memory_capture"),
      privacyState: String(row.privacy_state || "normal") as MemoryObservationPrivacyState,
      generatedBy: String(row.generated_by || "capture") as MemoryObservationGeneratedBy,
      migrationStatus: String(
        row.migration_status || "current",
      ) as MemoryObservationMigrationStatus,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      memoryCreatedAt: Number(row.memory_created_at || 0),
      summary: (row.summary as string) || undefined,
      content: String(row.content || ""),
      tokens: Number(row.tokens || 0),
      estimatedDetailTokens: estimateTokens(String(row.content || "")),
    };
  }

  private mapMemory(row: Record<string, unknown>): Memory {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      taskId: (row.task_id as string) || undefined,
      type: row.type as MemoryType,
      content: String(row.content || ""),
      summary: (row.summary as string) || undefined,
      tokens: Number(row.tokens || 0),
      isCompressed: row.is_compressed === 1,
      isPrivate: row.is_private === 1,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    };
  }

  private inferOrigin(row: Record<string, unknown>): MemoryCaptureOrigin {
    const content = String(row.content || "");
    const type = String(row.type || "");
    if (type === "screen_context") return "chronicle";
    if (/^\[Imported from /i.test(content) || content.includes("[Imported from ")) return "import";
    if (content.includes("[Playbook")) return "playbook";
    return row.task_id ? "task" : "system";
  }

  private buildFtsQuery(raw: string): string {
    const tokens = raw
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !WORD_STOP.has(token))
      .slice(0, 10);
    return tokens.length
      ? tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" OR ")
      : `"${raw.replace(/"/g, "")}"`;
  }
}
