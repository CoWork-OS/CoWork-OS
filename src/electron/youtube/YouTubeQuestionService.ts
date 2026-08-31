import { extractYouTubeVideoId } from "./url";
import { YouTubeIngestionService } from "./YouTubeIngestionService";
import { YouTubeTranscriptStore } from "./YouTubeTranscriptStore";
import type { YouTubeAskResult, YouTubeSearchHit } from "./types";
import type { YouTubeIngestionOptions } from "./access";

function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function buildExtractiveAnswer(question: string, sources: YouTubeSearchHit[]): string {
  if (!sources.length) {
    return "I could not find matching transcript moments for that question in the ingested video content.";
  }
  const lines = sources.slice(0, 5).map((source) => {
    const title = source.title || source.videoId;
    return `- ${title} at ${formatTimestamp(source.startMs)}: ${source.text}`;
  });
  return [
    `I found ${sources.length} relevant transcript moment${sources.length === 1 ? "" : "s"} for: ${question}`,
    ...lines,
  ].join("\n");
}

export class YouTubeQuestionService {
  constructor(
    private readonly workspaceId: string,
    private readonly workspacePath: string,
    private readonly options: YouTubeIngestionOptions = {},
  ) {}

  async ensureIngested(input: { url: string; language?: string; force?: boolean }) {
    const videoId = extractYouTubeVideoId(input.url);
    if (!videoId) throw new Error("Expected a YouTube URL or 11-character video ID.");
    const existing = YouTubeTranscriptStore.getVideo(this.workspaceId, videoId);
    if (!input.force && existing && YouTubeTranscriptStore.hasSegments(this.workspaceId, videoId)) {
      return { ok: true, video: existing, segments: [], warnings: [] };
    }
    return new YouTubeIngestionService(this.workspaceId, this.workspacePath, this.options).ingest({
      url: input.url,
      language: input.language,
      force: input.force,
    });
  }

  search(input: { query: string; videoIds?: string[]; limit?: number }): YouTubeSearchHit[] {
    return YouTubeTranscriptStore.search({ ...input, workspaceId: this.workspaceId });
  }

  async ask(input: {
    question: string;
    url?: string;
    videoIds?: string[];
    language?: string;
    limit?: number;
    force?: boolean;
  }): Promise<YouTubeAskResult> {
    const question = String(input.question || "").trim();
    if (!question) {
      return {
        ok: false,
        question,
        answer: "",
        sources: [],
        suggestedFollowUps: [],
        error: "Question is required.",
      };
    }

    const videoIds = [...(input.videoIds || [])];
    if (input.url) {
      const videoId = extractYouTubeVideoId(input.url);
      if (!videoId) {
        return {
          ok: false,
          question,
          answer: "",
          sources: [],
          suggestedFollowUps: [],
          error: "Expected a YouTube URL or 11-character video ID.",
        };
      }
      const ingestResult = await this.ensureIngested({
        url: input.url,
        language: input.language,
        force: input.force,
      });
      if (!ingestResult.ok) {
        return {
          ok: false,
          question,
          answer: "",
          sources: [],
          suggestedFollowUps: [],
          error: ingestResult.error || "Unable to ingest transcript for this video.",
          warnings: ingestResult.warnings,
        };
      }
      if (!videoIds.includes(videoId)) videoIds.push(videoId);
    }

    const sources = this.search({
      query: question,
      videoIds,
      limit: input.limit ?? 8,
    });

    return {
      ok: sources.length > 0,
      question,
      answer: buildExtractiveAnswer(question, sources),
      sources,
      suggestedFollowUps: [
        "Summarize the key moments.",
        "Find exact quotes about this topic.",
        "What should I watch first?",
      ],
      ...(sources.length ? {} : { error: "No matching transcript moments found." }),
    };
  }
}
