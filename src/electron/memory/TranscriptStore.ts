import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import { createHash, randomUUID } from "crypto";
import type { TaskEvent } from "../../shared/types";
import { DatabaseManager } from "../database/schema";

export interface TranscriptSpanRecord {
  taskId: string;
  timestamp: number;
  type: string;
  payload: unknown;
  eventId?: string;
  seq?: number;
}

export interface TranscriptSearchResult {
  taskId: string;
  timestamp: number;
  type: string;
  payload: unknown;
  eventId?: string;
  seq?: number;
  rawLine: string;
}

type TranscriptDatabase = Pick<import("better-sqlite3").Database, "exec" | "prepare">;

export type TranscriptReadGuard = (candidatePath: string) => boolean;

export type TranscriptCheckpointKind = "snapshot" | "pre_compaction" | "periodic" | "completion";

export interface TranscriptCheckpointStructuredSummary {
  source: "snapshot" | "compaction_summary" | "completion" | "fallback";
  rawText?: string;
  decisions: string[];
  openLoops: string[];
  nextActions: string[];
  keyFindings: string[];
}

export interface TranscriptCheckpointEvidenceSpan {
  sourceType: "transcript_span" | "task_message";
  objectId: string;
  taskId: string;
  timestamp: number;
  type: string;
  excerpt: string;
  eventId?: string;
  seq?: number;
}

export interface TranscriptCheckpointEvidencePacket {
  generatedAt: number;
  spanHash: string;
  spanCount: number;
  spans: TranscriptCheckpointEvidenceSpan[];
}

export interface TranscriptCheckpointIntegrity {
  algorithm: "sha256";
  generation: number;
  checksum: string;
}

export interface TranscriptCheckpointPayload {
  checkpointKind?: TranscriptCheckpointKind;
  conversationHistory?: unknown[];
  trackerState?: unknown;
  planSummary?: unknown;
  explicitChatSummaryBlock?: string;
  explicitChatSummaryCreatedAt?: number;
  explicitChatSummarySourceMessageCount?: number;
  usageTotals?: unknown;
  timestamp?: number;
  messageCount?: number;
  sourceEventId?: string;
  sourceTimestamp?: number;
  resumeStrategy?: "snapshot" | "checkpoint" | "transcript";
  structuredSummary?: TranscriptCheckpointStructuredSummary;
  evidencePacket?: TranscriptCheckpointEvidencePacket;
  dedupeHash?: string;
  checkpointIntegrity?: TranscriptCheckpointIntegrity;
  sourceMetadata?: {
    triggerEventType?: string;
    meaningfulExchangeCount?: number;
  };
}

function compareSearchResults(a: TranscriptSearchResult, b: TranscriptSearchResult): number {
  return (
    b.timestamp - a.timestamp ||
    a.taskId.localeCompare(b.taskId) ||
    (typeof b.seq === "number" ? b.seq : -1) - (typeof a.seq === "number" ? a.seq : -1) ||
    a.type.localeCompare(b.type)
  );
}

function rootDir(workspacePath: string): string {
  return path.join(workspacePath, ".cowork", "memory", "transcripts");
}

function spansDir(workspacePath: string): string {
  return path.join(rootDir(workspacePath), "spans");
}

function checkpointsDir(workspacePath: string): string {
  return path.join(rootDir(workspacePath), "checkpoints");
}

function taskSpanPath(workspacePath: string, taskId: string): string {
  return path.join(spansDir(workspacePath), `${taskId}.jsonl`);
}

function taskCheckpointPath(workspacePath: string, taskId: string): string {
  return path.join(checkpointsDir(workspacePath), `${taskId}.json`);
}

function taskPreviousCheckpointPath(workspacePath: string, taskId: string): string {
  return path.join(checkpointsDir(workspacePath), `${taskId}.previous.json`);
}

function checkpointChecksum(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseCheckpoint(raw: string): TranscriptCheckpointPayload | null {
  try {
    const parsed = JSON.parse(raw) as TranscriptCheckpointPayload;
    if (!parsed || typeof parsed !== "object") return null;

    const integrity = parsed.checkpointIntegrity;
    if (integrity !== undefined) {
      if (
        !integrity ||
        integrity.algorithm !== "sha256" ||
        typeof integrity.checksum !== "string" ||
        !/^[a-f0-9]{64}$/i.test(integrity.checksum) ||
        typeof integrity.generation !== "number" ||
        !Number.isFinite(integrity.generation) ||
        integrity.generation < 1
      ) {
        return null;
      }
      const withoutIntegrity = { ...(parsed as Any) };
      delete withoutIntegrity.checkpointIntegrity;
      if (checkpointChecksum(withoutIntegrity) !== integrity.checksum) return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function checkpointGeneration(checkpoint: TranscriptCheckpointPayload | null): number {
  const generation = checkpoint?.checkpointIntegrity?.generation;
  return typeof generation === "number" && Number.isFinite(generation)
    ? Math.max(0, Math.floor(generation))
    : 0;
}

function isSafeTaskId(taskId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(taskId);
}

function allowsRead(readGuard: TranscriptReadGuard | undefined, candidatePath: string): boolean {
  if (!readGuard) return true;
  try {
    return readGuard(candidatePath) === true;
  } catch {
    return false;
  }
}

function normalizeWorkspacePath(workspacePath: string): string {
  return path.resolve(workspacePath);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function buildSpanId(workspacePath: string, record: TranscriptSpanRecord, rawLine: string): string {
  const stablePart =
    record.eventId ||
    (typeof record.seq === "number"
      ? `seq:${record.seq}`
      : `ts:${record.timestamp}:${record.type}:${hashText(rawLine)}`);
  return `${hashText(normalizeWorkspacePath(workspacePath))}:${record.taskId}:${stablePart}`;
}

function payloadToSearchText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
}

function buildFtsQuery(query: string): string {
  return (query.toLowerCase().match(/[a-z0-9_]{2,}/g) || []).slice(0, 12).join(" ");
}

function shouldPersistSpan(type: string): boolean {
  return [
    "task_created",
    "user_message",
    "assistant_message",
    "timeline_group_started",
    "timeline_group_finished",
    "timeline_step_started",
    "timeline_step_updated",
    "timeline_step_finished",
    "timeline_evidence_attached",
    "timeline_artifact_emitted",
    "timeline_command_output",
    "timeline_error",
    "tool_call",
    "tool_result",
    "tool_error",
    "task_completed",
    "task_status",
    "task_paused",
    "task_resumed",
    "conversation_snapshot",
  ].includes(type);
}

function safeParseLine(line: string): TranscriptSpanRecord | null {
  try {
    const parsed = JSON.parse(line) as TranscriptSpanRecord;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.taskId !== "string" || typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export class TranscriptStore {
  private static dbOverride: TranscriptDatabase | null | undefined;
  private static dbSchemaReady = false;

  static setDatabaseForTests(db: TranscriptDatabase | null): void {
    this.dbOverride = db;
    this.dbSchemaReady = false;
  }

  static async ensureLayout(workspacePath: string): Promise<void> {
    await Promise.all([
      fs.mkdir(spansDir(workspacePath), { recursive: true }),
      fs.mkdir(checkpointsDir(workspacePath), { recursive: true }),
    ]);
  }

  static async appendEvent(workspacePath: string, event: TaskEvent): Promise<void> {
    if (!workspacePath || !shouldPersistSpan(event.type)) {
      return;
    }
    await this.ensureLayout(workspacePath);
    const record: TranscriptSpanRecord = {
      taskId: event.taskId,
      timestamp: typeof event.ts === "number" ? event.ts : event.timestamp,
      type: event.type,
      payload: event.payload,
      ...(event.eventId ? { eventId: event.eventId } : {}),
      ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
    };
    const rawLine = JSON.stringify(record);
    await fs.appendFile(taskSpanPath(workspacePath, event.taskId), `${rawLine}\n`, "utf8");
    this.indexSpan(workspacePath, record, rawLine);
  }

  static async writeCheckpoint(
    workspacePath: string,
    taskId: string,
    checkpoint: TranscriptCheckpointPayload,
  ): Promise<void> {
    if (!workspacePath || !taskId || !isSafeTaskId(taskId)) return;
    await this.ensureLayout(workspacePath);
    const basePayload: Record<string, unknown> = {
      ...checkpoint,
      timestamp: checkpoint.timestamp ?? Date.now(),
      resumeStrategy: checkpoint.resumeStrategy ?? "checkpoint",
    };
    delete basePayload.checkpointIntegrity;

    const currentPath = taskCheckpointPath(workspacePath, taskId);
    const previousPath = taskPreviousCheckpointPath(workspacePath, taskId);
    const existingGenerations = await Promise.all(
      [currentPath, previousPath].map(async (candidatePath) => {
        try {
          return checkpointGeneration(parseCheckpoint(await fs.readFile(candidatePath, "utf8")));
        } catch {
          return 0;
        }
      }),
    );
    const payload: TranscriptCheckpointPayload = {
      ...(basePayload as TranscriptCheckpointPayload),
      checkpointIntegrity: {
        algorithm: "sha256",
        generation: Math.max(...existingGenerations, 0) + 1,
        checksum: checkpointChecksum(basePayload),
      },
    };
    const serialized = JSON.stringify(payload, null, 2);
    const tempPath = `${currentPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(tempPath, "w");
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      // Preserve the last known-good generation before replacing the current
      // file.  A crash before rename therefore leaves a recoverable previous
      // checkpoint; rename itself is atomic on the target filesystem.
      try {
        await fs.copyFile(currentPath, previousPath);
      } catch (error: Any) {
        if (error?.code !== "ENOENT") throw error;
      }
      await fs.rename(tempPath, currentPath);
    } finally {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  static async loadCheckpoint(
    workspacePath: string,
    taskId: string,
    readGuard?: TranscriptReadGuard,
  ): Promise<TranscriptCheckpointPayload | null> {
    if (!isSafeTaskId(taskId)) return null;
    const candidates = [
      taskCheckpointPath(workspacePath, taskId),
      taskPreviousCheckpointPath(workspacePath, taskId),
    ];
    const validCandidates: Array<{
      checkpoint: TranscriptCheckpointPayload;
      generation: number;
    }> = [];
    for (const candidatePath of candidates) {
      if (!allowsRead(readGuard, candidatePath)) continue;
      try {
        const parsed = parseCheckpoint(await fs.readFile(candidatePath, "utf8"));
        if (parsed) {
          validCandidates.push({ checkpoint: parsed, generation: checkpointGeneration(parsed) });
        }
      } catch {
        // Try the previous generation when the newest file is truncated or
        // otherwise unreadable.
      }
    }
    validCandidates.sort((a, b) => b.generation - a.generation);
    return validCandidates[0]?.checkpoint || null;
  }

  static loadCheckpointSync(
    workspacePath: string,
    taskId: string,
    readGuard?: TranscriptReadGuard,
  ): TranscriptCheckpointPayload | null {
    if (!isSafeTaskId(taskId)) return null;
    const candidates = [
      taskCheckpointPath(workspacePath, taskId),
      taskPreviousCheckpointPath(workspacePath, taskId),
    ];
    const validCandidates: Array<{
      checkpoint: TranscriptCheckpointPayload;
      generation: number;
    }> = [];
    for (const candidatePath of candidates) {
      if (!allowsRead(readGuard, candidatePath)) continue;
      try {
        const parsed = parseCheckpoint(fsSync.readFileSync(candidatePath, "utf8"));
        if (parsed) {
          validCandidates.push({ checkpoint: parsed, generation: checkpointGeneration(parsed) });
        }
      } catch {
        // Try the previous generation when the newest file is truncated or
        // otherwise unreadable.
      }
    }
    validCandidates.sort((a, b) => b.generation - a.generation);
    return validCandidates[0]?.checkpoint || null;
  }

  static async loadRecentSpans(
    workspacePath: string,
    taskId: string,
    limit = 40,
    readGuard?: TranscriptReadGuard,
  ): Promise<TranscriptSpanRecord[]> {
    if (!isSafeTaskId(taskId)) return [];
    const spanPath = taskSpanPath(workspacePath, taskId);
    if (!allowsRead(readGuard, spanPath)) return [];
    try {
      const raw = await fs.readFile(spanPath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => safeParseLine(line))
        .filter((entry): entry is TranscriptSpanRecord => entry !== null)
        .slice(-Math.max(1, limit));
    } catch {
      return [];
    }
  }

  static async searchSpans(params: {
    workspacePath: string;
    query: string;
    taskId?: string;
    limit?: number;
    readGuard?: TranscriptReadGuard;
  }): Promise<TranscriptSearchResult[]> {
    const query = params.query.trim().toLowerCase();
    if (!query) return [];
    if (params.taskId && !isSafeTaskId(params.taskId)) return [];

    const limit = Math.max(1, params.limit ?? 10);
    const indexedResults = this.searchIndexedSpans({
      workspacePath: params.workspacePath,
      query,
      taskId: params.taskId,
      limit: params.readGuard ? Math.min(limit * 4, 120) : limit,
      readGuard: params.readGuard,
    });
    if (indexedResults.length >= limit) {
      return indexedResults.slice(0, limit);
    }

    const results: TranscriptSearchResult[] = [];
    const spansDirectory = spansDir(params.workspacePath);
    if (!params.taskId && !allowsRead(params.readGuard, spansDirectory)) {
      return indexedResults.slice(0, limit);
    }
    const files = params.taskId
      ? [taskSpanPath(params.workspacePath, params.taskId)]
      : (await fs.readdir(spansDir(params.workspacePath)).catch(() => []))
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => path.join(spansDir(params.workspacePath), name));

    for (const file of files) {
      if (!allowsRead(params.readGuard, file)) continue;
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      if (!raw) continue;
      const lines = raw.split("\n").filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.toLowerCase().includes(query)) continue;
        const parsed = safeParseLine(line);
        if (!parsed) continue;
        results.push({ ...parsed, rawLine: line });
        if (results.length > limit) {
          results.sort(compareSearchResults);
          results.length = limit;
        }
        if (params.taskId && results.length >= limit) {
          break;
        }
      }
    }

    return [...indexedResults, ...results]
      .filter((entry, index, all) => {
        const key = `${entry.taskId}:${entry.eventId || ""}:${entry.seq ?? ""}:${entry.timestamp}:${entry.rawLine}`;
        return (
          all.findIndex(
            (other) =>
              `${other.taskId}:${other.eventId || ""}:${other.seq ?? ""}:${other.timestamp}:${other.rawLine}` ===
              key,
          ) === index
        );
      })
      .sort(compareSearchResults)
      .slice(0, limit);
  }

  private static getDatabase(): TranscriptDatabase | null {
    if (this.dbOverride !== undefined) return this.dbOverride;
    try {
      return DatabaseManager.getInstance().getDatabase();
    } catch {
      return null;
    }
  }

  private static ensureDbSchema(db: TranscriptDatabase): boolean {
    if (this.dbSchemaReady) return true;
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS transcript_spans (
          id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          task_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          event_id TEXT,
          seq INTEGER,
          raw_line TEXT NOT NULL,
          search_text TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_transcript_spans_workspace_task
          ON transcript_spans(workspace_path, task_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_transcript_spans_workspace_time
          ON transcript_spans(workspace_path, timestamp DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS transcript_spans_fts USING fts5(
          search_text,
          raw_line,
          content='transcript_spans',
          content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS transcript_spans_fts_insert AFTER INSERT ON transcript_spans BEGIN
          INSERT INTO transcript_spans_fts(rowid, search_text, raw_line)
          VALUES (NEW.rowid, NEW.search_text, NEW.raw_line);
        END;
        CREATE TRIGGER IF NOT EXISTS transcript_spans_fts_delete AFTER DELETE ON transcript_spans BEGIN
          INSERT INTO transcript_spans_fts(transcript_spans_fts, rowid, search_text, raw_line)
          VALUES('delete', OLD.rowid, OLD.search_text, OLD.raw_line);
        END;
        CREATE TRIGGER IF NOT EXISTS transcript_spans_fts_update AFTER UPDATE ON transcript_spans BEGIN
          INSERT INTO transcript_spans_fts(transcript_spans_fts, rowid, search_text, raw_line)
          VALUES('delete', OLD.rowid, OLD.search_text, OLD.raw_line);
          INSERT INTO transcript_spans_fts(rowid, search_text, raw_line)
          VALUES (NEW.rowid, NEW.search_text, NEW.raw_line);
        END;
      `);
      this.dbSchemaReady = true;
      return true;
    } catch {
      return false;
    }
  }

  private static indexSpan(
    workspacePath: string,
    record: TranscriptSpanRecord,
    rawLine: string,
  ): void {
    const db = this.getDatabase();
    if (!db || !this.ensureDbSchema(db)) return;

    try {
      db.prepare<unknown[]>(
        `INSERT OR IGNORE INTO transcript_spans (
          id, workspace_path, task_id, timestamp, type, payload_json,
          event_id, seq, raw_line, search_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run?.(
        buildSpanId(workspacePath, record, rawLine),
        normalizeWorkspacePath(workspacePath),
        record.taskId,
        record.timestamp,
        record.type,
        JSON.stringify(record.payload ?? null),
        record.eventId ?? null,
        typeof record.seq === "number" ? record.seq : null,
        rawLine,
        `${record.type} ${payloadToSearchText(record.payload)}`,
        Date.now(),
      );
    } catch {
      // Search falls back to JSONL scans when SQLite/FTS is unavailable.
    }
  }

  private static searchIndexedSpans(params: {
    workspacePath: string;
    query: string;
    taskId?: string;
    limit: number;
    readGuard?: TranscriptReadGuard;
  }): TranscriptSearchResult[] {
    const db = this.getDatabase();
    if (!db || !this.ensureDbSchema(db)) return [];

    const ftsQuery = buildFtsQuery(params.query);
    if (!ftsQuery) return [];

    const whereTask = params.taskId ? "AND s.task_id = ?" : "";
    const values: unknown[] = [
      ftsQuery,
      normalizeWorkspacePath(params.workspacePath),
      ...(params.taskId ? [params.taskId] : []),
      params.limit,
    ];

    try {
      const rows =
        db
          .prepare<unknown[], Record<string, unknown>>(
            `SELECT s.task_id, s.timestamp, s.type, s.payload_json, s.event_id, s.seq, s.raw_line
           FROM transcript_spans_fts f
           JOIN transcript_spans s ON s.rowid = f.rowid
           WHERE transcript_spans_fts MATCH ?
             AND s.workspace_path = ?
             ${whereTask}
           ORDER BY bm25(transcript_spans_fts), s.timestamp DESC
           LIMIT ?`,
          )
          .all?.(...values) || [];

      return rows
        .map((row) => {
          const item = row as Record<string, unknown>;
          const rawLine = String(item.raw_line || "");
          let payload: unknown = null;
          try {
            payload = JSON.parse(String(item.payload_json || "null"));
          } catch {
            payload = item.payload_json;
          }
          return {
            taskId: String(item.task_id || ""),
            timestamp: Number(item.timestamp || 0),
            type: String(item.type || ""),
            payload,
            ...(typeof item.event_id === "string" && item.event_id
              ? { eventId: item.event_id }
              : {}),
            ...(typeof item.seq === "number" ? { seq: item.seq } : {}),
            rawLine,
          };
        })
        .filter(
          (entry) =>
            entry.taskId &&
            entry.type &&
            entry.rawLine &&
            allowsRead(params.readGuard, taskSpanPath(params.workspacePath, entry.taskId)),
        );
    } catch {
      return [];
    }
  }
}
