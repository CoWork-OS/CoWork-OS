import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildYouTubeWatchUrl, extractYouTubeVideoId } from "./url";
import { YouTubeTranscriptStore } from "./YouTubeTranscriptStore";
import type { YouTubeIngestionOptions } from "./access";
import type {
  YouTubeChapter,
  YouTubeIngestResult,
  YouTubeTranscriptSegment,
  YouTubeVideoMetadata,
} from "./types";

const execFileAsync = promisify(execFile);

type Json3Event = {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
};

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "Unknown error");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseDurationSeconds(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

function parseChapters(raw: unknown): YouTubeChapter[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const chapters = raw
    .map((entry): YouTubeChapter | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const start = Number(record.start_time);
      if (!Number.isFinite(start)) return null;
      const end = Number(record.end_time);
      return {
        title: String(record.title || "Chapter"),
        startMs: Math.max(0, Math.round(start * 1000)),
        ...(Number.isFinite(end) ? { endMs: Math.max(0, Math.round(end * 1000)) } : {}),
      };
    })
    .filter((chapter): chapter is YouTubeChapter => Boolean(chapter));
  return chapters.length ? chapters : undefined;
}

function coalesceSegments(
  segments: YouTubeTranscriptSegment[],
  targetWindowMs = 35_000,
): YouTubeTranscriptSegment[] {
  const sorted = segments
    .filter((segment) => normalizeText(segment.text))
    .sort((a, b) => a.startMs - b.startMs);
  const merged: YouTubeTranscriptSegment[] = [];
  let current: YouTubeTranscriptSegment | null = null;

  for (const segment of sorted) {
    const text = normalizeText(segment.text);
    if (!current) {
      current = { ...segment, text };
      continue;
    }
    const currentEnd = current.endMs ?? current.startMs;
    const gap = segment.startMs - currentEnd;
    const windowSize = segment.startMs - current.startMs;
    if (gap <= 5_000 && windowSize <= targetWindowMs) {
      current = {
        ...current,
        endMs: segment.endMs ?? segment.startMs,
        text: normalizeText(`${current.text} ${text}`),
      };
      continue;
    }
    merged.push(current);
    current = { ...segment, text };
  }
  if (current) merged.push(current);
  return merged;
}

function parseJson3Transcript(
  videoId: string,
  raw: string,
  source: YouTubeTranscriptSegment["source"],
  language?: string,
): YouTubeTranscriptSegment[] {
  const parsed = JSON.parse(raw) as { events?: Json3Event[] };
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  const segments = events
    .map((event): YouTubeTranscriptSegment | null => {
      if (!Array.isArray(event.segs)) return null;
      const text = normalizeText(event.segs.map((seg) => seg.utf8 || "").join(""));
      if (!text) return null;
      const startMs = Math.max(0, Math.round(Number(event.tStartMs || 0)));
      const durationMs = Number(event.dDurationMs);
      return {
        videoId,
        startMs,
        ...(Number.isFinite(durationMs) && durationMs > 0
          ? { endMs: startMs + Math.round(durationMs) }
          : {}),
        text,
        source,
        language,
      };
    })
    .filter((segment): segment is YouTubeTranscriptSegment => Boolean(segment));
  return coalesceSegments(segments);
}

function parseTranscriptApiJson(
  videoId: string,
  raw: string,
  language?: string,
): YouTubeTranscriptSegment[] {
  const parsed = JSON.parse(raw) as Array<{ text?: string; start?: number; duration?: number }>;
  if (!Array.isArray(parsed)) return [];
  return coalesceSegments(
    parsed
      .map((entry): YouTubeTranscriptSegment | null => {
        const text = normalizeText(String(entry.text || ""));
        if (!text) return null;
        const startMs = Math.max(0, Math.round(Number(entry.start || 0) * 1000));
        const durationMs = Number(entry.duration || 0) * 1000;
        return {
          videoId,
          startMs,
          ...(Number.isFinite(durationMs) && durationMs > 0
            ? { endMs: startMs + Math.round(durationMs) }
            : {}),
          text,
          source: "youtube-transcript-api",
          language,
        };
      })
      .filter((segment): segment is YouTubeTranscriptSegment => Boolean(segment)),
  );
}

export class YouTubeIngestionService {
  private static readonly ingestLocks = new Map<string, Promise<YouTubeIngestResult>>();

  constructor(
    private readonly workspaceId: string,
    private readonly workspacePath: string,
    private readonly options: YouTubeIngestionOptions = {},
  ) {}

  private cacheDir(videoId: string): string {
    return path.join(this.workspacePath, ".cowork", "youtube", videoId);
  }

  private assertCacheAccess(requestedPath: string, operation: "read" | "write"): string {
    return this.options.assertFilesystemAccess?.(requestedPath, operation) || requestedPath;
  }

  private async runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync("yt-dlp", args, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 90_000,
    });
    return {
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
    };
  }

  async fetchMetadata(input: string): Promise<YouTubeVideoMetadata> {
    const videoId = extractYouTubeVideoId(input);
    if (!videoId) throw new Error("Expected a YouTube URL or 11-character video ID.");
    const url = buildYouTubeWatchUrl(videoId);
    const result = await this.runYtDlp(["--dump-json", "--no-download", url]);
    const raw = JSON.parse(result.stdout) as Record<string, unknown>;
    return {
      videoId,
      url,
      title: typeof raw.title === "string" ? raw.title : undefined,
      channel:
        typeof raw.channel === "string"
          ? raw.channel
          : typeof raw.uploader === "string"
            ? raw.uploader
            : undefined,
      durationSeconds: parseDurationSeconds(raw.duration),
      thumbnailUrl: typeof raw.thumbnail === "string" ? raw.thumbnail : undefined,
      uploadDate: typeof raw.upload_date === "string" ? raw.upload_date : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
      chapters: parseChapters(raw.chapters),
      fetchedAt: Date.now(),
      raw,
    };
  }

  private async readFirstJson3Transcript(
    videoId: string,
    source: YouTubeTranscriptSegment["source"],
    language: string,
    directory = this.cacheDir(videoId),
  ): Promise<YouTubeTranscriptSegment[]> {
    const dir = this.assertCacheAccess(directory, "read");
    const files = await fs.readdir(dir).catch(() => []);
    const json3 = files.find((file) => file.endsWith(".json3"));
    if (!json3) return [];
    const transcriptPath = this.assertCacheAccess(path.join(dir, json3), "read");
    const raw = await fs.readFile(transcriptPath, "utf8");
    return parseJson3Transcript(videoId, raw, source, language);
  }

  private async fetchTranscriptWithYtDlp(
    videoId: string,
    language: string,
    auto: boolean,
  ): Promise<YouTubeTranscriptSegment[]> {
    const cacheDir = this.assertCacheAccess(this.cacheDir(videoId), "write");
    await fs.mkdir(cacheDir, { recursive: true });
    // Use a fresh run directory instead of deleting an existing cache. The
    // latter would turn a normal transcript refresh into an implicit delete
    // capability and would also race with concurrent reads.
    const dir = this.assertCacheAccess(await fs.mkdtemp(path.join(cacheDir, ".run-")), "write");
    const url = buildYouTubeWatchUrl(videoId);
    const output = path.join(dir, "%(id)s");
    await this.runYtDlp([
      auto ? "--write-auto-sub" : "--write-sub",
      "--sub-lang",
      language,
      "--sub-format",
      "json3",
      "--skip-download",
      "--no-warnings",
      "--no-cache-dir",
      "-o",
      output,
      url,
    ]);
    return this.readFirstJson3Transcript(videoId, auto ? "auto" : "manual", language, dir);
  }

  private async fetchTranscriptWithPython(
    videoId: string,
    language: string,
  ): Promise<YouTubeTranscriptSegment[]> {
    const code = `
import json, sys
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
items = api.fetch(sys.argv[1], languages=[sys.argv[2], "en"])
print(json.dumps([{"text": x.text, "start": x.start, "duration": x.duration} for x in items]))
`.trim();
    const result = await execFileAsync("python3", ["-c", code, videoId, language], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 90_000,
    });
    return parseTranscriptApiJson(videoId, String(result.stdout || ""), language);
  }

  async ingest(input: {
    url: string;
    language?: string;
    force?: boolean;
  }): Promise<YouTubeIngestResult> {
    const videoId = extractYouTubeVideoId(input.url);
    if (!videoId) {
      return {
        ok: false,
        segments: [],
        warnings: [],
        error: "Expected a YouTube URL or 11-character video ID.",
      };
    }
    const lockKey = `${this.workspaceId}:${videoId}`;
    const existingLock = YouTubeIngestionService.ingestLocks.get(lockKey);
    if (existingLock) return existingLock;
    if (this.options.assertFilesystemAccess) {
      this.assertCacheAccess(this.cacheDir(videoId), "read");
      this.assertCacheAccess(this.cacheDir(videoId), "write");
    }
    const locked = this.ingestUnlocked(input, videoId).finally(() => {
      if (YouTubeIngestionService.ingestLocks.get(lockKey) === locked) {
        YouTubeIngestionService.ingestLocks.delete(lockKey);
      }
    });
    YouTubeIngestionService.ingestLocks.set(lockKey, locked);
    return locked;
  }

  private async ingestUnlocked(
    input: {
      url: string;
      language?: string;
      force?: boolean;
    },
    videoId: string,
  ): Promise<YouTubeIngestResult> {
    const language = input.language || "en";
    const warnings: string[] = [];
    let video: YouTubeVideoMetadata = {
      videoId,
      url: buildYouTubeWatchUrl(videoId),
      fetchedAt: Date.now(),
    };

    try {
      video = await this.fetchMetadata(video.url);
    } catch (error) {
      warnings.push(`Metadata unavailable via yt-dlp: ${formatError(error)}`);
    }

    let segments: YouTubeTranscriptSegment[] = [];
    try {
      segments = await this.fetchTranscriptWithYtDlp(videoId, language, false);
    } catch (error) {
      warnings.push(`Manual captions unavailable via yt-dlp: ${formatError(error)}`);
    }
    if (!segments.length) {
      try {
        segments = await this.fetchTranscriptWithYtDlp(videoId, language, true);
      } catch (error) {
        warnings.push(`Auto captions unavailable via yt-dlp: ${formatError(error)}`);
      }
    }
    if (!segments.length) {
      try {
        segments = await this.fetchTranscriptWithPython(videoId, language);
      } catch (error) {
        warnings.push(`youtube-transcript-api fallback unavailable: ${formatError(error)}`);
      }
    }

    YouTubeTranscriptStore.saveVideo(this.workspaceId, video);
    if (segments.length) {
      YouTubeTranscriptStore.saveSegments(this.workspaceId, videoId, segments);
    }

    return {
      ok: segments.length > 0,
      video,
      segments,
      warnings,
      ...(segments.length
        ? {}
        : { error: "No transcript segments were available for this video." }),
    };
  }
}
