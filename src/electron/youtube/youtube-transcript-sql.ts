import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { buildYouTubeWatchUrl } from "./url";
import { extractFtsTerms, foldForMatch, quoteFtsTerm } from "../database/fts-query";
import type { YouTubeSearchHit, YouTubeTranscriptSegment, YouTubeVideoMetadata } from "./types";

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

/** Any-term query over the shared FTS term extraction and quoting (`database/fts-query.ts`). */
export function buildYouTubeTranscriptFtsQuery(query: string): string {
  return extractFtsTerms(query, { maxTerms: 48, minTermLength: 2, dropStopwords: true })
    .map((term) => term.toLocaleLowerCase())
    .filter((term) => !SEARCH_STOP_WORDS.has(foldForMatch(term)))
    .slice(0, 12)
    .map((term) => quoteFtsTerm(term))
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

/**
 * Workspace YouTube videos and transcript segments with their FTS index (async SQLite
 * migration plan, DB6). As services-domain units these run in the database worker when the
 * domain is routed there; callers use the static `YouTubeTranscriptStore`, which creates
 * the schema on the host before first use. Saving segments replaces a video's segments in
 * one transaction.
 */
export class YouTubeTranscriptSqlStore {
  constructor(private readonly db: Database.Database) {}

  saveVideo(workspaceId: string, video: YouTubeVideoMetadata): void {
    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const db = this.db;
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

  saveSegments(workspaceId: string, videoId: string, segments: YouTubeTranscriptSegment[]): void {
    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const db = this.db;
    // As a unit this runs in one transaction (DB6).
    {
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
    }
  }

  getVideo(workspaceId: string, videoId: string): YouTubeVideoMetadata | null {
    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const db = this.db;
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

  listVideos(workspaceId: string, limit = 50): YouTubeVideoMetadata[] {
    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const db = this.db;
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

  hasSegments(workspaceId: string, videoId: string): boolean {
    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const db = this.db;
    const row = db
      .prepare(
        `SELECT 1 AS found FROM youtube_workspace_transcript_segments
         WHERE workspace_id = ? AND video_id = ?
         LIMIT 1`,
      )
      .get(scopedWorkspaceId, videoId) as { found?: number } | undefined;
    return Boolean(row?.found);
  }

  search(params: {
    workspaceId: string;
    query: string;
    videoIds?: string[];
    limit?: number;
  }): YouTubeSearchHit[] {
    const scopedWorkspaceId = normalizeWorkspaceId(params.workspaceId);
    const db = this.db;
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
