import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import {
  ImageGenerator,
  ImageModel,
  ImageSize,
  ImageGenerationResult,
  ImageProvider,
} from "../skills/image-generator";
import { LLMTool } from "../llm/types";

/**
 * ImageTools - Tools for AI image generation
 *
 * Supports multiple backends depending on what's configured in Settings:
 * - Gemini (image generation)
 * - OpenAI (gpt-image-* / dall-e-*)
 * - OpenAI OAuth via Codex/ChatGPT (gpt-image-* through the Responses image_generation tool)
 * - Azure OpenAI (deployment-based)
 *
 * If multiple are configured, the tool prefers the configured default provider,
 * then falls back to the others unless explicitly overridden.
 */
export class ImageTools {
  private imageGenerator: ImageGenerator;
  private imageGenerationRequestSignatures = new Set<string>();
  private duplicateImageGenerationBlockLogged = false;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {
    this.imageGenerator = new ImageGenerator(workspace);
  }

  /**
   * Update the workspace for this tool
   * Recreates the image generator with the new workspace
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    this.imageGenerator = new ImageGenerator(workspace);
  }

  /**
   * Generate an image from a text prompt
   */
  async generateImage(
    input: {
      prompt: string;
      provider?: ImageProvider | "auto";
      model?: ImageModel;
      filename?: string;
      imageSize?: ImageSize;
      numberOfImages?: number;
    },
    options?: { signal?: AbortSignal },
  ): Promise<ImageGenerationResult> {
    if (!this.workspace.permissions.write) {
      throw new Error("Write permission not granted for image generation");
    }

    const requestSignature = this.getImageGenerationRequestSignature(input);
    if (this.imageGenerationRequestSignatures.has(requestSignature)) {
      const error =
        "generate_image has already been attempted with the same request in this task. CoWork OS blocks repeated identical image generation calls to prevent duplicate outputs.";
      if (!this.duplicateImageGenerationBlockLogged) {
        this.duplicateImageGenerationBlockLogged = true;
        this.daemon.logEvent(this.taskId, "error", {
          action: "generate_image",
          error,
        });
      }
      return {
        success: false,
        images: [],
        ...(input.provider && input.provider !== "auto" ? { provider: input.provider } : {}),
        model: input.model || "image-generation",
        error,
      };
    }

    this.imageGenerationRequestSignatures.add(requestSignature);

    const result = await this.imageGenerator.generate({
      prompt: input.prompt,
      provider: input.provider || "auto",
      model: input.model,
      filename: input.filename,
      imageSize: input.imageSize || "1K",
      numberOfImages: input.numberOfImages || 1,
      signal: options?.signal,
      onProgress: (event) => {
        this.daemon.logEvent(this.taskId, "progress_update", {
          action: "generate_image",
          provider: event.provider,
          model: event.model,
          timeoutMs: event.timeoutMs,
          fallbackModel: event.fallbackModel,
          message: event.message,
          status: "in_progress",
          actor: "agent",
        });
      },
    });

    // Log events for generated images
    if (result.success) {
      for (const image of result.images) {
        this.daemon.logEvent(this.taskId, "file_created", {
          path: image.filename,
          type: "image",
          mimeType: image.mimeType,
          size: image.size,
          model: result.model,
          provider: result.provider,
        });
      }
    } else {
      const payload: Record<string, Any> = {
        action: "generate_image",
        error: result.error,
      };
      if (result.actionHint) {
        payload.actionHint = result.actionHint;
      }
      this.daemon.logEvent(this.taskId, "error", {
        ...payload,
      });
    }

    return result;
  }

  private getImageGenerationRequestSignature(input: {
    prompt: string;
    provider?: ImageProvider | "auto";
    model?: ImageModel;
    imageSize?: ImageSize;
    numberOfImages?: number;
  }): string {
    return JSON.stringify({
      prompt: String(input.prompt || "").replace(/\s+/g, " ").trim().toLowerCase(),
      provider: input.provider || "auto",
      model: input.model || "",
      imageSize: input.imageSize || "1K",
      numberOfImages: input.numberOfImages || 1,
    });
  }

  /**
   * Check if image generation is available
   */
  static isAvailable(): boolean {
    return ImageGenerator.isAvailable();
  }

  /**
   * Get tool definitions for image generation
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "generate_image",
        description: `Generate an image from a text description using AI. CoWork OS will pick the best configured provider by default (Gemini/OpenAI/OpenAI OAuth/Azure/OpenRouter), unless you specify a provider/model.

Providers/models:
- OpenAI: gpt-image-1, gpt-image-1.5, dall-e-3, dall-e-2 (also accepts "gpt-1.5" alias)
- OpenAI (Codex auth): gpt-image-1, gpt-image-1.5 via ChatGPT/Codex OAuth
- Azure OpenAI: model maps to a deployment name (configured in Settings)
- OpenRouter: gpt-image-1.5 via openai/gpt-image-1.5
- Gemini: nano-banana-2 (gemini-3.1-flash-image-preview), gemini-image-pro, gemini-image-fast

The generated images are saved to the workspace folder.`,
        input_schema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "Detailed text description of the image to generate. Be specific about subject, style, colors, composition, lighting, etc.",
            },
            provider: {
              type: "string",
              enum: ["auto", "gemini", "openai", "openai-codex", "azure", "openrouter"],
              description:
                'Optional provider override. "auto" uses the configured default with fallbacks (default: auto).',
            },
            model: {
              type: "string",
              description:
                'Optional model override. Examples: "gpt-image-1.5", "dall-e-3", or an Azure deployment name.',
            },
            filename: {
              type: "string",
              description:
                "Output filename without extension (optional, defaults to generated_<timestamp>)",
            },
            imageSize: {
              type: "string",
              enum: ["1K", "2K"],
              description:
                'Size of the generated image. "1K" for 1024px, "2K" for 2048px (default: 1K)',
            },
            numberOfImages: {
              type: "number",
              description: "Number of images to generate (1-4, default: 1)",
            },
          },
          required: ["prompt"],
        },
      },
    ];
  }
}
