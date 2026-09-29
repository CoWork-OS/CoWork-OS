import type Database from "better-sqlite3";
import { serviceStatements } from "../database/service-statements";
import { DatabaseManager } from "../database/schema";
import type { YouTubeSearchHit, YouTubeTranscriptSegment, YouTubeVideoMetadata } from "./types";

export { buildYouTubeTranscriptFtsQuery } from "./youtube-transcript-sql";

type TranscriptDatabase = Database.Database;

/**
 * Workspace YouTube transcripts (async SQLite migration plan, DB6). Each operation is one
 * services-domain unit over `YouTubeTranscriptSqlStore`: in the database worker when the
 * domain is routed there, one host transaction otherwise. The schema is created on the host
 * before first use; without a database every read is empty and every write is skipped.
 */
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

  /** The connection with the schema ready, or null. */
  private static ready(): TranscriptDatabase | null {
    const db = this.getDatabase();
    return db && this.ensureSchema(db) ? db : null;
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

  static async saveVideo(workspaceId: string, video: YouTubeVideoMetadata): Promise<void> {
    const db = this.ready();
    if (!db) return;
    await serviceStatements(db).unit("youtube_saveVideo", [workspaceId, video]);
  }

  static async saveSegments(
    workspaceId: string,
    videoId: string,
    segments: YouTubeTranscriptSegment[],
  ): Promise<void> {
    const db = this.ready();
    if (!db) return;
    await serviceStatements(db).unit("youtube_saveSegments", [workspaceId, videoId, segments]);
  }

  static async getVideo(
    workspaceId: string,
    videoId: string,
  ): Promise<YouTubeVideoMetadata | null> {
    const db = this.ready();
    if (!db) return null;
    return serviceStatements(db).unit("youtube_getVideo", [workspaceId, videoId]);
  }

  static async listVideos(workspaceId: string, limit = 50): Promise<YouTubeVideoMetadata[]> {
    const db = this.ready();
    if (!db) return [];
    return serviceStatements(db).unit("youtube_listVideos", [workspaceId, limit]);
  }

  static async hasSegments(workspaceId: string, videoId: string): Promise<boolean> {
    const db = this.ready();
    if (!db) return false;
    return serviceStatements(db).unit("youtube_hasSegments", [workspaceId, videoId]);
  }

  static async search(params: {
    workspaceId: string;
    query: string;
    videoIds?: string[];
    limit?: number;
  }): Promise<YouTubeSearchHit[]> {
    const db = this.ready();
    if (!db) return [];
    return serviceStatements(db).unit("youtube_search", [params]);
  }
}
