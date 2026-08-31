import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import type { WorkspaceFilesystemApprovalHandlers } from "../../security/access-profile-paths";
import {
  VideoGenerator,
  VideoProvider,
  VideoGenerationMode,
  VideoAspectRatio,
  VideoResolution,
} from "../skills/video-generator";
import { LLMTool } from "../llm/types";

/**
 * VideoTools — Tools for AI video generation
 *
 * Supports all configured video providers:
 *   - OpenAI Sora 2 (text_to_video, image_to_video)
 *   - Azure OpenAI Sora 2 (text_to_video, image_to_video)
 *   - Gemini API Veo 3.1 (text_to_video, image_to_video)
 *   - Vertex AI Veo 3 / 3.1 (text_to_video, image_to_video)
 *   - Kling (text_to_video, image_to_video)
 *
 * Long-running video generation is handled as two-phase:
 *   1. generate_video → returns a jobId if pending=true
 *   2. get_video_generation_job → polls until the video is ready
 */
export class VideoTools {
  private videoGenerator: VideoGenerator;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {
    this.videoGenerator = this.createVideoGenerator(workspace);
  }

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    this.videoGenerator = this.createVideoGenerator(workspace);
  }

  private createVideoGenerator(workspace: Workspace): VideoGenerator {
    const daemon = this.daemon as unknown as {
      requestApproval?: (
        taskId: string,
        type: "external_file_access",
        description: string,
        details: Record<string, unknown>,
      ) => Promise<boolean>;
      consumeExternalFileApproval?: (
        taskId: string,
        filePath: string,
        operation: "read" | "write" | "delete",
      ) => boolean;
    };
    const approvalHandlers: WorkspaceFilesystemApprovalHandlers = {
      ...(typeof daemon.requestApproval === "function"
        ? {
            request: ({ path: approvedPath, operation, label }) =>
              daemon.requestApproval!(
                this.taskId,
                "external_file_access",
                `Allow ${operation} access to external ${label}: ${approvedPath}`,
                { path: approvedPath, operation, tool: "generate_video" },
              ),
          }
        : {}),
      ...(typeof daemon.consumeExternalFileApproval === "function"
        ? {
            consume: (approvedPath: string, operation: "read" | "write" | "delete") =>
              daemon.consumeExternalFileApproval!(this.taskId, approvedPath, operation),
          }
        : {}),
    };
    return new VideoGenerator(workspace, approvalHandlers);
  }

  /**
   * Submit a video generation request.
   * Returns immediately when the provider uses async jobs (pending=true).
   * Returns the finished video path when generation is synchronous.
   */
  async generateVideo(input: {
    prompt: string;
    mode?: VideoGenerationMode;
    provider?: VideoProvider | "auto";
    model?: string;
    duration?: number;
    aspectRatio?: VideoAspectRatio;
    resolution?: VideoResolution;
    referenceImagePath?: string;
    referenceVideoPath?: string;
    filename?: string;
  }) {
    if (!this.workspace.permissions.write) {
      throw new Error("Write permission not granted for video generation");
    }
    if (
      (input.referenceImagePath || input.referenceVideoPath) &&
      !this.workspace.permissions.read
    ) {
      throw new Error("Read permission not granted — required to read reference media files");
    }
    const result = await this.videoGenerator.generate(input);

    if (result.success) {
      if (!result.pending && result.outputPaths?.length) {
        for (const filePath of result.outputPaths) {
          this.daemon.logEvent(this.taskId, "file_created", {
            path: filePath,
            type: "video",
            mimeType: "video/mp4",
            model: result.model,
            provider: result.provider,
          });
        }
      }
    } else {
      const payload: Record<string, unknown> = {
        action: "generate_video",
        error: result.error,
      };
      if (result.actionHint) payload.actionHint = result.actionHint;
      this.daemon.logEvent(this.taskId, "error", payload);
    }

    return result;
  }

  /**
   * Poll an async video generation job.
   * Call this after generate_video returns pending=true.
   */
  async getVideoGenerationJob(input: {
    jobId: string;
    provider: VideoProvider;
    filename?: string;
  }) {
    if (!input.jobId?.trim()) {
      throw new Error("get_video_generation_job requires a non-empty jobId from generate_video.");
    }

    const status = await this.videoGenerator.pollJob(input.jobId, input.provider, input.filename);

    if (status.status === "succeeded" && status.outputPaths?.length) {
      for (const filePath of status.outputPaths) {
        this.daemon.logEvent(this.taskId, "file_created", {
          path: filePath,
          type: "video",
          mimeType: "video/mp4",
          provider: status.provider,
        });
      }
    }

    return status;
  }

  /**
   * Cancel an in-progress video generation job.
   */
  async cancelVideoGenerationJob(input: { jobId: string; provider: VideoProvider }) {
    return this.videoGenerator.cancelJob(input.jobId, input.provider);
  }

  static isAvailable(): boolean {
    return VideoGenerator.isAvailable();
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "generate_video",
        description: `Generate a video from a text prompt (or an image/video reference) using AI.
CoWork OS will pick the best configured provider automatically (OpenAI Sora 2 / Azure Sora 2 / Gemini Veo 3.1 / Vertex AI Veo / Kling), unless you specify a provider.

Modes:
- text_to_video (default): generate a video from a text prompt
- image_to_video: animate a reference image (referenceImagePath required)
- video_to_video: restyle or reprompt an existing video (provider-native, referenceVideoPath required)
- extend_video: extend the duration of an existing video (provider-native, referenceVideoPath required)

Provider support:
- openai: Sora 2 — text_to_video, image_to_video
- azure: Sora 2 via Azure OpenAI deployment ("sora-2" or "sora-2-pro") — text_to_video, image_to_video
- gemini: Veo 3.1 / 3.1-fast / 3.0 — text_to_video, image_to_video
- vertex: Veo 3 / 3.1 on Vertex AI — text_to_video, image_to_video
- kling: Kling v2 — text_to_video, image_to_video

Most providers use async job submission. When pending=true is returned, call get_video_generation_job with the returned jobId to check status.
Generated videos are saved to the workspace folder.`,
        input_schema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "Detailed description of the video to generate. Include subject, motion, style, lighting, camera movement, duration context.",
            },
            mode: {
              type: "string",
              enum: ["text_to_video", "image_to_video", "video_to_video", "extend_video"],
              description: "Generation mode. Default: text_to_video.",
            },
            provider: {
              type: "string",
              enum: ["auto", "openai", "azure", "gemini", "vertex", "kling"],
              description:
                'Provider override. "auto" uses the configured default with fallbacks (default: auto).',
            },
            model: {
              type: "string",
              description:
                'Optional model override (e.g. "sora-2" for OpenAI/Azure, "veo-3.1", "kling-v2"). Leave empty for provider default.',
            },
            duration: {
              type: "number",
              description: "Video duration in seconds (provider-dependent range, typically 1–20).",
            },
            aspectRatio: {
              type: "string",
              enum: ["16:9", "9:16", "1:1"],
              description: "Aspect ratio. Default: 16:9.",
            },
            resolution: {
              type: "string",
              enum: ["480p", "720p", "1080p"],
              description:
                "Output resolution (if supported by provider). Default: provider default.",
            },
            referenceImagePath: {
              type: "string",
              description: "Absolute path to a reference image (required for image_to_video mode).",
            },
            referenceVideoPath: {
              type: "string",
              description:
                "Absolute path to a reference video (for video_to_video / extend_video modes).",
            },
            filename: {
              type: "string",
              description:
                "Output filename without extension (optional, defaults to video_<timestamp>).",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "get_video_generation_job",
        description: `Check the status of an async video generation job.
Call this after generate_video returns pending=true.
Returns status: "pending" | "running" | "succeeded" | "failed" | "cancelled"
When succeeded, outputPaths contains the path(s) to the generated video(s).`,
        input_schema: {
          type: "object",
          properties: {
            jobId: {
              type: "string",
              description: "The job/operation ID returned by generate_video.",
            },
            provider: {
              type: "string",
              enum: ["openai", "azure", "gemini", "vertex", "kling"],
              description: "The provider that submitted the job.",
            },
            filename: {
              type: "string",
              description: "Optional output filename override when downloading the result.",
            },
          },
          required: ["jobId", "provider"],
        },
      },
      {
        name: "cancel_video_generation_job",
        description: `Cancel an in-progress video generation job. Not all providers support cancellation; an error will be returned for unsupported providers.`,
        input_schema: {
          type: "object",
          properties: {
            jobId: {
              type: "string",
              description: "The job ID to cancel.",
            },
            provider: {
              type: "string",
              enum: ["openai", "azure", "gemini", "vertex", "kling"],
              description: "The provider that owns the job.",
            },
          },
          required: ["jobId", "provider"],
        },
      },
    ];
  }
}
