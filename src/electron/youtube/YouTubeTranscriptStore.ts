import { createHash } from "crypto";
import { DatabaseManager } from "../database/schema";
import { buildYouTubeWatchUrl } from "./url";
import type { YouTubeSearchHit, YouTubeTranscriptSegment, YouTubeVideoMetadata } from "./types";

type TranscriptDatabase = Pick<import("better-sqlite3").Database, "exec" | "prepare">;

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

const SEARCH_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "can",
  "could",
  "did",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "into",
  "is",
  "the",
  "this",
  "that",
  "their",
  "there",
  "they",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "would",
]);

export function buildYouTubeTranscriptFtsQuery(query: string): string {
  const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || [];
  const keywords = Array.from(new Set(tokens.filter((token) => !SEARCH_STOP_WORDS.has(token))));
  return keywords
    .slice(0, 12)
    .map((token) => `"${token}"`)
    .join(" OR ");
}

function normalizeSegmentText(text: string): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWorkspaceId(workspaceId: string): string {
  const value = String(workspaceId || "").trim();
  if (!value) throw new Error("Workspace id is required for YouTube transcript storage.");
  return value;
}

export class YouTubeTranscriptStore {
  private static dbOverride: TranscriptDatabase | null | undefined;
  private static schemaReady = false;

  static setDatabaseForTests(db: TranscriptDatabase | null): void {
    this.dbOverride = db;
    this.schemaReady = false;
  }

  private static getDatabase(): TranscriptDatabase | null {
    if (this.dbOverride !== undefined) return this.dbOverride;
    try {
      return DatabaseManager.getInstance().getDatabase();
    } catch {
      return null;
    }
  }

  private static ensureSchema(db: TranscriptDatabase): boolean {
    if (this.schemaReady) return true;
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS youtube_workspace_videos (
          workspace_id TEXT NOT NULL,
          video_id TEXT NOT NULL,
          url TEXT NOT NULL,
          title TEXT,
          channel TEXT,
          duration_seconds INTEGER,
          thumbnail_url TEXT,
          upload_date TEXT,
          description TEXT,
          metadata_json TEXT,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, video_id)
        );
        CREATE TABLE IF NOT EXISTS youtube_workspace_transcript_segments (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          video_id TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER,
          text TEXT NOT NULL,
          source TEXT NOT NULL,
          language TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_youtube_workspace_segments_workspace_video_time
          ON youtube_workspace_transcript_segments(workspace_id, video_id, start_ms);

        CREATE VIRTUAL TABLE IF NOT EXISTS youtube_workspace_transcript_segments_fts USING fts5(
          text,
          content='youtube_workspace_transcript_segments',
          content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS youtube_workspace_segments_fts_insert
        AFTER INSERT ON youtube_workspace_transcript_segments BEGIN
          INSERT INTO youtube_workspace_transcript_segments_fts(rowid, text)
          VALUES (NEW.rowid, NEW.text);
        END;
        CREATE TRIGGER IF NOT EXISTS youtube_workspace_segments_fts_delete
        AFTER DELETE ON youtube_workspace_transcript_segments BEGIN
          INSERT INTO youtube_workspace_transcript_segments_fts(
            youtube_workspace_transcript_segments_fts, rowid, text
          )
          VALUES('delete', OLD.rowid, OLD.text);
        END;
        CREATE TRIGGER IF NOT EXISTS youtube_workspace_segments_fts_update
        AFTER UPDATE ON youtube_workspace_transcript_segments BEGIN
          INSERT INTO youtube_workspace_transcript_segments_fts(
            youtube_workspace_transcript_segments_fts, rowid, text
          )
          VALUES('delete', OLD.rowid, OLD.text);
          INSERT INTO youtube_workspace_transcript_segments_fts(rowid, text)
          VALUES (NEW.rowid, NEW.text);
        END;
      `);
      this.schemaReady = true;
      return true;
    } catch {
      return false;
    }
  }

  static saveVideo(workspaceId: string, video: YouTubeVideoMetadata): void {
    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return;
    db.prepare(
      `INSERT INTO youtube_workspace_videos (
        workspace_id, video_id, url, title, channel, duration_seconds, thumbnail_url,
        upload_date, description, metadata_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, video_id) DO UPDATE SET
        url=excluded.url,
        title=excluded.title,
        channel=excluded.channel,
        duration_seconds=excluded.duration_seconds,
        thumbnail_url=excluded.thumbnail_url,
        upload_date=excluded.upload_date,
        description=excluded.description,
        metadata_json=excluded.metadata_json,
        fetched_at=excluded.fetched_at`,
    ).run(
      scopedWorkspaceId,
      video.videoId,
      video.url,
      video.title ?? null,
      video.channel ?? null,
      video.durationSeconds ?? null,
      video.thumbnailUrl ?? null,
      video.uploadDate ?? null,
      video.description ?? null,
      JSON.stringify(video.raw ?? video),
      video.fetchedAt,
    );
  }

  static saveSegments(
    workspaceId: string,
    videoId: string,
    segments: YouTubeTranscriptSegment[],
  ): void {
    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare(
        `INSERT OR REPLACE INTO youtube_workspace_transcript_segments (
          id, workspace_id, video_id, start_ms, end_ms, text, source, language, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.prepare(
        "DELETE FROM youtube_workspace_transcript_segments WHERE workspace_id = ? AND video_id = ?",
      ).run(scopedWorkspaceId, videoId);
      const now = Date.now();
      for (const segment of segments) {
        const text = normalizeSegmentText(segment.text);
        if (!text) continue;
        const startMs = Math.max(0, Math.round(segment.startMs || 0));
        const id = `${scopedWorkspaceId}:${videoId}:${startMs}:${hashText(text)}`;
        insert.run(
          id,
          scopedWorkspaceId,
          videoId,
          startMs,
          typeof segment.endMs === "number" ? Math.max(startMs, Math.round(segment.endMs)) : null,
          text,
          segment.source || "unknown",
          segment.language ?? null,
          now,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures and surface the original write failure.
      }
      throw error;
    }
  }

  static getVideo(workspaceId: string, videoId: string): YouTubeVideoMetadata | null {
    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return null;
    const row = db
      .prepare("SELECT * FROM youtube_workspace_videos WHERE workspace_id = ? AND video_id = ?")
      .get(scopedWorkspaceId, videoId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      videoId: String(row.video_id || ""),
      url: String(row.url || buildYouTubeWatchUrl(videoId)),
      title: typeof row.title === "string" ? row.title : undefined,
      channel: typeof row.channel === "string" ? row.channel : undefined,
      durationSeconds: typeof row.duration_seconds === "number" ? row.duration_seconds : undefined,
      thumbnailUrl: typeof row.thumbnail_url === "string" ? row.thumbnail_url : undefined,
      uploadDate: typeof row.upload_date === "string" ? row.upload_date : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
      fetchedAt: Number(row.fetched_at || 0),
    };
  }

  static listVideos(workspaceId: string, limit = 50): YouTubeVideoMetadata[] {
    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return [];
    const rows = db
      .prepare(
        `SELECT video_id FROM youtube_workspace_videos
         WHERE workspace_id = ?
         ORDER BY fetched_at DESC
         LIMIT ?`,
      )
      .all(scopedWorkspaceId, Math.max(1, Math.min(200, Math.round(limit)))) as Array<{
      video_id: string;
    }>;
    return rows
      .map((row) => this.getVideo(scopedWorkspaceId, row.video_id))
      .filter((video): video is YouTubeVideoMetadata => Boolean(video));
  }

  static hasSegments(workspaceId: string, videoId: string): boolean {
    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return false;
    const row = db
      .prepare(
        `SELECT 1 AS found FROM youtube_workspace_transcript_segments
         WHERE workspace_id = ? AND video_id = ?
         LIMIT 1`,
      )
      .get(scopedWorkspaceId, videoId) as { found?: number } | undefined;
    return Boolean(row?.found);
  }

  static search(params: {
    workspaceId: string;
    query: string;
    videoIds?: string[];
    limit?: number;
  }): YouTubeSearchHit[] {
    const scopedWorkspaceId = normalizeWorkspaceId(params.workspaceId);
    const db = this.getDatabase();
    if (!db || !this.ensureSchema(db)) return [];
    const ftsQuery = buildYouTubeTranscriptFtsQuery(params.query);
    if (!ftsQuery) return [];
    const videoIds = (params.videoIds || []).filter(Boolean);
    const limit = Math.max(1, Math.min(50, Math.round(params.limit ?? 8)));
    const videoWhere = videoIds.length
      ? `AND s.video_id IN (${videoIds.map(() => "?").join(", ")})`
      : "";
    const rows = db
      .prepare(
        `SELECT
          s.video_id, s.start_ms, s.end_ms, s.text,
          bm25(youtube_workspace_transcript_segments_fts) AS score,
          v.title, v.channel
        FROM youtube_workspace_transcript_segments_fts f
        JOIN youtube_workspace_transcript_segments s ON s.rowid = f.rowid
        LEFT JOIN youtube_workspace_videos v
          ON v.workspace_id = s.workspace_id AND v.video_id = s.video_id
        WHERE youtube_workspace_transcript_segments_fts MATCH ?
        AND s.workspace_id = ?
        ${videoWhere}
        ORDER BY bm25(youtube_workspace_transcript_segments_fts), s.start_ms ASC
        LIMIT ?`,
      )
      .all(ftsQuery, scopedWorkspaceId, ...videoIds, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const videoId = String(row.video_id || "");
      const startMs = Number(row.start_ms || 0);
      return {
        videoId,
        title: typeof row.title === "string" ? row.title : undefined,
        channel: typeof row.channel === "string" ? row.channel : undefined,
        startMs,
        endMs: typeof row.end_ms === "number" ? row.end_ms : undefined,
        text: String(row.text || ""),
        url: buildYouTubeWatchUrl(videoId, startMs),
        score: typeof row.score === "number" ? row.score : undefined,
      };
    });
  }
}
