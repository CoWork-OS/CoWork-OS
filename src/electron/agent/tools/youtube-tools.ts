import type { Workspace } from "../../../shared/types";
import type { AgentDaemon } from "../daemon";
import type { LLMTool } from "../llm/types";
import { createYouTubeIngestionOptions, assertYouTubeIngestionAccess } from "../../youtube/access";
import {
  YouTubeIngestionService,
  YouTubeQuestionService,
  YouTubeTranscriptStore,
} from "../../youtube";

export class YouTubeTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  private get workspacePath(): string {
    if (!this.workspace.path) throw new Error("A workspace path is required for YouTube tools.");
    return this.workspace.path;
  }

  private get workspaceId(): string {
    if (!this.workspace.id) throw new Error("A workspace id is required for YouTube tools.");
    return this.workspace.id;
  }

  async ingestVideo(input: { url: string; language?: string; force?: boolean }) {
    assertYouTubeIngestionAccess(this.workspace, input.url, "youtube_ingest_video");
    const result = await new YouTubeIngestionService(
      this.workspaceId,
      this.workspacePath,
      createYouTubeIngestionOptions(this.workspace),
    ).ingest(input);
    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "youtube_ingest_video",
      videoId: result.video?.videoId,
      title: result.video?.title,
      segmentCount: result.segments.length,
      warningCount: result.warnings.length,
      success: result.ok,
      error: result.error,
    });
    return result;
  }

  async askVideo(input: { question: string; videoIds?: string[]; limit?: number }) {
    if (typeof (input as Any).url === "string" && (input as Any).url.trim()) {
      throw new Error(
        "youtube_ask_video only searches cached transcripts. Use youtube_ask_or_ingest_video for URLs.",
      );
    }
    const result = await new YouTubeQuestionService(this.workspaceId, this.workspacePath).ask({
      question: input.question,
      videoIds: input.videoIds,
      limit: input.limit,
    });
    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "youtube_ask_video",
      sourceCount: result.sources.length,
      success: result.ok,
      error: result.error,
    });
    return result;
  }

  async askOrIngestVideo(input: {
    question: string;
    url: string;
    videoIds?: string[];
    language?: string;
    limit?: number;
    force?: boolean;
  }) {
    assertYouTubeIngestionAccess(this.workspace, input.url, "youtube_ask_or_ingest_video");
    const result = await new YouTubeQuestionService(
      this.workspaceId,
      this.workspacePath,
      createYouTubeIngestionOptions(this.workspace),
    ).ask(input);
    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "youtube_ask_or_ingest_video",
      sourceCount: result.sources.length,
      success: result.ok,
      error: result.error,
    });
    return result;
  }

  searchSegments(input: { query: string; videoIds?: string[]; limit?: number }) {
    const result = new YouTubeQuestionService(this.workspaceId, this.workspacePath).search(input);
    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "youtube_search_ingested_segments",
      resultCount: result.length,
    });
    return { ok: true, results: result };
  }

  listVideos(input: { limit?: number } = {}) {
    return {
      ok: true,
      videos: YouTubeTranscriptStore.listVideos(this.workspaceId, input.limit ?? 50),
    };
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "youtube_ingest_video",
        description:
          "Ingest a public YouTube video's metadata and captions locally without using the YouTube Data API. Uses local yt-dlp/youtube-transcript-api when available, stores timestamped transcript segments, and returns warnings when captions are unavailable.",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "YouTube watch/shorts/embed URL or 11-character video ID.",
            },
            language: {
              type: "string",
              description: "Caption language code, default en.",
            },
            force: {
              type: "boolean",
              description: "Force a fresh ingest even when the video was seen before.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "youtube_ask_video",
        description:
          "Ask a question against locally ingested YouTube transcripts without network access. Returns an extractive answer plus timestamped source links for grounded follow-up synthesis.",
        input_schema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "Question to answer from the transcript.",
            },
            videoIds: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of already-ingested video IDs to search.",
            },
            limit: {
              type: "number",
              description: "Maximum source moments to return, default 8.",
            },
          },
          required: ["question"],
        },
      },
      {
        name: "youtube_ask_or_ingest_video",
        description:
          "Ask a question about a public YouTube video, ingesting captions first if needed. This may access the network through local yt-dlp/youtube-transcript-api but does not use YouTube Data API keys.",
        input_schema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "Question to answer from the transcript.",
            },
            url: {
              type: "string",
              description: "YouTube watch/shorts/embed URL or 11-character video ID.",
            },
            videoIds: {
              type: "array",
              items: { type: "string" },
              description: "Optional already-ingested video IDs to search with the URL.",
            },
            language: {
              type: "string",
              description: "Caption language code to use if ingestion is needed, default en.",
            },
            limit: {
              type: "number",
              description: "Maximum source moments to return, default 8.",
            },
            force: {
              type: "boolean",
              description: "Force a fresh ingest before answering.",
            },
          },
          required: ["question", "url"],
        },
      },
      {
        name: "youtube_search_ingested_segments",
        description:
          "Search locally ingested YouTube transcript segments and return timestamped matching moments.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            videoIds: {
              type: "array",
              items: { type: "string" },
              description: "Optional video IDs to restrict search.",
            },
            limit: { type: "number", description: "Maximum results, default 8." },
          },
          required: ["query"],
        },
      },
      {
        name: "youtube_list_ingested_videos",
        description: "List recently ingested YouTube videos in the local CoWork OS cache.",
        input_schema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum videos to list, default 50." },
          },
        },
      },
    ];
  }
}
